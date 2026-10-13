// tests/discord-integration/outbox.test.mjs - specs/tasks/2026-10-notification-outbox.md AC-1..AC-4
// Claim-and-enqueue (gg_database.claimNotification), the dispatcher (notificationDispatcher.js) and
// its hand-off to the Discord queue (utils.js). The first part drives the dispatcher with a scripted
// queue and clock; the last part runs the real queue with node-fetch mocked, so no webhook is ever
// called. Runs on the MySQL fake and, in CI, on MySQL 8.4. Webhook URLs are fixtures.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const posts = [];     // { url, body }
const responses = []; // scripted Responses; empty means 204 No Content
mock.module('node-fetch', {
    defaultExport: async (url, options) => {
        posts.push({ url, body: JSON.parse(options.body) });
        return responses.shift() ?? new Response(null, { status: 204 });
    },
});

const HOOK = 'https://discord.com/api/webhooks/0/fixture-outbox';
process.env.GG_CRATES_WEBHOOK = HOOK;
process.env.GG_BOUNTY_WEBHOOK = HOOK;

const db = await import('../../_gg_data/handler/gg_database.js');
const { createNotificationOutboxStore } = await import('../../_gg_data/handler/notificationOutbox.js');
const { createNotificationDispatcher, outboxBackoff } = await import('../../notificationDispatcher.js');
const { getAccountScope, setAccountScope } = await import('../../config/accountScope.mjs');
const { OUTBOX_MAX_ROUNDS, OUTBOX_RETRY_BASE, OUTBOX_RETRY_CAP } = await import('../../webhooks.js');
const utils = await import('../../utils.js');

const client = await db.getConnection();
const store = createNotificationOutboxStore(client);
after(() => db.closeDatabase());

const LIST = { storageKey: 'processed_outbox_test_ids', historyLimit: 3 };
const payload = n => ({ content: '', embeds: [{ title: `Alert ${n}`, description: `payload-${n}` }] });
const claim = (eventId, over = {}) => db.claimNotification({
    source: 'crates', ...LIST, eventId, accountScope: 'env',
    notifications: [{ settingKey: 'GG_CRATES_WEBHOOK', payload: payload(eventId) }], ...over,
});
const rows = () => client.query('SELECT id, source, event_id, part, account_scope, state, attempts, next_attempt_at, last_error, payload FROM notification_outbox ORDER BY id');
const list = async () => JSON.parse((await db.getContent(LIST.storageKey)) ?? '[]');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

let logs = [];
beforeEach(async (t) => {
    await client.query('DELETE FROM notification_outbox');
    await db.deleteContent(LIST.storageKey);
    setAccountScope('env');
    posts.length = responses.length = 0;
    logs = [];
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (...a) => logs.push(a.map(String).join(' ')));
});

/** A dispatcher whose Discord queue is scripted: each queued row waits in `queued` until settled. */
function scripted({ now = () => clock, ...over } = {}) {
    const queued = [];
    const dispatcher = createNotificationDispatcher({
        store, now, resolveWebhook: key => process.env[key] ?? '',
        queue: (webhook, body, meta) => queued.push({ webhook, body, meta }),
        ...over,
    });
    return { dispatcher, queued };
}
let clock = Date.now() + 3600_000; // ahead of real time, so rows claimed during the run are due

// --- AC-1: atomic claim ------------------------------------------------------------------------------

test('AC-1: a claim commits the dedupe ID and one pending row; a repeated claim adds nothing', async () => {
    assert.equal(await claim(101), true);
    assert.equal(await claim(101), false, 'the same event is not claimed twice');
    assert.deepEqual(await list(), [101], 'the processed list keeps the original ID type');
    const [row, ...rest] = await rows();
    assert.equal(rest.length, 0);
    assert.equal(row.state, 'pending');
    assert.equal(row.account_scope, 'env');
    assert.deepEqual(JSON.parse(row.payload), payload(101));
});

test('AC-1: a claim that fails part-way commits neither the dedupe ID nor any row', async () => {
    await assert.rejects(claim(102, { notifications: [
        { settingKey: 'GG_CRATES_WEBHOOK', payload: payload(102) },
        { settingKey: null, payload: payload(102) },              // the second insert fails
    ] }));
    assert.deepEqual(await list(), [], 'the ID was not claimed');
    assert.equal((await rows()).length, 0, 'the first row was rolled back');
    assert.equal(await claim(102), true, 'the event can be claimed on the next run');
});

test('AC-1: an event still in the outbox is not claimed again after the FIFO list trimmed it', async () => {
    for (const id of [1, 2, 3, 4]) await claim(id);
    assert.deepEqual(await list(), [2, 3, 4]);
    assert.equal(await claim(1), false);
    assert.equal((await rows()).length, 4);
});

