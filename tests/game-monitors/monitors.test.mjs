// tests/game-monitors/monitors.test.mjs - MON-TASK-004 / AC-MON-001, AC-MON-002, AC-MON-004, AC-MON-006
// utils.js network helpers are mocked with fixtures; a throwaway SQLite file holds state.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestWebhooks, storedAlerts, clearOutbox } from '../helpers/outbox-alerts.mjs';


let sent = [];              // alerts stored in the notification outbox (see outbox-alerts.mjs)
const fetched = [];         // secureFetch URLs
let routes = {};            // url substring -> response body | Error | { status }
let goldLookup, buffsLookup; // (targetId) => value | throws

function respond(url) {
    fetched.push(url);
    const key = Object.keys(routes).find(k => url.includes(k));
    const out = key === undefined ? { status: 404 } : routes[key];
    if (out instanceof Error) throw out;
    if (out?.status) return { ok: out.status < 400, status: out.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => out };
}

mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        secureFetch: async (url) => respond(String(url)),
        getGoldInHand: async (url) => goldLookup(url),
        getBuffs: async (url, isBounty) => buffsLookup(url, isBounty),
    },
});

configureTestWebhooks();
const db = await import('../../_gg_data/handler/gg_database.js');
const bountyBoard = await import('../../app_modules/BountyBoard.js');
const superElite = await import('../../app_modules/SuperElite.js');
const { UNKNOWN } = bountyBoard;
// Each run is followed by reading what it stored for delivery.
const checkBounties = async () => { await bountyBoard.checkBounties(); sent = await storedAlerts(db); };
const checkSuperElites = async () => { await superElite.checkSuperElites(); sent = await storedAlerts(db); };
const { autoJoinAllGroups } = await import('../../app_modules/QoL.js');
const { apiEndpoints } = await import('../../game_modules/API.js');
// The active account is 'env' here; each account keeps its own processed list (outbox AC-4).
const processed = async key => JSON.parse((await db.getContent(db.processedListKey(key, 'env'))) ?? 'null');

after(() => db.closeDatabase());

function quiet(t) {
    const lines = [];
    for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, (...a) => lines.push(`${k}: ${a.map(String).join(' ')}`));
    return lines;
}

beforeEach(async () => {
    for (const k of ['processed_bounty_ids', 'processed_se_kill_ids']) {
        await db.deleteContent(k);
        await db.deleteContent(db.processedListKey(k, 'env'));
    }
    await clearOutbox(db);
    sent = [];
    fetched.length = 0;
    routes = {};
    goldLookup = () => 1_234_567;
    buffsLookup = () => ({ hasDeflect: true, isCloaked: false, numberOfBuffs: 12 });
});

// --- AC-MON-002: BountyBoard ------------------------------------------------------------------------

const bounty = (id, over = {}) => ({
    id,
    target: { id: 900 + id, name: `Target${id}`, level: 700 },
    offerer: { name: 'Offerer' },
    currency: { type: 0, value: 50000 },
    ...over,
});
const board = (...bounties) => ({ s: true, r: { bounties } });
const BOARD = apiEndpoints.game.bountyBoard;

test('AC-MON-002: a new bounty is sent with deflect/cloak flags, buff count, gold, and its ID stored', async (t) => {
    quiet(t);
    routes[BOARD] = board(bounty(1));
    await checkBounties();
    assert.equal(sent.length, 1);
    const text = sent[0].args[0];
    assert.match(text, /Target: Target1 \(Lvl 700\)/);
    assert.match(text, /Reward: 50,000 Gold/);
    assert.match(text, /Gold in Hand: 1234567/);
    assert.match(text, /Deflect\? true/);
    assert.match(text, /Cloaked\? false/);
    assert.match(text, /Buffs: 12/);
    assert.deepEqual(await processed('processed_bounty_ids'), [1]);
});

test('AC-MON-002: target lookups ask for the bounty buff summary of the target player', async (t) => {
    quiet(t);
    const asked = [];
    buffsLookup = (url, isBounty) => { asked.push({ url, isBounty }); return { hasDeflect: false, isCloaked: true, numberOfBuffs: 1 }; };
    routes[BOARD] = board(bounty(2));
    await checkBounties();
    assert.deepEqual(asked, [{ url: apiEndpoints.player.activeBuffs(902), isBounty: true }]);
    assert.match(sent[0].args[0], /Cloaked\? true/);
});

