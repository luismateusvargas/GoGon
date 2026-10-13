// tests/task-engine/scheduling.test.mjs - ENG-TASK-002 / AC-ENG-001..AC-ENG-005
// Every monitor module and utils.js are replaced with fakes and timers are mocked, so no game,
// database, or Discord request ever runs.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];            // { task, at } for every handler invocation
const behaviour = {};        // task name -> (ctx) => Promise|value
let clock = 0;               // mocked "now", advanced by tick()
let flushCount = 0;

function fakeHandler(task) {
    return (ctx) => {
        calls.push({ task, at: clock });
        return (behaviour[task] ?? (() => undefined))(ctx);
    };
}

const moduleExports = {
    'SuperElite.js': { checkSuperElites: 'SuperElites' },
    'BountyBoard.js': { checkBounties: 'BountyBoard' },
    'Crates.js': { checkForCratesFound: 'Crates' },
    'Titans.js': { checkForTitanNotifications: 'Titans' },
    'Ladder.js': { checkLadderReset: 'Ladder' },
    'Shoutbox.js': { checkForShoutbox: 'Shoutbox' },
    'GameUpdates.js': { checkForUpdatesArchive: 'GameUpdates' },
    'Relics.js': { checkRelics: 'Relics' },
    'GuildConflicts.js': { checkGuildConflicts: 'GuildConflicts' },
    'QoL.js': { autoJoinAllGroups: 'Groups', checkAndSwapGear: 'AutoGearSwap' },
    'GuildMessages.js': { checkGuildMessages: 'GuildMessages' },
};
for (const [file, exports] of Object.entries(moduleExports)) {
    mock.module(new URL(`../../app_modules/${file}`, import.meta.url).href, {
        namedExports: Object.fromEntries(Object.entries(exports).map(([fn, task]) => [fn, fakeHandler(task)])),
    });
}
mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: { flushAllBatches: () => { flushCount++; } },
});

for (const k of ['GG_BOT_ID_CHARACTER', 'GG_PEACE_GEAR_IDS', 'GG_WAR_GEAR_IDS']) delete process.env[k];
const engine = await import('../../engine.js');
const ALL_TASKS = engine.getTasksStatus().map(s => s.name);

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
async function tick(t, ms) {
    clock += ms;
    t.mock.timers.tick(ms);
    await flush();
}
function quiet(t) {
    const lines = [];
    for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, (...a) => lines.push(`${k}: ${a.map(String).join(' ')}`));
    return lines;
}
const status = name => engine.getTasksStatus().find(s => s.name === name);

beforeEach(() => {
    for (const name of ALL_TASKS) engine.stopTask(name);
    calls.length = 0;
    for (const k of Object.keys(behaviour)) delete behaviour[k];
    clock = 0;
});

// --- AC-ENG-001 --------------------------------------------------------------------------------------

test('AC-ENG-001: every registered task has an interval (constraint)', () => {
    assert.equal(ALL_TASKS.length, 13);   // 12 monitors + CatalogSync (CAT-TASK-004, disabled by default)
    for (const s of engine.getTasksStatus()) assert.ok(Number.isInteger(s.interval) && s.interval > 0, s.name);
});

test('AC-ENG-001: initEngine starts tasks one by one, exactly 2000 ms apart; unconfigured AutoGearSwap is skipped', async (t) => {
    const lines = quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    engine.initEngine();
    await tick(t, 0);
    for (let i = 0; i < 24; i++) await tick(t, 1000);   // half-steps expose any early start

    const firstRuns = [];
    for (const c of calls) if (!firstRuns.some(f => f.task === c.task)) firstRuns.push(c);
    const started = firstRuns.map(f => f.task);
    assert.equal(started.includes('AutoGearSwap'), false);
    assert.equal(started.length, 11);
    firstRuns.forEach((f, i) => assert.equal(f.at, i * 2000, `${f.task} start time`));
    assert.equal(status('AutoGearSwap').isActive, false);
    assert.ok(lines.some(l => l.startsWith('warn') && l.includes('AutoGearSwap disabled')));
    engine.shutdownEngine();
});

