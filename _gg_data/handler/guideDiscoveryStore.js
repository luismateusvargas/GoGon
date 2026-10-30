// _gg_data/handler/guideDiscoveryStore.js - CAT-TASK-009 / AC-CAT-011, AC-CAT-012, AC-CAT-013, AC-CAT-015
// Repository for guide discovery (tables in migration 006): one checkpoint row per guide kind, one
// refresh row per guide ID, and a per-UTC-day request counter for visibility. The
// sweep planner that decides what to read next is catalog/guideRelay.js; this module only persists.
// Every statement is parameterized; column names come only from STATE_COLUMNS.

import { GUIDE_KINDS } from '../../catalog/contracts/guide.js';
export { GUIDE_KINDS };
export const DETAIL_OUTCOMES = Object.freeze(['ok', 'failed', 'missing']);

// camelCase field -> column, for the checkpoint row.
const STATE_COLUMNS = Object.freeze({
    lastSeenId: 'last_seen_id',
    lastSuccessfulCheckAt: 'last_successful_check_at',
    lastFullSweepAt: 'last_full_sweep_at',
    lastPageSeen: 'last_page_seen',
    sweepMode: 'sweep_mode',
    sweepStartedAt: 'sweep_started_at',
    nextPage: 'next_page',
    sweepPagesChecked: 'sweep_pages_checked',
    sweepMaxId: 'sweep_max_id',
    sweepPrevMinId: 'sweep_prev_min_id',
    sweepPrevPageIds: 'sweep_prev_page_ids',
    stopAfterPage: 'stop_after_page',
    orderState: 'order_state',
    status: 'status',
    statusReason: 'status_reason',
});
const INT_FIELDS = new Set(['lastSeenId', 'lastPageSeen', 'nextPage', 'sweepPagesChecked', 'sweepMaxId', 'sweepPrevMinId', 'stopAfterPage']);
const HOUR = 3600_000;

const stateRow = r => {
    if (!r) return null;
    const out = { entityKind: r.entity_kind, updatedAt: r.updated_at };
    for (const [field, col] of Object.entries(STATE_COLUMNS)) {
        const v = r[col];
        out[field] = v === null || v === undefined ? null : field === 'sweepPrevPageIds' ? JSON.parse(v) : INT_FIELDS.has(field) ? Number(v) : v;
    }
    return out;
};

const kindOk = kind => {
    if (!GUIDE_KINDS.includes(kind)) throw Object.assign(new Error('Unknown guide kind.'), { code: 'invalid' });
};
const idOk = id => {
    if (!(Number.isSafeInteger(id) && id > 0)) throw Object.assign(new Error('Guide IDs are positive integers.'), { code: 'invalid' });
};

/**
 * @param {{ query: Function, transaction: Function }} db
 * @param {{ now?: () => number }} [opts]
 */
