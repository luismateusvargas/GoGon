// tests/game-monitors/state-persistence.test.mjs - MON-TASK-002 / AC-MON-003, AC-MON-005
// Network helpers in utils.js are mocked with fixtures; a throwaway SQLite file holds state.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GG_BOT_ID_CHARACTER = '123';
process.env.GG_PEACE_GEAR_IDS = '1,2';
process.env.GG_WAR_GEAR_IDS = '3,4';

const TEN_DAYS_MS = 864_000_000;
const calls = { equip: [], sent: [], edited: [] };
const fixtures = { conflicts: [], equipped: [1, 2], equipStatus: 200 };
const json = body => ({ ok: true, status: 200, json: async () => body });

mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        secureFetch: async (url) => {
            if (url.includes('subcmd=conflicts')) return json({ s: true, r: { conflicts: fixtures.conflicts } });
            if (url.includes('subcmd=equipitem')) {
                calls.equip.push(url);
                return { ok: fixtures.equipStatus === 200, status: fixtures.equipStatus };
            }
            return json({ s: true, r: { equipped_items: fixtures.equipped.map(a => ({ a })) } });
        },
        sendAndGetMessageId: async (_hook, payload) => { calls.sent.push(payload); return 'msg-1'; },
        editDiscordMessage: async (_hook, id, payload) => { calls.edited.push({ id, payload }); },
    },
});

const db = await import('../../_gg_data/handler/gg_database.js');
const { COOLDOWNS } = await import('../../app_modules/constants.js');
const { checkGuildConflicts } = await import('../../app_modules/GuildConflicts.js');
const { checkAndSwapGear } = await import('../../app_modules/QoL.js');

after(() => db.closeDatabase());

const conflict = (over = {}) => ({
    id: 77, guild: { name: 'Rivals' }, members: [{ name: 'A' }], max_members: 5,
    incoming: 3, outgoing: 3, max_attacks: 3, expires: 3600, score_a: 0, score_b: 0, ...over,
});

beforeEach(async () => {
    for (const key of ['active_guild_conflicts', 'gvg_cooldowns', 'current_gear_state']) await db.deleteContent(key);
    calls.equip.length = calls.sent.length = calls.edited.length = 0;
    fixtures.conflicts = [];
    fixtures.equipped = [1, 2];
    fixtures.equipStatus = 200;
});

test('owner-locked GvG cooldown is exactly 10 days', () => {
    assert.equal(COOLDOWNS.GVG, TEN_DAYS_MS);
});

test('AC-MON-005: new conflict state is stored with setObject as a plain object', async () => {
    fixtures.conflicts = [conflict()];
    await checkGuildConflicts();
    const stored = JSON.parse(await db.getContent('active_guild_conflicts'));
    assert.ok(!Array.isArray(stored), 'state must not be wrapped in a list');
    assert.equal(stored['77'].messageId, 'msg-1');
    assert.equal(stored['77'].guildName, 'Rivals');
});

test('AC-MON-005: an ended conflict starts a 10-day cooldown and clears the active entry', async () => {
    fixtures.conflicts = [conflict()];
    await checkGuildConflicts();
    fixtures.conflicts = [];
    const before = Date.now();
    await checkGuildConflicts();
    const after = Date.now();

    assert.deepEqual(JSON.parse(await db.getContent('active_guild_conflicts')), {});
    const cooldowns = JSON.parse(await db.getContent('gvg_cooldowns'));
    assert.equal(cooldowns['77'].guildName, 'Rivals');
    assert.ok(cooldowns['77'].expires >= before + TEN_DAYS_MS && cooldowns['77'].expires <= after + TEN_DAYS_MS);
    assert.equal(calls.edited.at(-1).payload.content, null, 'the final edit clears any earlier ping');
});

test('AC-MON-005: legacy list-wrapped state written by setContent is recovered, not re-announced', async () => {
    const legacy = { 77: { messageId: 'old-msg', stateKey: '0-0|3-3', guildName: 'Rivals', lastIncoming: 3 } };
    await db.setContent('active_guild_conflicts', JSON.stringify({}));
    await db.setContent('active_guild_conflicts', JSON.stringify(legacy));
    fixtures.conflicts = [conflict()];
    await checkGuildConflicts();
    assert.equal(calls.sent.length, 0, 'a known conflict must not be announced again');
    // unchanged conflict: nothing saved yet, so the legacy row is still readable
    assert.deepEqual(await db.getObject('active_guild_conflicts', {}), legacy);
});

test('AC-MON-005: an incomplete ended entry is cleaned up without a cooldown', async () => {
    await db.setObject('active_guild_conflicts', { 90: { stateKey: 'x' } });
    await checkGuildConflicts();
    assert.deepEqual(JSON.parse(await db.getContent('active_guild_conflicts')), {});
    assert.deepEqual(await db.getObject('gvg_cooldowns', {}), {});
    assert.equal(calls.edited.length, 0);
});

test('AC-MON-003: gear state is stored as a scalar string after a successful swap', async () => {
    fixtures.conflicts = [conflict()];
    await checkAndSwapGear();
    assert.equal(calls.equip.length, 2);
    assert.equal(await db.getContent('current_gear_state'), '"war"');
    assert.equal(await db.getObject('current_gear_state', ''), 'war');
});

test('AC-MON-003: a stored state equal to the desired state skips the equipment check', async () => {
    await db.setObject('current_gear_state', 'peace');
    fixtures.equipped = [9];
    await checkAndSwapGear();
    assert.equal(calls.equip.length, 0);
});

test('AC-MON-003: a failed equip leaves current_gear_state unchanged for retry', async () => {
    await db.setObject('current_gear_state', 'peace');
    fixtures.conflicts = [conflict()];
    fixtures.equipStatus = 500;
    await checkAndSwapGear();
    assert.equal(calls.equip.length, 2);
    assert.equal(await db.getObject('current_gear_state', ''), 'peace');
});

test('AC-MON-003: gear already matching the target only records the state', async () => {
    fixtures.equipped = [1, 2];
    await db.setContent('current_gear_state', 'war'); // legacy list-wrapped value
    await checkAndSwapGear();
    assert.equal(calls.equip.length, 0);
    assert.equal(await db.getContent('current_gear_state'), '"peace"');
});
