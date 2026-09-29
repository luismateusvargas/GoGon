// catalog/catalogService.js - CAT-TASK-005 / AC-CAT-007, AC-CAT-008, AC-CAT-009, AC-CAT-010 (catalog-sync-v1 1.3.0)
// What the control plane's Catalog API calls. Browse and detail read serving rows through
// code-owned column lists (never a table or column from the request), with bounded pagination and
// strict filters. Job commands go through the store's transitions; a game job kind whose read
// contract is unverified is refused. Destructive work is plan-preview-confirm (catalogStore).
import { CatalogError } from '../_gg_data/handler/catalogStore.js';
import { GUIDE_POLICY, GAME_POLICY, fullSweepEstimate } from './contracts/policy.js';
import { GUIDE_ORDERING } from './contracts/guide.js';
import { readOperations, unavailableReason } from './requestPolicy.js';
import { describeSeedSources } from './sourceRegistry.js';

export const BROWSE_KINDS = Object.freeze(['item', 'creature', 'realm', 'master_realm', 'relic', 'quest']);
export const JOB_ACTIONS = Object.freeze({ pause: 'paused', resume: 'queued', cancel: 'cancelled' });
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE = 10_000;

// Serving columns each kind may return. JSON columns are parsed and size-bounded on the way out.
const SERVING = {
    item: { table: 'items', list: ['id', 'name', 'rarity', 'imageUrl'], detail: ['id', 'name', 'rarity', 'imageUrl', 'stats', 'enhancements', 'droppedBy', 'setBonuses', 'setId', 'setName'], json: ['stats', 'enhancements', 'droppedBy', 'setBonuses'] },
    creature: { table: 'creatures', list: ['id', 'name', 'imageUrl'], detail: ['id', 'name', 'imageUrl', 'description', 'stats', 'enhancements', 'droppedItems'], json: ['stats', 'enhancements', 'droppedItems'] },
    realm: { table: 'realms', list: ['id', 'name', 'min_level', 'master_realm_id'], detail: ['id', 'name', 'min_level', 'master_realm_id', 'shops', 'connections', 'map_objects'], json: ['shops', 'connections', 'map_objects'] },
    master_realm: { table: 'master_realms', list: ['id', 'name'], detail: ['id', 'name'], json: [] },
    relic: { table: 'relics', list: ['id', 'name', 'realm_id'], detail: ['id', 'name', 'realm_id'], json: [], natural: true },
    quest: { table: 'quests', list: ['id', 'name', 'realm_id', 'min_level'], detail: ['id', 'name', 'realm_id', 'min_level', 'details'], json: ['details'], natural: true },
};
const INT_COLUMNS = new Set(['id', 'min_level', 'master_realm_id', 'setId', 'realm_id']);
const MAX_JSON_OUT = 16 * 1024;
const COMPLETENESS = ['complete', 'incomplete'];

const invalid = (message, field) => new CatalogError('invalid', message, field ? { field } : {});
const like = v => `%${v.replace(/[!%_]/g, m => `!${m}`)}%`;   // with ESCAPE '!'

function cell(col, value, spec) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint' || INT_COLUMNS.has(col)) return Number(value);
    if (spec.json.includes(col)) {
        if (typeof value !== 'string' || value.length > MAX_JSON_OUT) return value === null ? null : { truncated: true };
        try { return JSON.parse(value); } catch { return null; }
    }
    return typeof value === 'string' ? value.slice(0, 8192) : value;
}

/**
 * @param {object} deps
 * @param {{ query: Function }} deps.db
 * @param {object} deps.store - catalogStore
 * @param {object} deps.guideStore - guideDiscoveryStore
 * @param {object} [deps.collector] - for per-job latest results
 * @param {object} [deps.operations] - read operations (test seam)
 * @param {() => number} [deps.now]
 * @param {() => string|null} [deps.relayLastSeenAt] - latest authenticated relay contact (CAT-TASK-010)
 * @param {object} [deps.seeds] - catalog/seedService.js (CAT-TASK-007)
 */