test('AC-1: an event with no alert is still claimed, as monitors did before', async () => {
    assert.equal(await claim(103, { notifications: [] }), true);
    assert.equal(await claim(103, { notifications: [] }), false);
    assert.deepEqual(await list(), [103]);
    assert.equal((await rows()).length, 0);
});

test('AC-1: restart between claim and Discord acceptance replays the one pending row', async () => {
    await claim(104);
    // The process that claimed it stops before sending; a fresh dispatcher stands in for the restart.
    const { dispatcher, queued } = scripted();
    await dispatcher.start();
    dispatcher.stop();
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].body, payload(104), 'the stored payload is sent; the game is not read again');
    assert.equal(queued[0].webhook, HOOK, 'the webhook comes from the live setting');
    await dispatcher.pump();
    assert.equal(queued.length, 1, 'a row already queued is not queued twice');
    queued[0].meta.onSettled({ ok: true, batchSize: 1 });
    await flush();
    assert.equal((await rows())[0].state, 'delivered');
});

test('AC-4 (migration): existing processed ID history stays readable and is not replayed', async () => {
    for (const id of [7, 8]) await db.setContent(LIST.storageKey, id, 3);   // history written before the outbox
    assert.equal(await claim(8), false, 'a legacy processed ID is not claimed or bulk replayed');
    assert.equal(await claim(9), true);
    assert.deepEqual(await list(), [7, 8, 9]);
    assert.deepEqual((await rows()).map(r => r.event_id), ['9']);
});

test('AC-4: nothing can be claimed while no account is signed in', async () => {
    await assert.rejects(claim(105, { accountScope: null }), /No active account/);
    assert.deepEqual(await list(), []);
});

// --- AC-2: retryable and permanent failures ----------------------------------------------------------

test('AC-2: a retryable failure keeps the row pending with bounded backoff, then it is delivered', async () => {
    await claim(201);
    const { dispatcher, queued } = scripted();
    await dispatcher.pump();
    queued[0].meta.onSettled({ ok: false, error: { category: 'server', status: 503, retryable: true }, batchSize: 1 });
    await flush();
    let [row] = await rows();
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'server (HTTP 503)');
    assert.equal(row.next_attempt_at, new Date(clock + OUTBOX_RETRY_BASE).toISOString());

    await dispatcher.pump();
    assert.equal(queued.length, 1, 'not retried before its next attempt time');
    clock += OUTBOX_RETRY_BASE;
    await dispatcher.pump();
    assert.equal(queued.length, 2, 'retried once due');
    assert.deepEqual(queued[1].body, payload(201));
    queued[1].meta.onSettled({ ok: true, batchSize: 1 });
    await flush();
    [row] = await rows();
    assert.equal(row.state, 'delivered');
    assert.match(logs.join('\n'), /round 1\/12/);
});

test('AC-2: backoff doubles per round up to its cap, and rounds are bounded', () => {
    assert.equal(outboxBackoff(1), OUTBOX_RETRY_BASE);
    assert.equal(outboxBackoff(2), 2 * OUTBOX_RETRY_BASE);
    assert.equal(outboxBackoff(30), OUTBOX_RETRY_CAP);
    assert.equal(OUTBOX_MAX_ROUNDS, 12);
});

test('AC-2: a row that keeps failing becomes failed after the last round', async () => {
    await claim(202);
    const { dispatcher, queued } = scripted();
    for (let round = 1; round <= OUTBOX_MAX_ROUNDS; round++) {
        await dispatcher.pump();
        assert.equal(queued.length, round);
        queued.at(-1).meta.onSettled({ ok: false, error: { category: 'timeout' }, batchSize: 1 });
        await flush();
        clock += OUTBOX_RETRY_CAP;
    }
    const [row] = await rows();
    assert.equal(row.state, 'failed');
    assert.equal(row.attempts, OUTBOX_MAX_ROUNDS);
    await dispatcher.pump();
    assert.equal(queued.length, OUTBOX_MAX_ROUNDS, 'a failed row is not sent again on its own');
});

