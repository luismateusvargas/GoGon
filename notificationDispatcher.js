// notificationDispatcher.js - specs/tasks/2026-10-notification-outbox.md
// Moves due notification_outbox rows of the active account into the Discord send queue (utils.js),
// which keeps its batching, two-second global spacing and bounded per-request retries. The outcome
// of each round is written back:
//   - Discord accepted -> 'delivered'. If that write fails, the row stays in memory and the ack is
//     retried; it is not re-sent unless the process restarts first (the documented duplicate window).
//   - retryable failure (timeout, network, 5xx, rate limits exhausted) -> pending with backoff, up
//     to OUTBOX_MAX_ROUNDS, then 'failed'.
//   - permanent failure (4xx other than 429, webhook setting removed) -> 'failed' at once. When Discord
//     rejects a merged batch, each row is retried as its own message first, so one bad alert cannot
//     fail the others.
// Rows of another account stay pending, untouched, until that account is active again.
import { queueDiscordMessage } from './utils.js';
import { getSetting } from './config/runtime.mjs';
import { getAccountScope } from './config/accountScope.mjs';
import { getConnection } from './_gg_data/handler/gg_database.js';
import { createNotificationOutboxStore, outboxEvents } from './_gg_data/handler/notificationOutbox.js';
import { LOG, WARN, ERR } from './app_modules/core.js';
import { incrementMetric } from './app_modules/metricsStore.js';
import {
    OUTBOX_MAX_ROUNDS, OUTBOX_RETRY_BASE, OUTBOX_RETRY_CAP, OUTBOX_POLL_INTERVAL, OUTBOX_BATCH_LIMIT, OUTBOX_DELIVERED_RETENTION,
} from './webhooks.js';

const PRUNE_EVERY = 3600_000;
const iso = ms => new Date(ms).toISOString();
const errorLabel = err => `${err?.category || 'unexpected'}${err?.status ? ` (HTTP ${err.status})` : ''}`;

/** Delay before the next round after `rounds` failed rounds. */
export function outboxBackoff(rounds) {
    return Math.min(OUTBOX_RETRY_BASE * 2 ** Math.max(0, rounds - 1), OUTBOX_RETRY_CAP);
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof createNotificationOutboxStore>} deps.store
 * @param {Function} [deps.queue] - queueDiscordMessage(webhook, payload, meta)
 * @param {(settingKey: string) => string} [deps.resolveWebhook] - the live webhook URL for a setting
 * @param {() => string|null} [deps.scope] - the active account scope
 * @param {() => number} [deps.now]
 */
