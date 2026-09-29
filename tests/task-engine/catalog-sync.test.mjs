// tests/task-engine/catalog-sync.test.mjs - CAT-TASK-004 / AC-CAT-001, AC-CAT-002, AC-CAT-008
// CatalogSync as an engine task: disabled by default, enabled by a persisted preference, serial,
// guarded against overlap with a foreground catalog command, and stopped by pauseAll (account
// switch). Monitor modules and utils.js are fakes; the catalog store and collector are injected.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const exportsByFile = {
    'SuperElite.js': ['checkSuperElites'], 'BountyBoard.js': ['checkBounties'], 'Crates.js': ['checkForCratesFound'],
    'Titans.js': ['checkForTitanNotifications'], 'Ladder.js': ['checkLadderReset'], 'Shoutbox.js': ['checkForShoutbox'],
    'GameUpdates.js': ['checkForUpdatesArchive'], 'Relics.js': ['checkRelics'], 'GuildConflicts.js': ['checkGuildConflicts'],
    'GuildMessages.js': ['checkGuildMessages'], 'QoL.js': ['autoJoinAllGroups', 'checkAndSwapGear'],
};
for (const [file, fns] of Object.entries(exportsByFile)) {
    mock.module(new URL(`../../app_modules/${file}`, import.meta.url).href, { namedExports: Object.fromEntries(fns.map(f => [f, async () => {}])) });
}
mock.module(new URL('../../utils.js', import.meta.url).href, { namedExports: { flushAllBatches: () => {} } });

const engine = await import('../../engine.js');
const { runCatalogSync, configureCatalogTask, withCatalogLock, isCatalogBusy } = await import('../../catalog/catalogTask.js');
const status = id => engine.getTasksStatus().find(s => s.name === id);
const quiet = t => { for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, () => {}); };

/** In-memory store/collector doubles that record what the task asked for. */
function fakeService(jobs) {
    const executed = [];
    const store = {
        listJobs: async () => jobs.map(j => ({ ...j })),
        async transitionJob(id, to) { jobs.find(j => j.id === id).state = to; },
    };
    const collector = {
        async runJob(job, { signal } = {}) {
            executed.push(job.id);
            if (job.onRun) await job.onRun(signal);
            return { outcome: 'ok', requests: 1 };
        },
    };
    return { store, collector, executed };
}

beforeEach(async () => {
    for (const id of engine.listModuleIds()) engine.stopTask(id);
    await engine.resumeAll([]);
});

test('CAT-TASK-004 / AC-CAT-002: CatalogSync is registered but disabled by default and not started at boot', (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.ok(engine.listModuleIds().includes('CatalogSync'));
    engine.initEngine();
    t.mock.timers.tick(60_000);
    assert.deepEqual([status('CatalogSync').enabled, status('CatalogSync').isActive], [false, false]);
    assert.equal(status('CatalogSync').interval, 60_000);
    engine.shutdownEngine();
});

test('CAT-TASK-004: a persisted preference enables it and sets its interval, like any module', (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const svc = fakeService([]);
    configureCatalogTask(svc);
    engine.initEngine({ preferences: new Map([['CatalogSync', { enabled: true, intervalMs: 300_000 }]]) });
    assert.deepEqual([status('CatalogSync').enabled, status('CatalogSync').interval], [true, 300_000]);
    engine.shutdownEngine();
    engine.initEngine({ preferences: new Map([['CatalogSync', { enabled: false, intervalMs: 300_000 }]]) });
    engine.shutdownEngine();
});

test('AC-CAT-002: a run executes queued game jobs one at a time; guide and paused jobs are left alone', async () => {
    const svc = fakeService([
        { id: 'a', kind: 'observe_realm', state: 'queued' },
        { id: 'b', kind: 'guide_discovery', state: 'queued' },
        { id: 'c', kind: 'item_frontier', state: 'paused' },
        { id: 'd', kind: 'item_frontier', state: 'queued' },
    ]);
    configureCatalogTask(svc);
    const r = await runCatalogSync({});
    assert.deepEqual(svc.executed, ['a', 'd']);
    assert.deepEqual(r.ran.map(x => x.jobId), ['a', 'd']);
});

test('CatalogSync runs the configured server guide worker under the catalog lock', async () => {
    const service = fakeService([{ id: 'guide', kind: 'guide_discovery', state: 'queued' }]);
    service.guideWorker = {
        async run() {
            assert.equal(isCatalogBusy(), true);
            return { status: 'sent', kind: 'item', requests: 1, results: 1 };
        },
    };
    configureCatalogTask(service);
    const result = await runCatalogSync({});
    assert.deepEqual(result.ran, []);
    assert.deepEqual(result.guide, { status: 'sent', kind: 'item', requests: 1, results: 1 });
});

test('CAT-TASK-004: jobs a crash left running are handed back once, then run', async () => {
    const jobs = [{ id: 'x', kind: 'observe_realm', state: 'running' }];
    const svc = fakeService(jobs);
    configureCatalogTask(svc);
    await runCatalogSync({});
    assert.deepEqual(svc.executed, ['x']);
    assert.equal(jobs[0].state, 'queued');
});

test('AC-CAT-008: a scheduled run and a foreground catalog command never overlap', async () => {
    const svc = fakeService([{ id: 'a', kind: 'observe_realm', state: 'queued' }]);
    configureCatalogTask(svc);
    let release;
    const foreground = withCatalogLock(() => new Promise(r => { release = r; }));
    assert.equal(isCatalogBusy(), true);
    assert.deepEqual(await runCatalogSync({}), { skipped: 'busy' });
    assert.equal(await withCatalogLock(async () => 'second'), null, 'a second foreground command is refused too');
    release('done');
    assert.deepEqual(await foreground, { value: 'done' });
    assert.equal(isCatalogBusy(), false);
    assert.equal((await runCatalogSync({})).ran.length, 1);
});

test('AC-CAT-001: pauseAll (account switch) aborts the run in flight and no further job starts', async (t) => {
    quiet(t);
    let sawAbort = false;
    const jobs = [
        { id: 'a', kind: 'observe_realm', state: 'queued', onRun: signal => new Promise(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true })) },
        { id: 'b', kind: 'item_frontier', state: 'queued' },
    ];
    const svc = fakeService(jobs);
    configureCatalogTask(svc);
    await engine.setModuleEnabled('CatalogSync', true);
    await new Promise(r => setImmediate(r));
    assert.equal(status('CatalogSync').isRunning, true);
    await engine.pauseAll({ timeoutMs: 1000 });
    assert.equal(sawAbort, true);
    assert.deepEqual(svc.executed, ['a'], 'job b never started after the abort');
    assert.equal(status('CatalogSync').lastRun.outcome, 'ok');
    assert.equal(engine.startTask('CatalogSync'), false, 'no start while paused');
    await engine.resumeAll([]);
    await engine.setModuleEnabled('CatalogSync', false);
});