test('AC-2: a permanent failure is failed at once, inspectable without payload, and does not block others', async () => {
    await claim(203);
    await claim(204);
    const { dispatcher, queued } = scripted();
    await dispatcher.pump();
    assert.equal(queued.length, 2);
    queued[0].meta.onSettled({ ok: false, error: { category: 'client', status: 404 }, batchSize: 1 });
    queued[1].meta.onSettled({ ok: true, batchSize: 1 });
    await flush();
    const [failed, delivered] = await rows();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.last_error, 'client (HTTP 404)');
    assert.equal(delivered.state, 'delivered');

    const view = await dispatcher.describe();
    assert.equal(view.counts.failed, 1);
    assert.equal(view.counts.delivered, 1);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].state, 'failed');
    const text = JSON.stringify(view);
    assert.ok(!text.includes('payload-') && !text.includes('fixture-outbox') && !('payload' in view.rows[0]), text);

    assert.equal(await dispatcher.retry(view.rows[0].id), true, 'the owner can retry it');
    await flush();
    assert.equal(queued.length, 3);
    queued[2].meta.onSettled({ ok: false, error: { category: 'client', status: 404 }, batchSize: 1 });
    await flush();
    assert.equal(await dispatcher.discard(view.rows[0].id), true, 'the owner can discard it');
    assert.equal((await rows()).length, 1);
    assert.deepEqual(await list(), [203, 204], 'discarding keeps the dedupe history');
    assert.match(logs.join('\n'), /failed: client \(HTTP 404\) after 1 round/);
});

test('AC-2: when Discord rejects a merged batch, each row is retried on its own before failing', async () => {
    await claim(205);
    await claim(206);
    const { dispatcher, queued } = scripted();
    await dispatcher.pump();
    for (const q of queued) q.meta.onSettled({ ok: false, error: { category: 'client', status: 400 }, batchSize: 2 });
    await flush();
    assert.deepEqual((await rows()).map(r => [r.state, r.attempts]), [['pending', 0], ['pending', 0]]);
    assert.equal(queued.length, 4, 'both rows were queued again');
    assert.deepEqual(queued.slice(2).map(q => q.meta.solo), [true, true], 'as single messages');
    queued[2].meta.onSettled({ ok: true, batchSize: 1 });
    queued[3].meta.onSettled({ ok: false, error: { category: 'client', status: 400 }, batchSize: 1 });
    await flush();
    assert.deepEqual((await rows()).map(r => r.state), ['delivered', 'failed']);
});

test('AC-2: a webhook setting removed after the claim fails the row for owner action', async () => {
    await claim(207, { notifications: [{ settingKey: 'GG_SHOUTBOX_WEBHOOK', payload: payload(207) }] });
    const { dispatcher, queued } = scripted({ resolveWebhook: () => '' });
    await dispatcher.pump();
    assert.equal(queued.length, 0);
    const [row] = await rows();
    assert.equal(row.state, 'failed');
    assert.equal(row.last_error, 'unconfigured');
});

// --- AC-3: duplicate window ----------------------------------------------------------------------------

test('AC-3: Discord accepted but the ack failed: not re-sent by this process; the ack is retried', async () => {
    await claim(301);
    let failAck = true;
    const flaky = { ...store, markDelivered: async (...a) => { if (failAck) throw new Error('mysql down'); return store.markDelivered(...a); } };
    const { dispatcher, queued } = scripted({ store: flaky });
    await dispatcher.pump();
    queued[0].meta.onSettled({ ok: true, batchSize: 1 });
    await flush();
    assert.equal((await rows())[0].state, 'pending', 'the row is still pending in MySQL');
    assert.deepEqual(dispatcher.state().unacked, [(await rows())[0].id]);
    await assert.rejects(dispatcher.pump());
    assert.equal(queued.length, 1, 'not sent again while the ack is outstanding');
    failAck = false;
    await dispatcher.pump();
    assert.equal(queued.length, 1);
    assert.equal((await rows())[0].state, 'delivered');
});

test('AC-3: a restart inside the window (accepted, not acknowledged) sends the alert once more', async () => {
    await claim(302);
    const first = scripted({ store: { ...store, markDelivered: async () => { throw new Error('process killed'); } } });
    await first.dispatcher.pump();
    first.queued[0].meta.onSettled({ ok: true, batchSize: 1 });   // Discord accepted
    await flush();
    const restarted = scripted();                                  // process restarts before the ack lands
    await restarted.dispatcher.pump();
    assert.equal(restarted.queued.length, 1, 'documented duplicate: the accepted alert is replayed once');
    restarted.queued[0].meta.onSettled({ ok: true, batchSize: 1 });
    await flush();
    await restarted.dispatcher.pump();
    assert.equal(restarted.queued.length, 1);
    assert.equal((await rows())[0].state, 'delivered');
});

// --- AC-4: account scope -----------------------------------------------------------------------------

test('AC-4: rows of another account are held, then sent when that account is active again', async () => {
    await claim(401, { accountScope: 'profile:a' });
    await claim(402, { accountScope: 'profile:b' });
    setAccountScope('profile:b');
    const { dispatcher, queued } = scripted();
    await dispatcher.pump();
    assert.deepEqual(queued.map(q => q.body), [payload(402)]);
    assert.equal(queued[0].meta.accountScope, 'profile:b');
    const view = await dispatcher.describe();
    assert.equal(view.counts.held, 1);
    assert.deepEqual(view.rows.map(r => r.eventId), ['401']);

    setAccountScope(null);                                         // switching: no account
    await dispatcher.pump();
    assert.equal(queued.length, 1);
    setAccountScope('profile:a');
    await dispatcher.pump();
    assert.deepEqual(queued.map(q => q.body), [payload(402), payload(401)]);
});

