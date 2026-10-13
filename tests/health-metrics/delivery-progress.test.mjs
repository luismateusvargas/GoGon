// tests/health-metrics/delivery-progress.test.mjs - specs/tasks/2026-10-notification-progress-health.md AC-1, AC-4
// Delivery progress classification (deliveryHealth.mjs), its effect on the loopback probe and the owner
// health report, and the bounded stall/recovery log events. Snapshots are scripted with a fake clock, so
// no Discord request is made. The webhook URL below is a fixture.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

mock.module(new URL('../../engine.js', import.meta.url).href, { namedExports: { getTasksStatus: () => [{ name: 'A', isActive: true }] } });
const { classifyDelivery, createDeliveryMonitor } = await import('../../deliveryHealth.mjs');
const { healthReport, createProbeHandler } = await import('../../healthCheck.mjs');
const { DELIVERY_STALL_AFTER, DELIVERY_UNHEALTHY_AFTER, DELIVERY_RECOVERED_WINDOW } = await import('../../webhooks.js');

const T0 = 1_800_000_000_000;
const HOOK = 'https://discord.com/api/webhooks/0/fixture-progress';
const MIN = 60_000;

/** A snapshot: an empty, never-used queue unless overridden. */
function snap(now, { queue = {}, outbox = {} } = {}) {
    return {
        now,
        queue: { queued: 0, batched: 0, dueSince: null, attemptStartedAt: null, lastAttemptAt: null, lastSuccessAt: null, lastFailure: null, ...queue },
        outbox: { due: 0, dueSince: null, ...outbox },
    };
}

async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

const ok = async () => {};

test('AC-1: thresholds are finite and the probe threshold is the longer, sustained one', () => {
    assert.equal(DELIVERY_STALL_AFTER, 5 * MIN);
    assert.equal(DELIVERY_UNHEALTHY_AFTER, 15 * MIN);
    assert.ok(DELIVERY_UNHEALTHY_AFTER > DELIVERY_STALL_AFTER);
    assert.equal(DELIVERY_RECOVERED_WINDOW, 15 * MIN);
});

test('AC-1: an empty queue is idle and healthy, even hours after the last game event', () => {
    for (const s of [snap(T0), snap(T0 + 12 * 3600_000, { queue: { lastAttemptAt: T0, lastSuccessAt: T0 } })]) {
        const r = classifyDelivery(s);
        assert.equal(r.state, 'idle');
        assert.equal(r.unhealthy, false);
        assert.equal(r.pending, 0);
        assert.equal(r.oldestDueAgeMs, null);
    }
});

test('AC-1: a draining backlog and work that is not due yet (429 pause, outbox backoff) are a backlog, not a stall', () => {
    // Oldest due for 20 minutes, but attempts keep completing.
    const draining = classifyDelivery(snap(T0, { queue: { queued: 40, dueSince: T0 - 20 * MIN, lastAttemptAt: T0 - 2_000 } }));
    assert.equal(draining.state, 'backlog');
    assert.equal(draining.unhealthy, false);
    // Waiting rows only: none is due (their next attempt is in the future, so dueSince is null).
    const waiting = classifyDelivery(snap(T0, { queue: { queued: 1, lastAttemptAt: T0 - 40 * MIN } }));
    assert.equal(waiting.state, 'backlog');
    assert.equal(waiting.pending, 1);
    // A just-due row after a long idle period is not a stall either.
    const fresh = classifyDelivery(snap(T0, { outbox: { due: 1, dueSince: T0 - 1_000 }, queue: { lastAttemptAt: T0 - 5 * 3600_000 } }));
    assert.equal(fresh.state, 'backlog');
});

test('AC-1: due work without a completed attempt is stalled after 5 min and unhealthy after 15 min, with ages and a sanitized outcome', () => {
    const failure = { category: 'timeout', at: T0 - 9 * MIN };
    const base = { queued: 1, dueSince: T0 - 10 * MIN, attemptStartedAt: T0 - 7 * MIN, lastAttemptAt: T0 - 9 * MIN, lastFailure: failure };
    const early = classifyDelivery(snap(T0 - 5 * MIN, { queue: base }));
    assert.equal(early.state, 'backlog', 'not yet 5 min without a completed attempt');

    const stalled = classifyDelivery(snap(T0, { queue: base, outbox: { due: 3, dueSince: T0 - 12 * MIN } }));
    assert.equal(stalled.state, 'stalled');
    assert.equal(stalled.unhealthy, false, 'the probe waits for the sustained threshold');
    assert.equal(stalled.pending, 4);
    assert.equal(stalled.outboxDue, 3);
    assert.equal(stalled.oldestDueAgeMs, 12 * MIN, 'queue age');
    assert.equal(stalled.attemptAgeMs, 7 * MIN, 'the current attempt has been in flight for 7 min');
    assert.equal(stalled.stalledForMs, 9 * MIN);
    assert.deepEqual(stalled.lastFailure, { category: 'timeout', at: new Date(T0 - 9 * MIN).toISOString() });

    const sustained = classifyDelivery(snap(T0 + 6 * MIN, { queue: base, outbox: { due: 3, dueSince: T0 - 12 * MIN } }));
    assert.equal(sustained.unhealthy, true);
    assert.ok(!JSON.stringify(sustained).includes('discord.com'));
});

