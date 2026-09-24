// tests/data-storage/state-persistence.test.mjs - DATA-TASK-001 / AC-DATA-003, AC-DATA-004
// Runs on the in-process MySQL fake (or a real MySQL with GG_TEST_MYSQL_URL); see tests/helpers/test-database.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../../_gg_data/handler/gg_database.js');
after(() => db.closeDatabase());

test('AC-DATA-003: setObject stores a scalar without wrapping it in an array', async () => {
    await db.setObject('current_gear_state', 'peace');
    assert.equal(await db.getContent('current_gear_state'), '"peace"');
    await db.setObject('current_gear_state', 'war');
    assert.equal(JSON.parse(await db.getContent('current_gear_state')), 'war');
});

test('AC-DATA-003: setObject replaces a structured state map as-is', async () => {
    const state = { 12: { status: 'active', timestamp: 1 } };
    await db.setObject('active_guild_conflicts', state);
    await db.setObject('active_guild_conflicts', { 34: { status: 'active', timestamp: 2 } });
    assert.deepEqual(JSON.parse(await db.getContent('active_guild_conflicts')), { 34: { status: 'active', timestamp: 2 } });
});

test('AC-DATA-003: setObject with undefined does not crash and removes the entry', async () => {
    await db.setObject('gvg_cooldowns', { 1: 2 });
    await assert.doesNotReject(() => db.setObject('gvg_cooldowns', undefined));
    assert.equal(await db.getContent('gvg_cooldowns'), null);
});

test('AC-DATA-003: setObject(null) persists JSON null', async () => {
    await db.setObject('nullable', null);
    assert.equal(await db.getContent('nullable'), 'null');
});

test('AC-DATA-004: deleteContent removes an existing key and reports one row', async () => {
    await db.setObject('to_delete', [1, 2]);
    assert.equal(await db.deleteContent('to_delete'), 1);
    assert.equal(await db.getContent('to_delete'), null);
});

test('AC-DATA-004: deleteContent on a missing key resolves 0 without error', async () => {
    assert.equal(await db.deleteContent('never_existed'), 0);
});

test('getObject unwraps legacy double-stringified and list-wrapped states', async () => {
    await db.setObject('double', JSON.stringify({ a: 1 }));        // backup wrote setObject(key, JSON.stringify(obj))
    assert.deepEqual(await db.getObject('double', {}), { a: 1 });
    await db.setContent('listed', JSON.stringify({ a: 1 }));
    await db.setContent('listed', JSON.stringify({ a: 2 }));       // root wrote setContent(key, JSON.stringify(obj))
    assert.deepEqual(await db.getObject('listed', {}), { a: 2 });
    await db.setContent('gear', 'war');
    assert.equal(await db.getObject('gear', ''), 'war');
});

test('getObject returns the default for missing, corrupt, or wrongly shaped values', async () => {
    assert.deepEqual(await db.getObject('missing', {}), {});
    await db.setObject('wrong_shape', [1, 2]);
    assert.deepEqual(await db.getObject('wrong_shape', {}), {});
    await db.setObject('number', 5);
    assert.equal(await db.getObject('number', ''), '');
});

test('setContent still appends FIFO-capped lists alongside setObject', async () => {
    for (const id of ['a', 'b', 'c']) await db.setContent('processed_ids', id, 2);
    assert.deepEqual(JSON.parse(await db.getContent('processed_ids')), ['b', 'c']);
});
