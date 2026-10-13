// tests/discord-integration/delivery.test.mjs - DISC-TASK-005 / AC-DISC-005, AC-DISC-006, delivery recovery
// Webhook batching, rate limiting and recovery in utils.js. node-fetch is mocked and the clock is mocked,
// so no webhook is ever called. The webhook URLs below are fixtures, not real endpoints.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const posts = [];     // { url, method, body, at, signal }
const responses = []; // scripted Response objects or (url, options) => Promise<Response>; empty means 204 No Content
mock.module('node-fetch', {
    defaultExport: async (url, options) => {
        posts.push({ url, method: options.method, body: JSON.parse(options.body), at: Date.now(), signal: options.signal });
        const next = responses.shift();
        if (typeof next === 'function') return next(url, options);
        return next ?? new Response(null, { status: 204 });
    },
});

const { queueDiscordMessage, flushAllBatches, sendAndGetMessageId, editDiscordMessage } = await import('../../utils.js');
const {
    DELAY_BETWEEN_MESSAGES, RETRY_DELAY, DISCORD_REQUEST_TIMEOUT, DISCORD_MAX_ATTEMPTS,
    DISCORD_MAX_RATE_LIMITS, DISCORD_RATE_LIMIT_FALLBACK, DISCORD_MAX_RETRY_AFTER,
} = await import('../../webhooks.js');

const HOOK_A = 'https://discord.com/api/webhooks/0/fixture-a';
const HOOK_B = 'https://discord.com/api/webhooks/0/fixture-b';
const embed = i => ({ title: `Event ${i}`, description: 'fixture' });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const advance = async ms => { mock.timers.tick(ms); await settle(); };
/** Lets simulated time pass in 100ms steps, so timers scheduled along the way also fire. */
const elapse = async ms => { for (let t = 0; t < ms; t += 100) await advance(Math.min(100, ms - t)); };

const hang = () => new Promise(() => {}); // a request that never settles and ignores abort
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rateLimited = retryAfter => json(429, { message: 'You are being rate limited.', retry_after: retryAfter, global: false });

// The clock only moves forward across tests, as it does in production, so the module's last-send time
// from a previous test never delays the next one.
let epoch = 0;
let logs = [];
const logText = () => logs.join('\n');
const startOffset = () => posts[0].at;

/** Asserts that diagnostics never contain a webhook URL, token fragment, or payload text. */
function assertSanitized() {
    const text = logText();
    for (const secret of ['discord.com/api/webhooks', 'fixture-a', 'fixture-b', 'Event ', 'payload-secret']) {
        assert.ok(!text.includes(secret), `logs leak "${secret}":\n${text}`);
    }
}

beforeEach(() => {
    posts.length = responses.length = 0;
    logs = [];
    epoch += 10_000_000;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch });
    for (const level of ['log', 'warn', 'error']) {
        mock.method(console, level, (...args) => { logs.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ')); });
    }
});
afterEach(async () => {
    responses.length = 0;
    await elapse(5 * DISCORD_MAX_RETRY_AFTER); // drain so the next test starts idle
    mock.timers.reset();
    mock.restoreAll();
});

test('AC-DISC-005: consecutive webhook posts are at least 2000ms apart', () => {
    assert.equal(DELAY_BETWEEN_MESSAGES, 2000);
});

test('recovery: deadline and retry constants are finite and bounded', () => {
    assert.equal(DISCORD_REQUEST_TIMEOUT, 15_000);
    assert.equal(DISCORD_MAX_ATTEMPTS, 3);
    assert.equal(DISCORD_MAX_RATE_LIMITS, 5);
    assert.equal(DISCORD_RATE_LIMIT_FALLBACK, 5_000);
    assert.equal(DISCORD_MAX_RETRY_AFTER, 60_000);
    assert.equal(RETRY_DELAY, 2000);
});

test('AC-DISC-006: a burst of 15 embeds becomes one 10-embed POST and one 5-embed POST', async () => {
    for (let i = 0; i < 15; i++) queueDiscordMessage(HOOK_A, { content: '<@&1>', embeds: [embed(i)] });
    await settle();
    assert.equal(posts.length, 1, 'a full batch of 10 is sent immediately');
    assert.equal(posts[0].body.embeds.length, 10);
    assert.equal(posts[0].body.content, '<@&1>', 'duplicate mentions are merged');

    await advance(100); // idle timeout flushes the partial batch into the queue
    await advance(DELAY_BETWEEN_MESSAGES - 101);
    assert.equal(posts.length, 1, 'second POST waits for the inter-message delay');
    await advance(1);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body.embeds.map(e => e.title), [10, 11, 12, 13, 14].map(i => `Event ${i}`));
});

