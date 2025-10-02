// --- APPLICATION ENGINE (engine.js) ---
// This module acts as the central scheduler, orchestrating all the individual
// worker modules at their specified intervals.

import { LOG, WARN, ERR } from './app_modules/core.js';

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
		interval: 7 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
	[ 'Crates', {
		handler: checkForCratesFound,
		interval: 60 * 1000,
		activeOnStart: true,
		timerId: null,
	}],
	[ 'Titans', { 
		handler: checkForTitanNotifications,
		interval: 60 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
	[ 'Ladder', {
		handler: checkLadderReset,
		interval: 60 * 1000,
		activeOnStart: true,
		timerID: null,
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
		timerID: null,
	}],
	[ 'Relics', {
		handler: checkRelics,
		interval: 60 * 1000,
		activeOnStart: true,  
		timerID: null
	}],
	[ 'GuildConflicts', {
		handler: checkGuildConflicts,
		interval: 6 * 60 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
	[ 'Groups', {
		handler: autoJoinAllGroups, 
		interval: 60 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
	[ 'AutoGearSwap', {
		handler: checkAndSwapGear,
		interval: 60 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
    [ 'GuildMessages', {
		handler: checkGuildMessages, 
		interval: 5 * 60 * 1000,
		activeOnStart: true,
		timerID: null,
	}],
]);

/**
 * Safely runs a task's handler function.
 * @param {object} task - The task object from the tasks Map.
 */
function runTask(task) {
    LOG('Engine', `Executing task: ${task.name}...`);
    try {
        (async () => {
            await task.handler();
        })();
    } catch (e) {
        ERR(task.name, 'execution failed', e);
    }
}

// --- PUBLIC CONTROL FUNCTIONS ---

/**
 * Starts a specific task by its name.
 * @param {string} taskName - The name of the task to start.
 */
export function startTask(taskName) {
    const task = tasks.get(taskName);
    if (!task) {
        WARN('Engine', `Attempted to start an unknown task: ${taskName}`);
        return;
    }
    if (task.timerId) {
        LOG('Engine', `Task "${taskName}" is already running.`);
        return;
    }

    // Run once immediately (kickoff)
    runTask({ name: taskName, handler: task.handler });

    // Schedule the interval
    task.timerId = setInterval(() => runTask({ name: taskName, handler: task.handler }), task.interval);
    LOG('Engine', `Task "${taskName}" has been started and scheduled.`);
}

/**
 * Stops a specific task by its name.
 * @param {string} taskName - The name of the task to stop.
 */
export function stopTask(taskName) {
    const task = tasks.get(taskName);
    if (!task) {
        WARN('Engine', `Attempted to stop an unknown task: ${taskName}`);
        return;
    }
    if (!task.timerId) {
        LOG('Engine', `Task "${taskName}" is not currently running.`);
        return;
    }

    clearInterval(task.timerId);
    task.timerId = null;
    LOG('Engine', `Task "${taskName}" has been stopped.`);
}

/**
 * Initializes the engine, starting all tasks configured to be active on startup.
 */
export function initEngine() {
    console.log('[SWS_Engine] Initializing task engine...');

    tasks.forEach((task, taskName) => {
        if (task.activeOnStart) {
            startTask(taskName);
        }
    });

    console.log(`[SWS_Engine] Engine initialized. Active tasks are now running.`);
}

/**
 * Returns the current status of all tasks.
 * Useful for the GUI to know which tasks are currently on or off.
 * @returns {Array<object>} A list of tasks and their status.
 */
export function getTasksStatus() {
    const status = [];
    tasks.forEach((task, name) => {
        status.push({
            name: name,
            isActive: !!task.timerId,
            interval: task.interval
        });
    });
    return status;
}
