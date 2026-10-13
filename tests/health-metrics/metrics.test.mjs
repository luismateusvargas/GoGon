// tests/health-metrics/metrics.test.mjs - specs/tasks/2026-10-notification-progress-health.md AC-2, AC-HLTH-002
// Drives the real Discord send queue (utils.js) through success, batching, timeout and retry, rate limit,
// and permanent failure, and checks that the metrics counters, last progress time, and pending count
// follow the actual outcomes. node-fetch and the clock are mocked, so no webhook is called; the URLs
// below are fixtures and must never appear in the metrics.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const responses = []; // scripted Responses or () => Promise; empty means 204 No Content
let posts = 0;
mock.module('node-fetch', {
    defaultExport: async () => {
        posts++;
        const next = responses.shift();
        if (typeof next === 'function') return next();
        return next ?? new Response(null, { status: 204 });
    },
});
mock.module(new URL('../../engine.js', import.meta.url).href, {
    namedExports: { getTasksStatus: () => [{ name: 'A', isActive: true, overdue: true }, { name: 'B', isActive: true, overdue: false }] },
});

const { queueDiscordMessage, getDiscordQueueProgress } = await import('../../utils.js');
const { getMetrics } = await import('../../metrics.mjs');
const { metricCounters } = await import('../../app_modules/metricsStore.js');
const { DISCORD_MAX_ATTEMPTS, DISCORD_REQUEST_TIMEOUT, RETRY_DELAY, DISCORD_MAX_RETRY_AFTER } = await import('../../webhooks.js');

const HOOK_A = 'https://discord.com/api/webhooks/0/fixture-metrics-a';
const HOOK_B = 'https://discord.com/api/webhooks/0/fixture-metrics-b';
const message = i => ({ content: '', embeds: [{ title: `Secret event ${i}`, description: `payload-secret-${i}` }] });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const elapse = async ms => { for (let t = 0; t < ms; t += 100) { mock.timers.tick(Math.min(100, ms - t)); await settle(); } };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hang = () => new Promise(() => {});

let epoch = 0;
let before;
const delta = () => {
    const now = metricCounters();
    return Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - before[k]]).filter(([, v]) => v !== 0));
};

beforeEach(() => {
    responses.length = 0;
    posts = 0;
    epoch += 10_000_000;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 + epoch });
    for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
    before = metricCounters();
});
afterEach(async () => {
    responses.length = 0;
    await elapse(5 * DISCORD_MAX_RETRY_AFTER);
    mock.timers.reset();
    mock.restoreAll();
});

function assertNoSecrets(value) {
    const text = JSON.stringify(value);
    for (const secret of ['discord.com/api/webhooks', 'fixture-metrics', 'Secret event', 'payload-secret']) {
        assert.ok(!text.includes(secret), `metrics leak "${secret}": ${text}`);
    }
}

test('AC-2: an accepted send and a merged batch advance sent, batches and saved, and set last progress', async () => {
    queueDiscordMessage(HOOK_A, message(1));
    queueDiscordMessage(HOOK_A, message(2));
    assert.equal(getDiscordQueueProgress().batched, 2, 'messages in the batch window count as pending');
    await elapse(200);
    assert.deepEqual(delta(), { discordSent: 1, discordBatches: 1, discordMessagesSaved: 1 });
    const progress = getDiscordQueueProgress();
    assert.equal(progress.lastSuccessAt, progress.lastAttemptAt);
    assert.equal(progress.queued + progress.batched, 0);

    const metrics = await getMetrics();
    assert.equal(metrics.discord.sent, metricCounters().discordSent);
    assert.equal(metrics.delivery.state, 'idle');
    assert.equal(metrics.delivery.pending, 0);
    assert.equal(metrics.delivery.lastProgressAt, new Date(progress.lastAttemptAt).toISOString());
    assert.equal(metrics.delivery.lastSuccessAt, metrics.delivery.lastProgressAt);
    assert.equal(metrics.tasks.overdue, 1);
    assert.ok(metrics.system.memory.rss > 0, 'AC-HLTH-002 memory stats still present');
    assertNoSecrets(metrics);
});

test('AC-2: timeouts are retried a bounded number of times, then the message is dropped', async () => {
    for (let i = 0; i < DISCORD_MAX_ATTEMPTS; i++) responses.push(hang);
    queueDiscordMessage(HOOK_A, message(3));
    await elapse(150);
    assert.ok(getDiscordQueueProgress().attemptStartedAt, 'an attempt is in flight');
    assert.equal((await getMetrics()).delivery.pending, 1);
    await elapse(DISCORD_MAX_ATTEMPTS * (DISCORD_REQUEST_TIMEOUT + RETRY_DELAY));
    assert.deepEqual(delta(), {
        discordErrors: DISCORD_MAX_ATTEMPTS, discordTimeouts: DISCORD_MAX_ATTEMPTS,
        discordRetries: DISCORD_MAX_ATTEMPTS - 1, discordDropped: 1,
    });
    const metrics = await getMetrics();
    assert.deepEqual(metrics.delivery.lastFailure, { category: 'timeout', at: metrics.delivery.lastProgressAt });
    assert.notEqual(metrics.delivery.lastSuccessAt, metrics.delivery.lastProgressAt, 'the last attempt failed');
    assert.equal(metrics.discord.timeouts, metricCounters().discordTimeouts);
    assert.equal(metrics.discord.dropped, metricCounters().discordDropped);
    assertNoSecrets(metrics);
});

test('AC-2: a 429 counts as a rate limit, not a retry; a 4xx is a permanent failure', async () => {
    responses.push(json(429, { message: 'rate limited', retry_after: 1, global: false }));
    queueDiscordMessage(HOOK_A, message(4));
    await elapse(150);
    assert.deepEqual(delta(), { discordErrors: 1, discordRateLimits: 1 });
    const waiting = await getMetrics();
    assert.equal(waiting.delivery.pending, 1, 'the rate-limited message is still pending');
    assert.equal(waiting.delivery.state, 'backlog');
    assert.deepEqual(waiting.delivery.lastFailure, { category: 'rate_limit', status: 429, at: waiting.delivery.lastProgressAt });
    await elapse(3_000);
    assert.deepEqual(delta(), { discordErrors: 1, discordRateLimits: 1, discordSent: 1 });

    responses.push(json(400, { code: 50035, message: `Invalid Form Body ${HOOK_B}` }));
    queueDiscordMessage(HOOK_B, message(5));
    await elapse(3_000);
    assert.deepEqual(delta(), { discordErrors: 2, discordRateLimits: 1, discordSent: 1, discordDropped: 1 });
    const metrics = await getMetrics();
    assert.deepEqual(metrics.delivery.lastFailure, { category: 'client', status: 400, at: metrics.delivery.lastProgressAt });
    assertNoSecrets(metrics);
});

test('AC-2: a 5xx is retried and then succeeds', async () => {
    responses.push(new Response('bad gateway', { status: 502 }));
    queueDiscordMessage(HOOK_A, message(6));
    await elapse(150 + RETRY_DELAY + 100);
    assert.deepEqual(delta(), { discordErrors: 1, discordRetries: 1, discordSent: 1 });
    assert.equal(posts, 2);
});

test('AC-2: metrics survive an unreadable outbox with the counters intact', async () => {
    const metrics = await getMetrics({ delivery: async () => { throw new Error('db down'); } });
    assert.deepEqual(metrics.delivery, { state: 'unknown' });
    assert.equal(typeof metrics.discord.sent, 'number');
    assert.deepEqual(Object.keys(metrics.outbox), ['delivered', 'retried', 'failed']);
});