test('AC-DISC-006: a partial batch waits for the 100ms idle timeout', async () => {
    queueDiscordMessage(HOOK_A, { embeds: [embed(1)] });
    await advance(99);
    assert.equal(posts.length, 0);
    queueDiscordMessage(HOOK_A, { embeds: [embed(2)] }); // resets the idle timer
    await advance(99);
    assert.equal(posts.length, 0);
    await advance(1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.embeds.length, 2);
});

test('AC-DISC-005: posts to different webhooks share one queue and stay 2000ms apart', async () => {
    queueDiscordMessage(HOOK_A, { embeds: [embed('a')] });
    queueDiscordMessage(HOOK_B, { embeds: [embed('b')] });
    await advance(100);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A]);
    await advance(DELAY_BETWEEN_MESSAGES - 1);
    assert.equal(posts.length, 1);
    await advance(1);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B]);
});

test('AC-DISC-005: HTTP 429 pauses the queue for retry_after and retries the same message', async () => {
    responses.push(rateLimited(1.5));
    queueDiscordMessage(HOOK_A, { embeds: [embed('limited')] });
    await advance(100);
    assert.equal(posts.length, 1);
    await advance(1999); // retry_after 1500ms + 500ms buffer
    assert.equal(posts.length, 1);
    await advance(1);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, posts[0].body);
});

test('AC-DISC-006: batches split before exceeding the Discord character budget', async () => {
    const big = i => ({ title: `Big ${i}`, description: 'x'.repeat(3000) });
    queueDiscordMessage(HOOK_A, { embeds: [big(1)] });
    queueDiscordMessage(HOOK_A, { embeds: [big(2)] });
    await settle();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.embeds.length, 1);
    await advance(100 + DELAY_BETWEEN_MESSAGES);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.embeds[0].title, 'Big 2');
});

test('AC-DISC-006: flushAllBatches sends pending batches without waiting for the idle timeout', async () => {
    queueDiscordMessage(HOOK_A, { embeds: [embed(1)] });
    queueDiscordMessage(HOOK_A, { embeds: [embed(2)] });
    queueDiscordMessage(HOOK_A, { embeds: [embed(3)] });
    flushAllBatches();
    await settle();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.embeds.length, 3);
});

test('AC-1: a POST that never settles times out, is aborted, and the next webhook is attempted', async () => {
    responses.push(hang);
    queueDiscordMessage(HOOK_A, { embeds: [embed('stuck')] });
    queueDiscordMessage(HOOK_B, { embeds: [embed('next')] });
    await advance(100);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A]);

    await advance(DISCORD_REQUEST_TIMEOUT - 1);
    assert.equal(posts.length, 1, 'the deadline has not expired yet');
    await advance(1);
    assert.equal(posts[0].signal.aborted, true, 'the pending request is aborted');
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B], 'the queue moves on to the other webhook');
    assert.match(logText(), /timeout, attempt 1\/3/);

    await advance(RETRY_DELAY);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B, HOOK_A], 'the timed-out message is retried');
    assert.equal(posts[2].body.embeds[0].title, 'Event stuck');
    assertSanitized();
});

