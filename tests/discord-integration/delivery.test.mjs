// tests/discord-integration/delivery.test.mjs - DISC-TASK-005 / AC-DISC-005, AC-DISC-006
// Webhook batching and rate limiting in utils.js. node-fetch is mocked and the clock is mocked,
// so no webhook is ever called. The webhook URLs below are fixtures, not real endpoints.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const posts = [];     // { url, body }
const responses = []; // scripted responses; empty means 204 No Content
mock.module('node-fetch', {
    defaultExport: async (url, options) => {
        posts.push({ url, body: JSON.parse(options.body) });
        return responses.shift() ?? { ok: true, status: 204 };
    },
});

const { queueDiscordMessage, flushAllBatches } = await import('../../utils.js');
const { DELAY_BETWEEN_MESSAGES } = await import('../../webhooks.js');

const HOOK_A = 'https://discord.com/api/webhooks/0/fixture-a';
const HOOK_B = 'https://discord.com/api/webhooks/0/fixture-b';
const embed = i => ({ title: `Event ${i}`, description: 'fixture' });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const advance = async ms => { mock.timers.tick(ms); await settle(); };

beforeEach(() => {
    posts.length = responses.length = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(async () => {
    await advance(10 * DELAY_BETWEEN_MESSAGES); // drain the queue so the next test starts idle
    mock.timers.reset();
});

test('AC-DISC-005: consecutive webhook posts are at least 2000ms apart', () => {
    assert.equal(DELAY_BETWEEN_MESSAGES, 2000);
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
    responses.push({ ok: false, status: 429, json: async () => ({ retry_after: 1.5 }) });
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
