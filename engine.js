// --- APPLICATION ENGINE (engine.js) ---
// This module acts as the central scheduler, orchestrating all the individual
// worker modules at their specified intervals.

import { EventEmitter } from 'node:events';
import { LOG, WARN, ERR } from './app_modules/core.js';
import { MODULE_INTERVAL_BOUNDS } from './config/registry.mjs';
import { flushAllBatches } from './utils.js';
import { getSetting } from './config/runtime.mjs';

// --- Module Imports ---
// Currently, only SuperElites is active for testing.
import { checkSuperElites } from './app_modules/SuperElite.js';
import { checkBounties } from './app_modules/BountyBoard.js';
import { checkForCratesFound } from './app_modules/Crates.js';
import { checkForTitanNotifications } from './app_modules/Titans.js';
import { checkLadderReset } from './app_modules/Ladder.js';
import { checkForShoutbox } from './app_modules/Shoutbox.js';
import { checkForUpdatesArchive } from './app_modules/GameUpdates.js';
import { checkRelics } from './app_modules/Relics.js';
import { checkGuildConflicts } from './app_modules/GuildConflicts.js';
import { autoJoinAllGroups, checkAndSwapGear } from './app_modules/QoL.js';
import { checkGuildMessages } from './app_modules/GuildMessages.js';