export function createNotificationDispatcher({
    store, queue = queueDiscordMessage, resolveWebhook = key => getSetting(key), scope = getAccountScope,
    now = Date.now, pollMs = OUTBOX_POLL_INTERVAL, batchLimit = OUTBOX_BATCH_LIMIT,
}) {
    const inFlight = new Set();   // row IDs in the in-memory queue (or delivered and awaiting ack)
    const unacked = new Set();    // delivered rows whose 'delivered' write failed; still in inFlight
    const solo = new Set();       // rows to send unbatched after Discord rejected their batch
    let pumping = null;
    let again = false;
    let timer = null;
    let wakeScheduled = false;
    let lastPrune = -Infinity;
    // When this dispatcher began serving the current account: replayed rows (after a restart or an account
    // switch) keep their old next_attempt_at, but they only became due for this process at this time.
    let servedScope = scope();
    let servingSince = now();

    function noteScope(accountScope) {
        if (accountScope !== servedScope) {
            servedScope = accountScope;
            servingSince = now();
        }
    }

    async function retryAcks() {
        if (!unacked.size) return;
        const ids = [...unacked];
        await store.markDelivered(ids, iso(now()));
        for (const id of ids) { unacked.delete(id); inFlight.delete(id); }
    }

    async function maybePrune() {
        if (now() - lastPrune < PRUNE_EVERY) return;
        lastPrune = now();
        const removed = await store.pruneDelivered(iso(now() - OUTBOX_DELIVERED_RETENTION));
        if (removed) LOG('Outbox', `Pruned ${removed} delivered notification(s).`);
    }

    async function recordFailure(row, err, permanent) {
        const rounds = row.attempts + 1;
        const terminal = permanent || rounds >= OUTBOX_MAX_ROUNDS;
        const delay = outboxBackoff(rounds);
        const label = errorLabel(err);
        const what = `${row.source} event ${row.eventId}#${row.part} to ${row.settingKey}`;
        try {
            await store.recordFailure(row.id, { error: label, terminal, nextAttemptAt: iso(now() + delay), now: iso(now()) });
            incrementMetric(terminal ? 'outboxFailed' : 'outboxRetried');
            if (terminal) ERR('Outbox', `Notification ${what} failed: ${label} after ${rounds} round(s). Kept for owner review.`);
            else WARN('Outbox', `Notification ${what} not delivered: ${label}, round ${rounds}/${OUTBOX_MAX_ROUNDS}. Retrying in ${delay}ms.`);
        } catch (e) {
            WARN('Outbox', `Could not record the outcome of ${what}; it stays pending.`, e?.message);
        } finally {
            inFlight.delete(row.id);
            if (terminal) solo.delete(row.id);
        }
    }

    async function onSettled(row, outcome) {
        if (outcome.ok) {
            incrementMetric('outboxDelivered');
            try {
                await store.markDelivered([row.id], iso(now()));
                inFlight.delete(row.id);
                solo.delete(row.id);
            } catch (e) {
                unacked.add(row.id); // stays in inFlight: not sent again by this process
                WARN('Outbox', `Discord accepted ${row.source} event ${row.eventId}#${row.part}, but marking it delivered failed; will retry the acknowledgement.`, e?.message);
            }
            return;
        }
        if (outcome.held) { // its account is no longer active; the row stays pending for it
            inFlight.delete(row.id);
            return;
        }
        const permanent = outcome.error?.category === 'client';
        if (permanent && outcome.batchSize > 1) {
            solo.add(row.id);
            inFlight.delete(row.id);
            WARN('Outbox', `Discord rejected a batch with ${row.source} event ${row.eventId}#${row.part}: ${errorLabel(outcome.error)}. Retrying it on its own.`);
            wake();
            return;
        }
        await recordFailure(row, outcome.error, permanent);
    }

    async function pumpOnce() {
        const accountScope = scope();
        noteScope(accountScope);
        if (!accountScope) return;
        await retryAcks();
        await maybePrune();
        const rows = await store.listDue({ accountScope, now: iso(now()), limit: batchLimit, excludeIds: inFlight });
        for (const row of rows) {
            const webhook = resolveWebhook(row.settingKey);
            inFlight.add(row.id);
            if (!webhook) {
                await recordFailure(row, { category: 'unconfigured' }, true);
                continue;
            }
            queue(webhook, row.payload, { accountScope, solo: solo.has(row.id), onSettled: outcome => onSettled(row, outcome) });
        }
        if (rows.length === batchLimit) again = true; // more may be due
    }

    /** Queues every due row of the active account. Concurrent calls share one run. */
    function pump() {
        if (pumping) {
            again = true;
            return pumping;
        }
        pumping = (async () => {
            do {
                again = false;
                await pumpOnce();
            } while (again);
        })().finally(() => { pumping = null; });
        return pumping;
    }

    function wake() {
        if (wakeScheduled) return;
        wakeScheduled = true;
        setImmediate(() => {
            wakeScheduled = false;
            pump().catch(e => WARN('Outbox', 'Could not read pending notifications.', e?.message));
        });
    }

    return {
        pump,
        wake,

        /** Replays pending rows now and keeps picking up new and due rows. */
        start() {
            if (!timer) {
                outboxEvents.on('enqueued', wake);
                timer = setInterval(wake, pollMs);
                timer.unref?.();
            }
            return pump();
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            outboxEvents.off('enqueued', wake);
        },

        /** Owner view: counts and the rows needing attention, without payloads or webhook URLs. */
        async describe() {
            const activeScope = scope();
            const [summary, rows] = await Promise.all([store.summary(), store.listAttention({ activeScope })]);
            const count = state => summary.filter(r => r.state === state).reduce((n, r) => n + r.n, 0);
            return {
                activeScope,
                counts: {
                    pending: count('pending'),
                    held: summary.filter(r => r.state === 'pending' && r.accountScope !== activeScope).reduce((n, r) => n + r.n, 0),
                    failed: count('failed'),
                    delivered: count('delivered'),
                },
                oldestPendingAt: summary.filter(r => r.state === 'pending').map(r => r.oldest).sort()[0] ?? null,
                rows: rows.map(r => ({ ...r, id: Number(r.id), part: Number(r.part), attempts: Number(r.attempts) })),
            };
        },

        /**
         * Delivery progress of the active account's outbox (read-only): how many pending rows are due now
         * and since when (ms). Rows waiting for their backoff or held for another account are not due;
         * rows already in the in-memory queue are counted by that queue instead.
         */
        async progress() {
            const accountScope = scope();
            noteScope(accountScope);
            if (!accountScope) return { due: 0, dueSince: null };
            const { due, dueSince } = await store.dueSummary({ accountScope, now: iso(now()), excludeIds: inFlight });
            const since = dueSince ? Date.parse(dueSince) : NaN;
            return { due, dueSince: due ? Math.max(Number.isFinite(since) ? since : 0, servingSince) : null };
        },

        async retry(id) {
            const ok = await store.retry(id, iso(now()));
            if (ok) wake();
            return ok;
        },

        discard: id => store.discard(id),

        /** For tests and diagnostics. */
        state: () => ({ inFlight: [...inFlight], unacked: [...unacked], solo: [...solo] }),
    };
}

let dispatcher = null;

/** Starts the process-wide dispatcher once (app.mjs). Replays pending rows of the active account. */
export async function startNotificationOutbox() {
    if (!dispatcher) {
        dispatcher = createNotificationDispatcher({ store: createNotificationOutboxStore(await getConnection()) });
        await dispatcher.start();
    }
    return dispatcher;
}

/** The running dispatcher, or null before startNotificationOutbox(). */
export function notificationOutbox() {
    return dispatcher;
}