test('AC-1/AC-3: repeated timeouts end in an explicit failure and later work still sends', async () => {
    responses.push(hang, hang, hang);
    queueDiscordMessage(HOOK_A, { embeds: [embed('stuck')] });
    await advance(100);
    for (let i = 0; i < DISCORD_MAX_ATTEMPTS; i++) await elapse(DISCORD_REQUEST_TIMEOUT + RETRY_DELAY);
    assert.equal(posts.length, DISCORD_MAX_ATTEMPTS);
    assert.match(logText(), /Dropped message for hook#[0-9a-f]{8}: timeout after 3 attempt\(s\)/);

    await advance(DELAY_BETWEEN_MESSAGES);
    queueDiscordMessage(HOOK_B, { embeds: [embed('later')] });
    await advance(100);
    assert.equal(posts.length, DISCORD_MAX_ATTEMPTS + 1);
    assert.equal(posts.at(-1).url, HOOK_B);
    assertSanitized();
});

test('AC-2: a rate-limited webhook waits while other webhooks progress with 2000ms spacing', async () => {
    responses.push(rateLimited(3)); // 3000ms + 500ms buffer
    queueDiscordMessage(HOOK_A, { embeds: [embed('a1')] });
    await advance(100);
    const t0 = startOffset();
    queueDiscordMessage(HOOK_A, { embeds: [embed('a2')] });
    queueDiscordMessage(HOOK_B, { embeds: [embed('b')] });
    await elapse(20_000);

    assert.deepEqual(posts.map(p => [p.url, p.body.embeds[0].title]), [
        [HOOK_A, 'Event a1'],
        [HOOK_B, 'Event b'],        // other destination is not blocked by the 429
        [HOOK_A, 'Event a1'],       // retried before later items for the same webhook
        [HOOK_A, 'Event a2'],
    ]);
    assert.ok(posts[2].at - t0 >= 3500, 'retry is no earlier than retry_after');
    for (let i = 1; i < posts.length; i++) {
        assert.ok(posts[i].at - posts[i - 1].at >= DELAY_BETWEEN_MESSAGES, `POST ${i} keeps the global gap`);
    }
    assertSanitized();
});

test('AC-2: sustained fresh traffic for another webhook cannot starve an eligible rate-limit retry', async () => {
    responses.push(rateLimited(5)); // 5000ms + 500ms buffer
    queueDiscordMessage(HOOK_A, { embeds: [embed('a')] });
    await advance(100);
    const t0 = startOffset();
    // A new B alert arrives every second, so a fresh item is always waiting when A becomes eligible.
    for (let i = 0; i < 12; i++) {
        queueDiscordMessage(HOOK_B, { embeds: [embed(`b${i}`)] });
        await elapse(1000);
    }

    const retry = posts.findIndex((p, i) => i > 0 && p.url === HOOK_A);
    assert.ok(retry !== -1, `A is retried: ${posts.map(p => p.body.embeds[0].title).join(', ')}`);
    assert.ok(retry <= 3, `A is retried within a bounded number of dispatches (index ${retry})`);
    assert.ok(posts[retry].at - t0 >= 5500, 'retry is no earlier than retry_after');
    assert.ok(posts.slice(retry + 1).some(p => p.url === HOOK_B), 'B keeps moving after the retry');
    for (let i = 1; i < posts.length; i++) {
        assert.ok(posts[i].at - posts[i - 1].at >= DELAY_BETWEEN_MESSAGES, `POST ${i} keeps the global gap`);
    }
    assertSanitized();
});

test('AC-2: new work wakes a dispatcher sleeping on a long rate limit', async () => {
    responses.push(rateLimited(30));
    queueDiscordMessage(HOOK_A, { embeds: [embed('a')] });
    await advance(100);
    await advance(10_000);
    assert.equal(posts.length, 1);
    queueDiscordMessage(HOOK_B, { embeds: [embed('b')] });
    await advance(100);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B], 'B is sent without waiting for A\'s 30s pause');
    assert.equal(posts[1].at - startOffset(), 10_100);
});

test('AC-2: malformed retry_after uses a bounded fallback and gives up after repeated 429s', async () => {
    const bad = ['soon', -1, null, { s: 1 }, '', 'NaN'];
    for (const value of bad) responses.push(rateLimited(value));
    queueDiscordMessage(HOOK_A, { embeds: [embed('limited')] });
    await advance(100);
    await advance(DISCORD_RATE_LIMIT_FALLBACK - 1);
    assert.equal(posts.length, 1, 'malformed delay is not a tight loop');
    await advance(1);
    assert.equal(posts.length, 2);

    await elapse(10 * DISCORD_RATE_LIMIT_FALLBACK);
    assert.equal(posts.length, DISCORD_MAX_RATE_LIMITS + 1, 'retries stop after the rate-limit budget');
    assert.match(logText(), /Dropped message for hook#[0-9a-f]{8}: rate_limit \(HTTP 429\) after 6 attempt\(s\), 6 rate limited/);
    assertSanitized();
});

test('AC-2: a huge retry_after is capped instead of sleeping indefinitely', async () => {
    responses.push(rateLimited(1e12));
    queueDiscordMessage(HOOK_A, { embeds: [embed('limited')] });
    await advance(100);
    await advance(DISCORD_MAX_RETRY_AFTER - 1);
    assert.equal(posts.length, 1);
    await advance(1);
    assert.equal(posts.length, 2);
});

test('AC-3: 5xx retries are bounded, then the item fails and the queue continues', async () => {
    // Responses are consumed in POST order. A's retry is due when the 2000ms gap ends, and A was queued
    // first, so it keeps its place until its attempts are exhausted: A, A, A, B.
    responses.push(json(503, { message: 'payload-secret' }), json(502, {}), json(500, {}), new Response(null, { status: 204 }));
    queueDiscordMessage(HOOK_A, { embeds: [embed('a')] });
    queueDiscordMessage(HOOK_B, { embeds: [embed('b')] });
    await elapse(30_000);

    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_A, HOOK_A, HOOK_B]);
    assert.match(logText(), /server \(HTTP 503\), attempt 1\/3/);
    assert.match(logText(), /Dropped message for hook#[0-9a-f]{8}: server \(HTTP 500\) after 3 attempt\(s\)/);
    assertSanitized();
});

