// tests/game-monitors/conflict-ping.test.mjs - MON-TASK-005 / AC-MON-007
// Incoming attacks are the enemy guild hitting us. utils.js network helpers are mocked with
// fixtures, the clock is mocked, and a throwaway SQLite file holds state.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';


const sent = [];
const edited = [];
let conflicts = [];
mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        secureFetch: async () => ({ ok: true, status: 200, json: async () => ({ s: true, r: { conflicts } }) }),
        sendAndGetMessageId: async (_hook, payload) => { sent.push(payload); return `msg-${sent.length}`; },
        editDiscordMessage: async (_hook, id, payload) => { edited.push({ id, payload }); return true; },
    },
});

const db = await import('../../_gg_data/handler/gg_database.js');
const { CONFLICT_PING } = await import('../../app_modules/constants.js');
const { checkGuildConflicts, evaluateIncomingPing } = await import('../../app_modules/GuildConflicts.js');

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const conflict = incoming => ({
    id: 5, guild: { name: 'Raiders' }, members: [{ name: 'A' }], max_members: 5,
    incoming, outgoing: 0, max_attacks: 20, expires: 86_400, score_a: 0, score_b: incoming,
});
const pings = () => sent.filter(p => typeof p.content === 'string' && p.content.includes('INCOMING ATTACK'));

// --- The rule itself -------------------------------------------------------------------------
test('rule constants: 15-minute quiet window, enemy "stopped" after more than 3 minutes', () => {
    assert.equal(CONFLICT_PING.QUIET_WINDOW_MS, 15 * MIN);
    assert.equal(CONFLICT_PING.BURST_GAP_MS, 3 * MIN);
});

test('no increase in incoming attacks never pings', () => {
    assert.deepEqual(evaluateIncomingPing({ lastIncoming: 4 }, 4, T0), { attacked: false, ping: false });
    assert.deepEqual(evaluateIncomingPing({ lastIncoming: 4 }, 3, T0), { attacked: false, ping: false });
});

test('the first incoming attack of a conflict pings', () => {
    assert.deepEqual(evaluateIncomingPing({ lastIncoming: 0 }, 1, T0), { attacked: true, ping: true });
});

test('attacks inside the 15-minute window never ping again, even after a pause', () => {
    const state = { lastIncoming: 3, lastPingAt: T0, lastIncomingAt: T0 + 4 * MIN };
    assert.equal(evaluateIncomingPing(state, 4, T0 + 6 * MIN).ping, false);   // still hitting
    assert.equal(evaluateIncomingPing(state, 4, T0 + 14 * MIN).ping, false);  // restarted, but inside window
});

test('an uninterrupted attack run past 15 minutes does not ping again', () => {
    const state = { lastIncoming: 8, lastPingAt: T0, lastIncomingAt: T0 + 14 * MIN };
    assert.equal(evaluateIncomingPing(state, 9, T0 + 16 * MIN).ping, false);
});

test('the enemy starting again after they had stopped and 15 minutes passed pings', () => {
    const state = { lastIncoming: 8, lastPingAt: T0, lastIncomingAt: T0 + 10 * MIN };
    assert.equal(evaluateIncomingPing(state, 9, T0 + 20 * MIN).ping, true);
});

test('legacy state without lastIncoming reads the incoming count from stateKey', () => {
    assert.equal(evaluateIncomingPing({ stateKey: '1-2|6-3' }, 6, T0).attacked, false);
    assert.equal(evaluateIncomingPing({ stateKey: '1-2|6-3' }, 7, T0).attacked, true);
});

// --- End to end through checkGuildConflicts, one poll per minute --------------------------------
beforeEach(async () => {
    await db.deleteContent('active_guild_conflicts');
    await db.deleteContent('gvg_cooldowns');
    sent.length = edited.length = 0;
});

async function pollAt(t, minute, incoming) {
    t.mock.timers.setTime(T0 + minute * MIN);
    conflicts = [conflict(incoming)];
    await checkGuildConflicts();
}

test('AC-MON-007: a full attack timeline pings exactly when the owner rule says', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });

    await pollAt(t, 0, 0);                 // conflict starts, nobody has hit us
    assert.equal(pings().length, 0);

    await pollAt(t, 1, 1);                 // enemy hits: first ping
    assert.equal(pings().length, 1);
    assert.match(pings()[0].content, /^@everyone .*Raiders/);
    assert.equal(pings()[0].embeds, undefined, 'the ping is its own message, not an edit');

    for (let m = 3; m <= 13; m += 2) await pollAt(t, m, 1 + (m - 1) / 2);   // hitting every 2 min
    assert.equal(pings().length, 1, 'no ping inside the 15-minute window');

    for (let m = 15; m <= 21; m += 2) await pollAt(t, m, 1 + (m - 1) / 2);  // still hitting after 15 min
    assert.equal(pings().length, 1, 'an uninterrupted run is not pinged again');

    await pollAt(t, 22, 11);               // they stop; monitoring continues every minute
    await pollAt(t, 26, 11);
    assert.equal(pings().length, 1);

    await pollAt(t, 30, 12);               // they start again after stopping, window long over
    assert.equal(pings().length, 2);

    const stored = (await db.getObject('active_guild_conflicts', {}))['5'];
    assert.equal(stored.lastPingAt, T0 + 30 * MIN, 'ping timestamp is cached in the database');
    assert.equal(stored.lastIncomingAt, T0 + 30 * MIN);
    assert.ok(edited.every(e => e.payload.content === null), 'live-message edits never carry a ping');
});

test('AC-MON-007: a conflict first seen with enemy hits already made pings once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    await pollAt(t, 0, 2);
    assert.equal(pings().length, 1);
    await pollAt(t, 2, 3);
    assert.equal(pings().length, 1);
});

test('AC-MON-007: outgoing attacks (us hitting them) never ping', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    await pollAt(t, 0, 0);
    t.mock.timers.setTime(T0 + MIN);
    conflicts = [{ ...conflict(0), outgoing: 3, score_a: 3 }];
    await checkGuildConflicts();
    assert.equal(pings().length, 0);
});
