// tests/task-engine/lifecycle.test.mjs - ENG-TASK-003 / AC-ENG-002, AC-ENG-003
// The SuperElites handler is replaced by a controllable fake; timers are mocked, so no
// real monitor, game, or Discord request ever runs.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';


const runs = [];
mock.module(new URL('../../app_modules/SuperElite.js', import.meta.url).href, {
    namedExports: {
        checkSuperElites: ({ signal } = {}) => new Promise(resolve => runs.push({ resolve, signal })),
    },
});

const engine = await import('../../engine.js');
const INTERVAL = 15_000; // SuperElites interval in engine.js
const flush = () => new Promise(resolve => setImmediate(resolve));
const status = () => engine.getTasksStatus().find(s => s.name === 'SuperElites');

test('stop/start while a run is in flight never produces a second loop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    assert.equal(engine.startTask('SuperElites'), true);
    assert.equal(runs.length, 1);
    assert.equal(status().isRunning, true);

    // AC-ENG-002: a slow run is never overlapped by the next one
    t.mock.timers.tick(INTERVAL * 4);
    assert.equal(runs.length, 1);

    // Stopping kills the task: the in-flight run is aborted and its loop invalidated
    assert.equal(engine.stopTask('SuperElites'), true);
    assert.equal(runs[0].signal.aborted, true);

    // Starting again is refused while the old run is still finishing
    assert.equal(engine.startTask('SuperElites'), false);
    assert.equal(runs.length, 1);

    // The old run finishing must not reschedule itself
    runs[0].resolve();
    await flush();
    t.mock.timers.tick(INTERVAL * 4);
    assert.equal(runs.length, 1);
    assert.deepEqual({ active: status().isActive, running: status().isRunning }, { active: false, running: false });

    // Once nothing is running, a start is accepted and loops normally, one run at a time
    assert.equal(engine.startTask('SuperElites'), true);
    assert.equal(runs.length, 2);
    runs[1].resolve();
    await flush();
    t.mock.timers.tick(INTERVAL);
    assert.equal(runs.length, 3);
    assert.equal(runs[2].signal.aborted, false);

    assert.equal(engine.stopTask('SuperElites'), true);
    runs[2].resolve();
    await flush();
    t.mock.timers.tick(INTERVAL * 4);
    assert.equal(runs.length, 3);
});

test('AC-ENG-003: starting a running task or stopping a stopped one returns false', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(engine.startTask('SuperElites'), true);
    assert.equal(engine.startTask('SuperElites'), false);
    assert.equal(engine.stopTask('SuperElites'), true);
    assert.equal(engine.stopTask('SuperElites'), false);
    runs.at(-1).resolve();
});

test('AC-ENG-003 error case: unknown task names return false without throwing', () => {
    assert.equal(engine.startTask('NoSuchTask'), false);
    assert.equal(engine.stopTask('NoSuchTask'), false);
});
