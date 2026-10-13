// tests/game-monitors/ladder-followups.test.mjs - specs/tasks/2026-10-notification-outbox.review-2.counter-plan.md (O5),
// review-3.counter-plan.md (O6, O7)
// A Ladder reset is claimed before its band results are fetched. Band results interrupted by an
// account switch, a failed fetch or a rejected band answer are fetched again by a later run under the
// account that claimed the reset (with backoff after repeated failures, never dropped), each missing
// part is added once, and no other account stores or sends them.
// utils.js network helpers are mocked with fixtures; core.js sleep() is instant.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestWebhooks, storedAlerts, clearOutbox } from '../helpers/outbox-alerts.mjs';

let routes = {};      // url substring -> response body | Error
let fetchGate = null; // (url) => Promise awaited before a fetch answers (holds the monitor mid-run)
let sleepGate = null; // (ms) => Promise awaited by core.js sleep(), e.g. between two band appends

mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        secureFetch: async (url) => {
            await fetchGate?.(String(url));
            const key = Object.keys(routes).find(k => String(url).includes(k));
            const out = key === undefined ? new Error(`no fixture for ${url}`) : routes[key];
            if (out instanceof Error) throw out;
            return { ok: true, status: 200, json: async () => out };
        },
    },
});
const coreUrl = new URL('../../app_modules/core.js', import.meta.url).href;
const core = await import(coreUrl);
mock.module(coreUrl, { namedExports: { ...core, sleep: async ms => { await sleepGate?.(ms); } } });

configureTestWebhooks();
const db = await import('../../_gg_data/handler/gg_database.js');
const { checkLadderReset, followupRetryAt } = await import('../../app_modules/Ladder.js');
const { apiEndpoints } = await import('../../game_modules/API.js');
const { setAccountScope } = await import('../../config/accountScope.mjs');
after(() => db.closeDatabase());

const RESET = 4242;
const SCOPES = ['env', 'profile:a', 'profile:b'];
const news = { s: true, r: { news: [{ id: RESET, type: 3, subject: 'PvP Ladder', time: 1_790_000_000 }] } };
const bands = [1, 2, 3].map(id => ({ id, level_start: id * 100, level_end: id * 100 + 99 }));
const band = id => ({ s: true, r: { bands, previous: [{ player: { name: `Top${id}` }, rating: 1000 + id }] } });
const bandUrl = id => apiEndpoints.game.ladderResetScoreboard(id);

const switchTo = scope => { setAccountScope(null); setAccountScope(scope); }; // the switcher clears the scope first
const rows = async () => (await storedAlerts(db)).map(a => [a.row.account_scope, Number(a.row.part)]);
const list = async scope => JSON.parse((await db.getContent(db.processedListKey('processed_ladder_news_ids', scope))) ?? '[]');
const followups = async scope => JSON.parse((await db.getContent(`ladder_followups@${scope}`)) ?? '[]');

function hold() {
    let release, reached;
    const released = new Promise(r => { release = r; });
    const arrived = new Promise(r => { reached = r; });
    return { release, arrived, wait: async () => { reached(); await released; } };
}

let lines;
beforeEach(async (t) => {
    for (const scope of SCOPES) {
        await db.deleteContent(db.processedListKey('processed_ladder_news_ids', scope));
        await db.deleteContent(`ladder_followups@${scope}`);
    }
    await db.deleteContent('processed_ladder_news_ids');
    await clearOutbox(db);
    routes = { [apiEndpoints.game.newsArchive]: news };
    for (const id of [1, 2, 3]) routes[`viewing_band_id=${id}`] = band(id);
    fetchGate = sleepGate = null;
    setAccountScope('env');
    lines = [];
    for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, (...a) => lines.push(`${k}: ${a.map(String).join(' ')}`));
});

test('O5: band results interrupted by a switch to B are added once by a later A run, never under B', async () => {
    setAccountScope('profile:a');
    const gate = hold();
    fetchGate = async url => { if (url === bandUrl(2)) await gate.wait(); };
    const aRun = checkLadderReset();
    await gate.arrived;              // reset claimed under A, band 1 being fetched alongside band 2
    switchTo('profile:b');
    gate.release();
    await aRun;
    fetchGate = null;

    assert.deepEqual(await list('profile:a'), [RESET], "the reset stays in A's dedupe list");
    assert.deepEqual(await rows(), [['profile:a', 0]], 'no band part was queued after the switch');
    assert.deepEqual(await followups('profile:a'), [{ id: RESET, attempts: 0 }], 'A keeps the unfinished reset; a switch is not a failed attempt');
    assert.ok(lines.some(l => l.includes('account changed')));

    await checkLadderReset();        // B's own run: B claims its own reset; nothing of A's is stored under B
    assert.deepEqual(await followups('profile:b'), []);
    assert.deepEqual((await rows()).filter(([scope]) => scope === 'profile:a'), [['profile:a', 0]], "A's parts are not added by B's run");
    const bParts = (await rows()).filter(([scope]) => scope === 'profile:b').map(([, part]) => part);
    assert.deepEqual(bParts, [0, 1, 2, 3], "B's rows are B's own claim");

    switchTo('profile:a');
    await checkLadderReset();        // a later A run revisits the processed reset and adds the missing parts
    const aParts = () => rows().then(r => r.filter(([scope]) => scope === 'profile:a').map(([, part]) => part).sort());
    assert.deepEqual(await aParts(), [0, 1, 2, 3]);
    assert.deepEqual(await followups('profile:a'), [], 'a finished reset is not fetched again');

    const fetchedBands = [];
    fetchGate = async url => { if (url.includes('viewing_band_id')) fetchedBands.push(url); };
    await checkLadderReset();
    assert.deepEqual(await aParts(), [0, 1, 2, 3], 'another run adds no duplicate part');
    assert.deepEqual(fetchedBands, [], 'and refetches no band');
});