test('AC-MON-002 error case: failing gold and buff lookups still send the alert with Unknown', async (t) => {
    quiet(t);
    goldLookup = () => { throw new Error('profile offline'); };
    buffsLookup = () => { throw new Error('buffs offline'); };
    routes[BOARD] = board(bounty(3), bounty(4));
    await checkBounties();
    assert.equal(sent.length, 2, 'every new bounty is still announced');
    for (const s of sent) {
        assert.match(s.args[0], new RegExp(`Gold in Hand: ${UNKNOWN}`));
        assert.match(s.args[0], new RegExp(`Deflect\\? ${UNKNOWN}`));
        assert.match(s.args[0], new RegExp(`Buffs: ${UNKNOWN}`));
    }
    assert.equal(UNKNOWN, 'Unknown');
});

test('AC-MON-002: helpers that return undefined (their failure signal) also show Unknown', async (t) => {
    quiet(t);
    goldLookup = () => undefined;
    buffsLookup = () => undefined;
    routes[BOARD] = board(bounty(5));
    await checkBounties();
    assert.match(sent[0].args[0], /Gold in Hand: Unknown/);
    assert.match(sent[0].args[0], /Cloaked\? Unknown/);
});

test('AC-MON-002/006: already processed and duplicated bounties are not re-announced', async (t) => {
    quiet(t);
    routes[BOARD] = board(bounty(6), bounty(6), bounty(7));
    await checkBounties();
    assert.equal(sent.length, 2, 'a duplicate inside one response is announced once');
    await checkBounties();
    assert.equal(sent.length, 2, 'the next cycle sends nothing new');
});

test('AC-MON-002: a failed board request sends nothing and does not throw', async (t) => {
    quiet(t);
    routes[BOARD] = { status: 503 };
    await checkBounties();
    routes[BOARD] = { s: false, e: { message: 'fixture' } };
    await checkBounties();
    routes[BOARD] = new Error('network down');
    await checkBounties();
    assert.equal(sent.length, 0);
});

// --- AC-MON-006: dedupe across restarts --------------------------------------------------------------

test('AC-MON-006: a restarted process loads processed IDs from SQLite and does not re-alert', async (t) => {
    quiet(t);
    routes[BOARD] = board(bounty(8));
    await checkBounties();
    assert.equal(sent.length, 1);

    // A fresh module instance stands in for a restarted process; only SQLite state carries over.
    const restarted = await import(`../../app_modules/BountyBoard.js?restart=${Date.now()}`);
    await restarted.checkBounties();
    sent = await storedAlerts(db);
    assert.equal(sent.length, 1);
    routes[BOARD] = board(bounty(8), bounty(9));
    await restarted.checkBounties();
    sent = await storedAlerts(db);
    assert.equal(sent.length, 2);
    assert.match(sent[1].args[0], /Target9/);
});

test('AC-MON-006: with no prior record a module starts fresh and records new IDs', async (t) => {
    quiet(t);
    assert.equal(await processed('processed_se_kill_ids'), null);
    const SERVER_TS = 1_790_000_000;
    const kill = { time: 60, creature: 999_101, item: 0, player: { id: 1, name: 'Hunter' }, realm: { realm: 5, x: 1, y: 2 } };
    const fixture = { s: true, t: `x ${SERVER_TS}`, r: { 0: kill } };
    routes = { [apiEndpoints.game.superEliteArchive]: fixture };
    await checkSuperElites();
    assert.equal(sent.length, 1);
    assert.equal((await processed('processed_se_kill_ids')).length, 1);

    const restarted = await import(`../../app_modules/SuperElite.js?restart=${Date.now()}`);
    await restarted.checkSuperElites();
    sent = await storedAlerts(db);
    assert.equal(sent.length, 1, 'the restarted monitor remembers the kill');
});

// --- outbox AC-1: claim-and-enqueue in monitors ------------------------------------------------------