// --- Task Configuration ---
// Using a Map allows for easy lookup by task name.
// Each task now includes a state (active) and a timerId.
const tasks = new Map([
    ['SuperElites', {
        handler: checkSuperElites,
        interval: 15 * 1000,
        activeOnStart: true, // Should the task be active when the engine starts?
        timerId: null, // Will hold the ID of the setInterval timer
    }],
    
    ['BountyBoard', {
		handler: checkBounties,
		interval: 5 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Crates', {
		handler: checkForCratesFound,
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Titans', { 
		handler: checkForTitanNotifications,
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Ladder', {
		handler: checkLadderReset,
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Shoutbox', {
		handler: checkForShoutbox,
		interval: 5 * 60 * 1000,		
		activeOnStart: true,
		timerId: null,
	}],
	[ 'GameUpdates', {
		handler: checkForUpdatesArchive,
		interval: 5 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Relics', {
		handler: checkRelics,
		interval: 1 * 60 * 1000,
		activeOnStart: true,  
		timerId: null
	}],
	[ 'GuildConflicts', {
		handler: checkGuildConflicts,
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Groups', {
		handler: autoJoinAllGroups, 
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'AutoGearSwap', {
		handler: checkAndSwapGear,
		interval: 1 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
    [ 'GuildMessages', {
		handler: checkGuildMessages, 
		interval: 5 * 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
]);

// Pending staggered-start timers from initEngine(), cancelled on shutdown (AC-ENG-005).
const startupTimers = new Set();
const SHUTDOWN_DRAIN_MS = 5000;
let shuttingDown = false;

// --- Runtime controller state (CTRL-TASK-003) ---
// 'task' events carry a task name whenever its state or latest result changes; the control plane
// streams them to the dashboard.
export const engineEvents = new EventEmitter();
let paused = false;                     // set by pauseAll(): no task may start until resumeAll()
let transitions = Promise.resolve();    // serializes lifecycle transitions requested at runtime

for (const task of tasks.values()) {
    task.defaultInterval = task.interval;
    task.lastRun = null;                // { startedAt, durationMs, outcome, error }
}

const emitTask = name => engineEvents.emit('task', name);

/** Short, credential-free error text for the dashboard: URLs are removed and long text is cut. */
function summarizeError(e) {
    const msg = String(e?.message ?? e ?? 'error').replace(/https?:\/\/\S+/g, '[url]');
    return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
}


/**
 * Core scheduling loop for a single task.
 * It runs the task, then schedules the next run after completion.
 * Each start gets a new run generation; a loop from an older generation (one that was
 * stopped) never reschedules itself, so a stop/start cycle cannot leave two loops. ENG-TASK-003
 * @param {string} taskName - The name of the task to run.
 * @param {number} generation - The run generation this loop belongs to.
 */
async function scheduleNextRun(taskName, generation) {
    const task = tasks.get(taskName);
    if (!task || task.generation !== generation) return; // Removed, or stopped since this run was scheduled

    const controller = new AbortController();
    task.abortController = controller;
    task.running = true;
    const startedAt = Date.now();
    let outcome = 'ok', error = null;
    let finishRun;
    task.runPromise = new Promise(resolve => { finishRun = resolve; });
    emitTask(taskName);
    try {
        // LOG('Engine', `Executing task: ${taskName}...`);
        await task.handler({ signal: controller.signal });
    } catch (e) {
        if (controller.signal.aborted) outcome = 'aborted';
        else { outcome = 'error'; error = summarizeError(e); ERR(taskName, 'execution failed', e); }
    } finally {
        task.running = false;
        task.lastRun = { startedAt, durationMs: Date.now() - startedAt, outcome, error };
        finishRun();
        if (task.abortController === controller) task.abortController = null;
        // IMPORTANT: Schedule the next run only after the current one finishes
        // This prevents task overlap.
        if (task.timerId !== null && task.generation === generation) { // Not stopped while it was running
            task.timerId = setTimeout(() => scheduleNextRun(taskName, generation), task.interval);
        }
        emitTask(taskName);
    }
}

// --- PUBLIC CONTROL FUNCTIONS ---

/**
 * Starts a specific task by its name. Refuses while an earlier run is still in flight,
 * so at most one instance of a task ever runs. ENG-TASK-003 / AC-ENG-002, AC-ENG-003
 * @param {string} taskName - The name of the task to start.
 * @returns {boolean} True when the task was started.
 */
export function startTask(taskName) {
    const task = tasks.get(taskName);
    if (!task) {
        ERR('Engine', `Task "${taskName}" not found in registry; cannot start it.`); // AC-ENG-003
        return false;
    }
    // timerId agora é usado como uma flag 'active' e para o setTimeout.
    // Usamos um valor simbólico (1) para indicar que deve iniciar, mas o ID real vem do setTimeout.
    if (task.timerId) {
        LOG('Engine', `Task "${taskName}" is already running.`);
        return false;
    }
    if (task.running) {
        WARN('Engine', `Task "${taskName}" is still finishing a stopped run; not starting a second instance.`);
        return false;
    }
    if (paused) {
        WARN('Engine', `Task "${taskName}" not started: the engine is paused (account switch in progress or failed).`);
        return false;
    }

    task.generation = (task.generation ?? 0) + 1;
    task.timerId = 1; // Mark as active
    scheduleNextRun(taskName, task.generation); // Kick off the first run
    LOG('Engine', `Task "${taskName}" has been started and scheduled.`);
    return true;
}

/**
 * Stops a specific task by its name: cancels its next run, aborts the in-flight run's
 * signal, and invalidates its loop so it can never reschedule. ENG-TASK-003
 * @param {string} taskName - The name of the task to stop.
 * @returns {boolean} True when a running task was stopped.
 */
export function stopTask(taskName) {
    const task = tasks.get(taskName);
    if (!task) {
        ERR('Engine', `Task "${taskName}" not found in registry; cannot stop it.`); // AC-ENG-003
        return false;
    }
    if (!task.timerId) {
        LOG('Engine', `Task "${taskName}" is not currently running.`);
        return false;
    }

    clearTimeout(task.timerId); // Use clearTimeout instead of clearInterval
    task.timerId = null;
    task.generation = (task.generation ?? 0) + 1;
    task.abortController?.abort();
    LOG('Engine', `Task "${taskName}" has been stopped.`);
    emitTask(taskName);
    return true;
}

// --- RUNTIME CONTROLLER (CTRL-TASK-003) ---

/** Runs one lifecycle transition after every earlier one has finished. */
function serialized(fn) {
    const run = transitions.then(fn, fn);
    transitions = run.catch(() => {});
    return run;
}

function requireTask(taskName) {
    const task = tasks.get(taskName);
    if (!task) throw Object.assign(new Error(`Task "${taskName}" not found in registry`), { code: 'UNKNOWN_MODULE' });
    return task;
}

/** Waits for a task's in-flight run (if any) to settle, bounded by timeoutMs. */
async function settleRun(task, timeoutMs) {
    if (!task.running || !task.runPromise) return true;
    let timer;
    const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const ok = await Promise.race([task.runPromise.then(() => true), timedOut]);
    clearTimeout(timer);
    return ok;
}

/** Stable module identifiers, in registry order. */
export function listModuleIds() {
    return [...tasks.keys()];
}

/**
 * Enables (starts) or disables (stops) a module. Serialized with other transitions.
 * @returns {Promise<{ enabled: boolean, active: boolean }>}
 */
export function setModuleEnabled(taskName, enabled) {
    return serialized(async () => {
        const task = requireTask(taskName);
        task.activeOnStart = Boolean(enabled);
        if (!enabled) {
            if (task.timerId) stopTask(taskName);
        } else if (!task.timerId && !paused) {
            await settleRun(task, 30_000);  // a stopped run must finish before a new loop starts
            startTask(taskName);
        }
        emitTask(taskName);
        return { enabled: task.activeOnStart, active: Boolean(task.timerId) };
    });
}

/** Changes a module's interval; the new value applies when its next run is scheduled. */
export function setModuleInterval(taskName, intervalMs) {
    return serialized(async () => {
        const task = requireTask(taskName);
        if (!Number.isInteger(intervalMs) || intervalMs < MODULE_INTERVAL_BOUNDS.min || intervalMs > MODULE_INTERVAL_BOUNDS.max) {
            throw Object.assign(new Error(`Interval must be ${MODULE_INTERVAL_BOUNDS.min}-${MODULE_INTERVAL_BOUNDS.max} ms.`), { code: 'BAD_INTERVAL' });
        }
        task.interval = intervalMs;
        emitTask(taskName);
        return { intervalMs };
    });
}

/**
 * Stops every task and waits for in-flight runs to finish (bounded). While paused no task starts.
 * @returns {Promise<string[]>} Modules that were enabled, for resumeAll().
 */
export function pauseAll({ timeoutMs = 30_000 } = {}) {
    return serialized(async () => {
        paused = true;
        for (const timer of startupTimers) clearTimeout(timer);
        startupTimers.clear();
        const wasEnabled = [...tasks.entries()].filter(([, t]) => t.activeOnStart).map(([name]) => name);
        for (const [name, task] of tasks) if (task.timerId) stopTask(name);
        await Promise.all([...tasks.values()].map(t => settleRun(t, timeoutMs)));
        engineEvents.emit('engine', { paused });
        return wasEnabled;
    });
}

/** Clears the pause and starts the given modules (normally the list pauseAll() returned). */
export function resumeAll(taskNames = listModuleIds().filter(n => tasks.get(n).activeOnStart)) {
    return serialized(async () => {
        paused = false;
        const started = [];
        for (const name of taskNames) {
            const task = tasks.get(name);
            if (!task || !task.activeOnStart) continue;
            if (startTask(name)) started.push(name);
        }
        engineEvents.emit('engine', { paused });
        return started;
    });
}

export function isPaused() {
    return paused;
}

/**
 * Initializes the engine with staggered start times.
 */
/**
 * @param {object} [opts]
 * @param {Map<string, {enabled: boolean, intervalMs: number}>} [opts.preferences] - Persisted module
 *   preferences (control plane); they override the built-in activeOnStart and interval.
 */
export function initEngine({ preferences } = {}) {
    console.log('[GoGon_Engine] Initializing task engine...');

    for (const [name, pref] of preferences ?? []) {
        const task = tasks.get(name);
        if (!task) { WARN('Engine', `Ignoring stored preference for unknown module "${name}".`); continue; }
        task.activeOnStart = Boolean(pref.enabled);
        if (Number.isInteger(pref.intervalMs) && pref.intervalMs >= MODULE_INTERVAL_BOUNDS.min && pref.intervalMs <= MODULE_INTERVAL_BOUNDS.max) {
            task.interval = pref.intervalMs;
        }
    }

    // --- PRE-FLIGHT VALIDATION ---
    // Check if QoL module (gear swap) has required configuration
    const botPlayerID = getSetting('GG_BOT_ID_CHARACTER');
    const peaceGearIds = getSetting('GG_PEACE_GEAR_IDS');
    const warGearIds = getSetting('GG_WAR_GEAR_IDS');
    
    // Disable gear swap if not configured
    const gearSwapTask = tasks.get('AutoGearSwap');
    if (gearSwapTask && (!botPlayerID || !peaceGearIds || !warGearIds)) {
        WARN('Engine', 'AutoGearSwap disabled: GG_BOT_ID_CHARACTER, GG_PEACE_GEAR_IDS, or GG_WAR_GEAR_IDS not configured in .env');
        gearSwapTask.activeOnStart = false;
    }

    // --- STAGGERED TASK INITIALIZATION ---
    let delay = 0;
    const staggerInterval = 2000; // 2 seconds between each task start

    tasks.forEach((task, taskName) => {
        if (task.activeOnStart) {
            // Stagger the start of each task to avoid initial load spikes
            const timer = setTimeout(() => {
                startupTimers.delete(timer);
                LOG('Engine', `Kicking off initial run for ${taskName}...`);
                startTask(taskName);
            }, delay);
            startupTimers.add(timer);
            delay += staggerInterval;
        } else {
            console.log(`[GoGon_Engine] ⏸️  Skipping task "${taskName}" (disabled or not configured)`);
        }
    });

    console.log(`[GoGon_Engine] ✅ Engine initialized. ${Array.from(tasks.values()).filter(t => t.activeOnStart).length} tasks scheduled.`);
}

export function getTasksStatus() {
    const status = [];
    tasks.forEach((task, name) => {
        status.push({
            name: name,
            isActive: !!task.timerId,
            isRunning: !!task.running, // A run is in flight right now
            enabled: !!task.activeOnStart,
            interval: task.interval,
            defaultInterval: task.defaultInterval,
            lastRun: task.lastRun ? { ...task.lastRun } : null,
        });
    });
    return status;
};
/**
 * Gracefully shuts down all running tasks.
 * Called on SIGTERM/SIGINT to allow tasks to finish.
 */
function shutdownEngine() {
    console.log('[GoGon_Engine] 🛑 Shutdown signal received. Stopping all tasks...');

    // Tasks whose staggered start has not fired yet must not start during shutdown
    for (const timer of startupTimers) clearTimeout(timer);
    startupTimers.clear();

    const activeTasks = [];
    tasks.forEach((task, name) => {
        if (task.timerId) {
            activeTasks.push(name);
            stopTask(name);
        }
    });
    
    if (activeTasks.length > 0) {
        console.log(`[GoGon_Engine] ✅ Stopped ${activeTasks.length} active tasks: ${activeTasks.join(', ')}`);
    } else {
        console.log('[GoGon_Engine] ℹ️  No active tasks to stop.');
    }

    // v1.8.0: Flush pending Discord message batches
    try {
        flushAllBatches();
        console.log('[GoGon_Engine] ✅ Flushed pending Discord batches');
    } catch (err) {
        console.warn('[GoGon_Engine] ⚠️  Could not flush Discord batches:', err.message);
    }
}


// --- PROCESS SIGNAL HANDLERS ---
// These handlers ensure graceful shutdown when the process is terminated

/**
 * Stops the engine once, then exits with code 0 after the drain window even if a
 * webhook flush hangs. Repeated signals do not start a second shutdown. ENG-TASK-001 / AC-ENG-005
 * @param {string} signal - The received signal name.
 * @param {object} [opts] - Test seams: exit function and drain window in ms.
 */
function handleShutdownSignal(signal, { exit = process.exit, drainMs = SHUTDOWN_DRAIN_MS } = {}) {
    if (shuttingDown) {
        console.log(`[GoGon_Engine] 📡 Received ${signal} again; shutdown already in progress`);
        return false;
    }
    shuttingDown = true;
    console.log(`\n[GoGon_Engine] 📡 Received ${signal} signal`);
    shutdownEngine();
    // Give tasks the drain window to finish any in-flight operations
    setTimeout(() => {
        console.log('[GoGon_Engine] 👋 Exiting gracefully');
        exit(0);
    }, drainMs);
    return true;
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

// Export shutdown functions for testing/external use
export { shutdownEngine, handleShutdownSignal };