test('O5: a switch between band appends leaves only the missing parts to the later A run', async () => {
    setAccountScope('profile:a');
    const gate = hold();
    let appends = 0;
    sleepGate = async () => { if (++appends === 1) await gate.wait(); }; // after band 1 is queued
    const aRun = checkLadderReset();
    await gate.arrived;
    switchTo('profile:b');
    gate.release();
    await aRun;
    sleepGate = null;
    assert.deepEqual(await rows(), [['profile:a', 0], ['profile:a', 1]], 'parts 2 and 3 were not queued under the old run');
    assert.equal(lines.filter(l => l.includes('is not queued')).length, 2);

    switchTo('profile:a');
    await checkLadderReset();
    assert.deepEqual(await rows(), [['profile:a', 0], ['profile:a', 1], ['profile:a', 2], ['profile:a', 3]], 'each missing part is added once');
    assert.deepEqual(await followups('profile:a'), []);

    // Revisiting a reset whose parts all exist adds nothing.
    await db.setObject('ladder_followups@profile:a', [{ id: RESET, attempts: 0 }]);
    await checkLadderReset();
    assert.equal((await rows()).length, 4);
    assert.deepEqual(await followups('profile:a'), []);
});

test('O6: a band fetch that keeps failing stays recoverable with backoff and is added once after recovery', async () => {
    setAccountScope('profile:a');
    routes['viewing_band_id=3'] = new Error('timeout');
    await checkLadderReset();
    assert.deepEqual((await rows()).map(([, part]) => part), [0, 1, 2]);
    assert.deepEqual(await followups('profile:a'), [{ id: RESET, attempts: 1 }], 'retried on the next run');

    for (let i = 2; i <= 6; i++) await checkLadderReset();
    const [entry] = await followups('profile:a');
    assert.equal(entry.id, RESET, 'the unfinished reset is kept after repeated failures');
    assert.equal(entry.attempts, 5, 'the fifth failure starts the backoff, so the sixth run fetched nothing');
    assert.ok(entry.retryAt > Date.now(), 'the next retry waits');
    assert.ok(lines.some(l => l.includes('still incomplete') && l.includes(String(RESET))));
    assert.deepEqual((await rows()).map(([, part]) => part), [0, 1, 2], 'no duplicate parts from the retries');

    routes['viewing_band_id=3'] = band(3);
    const fetchedBands = [];
    fetchGate = async url => { if (url.includes('viewing_band_id')) fetchedBands.push(url); };
    await checkLadderReset();
    assert.deepEqual(fetchedBands, [], 'no fetch while backing off');

    switchTo('profile:b');                // B's own run never touches A's record or parts
    await checkLadderReset();
    assert.equal((await followups('profile:a')).length, 1);
    assert.deepEqual((await rows()).filter(([scope]) => scope === 'profile:a').map(([, part]) => part), [0, 1, 2]);

    switchTo('profile:a');
    await db.setObject('ladder_followups@profile:a', [{ ...entry, retryAt: Date.now() - 1 }]); // the delay has passed
    await checkLadderReset();
    const aParts = (await rows()).filter(([scope]) => scope === 'profile:a').map(([, part]) => part);
    assert.deepEqual(aParts, [0, 1, 2, 3], 'the missing part is added once the game answers');
    assert.deepEqual(await followups('profile:a'), []);
    await checkLadderReset();
    assert.equal((await rows()).filter(([scope]) => scope === 'profile:a').length, 4, 'and only once');
});

test('O6: the retry delay doubles after the fast attempts and is capped at one day', () => {
    const now = 1_000_000;
    assert.equal(followupRetryAt(1, now), 0);
    assert.equal(followupRetryAt(4, now), 0);
    assert.equal(followupRetryAt(5, now), now + 15 * 60 * 1000);
    assert.equal(followupRetryAt(6, now), now + 30 * 60 * 1000);
    assert.equal(followupRetryAt(40, now), now + 24 * 60 * 60 * 1000);
});

test('O7: a rejected band answer keeps the reset unfinished; a valid empty band completes without an alert', async () => {
    setAccountScope('profile:a');
    routes['viewing_band_id=2'] = { s: false, e: { message: 'Not available' } };
    routes['viewing_band_id=3'] = { s: true, r: { bands, previous: [] } };
    await checkLadderReset();
    assert.deepEqual(await rows(), [['profile:a', 0], ['profile:a', 1]], 'no alert for the rejected or the empty band');
    assert.deepEqual(await followups('profile:a'), [{ id: RESET, attempts: 1 }], 'the marker stays after the rejection');
    assert.ok(lines.some(l => l.includes('Band 2 returned no usable result')));

    routes['viewing_band_id=2'] = { s: true, r: { bands, previous: 'unavailable' } }; // accepted but malformed
    await checkLadderReset();
    assert.deepEqual(await followups('profile:a'), [{ id: RESET, attempts: 2 }], 'a malformed answer is not a result');

    routes['viewing_band_id=2'] = band(2);
    await checkLadderReset();
    assert.deepEqual(await rows(), [['profile:a', 0], ['profile:a', 1], ['profile:a', 2]], 'the missing part is added once; the empty band stays without one');
    assert.deepEqual(await followups('profile:a'), []);
    await checkLadderReset();
    assert.equal((await rows()).length, 3);
});