export function createGuideDiscoveryStore(db, { now = Date.now } = {}) {
    const iso = (t = now()) => new Date(t).toISOString();

    return {
        async listStates(q = db) {
            return (await q.query('SELECT * FROM catalog_guide_state ORDER BY entity_kind')).map(stateRow);
        },

        async getState(kind, q = db, { lock = false } = {}) {
            kindOk(kind);
            const [r] = await q.query(`SELECT * FROM catalog_guide_state WHERE entity_kind = ?${lock ? ' FOR UPDATE' : ''}`, [kind]);
            return stateRow(r);
        },

        /** Sets allow-listed checkpoint fields (camelCase); unknown fields are a programming error. */
        async updateState(kind, fields, q = db) {
            kindOk(kind);
            const sets = [];
            const params = [];
            for (const [field, value] of Object.entries(fields)) {
                const col = STATE_COLUMNS[field];
                if (!col) throw new Error(`Unknown guide state field ${field}.`);
                sets.push(`${col} = ?`);
                params.push(field === 'sweepPrevPageIds' && value !== null ? JSON.stringify(value) : value);
            }
            sets.push('updated_at = ?');
            params.push(iso(), kind);
            await q.query(`UPDATE catalog_guide_state SET ${sets.join(', ')} WHERE entity_kind = ?`, params);
        },

        /** Existing snapshot items and creatures are tracked as pending details, due now (DEC-CAT-023). */
        async scheduleSeededDetails() {
            const at = iso();
            await db.transaction(async tx => {
                for (const [kind, table] of [['item', 'items'], ['creature', 'creatures']]) {
                    await tx.query(
                        `INSERT IGNORE INTO catalog_guide_ids (entity_kind, entity_id, first_seen_at, next_detail_at)
                         SELECT ?, id, ?, ? FROM ${table}`,
                        [kind, at, at]);
                }
            });
        },

        /**
         * Records IDs seen on a validated index page. New IDs become pending details (due now).
         * @returns {Promise<number[]>} the IDs that were not known before
         */
        async recordIndexIds(kind, ids, q = db, { scanStartedAt = iso() } = {}) {
            kindOk(kind);
            const uniqueIds = [...new Set(ids)];
            uniqueIds.forEach(idOk);
            if (!uniqueIds.length) return [];
            const at = iso();
            const placeholders = uniqueIds.map(() => '?').join(', ');
            const existing = await q.query(
                `SELECT entity_id FROM catalog_guide_ids WHERE entity_kind = ? AND entity_id IN (${placeholders})`,
                [kind, ...uniqueIds]);
            const knownIds = new Set(existing.map(row => Number(row.entity_id)));
            const fresh = [];
            for (const id of uniqueIds) {
                if (knownIds.has(id)) continue;
                const { affectedRows } = await q.query(
                    'INSERT IGNORE INTO catalog_guide_ids (entity_kind, entity_id, first_seen_at, last_index_seen_at, next_detail_at) VALUES (?, ?, ?, ?, ?)',
                    [kind, id, at, at, at]);
                if (affectedRows) fresh.push(id);
            }
            if (knownIds.size) await q.query(
                `UPDATE catalog_guide_ids SET last_index_seen_at = ? WHERE entity_kind = ? AND entity_id IN (${placeholders})`,
                [at, kind, ...uniqueIds]);
            // An event entry can return after its detail previously answered 404. Capture it now.
            await q.query(
                `UPDATE catalog_guide_ids SET detail_status = 'pending', next_detail_at = ?
                 WHERE entity_kind = ? AND entity_id IN (${placeholders}) AND detail_status = 'missing'`,
                [at, kind, ...uniqueIds]);
            // A previously fetched page is not proof that the stored entity is fulfilled. Check
            // each ID against catalog completeness, even if its ID is old or was already tracked.
            const tracked = await q.query(
                `SELECT g.entity_id, g.detail_checked_at, e.completeness FROM catalog_guide_ids g
                 LEFT JOIN catalog_entities e ON e.entity_kind = g.entity_kind
                 AND e.entity_key = COALESCE(g.entity_key, CAST(g.entity_id AS CHAR))
                 WHERE g.entity_kind = ? AND g.entity_id IN (${placeholders}) AND g.detail_status = 'ok'`, [kind, ...uniqueIds]);
            for (const row of tracked) {
                if (row.completeness === 'complete' || row.detail_checked_at && row.detail_checked_at >= scanStartedAt) continue;
                await q.query("UPDATE catalog_guide_ids SET detail_status = 'pending', next_detail_at = ? WHERE entity_kind = ? AND entity_id = ?", [at, kind, row.entity_id]);
            }
            return fresh;
        },

        /** Registers IDs discovered through another page (a realm's creatures) as pending details. */
        async registerIds(kind, ids, q = db) {
            kindOk(kind);
            const at = iso();
            for (const id of ids) {
                idOk(id);
                await q.query('INSERT IGNORE INTO catalog_guide_ids (entity_kind, entity_id, first_seen_at, next_detail_at) VALUES (?, ?, ?, ?)', [kind, id, at, at]);
            }
        },

        /** Incomplete details due by now: never-read first. Completed details are never re-read. */
        async dueDetails(kind, limit, q = db) {
            kindOk(kind);
            const l = Math.min(Math.max(0, limit | 0), 500);
            if (!l) return [];
            const rows = await q.query(
                `SELECT g.entity_id FROM catalog_guide_ids g LEFT JOIN catalog_entities e
                 ON e.entity_kind = g.entity_kind AND e.entity_key = COALESCE(g.entity_key, CAST(g.entity_id AS CHAR))
                 WHERE g.entity_kind = ? AND (g.detail_status <> 'ok' OR e.completeness IS NULL OR e.completeness <> 'complete') AND g.next_detail_at <= ?
                 ORDER BY CASE WHEN g.detail_status = 'pending' THEN 0 ELSE 1 END, g.next_detail_at, g.entity_id LIMIT ${l}`, [kind, iso()]);
            return rows.map(r => Number(r.entity_id));
        },

        async getIdState(kind, id, q = db) {
            const [r] = await q.query('SELECT * FROM catalog_guide_ids WHERE entity_kind = ? AND entity_id = ?', [kind, id]);
            return r ? {
                status: r.detail_status, hash: r.detail_hash, checkedAt: r.detail_checked_at, entityKey: r.entity_key ?? null,
                attempts: Number(r.detail_attempts), nextDetailAt: r.next_detail_at, lastIndexSeenAt: r.last_index_seen_at,
            } : null;
        },

        /** Finds Guide tracking for a natural catalog key.
         * @param {string} kind Guide kind.
         * @param {string} key Catalog realm/name key.
         * @returns {Promise<object|null>} Detail state or null if never linked to a Guide ID.
         */
        async getStateForEntityKey(kind, key) {
            kindOk(kind);
            const [row] = await db.query('SELECT entity_id FROM catalog_guide_ids WHERE entity_kind = ? AND entity_key = ? LIMIT 1', [kind, key]);
            return row ? this.getIdState(kind, Number(row.entity_id)) : null;
        },

        /** Links a Guide ID to the catalog key (relics/quests retain their realm/name identity).
         * @param {string} kind Entity kind.
         * @param {number} id Guide ID.
         * @param {string} key Catalog key.
         * @param {object} [q] Transaction connection.
         * @returns {Promise<void>}
         */
        async setEntityKey(kind, id, key, q = db) {
            kindOk(kind);
            idOk(id);
            await q.query('UPDATE catalog_guide_ids SET entity_key = ? WHERE entity_kind = ? AND entity_id = ?', [key, kind, id]);
        },

        /**
         * Records one detail read. Missing pages are retried after policy.detailRefreshAfterMs;
         * A successful page read is retried only if the stored catalog record remains incomplete.
         * failed backs off (1 h, 2 h, 4 h, ...) and becomes status 'failed' after maxDetailAttempts.
         * @returns {Promise<{ changed: boolean }>} changed: an ok page whose content hash differs
         */
        async markDetail(kind, id, { outcome, hash = null }, policy, q = db) {
            kindOk(kind);
            idOk(id);
            if (!DETAIL_OUTCOMES.includes(outcome)) throw new Error('Unknown detail outcome.');
            const t = now();
            const at = iso(t);
            await this.registerIds(kind, [id], q);
            const [cur] = await q.query('SELECT detail_status, detail_hash, detail_attempts FROM catalog_guide_ids WHERE entity_kind = ? AND entity_id = ?', [kind, id]);
            if (outcome === 'failed') {
                const attempts = Number(cur.detail_attempts) + 1;
                const exhausted = attempts >= policy.maxDetailAttempts;
                const next = exhausted ? t + policy.detailRefreshAfterMs : t + Math.min(HOUR * 2 ** (attempts - 1), policy.detailRefreshAfterMs);
                await q.query('UPDATE catalog_guide_ids SET detail_attempts = ?, detail_status = ?, next_detail_at = ? WHERE entity_kind = ? AND entity_id = ?',
                    [exhausted ? 0 : attempts, exhausted ? 'failed' : cur.detail_status, iso(next), kind, id]);
                return { changed: false };
            }
            const changed = outcome === 'ok' && cur.detail_hash !== hash;
            await q.query('UPDATE catalog_guide_ids SET detail_status = ?, detail_hash = ?, detail_checked_at = ?, detail_attempts = 0, next_detail_at = ? WHERE entity_kind = ? AND entity_id = ?',
                [outcome, outcome === 'ok' ? hash : null, at, iso(t + policy.detailRefreshAfterMs), kind, id]);
            return { changed };
        },

        /** Per-kind detail coverage for the Catalog tab. */
        async coverage(q = db) {
            const rows = await q.query('SELECT entity_kind, detail_status, COUNT(*) AS n FROM catalog_guide_ids GROUP BY entity_kind, detail_status');
            const out = Object.fromEntries(GUIDE_KINDS.map(k => [k, { pending: 0, ok: 0, failed: 0, missing: 0 }]));
            for (const r of rows) if (out[r.entity_kind]) out[r.entity_kind][r.detail_status] = Number(r.n);
            return out;
        },

        // --- guide request accounting (AC-CAT-015) ---

        dayOf: (t = now()) => iso(t).slice(0, 10),

        async usage(day = this.dayOf(), q = db) {
            const [r] = await q.query('SELECT requests FROM catalog_guide_usage WHERE day = ?', [day]);
            return r ? Number(r.requests) : 0;
        },

        async addUsage(n, q = db, day = this.dayOf()) {
            if (!(Number.isSafeInteger(n) && n >= 0)) throw new Error('Usage must be a non-negative integer.');
            await q.query('INSERT INTO catalog_guide_usage (day, requests) VALUES (?, ?) AS new ON DUPLICATE KEY UPDATE requests = catalog_guide_usage.requests + new.requests', [day, n]);
        },

        /** Gives back reserved requests that were not made (never below zero). */
        async refundUsage(n, q = db, day = this.dayOf()) {
            if (!(Number.isSafeInteger(n) && n >= 0)) throw new Error('Usage must be a non-negative integer.');
            if (!n) return;
            await q.query('UPDATE catalog_guide_usage SET requests = CASE WHEN requests > ? THEN requests - ? ELSE 0 END WHERE day = ?', [n, n, day]);
        },
    };
}