export function createCatalogService({ db, store, guideStore, collector = null, operations = readOperations(), now = Date.now, relayLastSeenAt = () => null, seeds = null }) {
    const entityKey = (kind, row) => (SERVING[kind].natural ? `${row.realm_id}:${row.name}` : String(row.id));

    async function statesFor(kind, keys) {
        if (!keys.length) return new Map();
        const rows = await db.query(`SELECT entity_key, first_seen_at, last_seen_at, completeness, incomplete_reason, verified_at FROM catalog_entities WHERE entity_kind = ? AND entity_key IN (${keys.map(() => '?').join(', ')})`, [kind, ...keys]);
        return new Map(rows.map(r => [r.entity_key, r]));
    }

    function guideStatus(state, t) {
        const last = state.lastSuccessfulCheckAt ? Date.parse(state.lastSuccessfulCheckAt) : null;
        const age = last === null ? null : t - last;
        const due = age === null || age >= GUIDE_POLICY.checkIntervalMs;
        const overdue = age === null ? Boolean(state.sweepStartedAt) : age >= 2 * GUIDE_POLICY.checkIntervalMs;
        const seen = relayLastSeenAt();
        const browserRecent = seen && t - Date.parse(seen) < 30 * 60_000;
        let display = state.status;
        if (state.status === 'idle' || state.status === 'partial') {
            if (due && !browserRecent) display = 'waiting_for_browser';
            else if (state.status === 'idle') display = due ? 'due' : 'ok';
        }
        return { ...state, due, overdue, display };
    }

    return {
        /** Light summary for the SSE dashboard state. */
        async stateSummary() {
            const t = now();
            const jobs = await store.listJobs();
            const results = collector?.lastResults?.() ?? {};
            return {
                jobs: jobs.slice(0, 20).map(j => ({ ...j, lastResult: results[j.id] ?? null })),
                guide: (await guideStore.listStates()).map(s => guideStatus(s, t)),
                available: Object.fromEntries(['observe_realm', 'item_frontier', 'guide_discovery'].map(k => [k, unavailableReason(k, operations)])),
            };
        },

        /** Counts, freshness, completeness, guide status and policy for the Catalog tab. */
        async summary() {
            const kinds = {};
            for (const kind of BROWSE_KINDS) {
                const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${SERVING[kind].table}`);
                const [e] = await db.query('SELECT COUNT(*) AS tracked, MAX(last_seen_at) AS lastSeenAt FROM catalog_entities WHERE entity_kind = ?', [kind]);
                const byCompleteness = {};
                for (const r of await db.query('SELECT completeness, COUNT(*) AS n FROM catalog_entities WHERE entity_kind = ? AND completeness IS NOT NULL GROUP BY completeness', [kind])) byCompleteness[r.completeness] = Number(r.n);
                kinds[kind] = { rows: Number(n), tracked: Number(e.tracked), lastSeenAt: e.lastSeenAt ?? null, complete: byCompleteness.complete ?? 0, incomplete: byCompleteness.incomplete ?? 0 };
            }
            return {
                ...(await this.stateSummary()),
                kinds,
                coverage: await guideStore.coverage(),
                guideRequestsToday: await guideStore.usage(),
                relayLastSeenAt: relayLastSeenAt(),
                policy: { game: GAME_POLICY, guide: GUIDE_POLICY, ordering: GUIDE_ORDERING, fullSweep: fullSweepEstimate() },
            };
        },

        /**
         * AC-CAT-007: one page of a kind. filters: q (name substring), completeness (item/creature).
         * @returns {Promise<{ kind, page, pageSize, total, items: object[] }>}
         */
        async listEntities({ kind, q = null, completeness = null, page = 1, pageSize = 25 }) {
            if (!BROWSE_KINDS.includes(kind)) throw invalid('Unknown kind.', 'kind');
            if (!(Number.isInteger(page) && page >= 1 && page <= MAX_PAGE)) throw invalid(`page must be 1-${MAX_PAGE}.`, 'page');
            if (!(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)) throw invalid(`pageSize must be 1-${MAX_PAGE_SIZE}.`, 'pageSize');
            if (q !== null && (typeof q !== 'string' || q.length < 1 || q.length > 64)) throw invalid('q must be 1-64 characters.', 'q');
            if (completeness !== null && !(COMPLETENESS.includes(completeness) && (kind === 'item' || kind === 'creature'))) throw invalid('completeness is complete or incomplete, for items and creatures.', 'completeness');
            const spec = SERVING[kind];
            const cols = spec.list.map(c => `s.\`${c}\``).join(', ');
            const where = [];
            const params = [];
            let from = `${spec.table} s`;
            if (completeness) {
                from += ' JOIN catalog_entities e ON e.entity_kind = ? AND e.entity_key = s.id';
                params.push(kind);
                where.push('e.completeness = ?');
                params.push(completeness);
            }
            // Case-insensitive on both MySQL (utf8mb4_bin compares exactly) and SQLite.
            if (q) { where.push("LOWER(s.name) LIKE ? ESCAPE '!'"); params.push(like(q.toLowerCase())); }
            const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
            const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${from}${whereSql}`, params);
            const offset = (page - 1) * pageSize;
            const rows = await db.query(`SELECT ${cols} FROM ${from}${whereSql} ORDER BY s.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
            const states = await statesFor(kind, rows.map(r => entityKey(kind, r)));
            return {
                kind, page, pageSize, total: Number(n),
                items: rows.map(r => {
                    const key = entityKey(kind, r);
                    const s = states.get(key);
                    const out = { key };
                    for (const c of spec.list) out[c] = cell(c, r[c], spec);
                    out.catalog = s ? {
                        firstSeenAt: s.first_seen_at, lastSeenAt: s.last_seen_at, completeness: s.completeness ?? null,
                        incompleteReasons: s.incomplete_reason ? s.incomplete_reason.split(',') : [], verifiedAt: s.verified_at ?? null,
                    } : null;
                    return out;
                }),
            };
        },

        /** AC-CAT-007: one entity with its catalog state, recent provenance, and relations. */
        async getEntity(kind, key) {
            if (!BROWSE_KINDS.includes(kind)) throw invalid('Unknown kind.', 'kind');
            const spec = SERVING[kind];
            let row;
            if (spec.natural) {
                const m = typeof key === 'string' ? key.match(/^(\d{1,18}):(.{1,191})$/s) : null;
                if (!m) throw invalid('Key must be realm_id:name.', 'key');
                [row] = await db.query(`SELECT ${spec.detail.map(c => `\`${c}\``).join(', ')} FROM ${spec.table} WHERE realm_id = ? AND name = ? LIMIT 1`, [Number(m[1]), m[2]]);
            } else {
                if (typeof key !== 'string' || !/^\d{1,18}$/.test(key)) throw invalid('Key must be a numeric ID.', 'key');
                [row] = await db.query(`SELECT ${spec.detail.map(c => `\`${c}\``).join(', ')} FROM ${spec.table} WHERE id = ?`, [Number(key)]);
            }
            if (!row) throw new CatalogError('not_found', 'Unknown entity.');
            const fields = {};
            for (const c of spec.detail) fields[c] = cell(c, row[c], spec);
            const k = entityKey(kind, row);
            const [s] = await db.query('SELECT first_seen_at, last_seen_at, completeness, incomplete_reason, verified_at, last_run_id FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [kind, k]);
            const provenance = (await db.query(
                `SELECT o.source, o.payload_hash, ro.run_id, ro.observed_at, r.mode, r.status FROM catalog_run_observations ro
                 JOIN catalog_observations o ON o.id = ro.observation_id JOIN catalog_runs r ON r.id = ro.run_id
                 WHERE o.entity_kind = ? AND o.entity_key = ? ORDER BY ro.seq DESC LIMIT 50`, [kind, k]))
                .map(p => ({ source: p.source, hash: String(p.payload_hash).slice(0, 12), runId: p.run_id, observedAt: p.observed_at, mode: p.mode, runStatus: p.status }));
            const relations = {};
            const id = Number(row.id);
            if (kind === 'realm') {
                relations.creatures = (await db.query('SELECT c.id, c.name FROM realm_creatures rc JOIN creatures c ON c.id = rc.creature_id WHERE rc.realm_id = ? ORDER BY c.id LIMIT 200', [id])).map(r => ({ id: Number(r.id), name: r.name }));
                relations.relics = (await db.query('SELECT name FROM relics WHERE realm_id = ? ORDER BY name LIMIT 200', [id])).map(r => r.name);
                relations.quests = (await db.query('SELECT name, min_level FROM quests WHERE realm_id = ? ORDER BY name LIMIT 200', [id])).map(r => ({ name: r.name, minLevel: r.min_level === null ? null : Number(r.min_level) }));
            } else if (kind === 'creature') {
                relations.realms = (await db.query('SELECT r.id, r.name FROM realm_creatures rc JOIN realms r ON r.id = rc.realm_id WHERE rc.creature_id = ? ORDER BY r.id LIMIT 200', [id])).map(r => ({ id: Number(r.id), name: r.name }));
                relations.drops = (await db.query('SELECT i.id, i.name FROM creature_drops cd JOIN items i ON i.id = cd.item_id WHERE cd.creature_id = ? ORDER BY i.id LIMIT 200', [id])).map(r => ({ id: Number(r.id), name: r.name }));
            } else if (kind === 'item') {
                relations.droppedBy = (await db.query('SELECT c.id, c.name FROM creature_drops cd JOIN creatures c ON c.id = cd.creature_id WHERE cd.item_id = ? ORDER BY c.id LIMIT 200', [id])).map(r => ({ id: Number(r.id), name: r.name }));
            }
            const guide = ['item', 'creature', 'realm', 'master_realm'].includes(kind) ? await guideStore.getIdState(kind, id) : null;
            return {
                kind, key: k, fields, relations, provenance,
                catalog: s ? {
                    firstSeenAt: s.first_seen_at, lastSeenAt: s.last_seen_at, lastRunId: s.last_run_id, completeness: s.completeness ?? null,
                    incompleteReasons: s.incomplete_reason ? s.incomplete_reason.split(',') : [], verifiedAt: s.verified_at ?? null,
                } : null,
                guide: guide ? { status: guide.status, checkedAt: guide.checkedAt, nextCheckAt: guide.nextDetailAt, attempts: guide.attempts } : null,
            };
        },

        async listRuns({ page = 1, pageSize = 25 } = {}) {
            if (!(Number.isInteger(page) && page >= 1 && page <= MAX_PAGE)) throw invalid(`page must be 1-${MAX_PAGE}.`, 'page');
            if (!(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)) throw invalid(`pageSize must be 1-${MAX_PAGE_SIZE}.`, 'pageSize');
            return { page, pageSize, runs: await store.listRuns({ limit: pageSize, offset: (page - 1) * pageSize }) };
        },

        async getRun(id) {
            const run = await store.getRun(id);
            if (!run) throw new CatalogError('not_found', 'Unknown catalog run.');
            return run;
        },

        /**
         * AC-CAT-008: creates an allow-listed job. Only kind, requestBudget, and (item_frontier)
         * nextItemId come from the request; a kind whose contract is unverified is refused.
         */
        async createJob({ kind, requestBudget, nextItemId }) {
            const why = unavailableReason(kind, operations);
            if (why === 'unknown_kind') throw invalid('Unknown job kind.', 'kind');
            if (why === 'contract_unverified') throw new CatalogError('conflict', 'This job kind has no verified game read contract yet (DEC-CAT-019).', { reason: why });
            const cursor = kind === 'item_frontier' ? { nextItemId } : {};
            const id = await store.createJob({ kind, cursor, requestBudget });
            return store.getJob(id);
        },

        async jobAction(id, action) {
            const to = JOB_ACTIONS[action];
            if (!to) throw invalid('Unknown job action.', 'action');
            return store.transitionJob(id, to);
        },

        planRollback: runId => store.planRollback(runId),
        executePlan: (planId, confirmation) => store.executePlan(planId, { confirmation }),

        // --- staged seeds (CAT-TASK-007 / AC-CAT-006) ---
        seedSources: () => describeSeedSources(),
        stageSeed(sourceKey) {
            if (!seeds) throw new CatalogError('conflict', 'Seeding is not configured.');
            return seeds.stage(sourceKey);
        },
        planPromotion: runId => store.planPromotion(runId),
        discardStagedRun: runId => store.discardStagedRun(runId),
    };
}
