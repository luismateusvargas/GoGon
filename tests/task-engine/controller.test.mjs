// tests/task-engine/controller.test.mjs - CTRL-TASK-003 / AC-CTRL-003, AC-CTRL-004 (engine side)
// Registry-backed runtime control: persisted preferences, serialized transitions, pause/resume,
// and per-run results. All monitor modules and utils.js are fakes; timers are mocked.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const runs = [];                 // { task, resolve, reject, signal }
const exportsByFile = {
    'SuperElite.js': ['checkSuperElites', 'SuperElites'], 'BountyBoard.js': ['checkBounties', 'BountyBoard'],
    'Crates.js': ['checkForCratesFound', 'Crates'], 'Titans.js': ['checkForTitanNotifications', 'Titans'],
    'Ladder.js': ['checkLadderReset', 'Ladder'], 'Shoutbox.js': ['checkForShoutbox', 'Shoutbox'],
    'GameUpdates.js': ['checkForUpdatesArchive', 'GameUpdates'], 'Relics.js': ['checkRelics', 'Relics'],
    'GuildConflicts.js': ['checkGuildConflicts', 'GuildConflicts'], 'GuildMessages.js': ['checkGuildMessages', 'GuildMessages'],
};
const pendingRun = task => ({ signal } = {}) => new Promise((resolve, reject) => runs.push({ task, resolve, reject, signal }));
for (const [file, [fn, task]] of Object.entries(exportsByFile)) {
    mock.module(new URL(`../../app_modules/${file}`, import.meta.url).href, { namedExports: { [fn]: pendingRun(task) } });
}
mock.module(new URL('../../app_modules/QoL.js', import.meta.url).href, {
    namedExports: { autoJoinAllGroups: pendingRun('Groups'), checkAndSwapGear: pendingRun('AutoGearSwap') },
});
mock.module(new URL('../../utils.js', import.meta.url).href, { namedExports: { flushAllBatches: () => {} } });

const engine = await import('../../engine.js');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const status = id => engine.getTasksStatus().find(s => s.name === id);
const quiet = t => { for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, () => {}); };

beforeEach(async () => {
    for (const id of engine.listModuleIds()) engine.stopTask(id);
    for (const r of runs.splice(0)) r.resolve();
    await flush();
    await engine.resumeAll([]);
});

test('CTRL-TASK-003: stable module identifiers, in registry order', () => {
    assert.deepEqual(engine.listModuleIds(), ['SuperElites', 'BountyBoard', 'Crates', 'Titans', 'Ladder', 'Shoutbox', 'GameUpdates', 'Relics', 'GuildConflicts', 'Groups', 'AutoGearSwap', 'GuildMessages']);
});

test('CTRL-TASK-003: persisted preferences override enablement and interval at boot; invalid ones are ignored', (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    engine.initEngine({ preferences: new Map([
        ['Crates', { enabled: false, intervalMs: 120_000 }],
        ['Titans', { enabled: true, intervalMs: 10 }],                 // below bounds: interval ignored
        ['Unknown', { enabled: true, intervalMs: 60_000 }],
    ]) });
    assert.deepEqual([status('Crates').enabled, status('Crates').interval], [false, 120_000]);
    assert.deepEqual([status('Titans').enabled, status('Titans').interval], [true, 60_000]);
    engine.shutdownEngine();
});

test('CTRL-TASK-003: setModuleEnabled starts/stops a module; setModuleInterval applies to the next schedule', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await engine.setModuleEnabled('Relics', true);
    await flush();
    assert.equal(status('Relics').isActive, true);
    await engine.setModuleInterval('Relics', 90_000);
    runs.find(r => r.task === 'Relics').resolve();
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(runs.filter(r => r.task === 'Relics').length, 1, 'old 60 s interval no longer applies');
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(runs.filter(r => r.task === 'Relics').length, 2, 'new 90 s interval applied');
    await engine.setModuleEnabled('Relics', false);
    assert.deepEqual([status('Relics').enabled, status('Relics').isActive], [false, false]);
    await assert.rejects(engine.setModuleInterval('Relics', 1000), { code: 'BAD_INTERVAL' });
    await assert.rejects(engine.setModuleEnabled('Nope', true), { code: 'UNKNOWN_MODULE' });
});

test('CTRL-TASK-003: each run records its latest result without URLs', async (t) => {
    quiet(t);
    engine.startTask('Ladder');
    await flush();
    runs.find(r => r.task === 'Ladder').reject(new Error('GET https://www.fallensword.com/api?x=1 failed'));
    await flush();
    const last = status('Ladder').lastRun;
    assert.equal(last.outcome, 'error');
    assert.equal(last.error, 'GET [url] failed');
    engine.stopTask('Ladder');
});

test('AC-CTRL-004 engine side: pauseAll stops everything, waits for in-flight runs, and blocks starts until resumeAll', async (t) => {
    quiet(t);
    const events = [];
    engine.engineEvents.on('engine', e => events.push(e.paused));
    engine.startTask('Shoutbox');
    engine.startTask('Crates');
    await engine.setModuleEnabled('Shoutbox', true);
    await engine.setModuleEnabled('Crates', true);
    await flush();
    const inflight = runs.find(r => r.task === 'Shoutbox');

    let pausedList;
    const pausing = engine.pauseAll({ timeoutMs: 5_000 }).then(l => { pausedList = l; });
    await flush();
    assert.equal(pausedList, undefined, 'pause waits for the in-flight run');
    assert.equal(inflight.signal.aborted, true, 'the in-flight run was told to stop');
    runs.filter(r => r.task === 'Shoutbox' || r.task === 'Crates').forEach(r => r.resolve());
    await pausing;
    assert.ok(pausedList.includes('Shoutbox') && pausedList.includes('Crates'));
    assert.equal(engine.isPaused(), true);
    assert.deepEqual(engine.getTasksStatus().filter(s => s.isActive), []);
    assert.equal(engine.startTask('Shoutbox'), false, 'no start while paused');
    await engine.setModuleEnabled('Titans', true);
    assert.equal(status('Titans').isActive, false, 'enabling while paused only records the preference');

    const started = await engine.resumeAll(['Shoutbox', 'Crates']);
    assert.deepEqual(started, ['Shoutbox', 'Crates']);
    assert.equal(engine.isPaused(), false);
    assert.deepEqual(events.slice(-2), [true, false]);
    for (const id of ['Shoutbox', 'Crates', 'Titans']) await engine.setModuleEnabled(id, false);
});

test('CTRL-TASK-003: lifecycle transitions are serialized in request order', async (t) => {
    quiet(t);
    const order = [];
    await Promise.all([
        engine.setModuleEnabled('GameUpdates', true).then(() => order.push('enable')),
        engine.setModuleInterval('GameUpdates', 120_000).then(() => order.push('interval')),
        engine.setModuleEnabled('GameUpdates', false).then(() => order.push('disable')),
    ]);
    assert.deepEqual(order, ['enable', 'interval', 'disable']);
    assert.deepEqual([status('GameUpdates').enabled, status('GameUpdates').interval], [false, 120_000]);
});