test('AC-3: a network error is retried and its URL-bearing message is never logged', async () => {
    responses.push(() => { const e = new Error(`request to ${HOOK_A} failed, reason: socket hang up`); e.code = 'ECONNRESET'; throw e; });
    queueDiscordMessage(HOOK_A, { embeds: [embed('a')] });
    await elapse(100 + RETRY_DELAY);
    assert.equal(posts.length, 2);
    assert.match(logText(), /network, attempt 1\/3/);
    assertSanitized();
});

test('AC-3: a 4xx other than 429 is permanent and does not block later items', async () => {
    responses.push(json(400, { code: 50035, message: 'Invalid Form Body', errors: { embeds: 'payload-secret' } }));
    queueDiscordMessage(HOOK_A, { embeds: [embed('bad')] });
    queueDiscordMessage(HOOK_B, { embeds: [embed('good')] });
    await elapse(30_000);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B], 'the 400 is not retried');
    assert.match(logText(), /Dropped message for hook#[0-9a-f]{8}: client \(HTTP 400\) after 1 attempt\(s\)/);
    assertSanitized();
});

test('AC-4: after the queue goes idle, a later item starts processing', async () => {
    queueDiscordMessage(HOOK_A, { embeds: [embed('first')] });
    await advance(100);
    await elapse(30_000);
    queueDiscordMessage(HOOK_B, { embeds: [embed('second')] });
    await advance(100);
    assert.deepEqual(posts.map(p => p.url), [HOOK_A, HOOK_B]);
});

test('AC-4: an unexpected error while sending resets queue state', async () => {
    const circular = { title: 'loop' };
    circular.self = circular; // JSON.stringify throws before any request
    queueDiscordMessage(HOOK_A, { embeds: [circular] });
    await advance(100);
    queueDiscordMessage(HOOK_B, { embeds: [embed('after')] });
    await elapse(100 + DELAY_BETWEEN_MESSAGES);
    assert.deepEqual(posts.map(p => p.url), [HOOK_B]);
    assert.match(logText(), /Dropped message for hook#[0-9a-f]{8}: unexpected/);
});

test('AC-4: sendAndGetMessageId returns the created message ID and editDiscordMessage returns true', async () => {
    responses.push(json(200, { id: '123456' }), json(200, { id: '123456' }));
    assert.equal(await sendAndGetMessageId(HOOK_A, { content: 'x' }), '123456');
    assert.equal(posts[0].url, `${HOOK_A}?wait=true`);
    assert.equal(posts[0].method, 'POST');
    assert.equal(await editDiscordMessage(HOOK_A, '123456', { content: 'y' }), true);
    assert.equal(posts[1].url, `${HOOK_A}/messages/123456`);
    assert.equal(posts[1].method, 'PATCH');
});

test('AC-1/AC-4: direct sends are bounded by the deadline and return their failure values', async () => {
    responses.push(hang, hang, hang);
    const pending = sendAndGetMessageId(HOOK_A, { content: 'x' });
    for (let i = 0; i < DISCORD_MAX_ATTEMPTS; i++) await elapse(DISCORD_REQUEST_TIMEOUT + RETRY_DELAY);
    assert.equal(await pending, null);
    assert.equal(posts.length, DISCORD_MAX_ATTEMPTS);

    responses.push(json(404, { code: 10008, message: 'Unknown Message' }));
    assert.equal(await editDiscordMessage(HOOK_A, '999', { content: 'y' }), false);
    assert.equal(posts.length, DISCORD_MAX_ATTEMPTS + 1, 'a 404 edit is not retried');
    assertSanitized();
});