// --- AC-ENG-002 --------------------------------------------------------------------------------------

test('AC-ENG-002: a run slower than its interval never overlaps; the next run waits for completion', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = [];
    let concurrent = 0, maxConcurrent = 0;
    behaviour.BountyBoard = () => new Promise(resolve => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        pending.push(() => { concurrent--; resolve(); });
    });
    const interval = status('BountyBoard').interval;

    engine.startTask('BountyBoard');
    await flush();
    await tick(t, interval * 5);                        // run 1 takes 5 intervals
    assert.equal(calls.filter(c => c.task === 'BountyBoard').length, 1);

    pending.shift()();                                  // run 1 finishes
    await flush();
    await tick(t, interval - 1);
    assert.equal(calls.filter(c => c.task === 'BountyBoard').length, 1, 'next run waits a full interval after completion');
    await tick(t, 1);
    assert.equal(calls.filter(c => c.task === 'BountyBoard').length, 2);
    assert.equal(maxConcurrent, 1);
    pending.shift()();
    engine.stopTask('BountyBoard');
});

test('AC-ENG-002: a throwing handler is logged with ERR and still rescheduled', async (t) => {
    const lines = quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    behaviour.Crates = () => { throw new Error('fixture failure'); };
    const interval = status('Crates').interval;

    engine.startTask('Crates');
    await flush();
    assert.ok(lines.some(l => l.startsWith('error') && l.includes('[Crates] execution failed')));
    await tick(t, interval);
    await tick(t, interval);
    assert.equal(calls.filter(c => c.task === 'Crates').length, 3);
    engine.stopTask('Crates');
});

// --- AC-ENG-003 --------------------------------------------------------------------------------------

test('AC-ENG-003: startTask runs immediately; stopTask clears the timer and no run follows', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const interval = status('Titans').interval;

    assert.equal(engine.startTask('Titans'), true);
    await flush();
    assert.equal(calls.filter(c => c.task === 'Titans').length, 1, 'first run is immediate');
    assert.equal(status('Titans').isActive, true);

    assert.equal(engine.stopTask('Titans'), true);
    assert.equal(status('Titans').isActive, false);
    await tick(t, interval * 3);
    assert.equal(calls.filter(c => c.task === 'Titans').length, 1);
});

test('AC-ENG-003: unknown task names log "not found in registry" and return false', (t) => {
    const lines = quiet(t);
    assert.equal(engine.startTask('NoSuchTask'), false);
    assert.equal(engine.stopTask('NoSuchTask'), false);
    assert.equal(lines.filter(l => l.startsWith('error') && l.includes('"NoSuchTask" not found in registry')).length, 2);
});

// --- AC-ENG-004 --------------------------------------------------------------------------------------

async function withEnv(t, env, fn) {
    const keys = ['GG_EMAIL', 'SWS_EMAIL', 'FS_EMAIL', 'GG_PASSWORD', 'SWS_PASSWORD', 'FS_PASSWORD',
        'GG_BOT_CHARACTER', 'SWS_BOT_CHARACTER', 'FS_BOT_CHARACTER', 'GG_BOT_ID_CHARACTER', 'SWS_BOT_ID_CHARACTER', 'FS_BOT_ID_CHARACTER',
        'GG_DISCORD_TOKEN', 'DISCORD_TOKEN', 'GG_DISCORD_APP_ID', 'DISCORD_APP_ID', 'GG_DISCORD_GUILD_ID', 'DISCORD_GUILD_ID'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    return fn();
}

test('AC-ENG-004: missing GG_EMAIL/GG_PASSWORD prints remediation and exits with code 1', async (t) => {
    const lines = quiet(t);
    const exit = t.mock.method(process, 'exit', () => {});
    const { validateAndExit } = await import('../../configValidator.mjs');
    await withEnv(t, { GG_BOT_CHARACTER: 'Bot', GG_BOT_ID_CHARACTER: '1' }, () => validateAndExit());
    assert.deepEqual(exit.mock.calls.map(c => c.arguments[0]), [1]);
    const out = lines.join('\n');
    assert.match(out, /GG_EMAIL/);
    assert.match(out, /GG_PASSWORD/);
});

test('AC-ENG-004: optional/important gaps only warn and boot continues', async (t) => {
    const lines = quiet(t);
    const exit = t.mock.method(process, 'exit', () => {});
    const { validateAndExit } = await import('../../configValidator.mjs');
    const ok = await withEnv(t, { GG_EMAIL: 'a@example.test', GG_PASSWORD: 'fixture', GG_BOT_CHARACTER: 'Bot', GG_BOT_ID_CHARACTER: '1' }, () => validateAndExit());
    assert.equal(ok, true);
    assert.equal(exit.mock.callCount(), 0);
    assert.match(lines.join('\n'), /GG_DISCORD_TOKEN/);
});

// --- AC-ENG-005 --------------------------------------------------------------------------------------

test('AC-ENG-005: shutdown stops every active task and flushes Discord batches', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    engine.startTask('Ladder');
    engine.startTask('Relics');
    await flush();
    const before = flushCount;
    engine.shutdownEngine();
    assert.equal(flushCount, before + 1);
    assert.deepEqual(engine.getTasksStatus().filter(s => s.isActive), []);
    await tick(t, 10 * 60_000);
    assert.equal(calls.length, 2, 'no run after shutdown');
});