test('outbox AC-1: alerts are stored oldest first with their webhook setting and account; a failed build stays unclaimed', async (t) => {
    const lines = quiet(t);
    const { claimAlerts, alertFor } = await import('../../app_modules/notify.js');
    const events = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }];
    const claimed = await claimAlerts('bounty', { storageKey: 'processed_bounty_ids', historyLimit: 100 }, events, {
        idOf: e => e.id,
        build: async e => {
            if (e.id === 'e2') throw new Error('lookup failed');
            return [alertFor('GG_BOUNTY_WEBHOOK', { content: '', embeds: [{ description: e.id }] }), alertFor('GG_LADDER_RANKING_WEBHOOK', {}) /* not configured: not stored */];
        },
    });
    assert.deepEqual(claimed.map(e => e.id), ['e1', 'e3'], 'later events are still claimed');
    assert.deepEqual(await processed('processed_bounty_ids'), ['e1', 'e3'], 'e2 is not marked processed');
    sent = await storedAlerts(db);
    assert.deepEqual(sent.map(a => [a.row.event_id, a.row.setting_key, a.row.account_scope]), [['e1', 'GG_BOUNTY_WEBHOOK', 'env'], ['e3', 'GG_BOUNTY_WEBHOOK', 'env']]);
    assert.ok(lines.some(l => l.includes('event e2') && l.includes('retried on the next run')));

    const retried = await claimAlerts('bounty', { storageKey: 'processed_bounty_ids', historyLimit: 100 }, [{ id: 'e2' }], {
        idOf: e => e.id,
        build: async e => [alertFor('GG_BOUNTY_WEBHOOK', { content: '', embeds: [{ description: e.id }] })],
    });
    assert.deepEqual(retried.map(e => e.id), ['e2']);
    assert.deepEqual((await storedAlerts(db)).map(a => a.row.event_id), ['e1', 'e3', 'e2']);

    const empty = await claimAlerts('bounty', { storageKey: 'processed_bounty_ids', historyLimit: 100 }, [{ id: 'e4' }], {
        idOf: e => e.id,
        build: async () => [alertFor('GG_LADDER_RANKING_WEBHOOK', {})], // built, but its webhook is not configured
    });
    assert.deepEqual(empty.map(e => e.id), ['e4'], 'an event that intentionally yields no alert is still claimed');
    assert.equal((await storedAlerts(db)).length, 3);
});

test('outbox AC-1 (O2): a Super Elite kill whose creature lookup fails once is claimed with its alert on the next run', async (t) => {
    const lines = quiet(t);
    const SERVER_TS = 1_790_100_000;
    const kill = { time: 120, creature: 999_202, item: 0, player: { id: 2, name: 'Retry' }, realm: { realm: 5, x: 3, y: 4 } };
    routes = { [apiEndpoints.game.superEliteArchive]: { s: true, t: `x ${SERVER_TS}`, r: { 0: kill } } };
    const client = await db.getConnection();

    // A transient database failure during enrichment: the creature table cannot be read for one run.
    await client.query('ALTER TABLE creatures RENAME TO creatures_offline');
    try {
        await checkSuperElites();
    } finally {
        await client.query('ALTER TABLE creatures_offline RENAME TO creatures');
    }
    assert.equal(sent.length, 0, 'no alert was stored');
    assert.equal(await processed('processed_se_kill_ids'), null, 'the kill was not marked processed');
    assert.ok(lines.some(l => /retried on the next run/.test(l)));

    await checkSuperElites();
    assert.equal(sent.length, 1, 'the next run builds and claims it');
    assert.equal(sent[0].row.state, 'pending');
    assert.equal((await processed('processed_se_kill_ids')).length, 1);
    await checkSuperElites();
    assert.equal(sent.length, 1, 'and only once');
});

// --- AC-MON-004: group auto-join ---------------------------------------------------------------------

test('AC-MON-004: auto-join sends the join-all group command and logs success', async (t) => {
    const lines = quiet(t);
    routes['subcmd2=joinall'] = { s: true };
    await autoJoinAllGroups();
    assert.deepEqual(fetched, ['https://www.fallensword.com/index.php?cmd=guild&subcmd=groups&subcmd2=joinall']);
    assert.ok(lines.some(l => l.includes('join all groups')));
});

test('AC-MON-004 error case: a refused or failing join logs a warning/error and never throws', async (t) => {
    const lines = quiet(t);
    routes['subcmd2=joinall'] = { status: 409 };
    await assert.doesNotReject(autoJoinAllGroups());
    assert.ok(lines.some(l => l.startsWith('warn') && l.includes('409')));
    routes['subcmd2=joinall'] = new Error('group is full');
    await assert.doesNotReject(autoJoinAllGroups());
    assert.ok(lines.some(l => l.startsWith('error') && l.includes('JoinAll')));
});