test('AC-4: a queued alert whose account was switched away is released unsent and stays pending', async () => {
    await claim(403, { accountScope: 'profile:a' });
    setAccountScope('profile:a');
    const dispatcher = createNotificationDispatcher({ store, resolveWebhook: key => process.env[key] ?? '' });
    await dispatcher.pump();          // real utils queue: batched for 100ms
    setAccountScope('profile:b');     // the switch happens before the POST
    await new Promise(r => setTimeout(r, 300));
    await flush();
    assert.equal(posts.length, 0, 'nothing was posted under the other account');
    assert.equal((await rows())[0].state, 'pending');
    assert.deepEqual(dispatcher.state().inFlight, [], 'released, so it is picked up again later');
    setAccountScope('profile:a');
    await dispatcher.pump();
    for (let i = 0; i < 50 && (await rows())[0].state !== 'delivered'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(posts.length, 1);
    assert.equal((await rows())[0].state, 'delivered');
});

// --- end to end through utils.js ------------------------------------------------------------------------

test('end to end: a claimed alert is posted with its stored payload and acknowledged; a 4xx is kept as failed', async () => {
    await claim(501);
    responses.push(new Response(JSON.stringify({ code: 50027, message: 'Invalid Webhook Token' }), { status: 401 }));
    const dispatcher = createNotificationDispatcher({ store, resolveWebhook: key => process.env[key] ?? '' });
    await dispatcher.pump();
    for (let i = 0; i < 50 && (await rows())[0].state === 'pending'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await rows())[0].state, 'failed');
    assert.equal((await rows())[0].last_error, 'client (HTTP 401)');

    assert.equal(await dispatcher.retry((await rows())[0].id), true);
    for (let i = 0; i < 60 && (await rows())[0].state !== 'delivered'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await rows())[0].state, 'delivered');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, { content: '', embeds: payload(501).embeds });
    const text = logs.join('\n');
    assert.ok(!text.includes('fixture-outbox') && !text.includes('payload-501'), text);
    assert.equal(getAccountScope(), 'env');
    void utils;
});

// --- specs/tasks/2026-10-notification-progress-health.md: outbox progress and counters ---------------

test('progress-health: progress() counts due rows not yet queued, from when this dispatcher began serving the account', async () => {
    const { metricCounters } = await import('../../app_modules/metricsStore.js');
    const before = metricCounters();
    clock += 60_000;
    const servingSince = clock;
    const { dispatcher, queued } = scripted();
    await claim(901);
    await claim(902);
    await claim(903);
    clock += 30_000;
    assert.deepEqual(await dispatcher.progress(), { due: 3, dueSince: servingSince },
        'rows claimed earlier are counted as due only from when this dispatcher started');

    await dispatcher.pump();
    assert.equal(queued.length, 3);
    assert.deepEqual(await dispatcher.progress(), { due: 0, dueSince: null }, 'rows in the in-memory queue are counted by that queue');

    await queued[0].meta.onSettled({ ok: true, batchSize: 1 });
    await queued[1].meta.onSettled({ ok: false, error: { category: 'server', status: 502 }, batchSize: 1 });
    await queued[2].meta.onSettled({ ok: false, error: { category: 'client', status: 400 }, batchSize: 1 });
    assert.deepEqual(await dispatcher.progress(), { due: 0, dueSince: null }, 'a row waiting for its backoff is not due');
    const after = metricCounters();
    assert.deepEqual(['outboxDelivered', 'outboxRetried', 'outboxFailed'].map(k => after[k] - before[k]), [1, 1, 1]);

    clock += outboxBackoff(1);
    const due = await dispatcher.progress();
    assert.equal(due.due, 1, 'the retryable row is due again after its backoff');

    // Another account: its rows are held, and the clock restarts when the account becomes active again.
    setAccountScope('profile:other');
    assert.deepEqual(await dispatcher.progress(), { due: 0, dueSince: null });
    clock += 5_000;
    setAccountScope('env');
    assert.deepEqual(await dispatcher.progress(), { due: 1, dueSince: clock });
    setAccountScope(null);
    assert.deepEqual(await dispatcher.progress(), { due: 0, dueSince: null }, 'no active account');
    assert.ok(!JSON.stringify(await dispatcher.progress()).includes('fixture-outbox'));
});
