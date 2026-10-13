// _gg_data/handler/notificationOutbox.js - specs/tasks/2026-10-notification-outbox.md
// SQL for the notification_outbox table (migration 014). gg_database.claimNotification() inserts
// rows inside a monitor's dedupe transaction; notificationDispatcher.js reads due rows, records
// outcomes, and serves the owner's inspection. Rows hold a webhook setting key, never its URL; the
// owner views never include the payload.
import { EventEmitter } from 'node:events';

/** Emits 'enqueued' after new rows commit, so the dispatcher can pick them up without polling. */
export const outboxEvents = new EventEmitter();

const MAX_EVENT_ID = 128;
const MAX_SOURCE = 32;
const nowIso = () => new Date().toISOString();

// Columns the owner may see: no payload, no URL.
const VIEW_COLUMNS = 'id, source, event_id AS eventId, part, account_scope AS accountScope, setting_key AS settingKey, state, attempts, '
    + 'next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt';

/**
 * Inserts an event's notification rows in the caller's transaction. An event is identified per account
 * (source, account_scope, event_id; migration 015): two accounts may each hold rows for one game ID.
 * Without ignoreExisting (a new claim), an event that already has rows is not inserted again and
 * false is returned; the caller's list lock serializes claims of the same event. With
 * ignoreExisting, parts that already exist are skipped and the number inserted is returned.
 * @returns {Promise<boolean|number>}
 */
export async function insertOutboxRows(tx, { source, eventId, accountScope, notifications, firstPart = 0, ignoreExisting = false }) {
    const event = String(eventId);
    if (!source || source.length > MAX_SOURCE) throw new Error('[GG_DB] Invalid outbox source.');
    if (!event || event.length > MAX_EVENT_ID) throw new Error(`[GG_DB] Invalid outbox event ID for ${source}.`);
    if (!ignoreExisting) {
        const existing = await tx.query('SELECT id FROM notification_outbox WHERE source = ? AND account_scope = ? AND event_id = ? LIMIT 1', [source, accountScope, event]);
        if (existing.length) return false;
    }
    const now = nowIso();
    let inserted = 0;
    for (const [i, { settingKey, payload }] of notifications.entries()) {
        const info = await tx.query(
            `INSERT ${ignoreExisting ? 'IGNORE ' : ''}INTO notification_outbox (source, event_id, part, account_scope, setting_key, payload, state, attempts, next_attempt_at, created_at, updated_at) `
            + "VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
            [source, event, firstPart + i, accountScope, settingKey, JSON.stringify(payload), now, now, now]);
        inserted += info.affectedRows;
    }
    return ignoreExisting ? inserted : true;
}

/**
 * @param {{ query: Function, transaction: Function }} db - The migrated MySQL client (gg_database getConnection()).
 */
export function createNotificationOutboxStore(db) {
    return {
        /** Pending rows of one account that are due, oldest first, skipping rows already queued in memory. */
        async listDue({ accountScope, now = nowIso(), limit = 50, excludeIds = new Set() }) {
            const rows = await db.query(
                "SELECT id, source, event_id AS eventId, part, setting_key AS settingKey, payload, attempts FROM notification_outbox "
                + "WHERE state = 'pending' AND account_scope = ? AND next_attempt_at <= ? ORDER BY id LIMIT ?",
                [accountScope, now, limit + excludeIds.size]);
            return rows.filter(r => !excludeIds.has(Number(r.id))).slice(0, limit).map(r => ({
                ...r, id: Number(r.id), attempts: Number(r.attempts), payload: JSON.parse(r.payload),
            }));
        },

        /** Discord accepted these rows. Only pending rows change, so a late ack cannot revive a discarded row. */
        async markDelivered(ids, now = nowIso()) {
            if (!ids.length) return 0;
            const info = await db.query(
                `UPDATE notification_outbox SET state = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL WHERE state = 'pending' AND id IN (${ids.map(() => '?').join(', ')})`,
                [now, now, ...ids]);
            return info.affectedRows;
        },

        /**
         * Records a failed delivery round: the row stays pending until nextAttemptAt, or becomes
         * 'failed' when terminal. error is a sanitized label such as 'server (HTTP 503)'.
         */
        async recordFailure(id, { error, terminal, nextAttemptAt, now = nowIso() }) {
            const info = await db.query(
                'UPDATE notification_outbox SET attempts = attempts + 1, state = ?, next_attempt_at = ?, last_error = ?, updated_at = ? '
                + "WHERE id = ? AND state = 'pending'",
                [terminal ? 'failed' : 'pending', terminal ? now : nextAttemptAt, String(error).slice(0, 64), now, id]);
            return info.affectedRows === 1;
        },

        /** Counts by state and account, for the owner and health views. */
        /**
         * Count of one account's pending rows that are due, and the earliest next_attempt_at among them,
         * leaving out excludeIds (rows already queued in memory).
         */
        async dueSummary({ accountScope, now = nowIso(), excludeIds = new Set() }) {
            const ids = [...excludeIds];
            const [row] = await db.query(
                "SELECT COUNT(*) AS n, MIN(next_attempt_at) AS dueSince FROM notification_outbox "
                + "WHERE state = 'pending' AND account_scope = ? AND next_attempt_at <= ?"
                + (ids.length ? ` AND id NOT IN (${ids.map(() => '?').join(', ')})` : ''),
                [accountScope, now, ...ids]);
            return { due: Number(row?.n ?? 0), dueSince: row?.dueSince ?? null };
        },

        async summary() {
            const rows = await db.query(
                'SELECT state, account_scope AS accountScope, COUNT(*) AS n, MIN(created_at) AS oldest FROM notification_outbox GROUP BY state, account_scope');
            return rows.map(r => ({ ...r, n: Number(r.n) }));
        },

        /** Failed rows and pending rows that have failed at least once or belong to another account. */
        async listAttention({ activeScope, limit = 100 }) {
            return db.query(
                `SELECT ${VIEW_COLUMNS} FROM notification_outbox `
                + "WHERE state = 'failed' OR (state = 'pending' AND (attempts > 0 OR account_scope <> ?)) ORDER BY id DESC LIMIT ?",
                [activeScope ?? '', limit]);
        },

        /** Owner action: a failed row becomes pending again with a fresh attempt budget. */
        async retry(id, now = nowIso()) {
            const info = await db.query(
                "UPDATE notification_outbox SET state = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'failed'",
                [now, now, id]);
            return info.affectedRows === 1;
        },

        /** Owner action: removes a failed row. The event stays in the monitor's dedupe list. */
        async discard(id) {
            const info = await db.query("DELETE FROM notification_outbox WHERE id = ? AND state = 'failed'", [id]);
            return info.affectedRows === 1;
        },

        /** Deletes delivered rows older than the cutoff; pending and failed rows are kept. */
        async pruneDelivered(before) {
            const info = await db.query("DELETE FROM notification_outbox WHERE state = 'delivered' AND delivered_at < ?", [before]);
            return info.affectedRows;
        },
    };
}
