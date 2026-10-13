// deliveryHealth.mjs - specs/tasks/2026-10-notification-progress-health.md (AC-1, AC-2, AC-4)
// Tells an idle system apart from a delivery backlog or a stuck sender.
//   - idle:      nothing waits to be sent (healthy even when no game event happens for hours)
//   - backlog:   notifications wait, and sends are completing or the waiting ones are not due yet
//                (429 pause, retry delay, outbox backoff, batch window)
//   - stalled:   due notifications exist and no send attempt has completed for DELIVERY_STALL_AFTER;
//                after DELIVERY_UNHEALTHY_AFTER the loopback probe answers 503
//   - recovered: a stall cleared within the last DELIVERY_RECOVERED_WINDOW
// "Completed" means Discord answered or the attempt failed (timeout, network, 4xx/5xx, 429); a failing but
// live sender is a backlog with a failure category, not a stall.
// Reports carry counts, ages, times, and a failure category only: never a webhook URL or payload.
import { getDiscordQueueProgress } from './utils.js';
import { notificationOutbox } from './notificationDispatcher.js';
import { WARN, INFO } from './app_modules/core.js';
import { DELIVERY_STALL_AFTER, DELIVERY_UNHEALTHY_AFTER, DELIVERY_RECOVERED_WINDOW } from './webhooks.js';

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const seconds = ms => `${Math.round(ms / 1000)}s`;

/**
 * Read-only progress of the in-memory send queue and the active account's outbox.
 * @returns {Promise<{ now: number, queue: ReturnType<typeof getDiscordQueueProgress>, outbox: { due: number, dueSince: number|null } }>}
 */
export async function deliverySnapshot({ queue = getDiscordQueueProgress, outbox = notificationOutbox, now = Date.now } = {}) {
    const t = now();
    const dispatcher = outbox();
    return {
        now: t,
        queue: queue(t),
        outbox: dispatcher ? await dispatcher.progress() : { due: 0, dueSince: null },
    };
}

/**
 * Pure classification of a snapshot into idle, backlog, or stalled (the monitor adds 'recovered').
 */
export function classifyDelivery({ now, queue, outbox }, { stallAfter = DELIVERY_STALL_AFTER, unhealthyAfter = DELIVERY_UNHEALTHY_AFTER } = {}) {
    const pending = queue.queued + queue.batched + outbox.due;
    const dueTimes = [queue.dueSince, outbox.due > 0 ? outbox.dueSince : null].filter(Number.isFinite);
    const dueSince = dueTimes.length ? Math.min(...dueTimes) : null;
    // Time without a completed attempt while work was due: measured from whichever is later, the moment
    // the oldest due notification became due or the last completed attempt.
    const stalledForMs = dueSince === null ? 0 : Math.max(0, now - Math.max(dueSince, queue.lastAttemptAt ?? -Infinity));
    const stalled = dueSince !== null && stalledForMs >= stallAfter;
    const failure = queue.lastFailure;
    return {
        state: stalled ? 'stalled' : pending > 0 ? 'backlog' : 'idle',
        unhealthy: dueSince !== null && stalledForMs >= unhealthyAfter,
        pending,
        queued: queue.queued + queue.batched,
        outboxDue: outbox.due,
        oldestDueAgeMs: dueSince === null ? null : Math.max(0, now - dueSince),
        attemptAgeMs: Number.isFinite(queue.attemptStartedAt) ? Math.max(0, now - queue.attemptStartedAt) : null,
        stalledForMs: stalled ? stalledForMs : 0,
        lastProgressAt: iso(queue.lastAttemptAt),
        lastSuccessAt: iso(queue.lastSuccessAt),
        lastFailure: failure ? { category: failure.category, ...(failure.status ? { status: failure.status } : {}), at: iso(failure.at) } : null,
        thresholds: { stallAfterMs: stallAfter, unhealthyAfterMs: unhealthyAfter },
    };
}

/**
 * Evaluates delivery progress on demand (health polls, metrics, a background timer) and logs one WARN
 * when a stall begins and one INFO when it clears, however often it is polled.
 */
export function createDeliveryMonitor({ snapshot = deliverySnapshot, warn = WARN, info = INFO, recoveredWindow = DELIVERY_RECOVERED_WINDOW, ...thresholds } = {}) {
    let stalledSince = null;
    let recoveredAt = null;
    let timer = null;

    async function check() {
        const snap = await snapshot();
        const report = classifyDelivery(snap, thresholds);
        // Transitions are applied synchronously after the await, so concurrent checks log once.
        if (report.state === 'stalled' && stalledSince === null) {
            stalledSince = snap.now - report.stalledForMs;
            recoveredAt = null;
            const failure = report.lastFailure ? `; last failure: ${report.lastFailure.category}${report.lastFailure.status ? ` (HTTP ${report.lastFailure.status})` : ''}` : '';
            warn('Delivery', `Notification delivery stalled: ${report.pending} pending, oldest due ${seconds(report.oldestDueAgeMs)} ago, no send attempt completed for ${seconds(report.stalledForMs)}${failure}.`);
        } else if (report.state !== 'stalled' && stalledSince !== null) {
            info('Delivery', `Notification delivery recovered after ${seconds(snap.now - stalledSince)} stalled; ${report.pending} pending.`);
            stalledSince = null;
            recoveredAt = snap.now;
        }
        if (report.state !== 'stalled' && recoveredAt !== null) {
            if (snap.now - recoveredAt < recoveredWindow) {
                report.state = 'recovered';
                report.recoveredAt = iso(recoveredAt);
            } else {
                recoveredAt = null;
            }
        }
        return report;
    }

    return {
        check,
        /** Checks periodically so stall and recovery are logged even when nothing polls health. */
        start(intervalMs = 60_000) {
            if (!timer) {
                timer = setInterval(() => check().catch(() => {}), intervalMs); // a failed read changes nothing
                timer.unref?.();
            }
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
    };
}

/** The process-wide monitor used by the probe, the owner API, and metrics. */
export const deliveryMonitor = createDeliveryMonitor();
