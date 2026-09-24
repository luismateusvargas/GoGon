// tests/task-engine/shutdown.test.mjs - ENG-TASK-001 / AC-ENG-005
// Timers are mocked, so no task handler (and no game or Discord request) ever runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const engine = await import('../../engine.js');

test('engine.js is pure ESM: no require() and flushAllBatches is imported', () => {
    const source = readFileSync(new URL('../../engine.js', import.meta.url), 'utf8');
    assert.ok(!/\brequire\s*\(/.test(source), 'engine.js must not call require()');
    assert.match(source, /import\s*\{[^}]*\bflushAllBatches\b[^}]*\}\s*from\s*'\.\/utils\.js'/);
});

test('AC-ENG-005: shutdown cancels staggered starts that have not fired yet', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    engine.initEngine();
    engine.shutdownEngine();
    t.mock.timers.tick(60_000);
    assert.deepEqual(engine.getTasksStatus().filter(s => s.isActive), []);
});

test('AC-ENG-005: a signal exits with code 0 after the 5 s drain window, once', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const exits = [];
    const exit = code => exits.push(code);

    assert.equal(engine.handleShutdownSignal('SIGTERM', { exit }), true);
    t.mock.timers.tick(4_999);
    assert.deepEqual(exits, [], 'must not exit before the drain window ends');
    t.mock.timers.tick(1);
    assert.deepEqual(exits, [0]);

    assert.equal(engine.handleShutdownSignal('SIGINT', { exit }), false, 'a repeated signal is ignored');
    t.mock.timers.tick(10_000);
    assert.deepEqual(exits, [0]);
});