// --- specs/tasks/2026-10-notification-progress-health.md AC-3 ----------------------------------------

test('progress-health AC-3: an enabled module whose next run is late beyond the grace is overdue; disabled, paused and running are not', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { overdueBy, overdueGrace, TASK_OVERDUE_MIN_GRACE } = await import('../../app_modules/taskHealth.js');
    engine.startTask('Ladder');
    await flush();
    const s0 = status('Ladder');
    const grace = overdueGrace(s0.interval);
    assert.equal(grace, Math.max(s0.interval, TASK_OVERDUE_MIN_GRACE));
    assert.equal(s0.nextRunAt, 1_000_000 + s0.interval, 'the next run is scheduled one interval after the first run');
    assert.equal(s0.overdue, false);
    assert.equal(s0.overdueMs, 0);

    // The scheduled run should have started at nextRunAt; it is overdue only after the grace too.
    const late = s0.nextRunAt + grace;
    assert.equal(overdueBy(s0, { now: late }), 0, 'within the grace');
    assert.equal(overdueBy(s0, { now: late + 1 }), 1, 'one interval plus the grace has passed with no new run');
    assert.equal(overdueBy(s0, { now: late + 1, paused: true }), 0, 'paused engine (account switch)');
    assert.equal(overdueBy({ ...s0, enabled: false }, { now: late + 1 }), 0, 'disabled');
    assert.equal(overdueBy({ ...s0, isRunning: true }, { now: late + 1 }), 0, 'run in flight');
    assert.equal(overdueBy({ ...s0, lastRun: null }, { now: late + 1 }), 0, 'first run not finished yet');
    assert.equal(overdueBy({ ...s0, nextRunAt: null }, { now: s0.lastRun.startedAt + s0.lastRun.durationMs + s0.interval + grace + 1 }), 1,
        'without nextRunAt the end of the last run plus the interval is used');

    // When the run fires on time the module is not overdue.
    await tick(t, s0.interval);
    assert.equal(status('Ladder').overdue, false);
    assert.equal(status('Ladder').nextRunAt, 1_000_000 + 2 * s0.interval);

    engine.stopTask('Ladder');
    assert.equal(status('Ladder').overdue, false, 'stopped');
    assert.equal(status('Ladder').nextRunAt, null);
});

test('progress-health AC-3: a long run in flight is not overdue; the module is overdue only once it stops progressing after it', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
    let finish;
    behaviour.Relics = () => new Promise(r => { finish = r; });
    engine.startTask('Relics');
    await flush();
    const interval = status('Relics').interval;
    t.mock.timers.tick(10 * interval);
    await flush();
    assert.equal(status('Relics').isRunning, true);
    assert.equal(status('Relics').overdue, false, 'running');
    finish();
    await flush();
    assert.equal(status('Relics').overdue, false, 'the next run was just scheduled');
});