test('AC-1: the probe answers 503 for a sustained stall with only the state name; an empty queue answers 200', async () => {
    let progress = classifyDelivery(snap(T0));
    const { base, close } = await serve(createProbeHandler({ report: () => healthReport({ database: ok, delivery: async () => progress }) }));
    try {
        let res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).delivery, 'idle');

        progress = classifyDelivery(snap(T0, { queue: { queued: 1, dueSince: T0 - 8 * MIN, lastFailure: { category: 'server', status: 502, at: T0 - 8 * MIN } } }));
        res = await fetch(`${base}/health`);
        assert.equal(res.status, 200, 'stalled for 8 min: reported, but the probe stays healthy');
        assert.equal((await res.json()).delivery, 'stalled');

        progress = classifyDelivery(snap(T0, { queue: { queued: 1, dueSince: T0 - 16 * MIN, lastFailure: { category: 'server', status: 502, at: T0 - 16 * MIN } } }));
        res = await fetch(`${base}/health`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.deepEqual(Object.keys(body).sort(), ['delivery', 'error', 'status', 'tasks', 'timestamp', 'uptime']);
        assert.equal(body.status, 'unhealthy');
        assert.equal(body.error, 'delivery stalled');
        assert.equal(body.delivery, 'stalled', 'no counts, ages, or failure detail on the unauthenticated probe');
    } finally { await close(); }
});

test('AC-1: the owner report carries the delivery detail; an unreadable outbox leaves the database check to decide', async () => {
    const progress = classifyDelivery(snap(T0, { queue: { queued: 2, dueSince: T0 - 6 * MIN } }));
    const owner = await healthReport({ database: ok, detail: true, delivery: async () => progress });
    assert.equal(owner.status, 'ok');
    assert.equal(owner.delivery.state, 'stalled');
    assert.equal(owner.delivery.pending, 2);
    assert.deepEqual(owner.tasks, { active: 1, total: 1, overdue: 0, overdueModules: [] });

    const unreadable = await healthReport({ database: ok, delivery: async () => { throw new Error('outbox read failed'); } });
    assert.equal(unreadable.status, 'ok');
    assert.equal(unreadable.delivery, 'unknown');
});

test('AC-4: repeated polls log one stall WARN and one recovery INFO, both redacted; recovered then returns to idle', async () => {
    let current = snap(T0);
    const warns = [];
    const infos = [];
    const monitor = createDeliveryMonitor({
        snapshot: async () => current,
        warn: (feature, msg) => warns.push(`${feature} ${msg}`),
        info: (feature, msg) => infos.push(`${feature} ${msg}`),
    });
    const stuck = now => snap(now, {
        queue: { queued: 2, dueSince: T0, lastAttemptAt: T0 - 1_000, lastFailure: { category: 'rate_limit', status: 429, at: T0 - 1_000 } },
        outbox: { due: 1, dueSince: T0 },
    });

    assert.equal((await monitor.check()).state, 'idle');
    for (let i = 0; i <= 20; i++) { // polled every 30 s for 10 minutes while stalled
        current = stuck(T0 + 5 * MIN + i * 30_000);
        await Promise.all([monitor.check(), monitor.check()]); // concurrent probe and owner polls
    }
    assert.equal((await monitor.check()).state, 'stalled');
    assert.equal(warns.length, 1, warns.join('\n'));
    assert.match(warns[0], /stalled: 3 pending, oldest due 300s ago, no send attempt completed for 300s; last failure: rate_limit \(HTTP 429\)/);
    assert.equal(infos.length, 0);

    // A send completes and the queue empties.
    current = snap(T0 + 16 * MIN, { queue: { lastAttemptAt: T0 + 16 * MIN, lastSuccessAt: T0 + 16 * MIN } });
    for (let i = 0; i < 10; i++) assert.equal((await monitor.check()).state, 'recovered');
    assert.equal(infos.length, 1);
    assert.match(infos[0], /recovered after 960s stalled; 0 pending/);
    assert.equal(warns.length, 1);

    current = snap(T0 + 16 * MIN + DELIVERY_RECOVERED_WINDOW, { queue: { lastAttemptAt: T0 + 16 * MIN } });
    assert.equal((await monitor.check()).state, 'idle', 'recovered is shown for a bounded window');
    for (const line of [...warns, ...infos]) {
        for (const secret of [HOOK, 'discord.com', 'fixture', 'payload']) assert.ok(!line.includes(secret), line);
    }

    // A failed snapshot read changes nothing and logs nothing.
    const broken = createDeliveryMonitor({ snapshot: async () => { throw new Error('db'); }, warn: m => warns.push(m), info: m => infos.push(m) });
    await assert.rejects(broken.check());
    assert.equal(warns.length + infos.length, 2);
});
