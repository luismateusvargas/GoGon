// _gg_data/handler/catalogStore.js - CAT-TASK-002 / AC-CAT-005, AC-CAT-006, AC-CAT-009, AC-CAT-010
// Catalog provenance and projection over MySQL (tables in migrations 003/004).
//   recordRun()   transaction 1: validates every observation, then stores the run, the
//                 content-addressed observations, and the run <-> observation links.
//   projectRun()  transaction 2: applies the run to the serving tables (items, creatures, realms,
//                 master_realms, relics, quests, realm_creatures, creature_drops). The first time the
//                 catalog touches an existing serving row, that row is kept as a guide_baseline
//                 observation, so rollback can restore it. A failure rolls the whole projection back
//                 and marks the run failed; its provenance stays diagnosable.
//   planRollback() / executePlan()  one-use, 10-minute plans; rollback replays the provenance that
//                 remains without the run, and removes entities that have none left.
//   completeness  CAT-TASK-009 / AC-CAT-013: every projection and rollback recomputes complete/
//                 incomplete for the items and creatures it touched (and for entities waiting on an
//                 unresolved drop), from the guide detail status and the serving row.
// Every statement is parameterized; table and column names come only from the schemas below.
import crypto from 'node:crypto';
import { clearAllCaches } from './cacheLayer.js';
import { canonicalImageUrl } from './mediaUrl.js';
import { idsFrom, parseJsonColumn } from './servingRelations.js';
import { GUIDE_POLICY } from '../../catalog/contracts/policy.js';

export const ENTITY_KINDS = Object.freeze(['item', 'creature', 'realm', 'master_realm', 'relic', 'quest', 'relation']);
export const SOURCES = Object.freeze(['game_session', 'guide_baseline', 'manual_import']);
export const RUN_MODES = Object.freeze(['observe_realm', 'item_frontier', 'guide_discovery', 'seed', 'promote', 'revert']);
export const JOB_KINDS = Object.freeze(['observe_realm', 'item_frontier', 'guide_discovery']);
// AC-CAT-013: bounded, code-owned reasons (joined with ',' in catalog_entities.incomplete_reason).
export const INCOMPLETE_REASONS = Object.freeze(['guide_detail_missing', 'guide_detail_failed', 'required_field_missing', 'known_drop_unresolved']);
const COMPLETENESS_KINDS = ['item', 'creature'];
const DEPENDENT_RECHECK_LIMIT = 500;
export const RELATION_TYPES = Object.freeze(['realm_creature', 'creature_drop']);
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_OBSERVATIONS_PER_RUN = 20_000;
export const MAX_REQUEST_BUDGET = 50;
export const MAX_CURSOR_BYTES = 1024;
export const PLAN_TTL_MS = 10 * 60_000;
// Width of the entity_key columns (migration 003). The longest key is a relic/quest
// "realm_id:name": 19 digits + ':' + 191 characters = 211.
export const MAX_ENTITY_KEY = 255;
const MAX_DEPTH = 8;
const BASELINE_MODE = 'baseline_snapshot';
// Field-level precedence (catalog-sync constraint): a field set by a higher-ranked source is never
// overwritten by a lower-ranked one; within a rank, the later observation wins.
export const SOURCE_RANK = Object.freeze({ guide_baseline: 0, manual_import: 1, game_session: 2 });

/** Errors callers may map to HTTP: invalid 400, not_found 404, conflict/plan_* 409, projection_failed 500. */
export class CatalogError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        Object.assign(this, extra);
    }
}
const invalid = (message, field) => new CatalogError('invalid', message, field ? { field } : {});

// --- canonical JSON ------------------------------------------------------------------------------

/** JSON with object keys sorted at every level; rejects values JSON cannot represent exactly. */
export function canonicalJson(value) {
    const walk = (v, depth) => {
        if (depth > MAX_DEPTH) throw invalid('Payload is nested too deeply.');
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) throw invalid('Payload numbers must be finite.');
            return v;
        }
        if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
        if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
            const out = {};
            for (const k of Object.keys(v).sort()) {
                if (v[k] === undefined) continue;
                out[k] = walk(v[k], depth + 1);
            }
            return out;
        }
        throw invalid('Payload contains a value JSON cannot represent.');
    };
    return JSON.stringify(walk(value, 0));
}

export const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// --- per-entity schemas --------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const field = {
    id: v => Number.isSafeInteger(v) && v > 0,
    idOrNull: v => v === null || field.id(v),
    int: v => Number.isSafeInteger(v),
    intOrNull: v => v === null || Number.isSafeInteger(v),
    text: max => v => v === null || (typeof v === 'string' && v.length <= max && !CONTROL.test(v)),
    name: v => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= 191 && !CONTROL.test(v),
    json: () => true, // any canonical JSON value; bounded by MAX_PAYLOAD_BYTES and MAX_DEPTH
};

// table/columns are the serving projection. json: columns stored as JSON text. Realm creature/relic/
// quest lists are projected through relations, not realm payloads.
const SCHEMAS = {
    master_realm: { table: 'master_realms', columns: { id: field.id, name: field.text(256), connected_realms: field.json }, json: ['connected_realms'] },
    realm: {
        table: 'realms',
        columns: { id: field.id, name: field.text(256), min_level: field.intOrNull, master_realm_id: field.idOrNull, shops: field.json, connections: field.json, map_objects: field.json },
        json: ['shops', 'connections', 'map_objects'],
    },
    creature: {
        table: 'creatures',
        columns: { id: field.id, name: field.text(256), imageUrl: field.text(512), description: field.text(8192), stats: field.json, enhancements: field.json, droppedItems: field.json },
        json: ['stats', 'enhancements', 'droppedItems'],
    },
    item: {
        table: 'items',
        columns: { id: field.id, name: field.text(256), rarity: field.text(64), imageUrl: field.text(512), stats: field.json, enhancements: field.json, droppedBy: field.json, setBonuses: field.json, setId: field.idOrNull, setName: field.text(256) },
        json: ['stats', 'enhancements', 'droppedBy', 'setBonuses'],
    },
    relic: { natural: true, columns: { realm_id: field.id, name: field.name }, json: [] },
    quest: { natural: true, columns: { realm_id: field.id, name: field.name, min_level: field.intOrNull, details: field.json }, json: ['details'] },
};
const RELATION_FIELDS = { realm_creature: ['realm_id', 'creature_id'], creature_drop: ['creature_id', 'item_id'] };
const PROJECTION_ORDER = ['master_realm', 'realm', 'creature', 'item', 'relic', 'quest', 'relation'];

function entityKey(kind, p) {
    if (kind === 'relation') return `${p.type}:${p[RELATION_FIELDS[p.type][0]]}:${p[RELATION_FIELDS[p.type][1]]}`;
    if (SCHEMAS[kind].natural) return `${p.realm_id}:${p.name}`;
    return String(p.id);
}

/**
 * Validates one observation against its entity schema (unknown fields, types, byte limit).
 * @returns {{ kind, key, externalId, payload, json, hash }}
 */
export function normalizeObservation(kind, payload) {
    if (!ENTITY_KINDS.includes(kind)) throw invalid('Unknown entity kind.', 'kind');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Payload must be an object.', 'payload');
    let allowed;
    let required;
    if (kind === 'relation') {
        if (!RELATION_TYPES.includes(payload.type)) throw invalid('Unknown relation type.', 'type');
        required = RELATION_FIELDS[payload.type];
        allowed = { type: () => true, ...Object.fromEntries(required.map(f => [f, field.id])) };
    } else {
        allowed = SCHEMAS[kind].columns;
        required = SCHEMAS[kind].natural ? ['realm_id', 'name'] : ['id'];
    }
    for (const [k, v] of Object.entries(payload)) {
        if (!Object.hasOwn(allowed, k)) throw invalid(`Field "${k.slice(0, 40)}" is not allowed for ${kind}.`, k.slice(0, 40));
        if (v !== undefined && !allowed[k](v)) throw invalid(`Field "${k}" has an invalid value.`, k);
    }
    for (const k of required) if (payload[k] === undefined) throw invalid(`Field "${k}" is required for ${kind}.`, k);
    if (typeof payload.imageUrl === 'string') payload = { ...payload, imageUrl: canonicalImageUrl(payload.imageUrl) };
    const json = canonicalJson(payload);
    if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw invalid(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`, 'payload');
    const canonical = JSON.parse(json);
    const key = entityKey(kind, canonical);
    if (key.length > MAX_ENTITY_KEY) throw invalid('Entity key is too long.', 'payload');
    return {
        kind,
        key,
        externalId: kind === 'relation' || SCHEMAS[kind].natural ? null : String(canonical.id),
        payload: canonical,
        json,
        hash: sha256(json),
    };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** A short, credential-free failure summary: only a driver error code, never messages or values. */
function redactedError(error, stage) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? error.code : 'ERROR';
    return { stage, code };
}

// --- store -----------------------------------------------------------------------------------------

/**
 * @param {{ query: Function, transaction: Function }} db - the migrated MySQL client
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {() => void} [opts.invalidateCaches] - clears the serving-entity LRU caches
 */
export function createCatalogStore(db, { now = Date.now, invalidateCaches = clearAllCaches } = {}) {
    const iso = () => new Date(now()).toISOString();
    const uuid = () => crypto.randomUUID();

    async function lockRevision(tx) {
        const [row] = await tx.query('SELECT revision FROM catalog_state WHERE id = 1 FOR UPDATE');
        if (!row) throw new CatalogError('invalid', 'Catalog state is missing; run the migrations.');
        return Number(row.revision);
    }
    const bumpRevision = tx => tx.query('UPDATE catalog_state SET revision = revision + 1 WHERE id = 1');

    /** Returns the observation ID for this content, inserting it once per source/entity/hash. */
    async function upsertObservation(tx, source, o, at) {
        const find = () => tx.query('SELECT id FROM catalog_observations WHERE source = ? AND entity_kind = ? AND entity_key = ? AND payload_hash = ?', [source, o.kind, o.key, o.hash]);
        const [found] = await find();
        if (found) return { id: found.id, created: false };
        const id = uuid();
        await tx.query('INSERT INTO catalog_observations (id, entity_kind, entity_key, external_id, source, payload_hash, payload, first_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, o.kind, o.key, o.externalId, source, o.hash, o.json, at]);
        return { id, created: true };
    }

    const linkObservation = (tx, runId, observationId, at) =>
        tx.query('INSERT IGNORE INTO catalog_run_observations (run_id, observation_id, observed_at) VALUES (?, ?, ?)', [runId, observationId, at]);

    // --- serving-table access (names from SCHEMAS only) ---

    const serialize = (col, value, spec, raw) => {
        if (value === undefined || value === null) return null;
        if (!spec.json.includes(col) || raw) return value;
        return JSON.stringify(value);
    };

    /** Upserts the given columns of an ID-keyed serving row; columns not listed keep their values. */
    async function upsertServing(tx, kind, values, rawCols = new Set()) {
        const spec = SCHEMAS[kind];
        const cols = Object.keys(values);
        const updates = (cols.length > 1 ? cols.filter(c => c !== 'id') : cols).map(c => `\`${c}\` = new.\`${c}\``).join(', ');
        await tx.query(`INSERT INTO ${spec.table} (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) AS new ON DUPLICATE KEY UPDATE ${updates}`,
            cols.map(c => serialize(c, values[c], spec, rawCols.has(c))));
    }

    /** The current serving row as a baseline payload (JSON columns kept as stored text), or null. */
    async function snapshotServing(tx, kind, p) {
        if (kind === 'relation') {
            const [a, b] = RELATION_FIELDS[p.type];
            const table = p.type === 'realm_creature' ? 'realm_creatures' : 'creature_drops';
            const [row] = await tx.query(`SELECT 1 AS present FROM ${table} WHERE ${a} = ? AND ${b} = ?`, [p[a], p[b]]);
            return row ? { type: p.type, [a]: p[a], [b]: p[b] } : null;
        }
        const spec = SCHEMAS[kind];
        if (kind === 'relic') {
            const [row] = await tx.query('SELECT realm_id, name FROM relics WHERE realm_id = ? AND name = ? LIMIT 1', [p.realm_id, p.name]);
            return row ? { realm_id: Number(row.realm_id), name: row.name } : null;
        }
        const cols = Object.keys(spec.columns);
        const where = spec.natural ? 'realm_id = ? AND name = ?' : 'id = ?';
        const [row] = await tx.query(`SELECT ${cols.map(c => `\`${c}\``).join(', ')} FROM ${kind === 'quest' ? 'quests' : spec.table} WHERE ${where}`,
            spec.natural ? [p.realm_id, p.name] : [p.id]);
        if (!row) return null;
        const out = { $baseline: true };
        for (const c of cols) {
            const v = row[c];
            out[c] = v === null || v === undefined ? null : (typeof v === 'bigint' ? Number(v) : v);
            if (['id', 'realm_id', 'master_realm_id', 'setId', 'min_level'].includes(c) && out[c] !== null) out[c] = Number(out[c]);
        }
        return out;
    }

    /** Adds or removes a creature ID in realms.creatures when it is a JSON array (the Discord view). */
    async function syncRealmCreatureJson(tx, realmId, creatureId, present) {
        const [row] = await tx.query('SELECT creatures FROM realms WHERE id = ?', [realmId]);
        if (!row) return;
        let list;
        try { list = row.creatures == null ? [] : JSON.parse(row.creatures); } catch { return; }
        if (!Array.isArray(list)) return;
        const idOf = x => Number(x && typeof x === 'object' ? (x.id ?? x.creature_id ?? x.creatureId) : x);
        const has = list.some(x => idOf(x) === creatureId);
        if (present && !has) list.push(creatureId);
        else if (!present && has) list = list.filter(x => idOf(x) !== creatureId);
        else return;
        await tx.query('UPDATE realms SET creatures = ? WHERE id = ?', [JSON.stringify(list), realmId]);
    }

    /**
     * Writes an entity's state into the serving tables. merge: only the payload's fields change
     * (incremental projection); otherwise every column is set, missing ones to NULL (restore).
     */
    async function applyEntity(tx, kind, payload, { merge }) {
        if (kind === 'relation') {
            const [a, b] = RELATION_FIELDS[payload.type];
            const table = payload.type === 'realm_creature' ? 'realm_creatures' : 'creature_drops';
            const [row] = await tx.query(`SELECT 1 AS present FROM ${table} WHERE ${a} = ? AND ${b} = ?`, [payload[a], payload[b]]);
            if (!row) {
                await tx.query(`INSERT INTO ${table} (${a}, ${b}) VALUES (?, ?)`, [payload[a], payload[b]]);
                if (payload.type === 'realm_creature') await syncRealmCreatureJson(tx, payload.realm_id, payload.creature_id, true);
            }
            return;
        }
        if (kind === 'relic') {
            const [row] = await tx.query('SELECT id FROM relics WHERE realm_id = ? AND name = ? LIMIT 1', [payload.realm_id, payload.name]);
            if (!row) await tx.query('INSERT INTO relics (name, realm_id) VALUES (?, ?)', [payload.name, payload.realm_id]);
            return;
        }
        const spec = SCHEMAS[kind];
        const raw = new Set(payload.$raw ?? []);
        const values = {};
        for (const c of Object.keys(spec.columns)) {
            if (Object.hasOwn(payload, c)) values[c] = payload[c];
            else if (!merge) values[c] = null;
        }
        if (kind === 'quest') {
            const cols = Object.keys(values);
            const updates = cols.filter(c => c !== 'realm_id' && c !== 'name').map(c => `\`${c}\` = new.\`${c}\``);
            await tx.query(`INSERT INTO quests (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) AS new ON DUPLICATE KEY UPDATE ${updates.length ? updates.join(', ') : '`name` = new.`name`'}`,
                cols.map(c => serialize(c, values[c], spec, raw.has(c))));
            return;
        }
        await upsertServing(tx, kind, values, raw);
    }

    /**
     * Removes an entity and every serving row that depends on it (explicitly, so the result does not
     * depend on which foreign keys a database enforces). With dryRun, nothing is written.
     * @returns {Promise<{ stateKeys: Array<[string, string]> }>} the catalog_entities rows (other than
     *   the entity itself) that stop being projected because they depend on it.
     */
    async function removeEntity(q, kind, payload, { dryRun }) {
        const states = async (pattern, kinds) => (await q.query(
            `SELECT entity_kind, entity_key FROM catalog_entities WHERE entity_kind IN (${kinds.map(() => '?').join(', ')}) AND entity_key LIKE ?`, [...kinds, pattern]))
            .map(r => [r.entity_kind, r.entity_key]);
        const steps = [];   // [sql, params]
        let stateKeys = [];
        if (kind === 'relation') {
            const [a, b] = RELATION_FIELDS[payload.type];
            const table = payload.type === 'realm_creature' ? 'realm_creatures' : 'creature_drops';
            if (!dryRun && payload.type === 'realm_creature') await syncRealmCreatureJson(q, payload.realm_id, payload.creature_id, false);
            steps.push([`DELETE FROM ${table} WHERE ${a} = ? AND ${b} = ?`, [payload[a], payload[b]]]);
        } else if (kind === 'relic') {
            steps.push(['DELETE FROM relics WHERE realm_id = ? AND name = ?', [payload.realm_id, payload.name]]);
        } else if (kind === 'quest') {
            steps.push(['DELETE FROM quests WHERE realm_id = ? AND name = ?', [payload.realm_id, payload.name]]);
        } else if (kind === 'realm') {
            const id = payload.id;
            steps.push(['DELETE FROM realm_creatures WHERE realm_id = ?', [id]]);
            steps.push(['DELETE FROM quests WHERE realm_id = ?', [id]]);
            steps.push(['DELETE FROM relics WHERE realm_id = ?', [id]]);
            steps.push(['DELETE FROM realms WHERE id = ?', [id]]);
            stateKeys = [...await states(`realm_creature:${id}:%`, ['relation']), ...await states(`${id}:%`, ['relic', 'quest'])];
        } else if (kind === 'creature') {
            const id = payload.id;
            if (!dryRun) {
                for (const r of await q.query('SELECT realm_id FROM realm_creatures WHERE creature_id = ?', [id])) {
                    await syncRealmCreatureJson(q, Number(r.realm_id), id, false);
                }
            }
            steps.push(['DELETE FROM realm_creatures WHERE creature_id = ?', [id]]);
            steps.push(['DELETE FROM creature_drops WHERE creature_id = ?', [id]]);
            steps.push(['DELETE FROM creatures WHERE id = ?', [id]]);
            stateKeys = [...await states(`realm_creature:%:${id}`, ['relation']), ...await states(`creature_drop:${id}:%`, ['relation'])];
        } else if (kind === 'item') {
            const id = payload.id;
            steps.push(['DELETE FROM creature_drops WHERE item_id = ?', [id]]);
            steps.push(['DELETE FROM items WHERE id = ?', [id]]);
            stateKeys = await states(`creature_drop:%:${id}`, ['relation']);
        } else if (kind === 'master_realm') {
            const id = payload.id;
            steps.push(['UPDATE realms SET master_realm_id = NULL WHERE master_realm_id = ?', [id]]);
            steps.push(['DELETE FROM master_realms WHERE id = ?', [id]]);
        }
        if (!dryRun) {
            for (const [sql, params] of steps) await q.query(sql, params);
            for (const [k, key] of stateKeys) await q.query('DELETE FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [k, key]);
        }
        return { stateKeys };
    }

    /**
     * Merges observations in replay order under source precedence. Baseline payloads carry stored
     * JSON text for JSON columns.
     * @param {Array<{ payload: object, source: string }>} entries
     */
    function replay(kind, entries) {
        const merged = {};
        const rank = {};
        const raw = new Set();
        for (const { payload, source } of entries) {
            const { $baseline, ...fields } = payload;
            const r = SOURCE_RANK[source];
            for (const [c, v] of Object.entries(fields)) {
                if (rank[c] !== undefined && r < rank[c]) continue;
                merged[c] = v;
                rank[c] = r;
                if ($baseline && kind !== 'relation' && SCHEMAS[kind].json.includes(c)) raw.add(c);
                else raw.delete(c);
            }
        }
        return { ...merged, $raw: [...raw] };
    }

    const parse = text => JSON.parse(text);

    /**
     * The provenance an entity's state is rebuilt from: observations of succeeded runs (plus
     * includeRun, the run being projected), without excludeRun (the run being rolled back).
     * Order: baseline snapshots first, then observation order.
     */
    const provenanceOf = (q, kind, key, { includeRun = '', excludeRun = '' }) => q.query(
        `SELECT o.id, o.payload, o.source, ro.run_id, ro.observed_at FROM catalog_run_observations ro
         JOIN catalog_observations o ON o.id = ro.observation_id
         JOIN catalog_runs r ON r.id = ro.run_id
         WHERE o.entity_kind = ? AND o.entity_key = ? AND (r.status = 'succeeded' OR r.id = ?) AND ro.run_id <> ?
         ORDER BY CASE WHEN r.mode = '${BASELINE_MODE}' THEN 0 ELSE 1 END, ro.seq`, [kind, key, includeRun, excludeRun]);
    const replayRows = (kind, rows) => replay(kind, rows.map(r => ({ payload: parse(r.payload), source: r.source })));

    /**
     * Checks a state against the parents that exist now. An unknown master realm becomes NULL (as in
     * populate_db and migration 004); a relic, quest, or relation whose parent is gone cannot exist.
     * @returns {Promise<object|null>} the writable payload, or null when it must not be written
     */
    async function resolveParents(q, kind, payload) {
        const exists = async (table, id) => (await q.query(`SELECT 1 AS present FROM ${table} WHERE id = ?`, [id])).length > 0;
        if (kind === 'realm' && payload.master_realm_id != null && !(await exists('master_realms', payload.master_realm_id))) {
            return { ...payload, master_realm_id: null };
        }
        if (kind === 'relic' || kind === 'quest') return (await exists('realms', payload.realm_id)) ? payload : null;
        if (kind === 'relation') {
            const [a, b] = RELATION_FIELDS[payload.type];
            const tableOf = { realm_id: 'realms', creature_id: 'creatures', item_id: 'items' };
            return (await exists(tableOf[a], payload[a])) && (await exists(tableOf[b], payload[b])) ? payload : null;
        }
        return payload;
    }

    /**
     * What rolling back runId would do. Replay order: baseline snapshots first, then observation order.
     * @returns {Promise<{ restore: object[], remove: object[], counts: object }>}
     */
    async function computeRollback(q, runId) {
        const [run] = await q.query('SELECT id, mode, status FROM catalog_runs WHERE id = ?', [runId]);
        if (!run) throw new CatalogError('not_found', 'Unknown catalog run.');
        if (run.status !== 'succeeded' || run.mode === BASELINE_MODE) {
            throw new CatalogError('conflict', `A ${run.status} ${run.mode === BASELINE_MODE ? 'baseline ' : ''}run cannot be rolled back.`);
        }
        const touched = await q.query(
            `SELECT DISTINCT o.entity_kind, o.entity_key FROM catalog_run_observations ro
             JOIN catalog_observations o ON o.id = ro.observation_id WHERE ro.run_id = ?`, [runId]);
        const [{ n: observations }] = await q.query('SELECT COUNT(*) AS n FROM catalog_run_observations WHERE run_id = ?', [runId]);
        const restore = [];
        const remove = [];
        for (const t of touched) {
            const remaining = await provenanceOf(q, t.entity_kind, t.entity_key, { excludeRun: runId });
            if (remaining.length) {
                const last = remaining[remaining.length - 1];
                restore.push({ kind: t.entity_kind, key: t.entity_key, payload: replayRows(t.entity_kind, remaining), observationId: last.id, runId: last.run_id, observedAt: last.observed_at });
            } else {
                const [latest] = await q.query(
                    `SELECT o.payload FROM catalog_run_observations ro JOIN catalog_observations o ON o.id = ro.observation_id
                     WHERE ro.run_id = ? AND o.entity_kind = ? AND o.entity_key = ? ORDER BY ro.seq DESC LIMIT 1`, [runId, t.entity_kind, t.entity_key]);
                remove.push({ kind: t.entity_kind, key: t.entity_key, payload: parse(latest.payload) });
            }
        }
        const byOrder = (a, b) => PROJECTION_ORDER.indexOf(a.kind) - PROJECTION_ORDER.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        restore.sort(byOrder);
        remove.sort((a, b) => byOrder(b, a));
        // Catalog entities outside this run that disappear with a removed parent are not restored.
        const cascadeKeys = new Set();
        const removing = new Set(remove.map(r => `${r.kind}|${r.key}`));
        for (const r of remove) {
            const { stateKeys } = await removeEntity(q, r.kind, r.payload, { dryRun: true });
            for (const [k, key] of stateKeys) if (!removing.has(`${k}|${key}`)) cascadeKeys.add(`${k}|${key}`);
        }
        const restoreKept = restore.filter(r => !cascadeKeys.has(`${r.kind}|${r.key}`));
        return {
            restore: restoreKept,
            remove,
            counts: {
                observations: Number(observations),
                entities: touched.length,
                restore: restoreKept.length,
                remove: remove.length,
                relations: touched.filter(t => t.entity_kind === 'relation').length,
                cascade: cascadeKeys.size,
            },
        };
    }

    /**
     * After a guide_discovery run is rolled back, its guide details no longer describe what the catalog
     * serves: they become pending (unverified, so completeness says guide_detail_missing) with no hash,
     * so the next read stages them again. That read keeps the normal refresh interval (owner decision
     * 2026-09-28), so the rollback holds until then.
     */
    async function unverifyGuideDetails(tx, runId) {
        const [run] = await tx.query('SELECT mode FROM catalog_runs WHERE id = ?', [runId]);
        if (run?.mode !== 'guide_discovery') return;
        const rows = await tx.query(
            `SELECT DISTINCT o.entity_kind, o.entity_key FROM catalog_run_observations ro JOIN catalog_observations o ON o.id = ro.observation_id
             WHERE ro.run_id = ? AND o.entity_kind IN ('item', 'creature', 'realm', 'master_realm')`, [runId]);
        const next = new Date(now() + GUIDE_POLICY.detailRefreshAfterMs).toISOString();
        for (const r of rows) {
            await tx.query("UPDATE catalog_guide_ids SET detail_status = 'pending', detail_hash = NULL, detail_attempts = 0, next_detail_at = ? WHERE entity_kind = ? AND entity_id = ?",
                [next, r.entity_kind, Number(r.entity_key)]);
        }
    }

    /**
     * Rolls runId back inside tx. The exact effect on the serving tables is returned as per-table row
     * deltas, so a plan can preview it by running this in a transaction that is then rolled back.
     */
    async function performRollback(tx, runId, planId) {
        const computed = await computeRollback(tx, runId);
        const before = await servingCounts(tx);
        for (const r of computed.remove) {
            await removeEntity(tx, r.kind, r.payload, { dryRun: false });
            await tx.query('DELETE FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [r.kind, r.key]);
        }
        let orphaned = 0;
        for (const r of computed.restore) {
            // Removals ran first, so parent checks see the post-rollback tables.
            const payload = await resolveParents(tx, r.kind, r.payload);
            const [state] = await tx.query('SELECT first_seen_at FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [r.kind, r.key]);
            await tx.query('DELETE FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [r.kind, r.key]);
            if (!payload) {
                await removeEntity(tx, r.kind, r.payload, { dryRun: false });   // its parent is gone: it cannot exist
                orphaned++;
                continue;
            }
            await applyEntity(tx, r.kind, payload, { merge: false });
            await tx.query('INSERT INTO catalog_entities (entity_kind, entity_key, observation_id, last_run_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
                [r.kind, r.key, r.observationId, r.runId, state?.first_seen_at ?? r.observedAt, r.observedAt]);
        }
        await unverifyGuideDetails(tx, runId);
        await refreshCompleteness(tx, [...computed.restore, ...computed.remove].map(r => [r.kind, r.key]), computed.remove);
        const after = await servingCounts(tx);
        const rows = {};
        for (const table of Object.keys(before)) if (after[table] !== before[table]) rows[table] = after[table] - before[table];
        const counts = { ...computed.counts, orphaned, rows };
        const [run] = await tx.query('SELECT summary FROM catalog_runs WHERE id = ?', [runId]);
        const summary = { ...(run.summary ? JSON.parse(run.summary) : {}), revert: { planId, ...counts, before, after } };
        await tx.query('UPDATE catalog_runs SET status = ?, summary = ? WHERE id = ?', ['reverted', JSON.stringify(summary), runId]);
        return { counts, before, after };
    }

    async function servingCounts(q) {
        const out = {};
        for (const table of ['master_realms', 'realms', 'creatures', 'items', 'relics', 'quests', 'realm_creatures', 'creature_drops']) {
            out[table] = Number((await q.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
        }
        return out;
    }

    // --- completeness (CAT-TASK-009 / AC-CAT-013) ---

    /** A creature name as items list it ("Name (Class LE)") and as creatures store it ("Name"). */
    const dropNames = name => {
        const n = String(name).trim();
        const bare = n.replace(/\s*\([^()]*\)\s*$/, '').trim();
        return bare && bare !== n ? [n, bare] : [n];
    };

    /**
     * Complete means: a validated guide detail, the required serving fields, and every currently
     * known drop link resolving to an existing row. It never claims that no other drop exists.
     */
    async function completenessOf(q, kind, id) {
        const reasons = [];
        const [g] = await q.query('SELECT detail_status, detail_checked_at FROM catalog_guide_ids WHERE entity_kind = ? AND entity_id = ?', [kind, id]);
        if (!g || g.detail_status === 'pending' || g.detail_status === 'missing') reasons.push('guide_detail_missing');
        else if (g.detail_status === 'failed') reasons.push('guide_detail_failed');
        const [row] = kind === 'item'
            ? await q.query('SELECT name, droppedBy AS drops FROM items WHERE id = ?', [id])
            : await q.query('SELECT name, stats, droppedItems AS drops FROM creatures WHERE id = ?', [id]);
        if (!row || !row.name || (kind === 'creature' && row.stats == null)) reasons.push('required_field_missing');
        const drops = parseJsonColumn(row?.drops);
        let unresolved = false;
        if (kind === 'creature') {
            for (const itemId of idsFrom(drops)) {
                if (!(await q.query('SELECT 1 AS present FROM items WHERE id = ?', [itemId])).length) { unresolved = true; break; }
            }
        } else if (Array.isArray(drops)) {
            for (const d of drops) {
                const name = typeof d === 'string' ? d : (d?.creatureName ?? d?.name);
                if (typeof name !== 'string' || !name.trim()) continue;
                const candidates = dropNames(name);
                const found = await q.query(`SELECT 1 AS present FROM creatures WHERE name IN (${candidates.map(() => '?').join(', ')}) LIMIT 1`, candidates);
                if (!found.length) { unresolved = true; break; }
            }
        }
        if (unresolved) reasons.push('known_drop_unresolved');
        return {
            completeness: reasons.length ? 'incomplete' : 'complete',
            reason: reasons.length ? reasons.join(',') : null,
            verifiedAt: g?.detail_status === 'ok' ? g.detail_checked_at : null,
        };
    }

    /**
     * Recomputes completeness for the given item/creature entities (keys are game IDs), plus up to
     * DEPENDENT_RECHECK_LIMIT entities of the other kind still waiting on an unresolved drop.
     * @param {Array<[string, string]>} entities - [kind, key] pairs; other kinds are ignored
     * @param {Array<{ kind: string, payload: object }>} [removed] - items/creatures just removed: the
     *   entities whose drop lists name them may have lost a resolved drop, so they are rechecked too
     */
    async function refreshCompleteness(q, entities, removed = []) {
        const targets = new Map();
        for (const [kind, key] of entities) if (COMPLETENESS_KINDS.includes(kind)) targets.set(`${kind}|${key}`, [kind, key]);
        const like = v => `%${String(v).replace(/[!%_]/g, m => `!${m}`)}%`;   // with ESCAPE '!' (same on MySQL and SQLite)
        for (const r of removed) {
            // A coarse LIKE finds candidates; completenessOf() then checks each one exactly.
            const found = r.kind === 'item' && r.payload?.id != null
                ? await q.query(`SELECT id FROM creatures WHERE droppedItems LIKE ? ESCAPE '!' LIMIT ${DEPENDENT_RECHECK_LIMIT}`, [like(r.payload.id)])
                : r.kind === 'creature' && typeof r.payload?.name === 'string'
                    ? await q.query(`SELECT id FROM items WHERE droppedBy LIKE ? ESCAPE '!' LIMIT ${DEPENDENT_RECHECK_LIMIT}`, [like(r.payload.name)])
                    : [];
            const other = r.kind === 'item' ? 'creature' : 'item';
            for (const f of found) targets.set(`${other}|${f.id}`, [other, String(f.id)]);
        }
        const touchedKinds = new Set([...targets.values()].map(([k]) => k));
        for (const other of COMPLETENESS_KINDS) {
            if (!touchedKinds.has(other === 'item' ? 'creature' : 'item')) continue;
            const waiting = await q.query(`SELECT entity_key FROM catalog_entities WHERE entity_kind = ? AND incomplete_reason LIKE ? ORDER BY entity_key LIMIT ${DEPENDENT_RECHECK_LIMIT}`,
                [other, '%known_drop_unresolved%']);
            for (const w of waiting) targets.set(`${other}|${w.entity_key}`, [other, w.entity_key]);
        }
        let updated = 0;
        for (const [kind, key] of targets.values()) {
            const [state] = await q.query('SELECT 1 AS present FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [kind, key]);
            if (!state) continue;
            const c = await completenessOf(q, kind, Number(key));
            await q.query('UPDATE catalog_entities SET completeness = ?, incomplete_reason = ?, verified_at = ? WHERE entity_kind = ? AND entity_key = ?',
                [c.completeness, c.reason, c.verifiedAt, kind, key]);
            updated++;
        }
        return updated;
    }

    /**
     * Applies a recorded ('running') run to the serving tables inside tx (the caller holds the
     * revision lock and bumps the revision). Marks the run succeeded; its summary keeps any fields
     * recorded with it (a seed's batch/part) and gains the projection counts.
     */
    async function performProjection(tx, runId) {
        // Recheck under the lock: a reload may have discarded the run since any earlier check.
        const [current] = await tx.query('SELECT status, summary FROM catalog_runs WHERE id = ? FOR UPDATE', [runId]);
        if (!current) throw new CatalogError('not_found', 'Unknown catalog run.');
        if (current.status !== 'running') throw new CatalogError('conflict', `A ${current.status} run cannot be projected.`);
        const rows = await tx.query(
            `SELECT o.id, o.entity_kind, o.entity_key, o.payload, ro.observed_at FROM catalog_run_observations ro
             JOIN catalog_observations o ON o.id = ro.observation_id WHERE ro.run_id = ? ORDER BY ro.seq`, [runId]);
        rows.sort((a, b) => PROJECTION_ORDER.indexOf(a.entity_kind) - PROJECTION_ORDER.indexOf(b.entity_kind));
        const counts = { projected: 0, unchanged: 0, baselines: 0 };
        let baselineRunId = null;
        const at = iso();
        for (const row of rows) {
            const kind = row.entity_kind;
            const payload = parse(row.payload);
            const [state] = await tx.query('SELECT observation_id, first_seen_at FROM catalog_entities WHERE entity_kind = ? AND entity_key = ? FOR UPDATE', [kind, row.entity_key]);
            let firstSeen = state?.first_seen_at ?? row.observed_at;
            if (!state) {
                const baseline = await snapshotServing(tx, kind, payload);
                if (baseline) {
                    if (!baselineRunId) {
                        baselineRunId = uuid();
                        await tx.query('INSERT INTO catalog_runs (id, mode, source, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
                            [baselineRunId, BASELINE_MODE, 'guide_baseline', 'succeeded', at, at]);
                    }
                    const json = canonicalJson(baseline);
                    const obs = await upsertObservation(tx, 'guide_baseline', { kind, key: row.entity_key, externalId: baseline.id != null ? String(baseline.id) : null, json, hash: sha256(json) }, at);
                    await linkObservation(tx, baselineRunId, obs.id, at);
                    counts.baselines++;
                    firstSeen = at;
                }
            } else if (state.observation_id === row.id) {
                counts.unchanged++;
                await tx.query('UPDATE catalog_entities SET last_run_id = ?, last_seen_at = ? WHERE entity_kind = ? AND entity_key = ?', [runId, row.observed_at, kind, row.entity_key]);
                continue;
            }
            // Rebuild from all provenance (baseline, earlier runs, this run) under source
            // precedence, so a lower-ranked source never overwrites a higher-ranked field.
            const rebuilt = await resolveParents(tx, kind, replayRows(kind, await provenanceOf(tx, kind, row.entity_key, { includeRun: runId })));
            await applyEntity(tx, kind, rebuilt ?? payload, { merge: false }); // no state: let the foreign key reject it
            await tx.query('DELETE FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [kind, row.entity_key]);
            await tx.query('INSERT INTO catalog_entities (entity_kind, entity_key, observation_id, last_run_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
                [kind, row.entity_key, row.id, runId, firstSeen, row.observed_at]);
            counts.projected++;
        }
        await refreshCompleteness(tx, rows.map(r => [r.entity_kind, r.entity_key]));
        const summary = { ...(current.summary ? JSON.parse(current.summary) : {}), observations: rows.length, ...counts };
        await tx.query('UPDATE catalog_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?', ['succeeded', iso(), JSON.stringify(summary), runId]);
        return summary;
    }

    /** Projects runId inside tx and measures it: projection counts plus exact serving row deltas. */
    async function measuredProjection(tx, runId) {
        const before = await servingCounts(tx);
        const summary = await performProjection(tx, runId);
        const after = await servingCounts(tx);
        const rows = {};
        for (const table of Object.keys(before)) if (after[table] !== before[table]) rows[table] = after[table] - before[table];
        return { counts: { observations: summary.observations, projected: summary.projected, unchanged: summary.unchanged, baselines: summary.baselines, rows }, before, after };
    }

    const confirmationFor = (runId, counts) => `ROLLBACK ${runId.slice(0, 8)} ${counts.entities}`;
    const promotionConfirmationFor = (runId, counts) => `PROMOTE ${runId.slice(0, 8)} ${counts.observations}`;

    const jobRow = r => r && ({
        id: r.id, kind: r.kind, cursor: JSON.parse(r.cursor_json), state: r.state,
        requestBudget: Number(r.request_budget), createdAt: r.created_at, updatedAt: r.updated_at,
    });

    function validateCursor(kind, cursor) {
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw invalid('Cursor must be an object.', 'cursor');
        for (const [k, v] of Object.entries(cursor)) {
            if (!/^[A-Za-z]{1,32}$/.test(k) || !(Number.isSafeInteger(v) && v >= 0)) throw invalid('Cursor values must be non-negative integers.', 'cursor');
        }
        if (kind === 'item_frontier' && !(Number.isSafeInteger(cursor.nextItemId) && cursor.nextItemId >= 1)) throw invalid('item_frontier needs cursor.nextItemId >= 1.', 'cursor');
        const json = canonicalJson(cursor);
        if (Buffer.byteLength(json) > MAX_CURSOR_BYTES) throw invalid('Cursor is too large.', 'cursor');
        return json;
    }

    // running -> queued: an execution ended with work left (CAT-TASK-003 collector, the next run resumes).
    const JOB_TRANSITIONS = {
        queued: ['running', 'paused', 'cancelled'],
        running: ['queued', 'paused', 'completed', 'failed', 'cancelled'],
        paused: ['queued', 'running', 'cancelled'],
    };

    return {
        /**
         * Transaction 1 (AC-CAT-005, AC-CAT-006): validates everything first, so an invalid batch
         * writes nothing; then stores the run and its provenance with status 'running'.
         * @param {{ mode: string, source: string, observations: Array<{ kind: string, payload: object, observedAt?: string }> }} input
         * @param {{ onRecorded?: (tx: object, runId: string) => Promise<void> }} [opts] - runs inside the
         *   same transaction, so a caller can link the run to its own record atomically (a throw records nothing)
         */
        async recordRun({ mode, source, observations, summary = null }, { onRecorded } = {}) {
            if (!RUN_MODES.includes(mode)) throw invalid('Unknown run mode.', 'mode');
            if (!SOURCES.includes(source)) throw invalid('Unknown source.', 'source');
            let summaryJson = null;
            if (summary !== null) {
                if (typeof summary !== 'object' || Array.isArray(summary)) throw invalid('Run summary must be an object.', 'summary');
                summaryJson = canonicalJson(summary);
                if (Buffer.byteLength(summaryJson) > 2048) throw invalid('Run summary is too large.', 'summary');
            }
            if (!Array.isArray(observations) || observations.length === 0) throw invalid('A run needs at least one observation.', 'observations');
            if (observations.length > MAX_OBSERVATIONS_PER_RUN) throw invalid(`A run holds at most ${MAX_OBSERVATIONS_PER_RUN} observations.`, 'observations');
            const at = iso();
            const normalized = observations.map((o, i) => {
                try {
                    if (!o || typeof o !== 'object' || Array.isArray(o)) throw invalid('Each observation must be an object.', 'observations');
                    if (o.observedAt !== undefined && !(typeof o.observedAt === 'string' && ISO.test(o.observedAt))) throw invalid('observedAt must be a UTC ISO-8601 timestamp.', 'observedAt');
                    return { ...normalizeObservation(o.kind, o.payload), observedAt: o.observedAt ?? at };
                } catch (e) {
                    if (e instanceof CatalogError) e.index = i;
                    throw e;
                }
            });
            const runId = uuid();
            let created = 0;
            await db.transaction(async tx => {
                await lockRevision(tx);   // ordered against discardProjections(): a run is recorded before or after a reload
                await tx.query('INSERT INTO catalog_runs (id, mode, source, status, started_at, summary) VALUES (?, ?, ?, ?, ?, ?)', [runId, mode, source, 'running', at, summaryJson]);
                for (const o of normalized) {
                    const obs = await upsertObservation(tx, source, o, o.observedAt);
                    if (obs.created) created++;
                    await linkObservation(tx, runId, obs.id, o.observedAt);
                }
                if (onRecorded) await onRecorded(tx, runId);
            });
            return { runId, observations: normalized.length, newObservations: created };
        },

        /**
         * Transaction 2 (AC-CAT-005): applies a recorded run to the serving tables. On failure nothing
         * is projected, the run is marked failed with a redacted summary, and a CatalogError is thrown.
         */
        async projectRun(runId) {
            const [run] = await db.query('SELECT status FROM catalog_runs WHERE id = ?', [runId]);
            if (!run) throw new CatalogError('not_found', 'Unknown catalog run.');
            if (run.status !== 'running') throw new CatalogError('conflict', `A ${run.status} run cannot be projected.`);
            try {
                const summary = await db.transaction(async tx => {
                    await lockRevision(tx);
                    const s = await performProjection(tx, runId);
                    await bumpRevision(tx);
                    return s;
                });
                invalidateCaches();
                return summary;
            } catch (error) {
                if (error instanceof CatalogError && error.code === 'conflict') throw error;
                const summary = { error: redactedError(error, 'projection') };
                await db.query("UPDATE catalog_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ? AND status = 'running'", ['failed', iso(), JSON.stringify(summary), runId]);
                throw new CatalogError('projection_failed', 'Catalog projection failed; nothing was applied.', { cause: error, summary });
            }
        },

        /**
         * AC-CAT-003 error case: a run that read nothing usable. It has no observations and only a
         * redacted reason code (a response class or schema reason, never text from the response).
         */
        async recordFailedRun({ mode, source, stage, reason }) {
            if (!RUN_MODES.includes(mode)) throw invalid('Unknown run mode.', 'mode');
            if (!SOURCES.includes(source)) throw invalid('Unknown source.', 'source');
            const code = typeof reason === 'string' && /^[a-z][a-z0-9_ ]{0,39}$/.test(reason) ? reason : 'error';
            const runId = uuid();
            const at = iso();
            await db.query('INSERT INTO catalog_runs (id, mode, source, status, started_at, finished_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [runId, mode, source, 'failed', at, at, JSON.stringify({ error: { stage: String(stage).slice(0, 32), code } })]);
            return runId;
        },

        /** recordRun then projectRun. */
        async ingest(input, opts) {
            const recorded = await this.recordRun(input, opts);
            return { ...recorded, ...(await this.projectRun(recorded.runId)) };
        },

        async getRun(runId) {
            const [r] = await db.query('SELECT id, mode, source, status, started_at AS startedAt, finished_at AS finishedAt, summary FROM catalog_runs WHERE id = ?', [runId]);
            return r ? { ...r, summary: r.summary ? JSON.parse(r.summary) : null } : null;
        },

        async listRuns({ limit = 50, offset = 0 } = {}) {
            const l = Math.min(Math.max(1, limit | 0), 200);
            const o = Math.min(Math.max(0, offset | 0), 1_000_000);
            const rows = await db.query(`SELECT id, mode, source, status, started_at AS startedAt, finished_at AS finishedAt, summary FROM catalog_runs ORDER BY started_at DESC, id LIMIT ${l} OFFSET ${o}`);
            return rows.map(r => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
        },

        /** AC-CAT-009: an immutable preview with exact counts, a 10-minute expiry, and no state change. */
        async planRollback(runId) {
            // Dry run: perform the rollback, measure it, and roll the transaction back.
            const preview = new Error('preview');
            let simulated;
            try {
                await db.transaction(async tx => {
                    simulated = { revision: await lockRevision(tx), ...(await performRollback(tx, runId, null)) };
                    throw preview;
                });
            } catch (e) {
                if (e !== preview) throw e;
            }
            return db.transaction(async tx => {
                const revision = await lockRevision(tx);
                if (revision !== simulated.revision) throw new CatalogError('conflict', 'The catalog changed while the preview was built; try again.');
                const { counts } = simulated;
                const id = uuid();
                const createdAt = iso();
                const expiresAt = new Date(now() + PLAN_TTL_MS).toISOString();
                const confirmation = confirmationFor(runId, counts);
                await tx.query('INSERT INTO catalog_deletion_plans (id, action, target_run_id, revision, expected_counts, confirmation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [id, 'rollback', runId, revision, JSON.stringify(counts), confirmation, createdAt, expiresAt]);
                return { id, action: 'rollback', targetRunId: runId, expectedCounts: counts, confirmation, expiresAt };
            });
        },

        /**
         * CAT-TASK-007 / AC-CAT-006, AC-CAT-009: a promotion preview for a staged seed run. The
         * projection runs in a transaction that is rolled back; the plan records its exact counts.
         * Parts of one seed batch are promoted in order, so relations never precede their parents.
         */
        async planPromotion(runId) {
            const [run] = await db.query('SELECT id, mode, status, summary FROM catalog_runs WHERE id = ?', [runId]);
            if (!run) throw new CatalogError('not_found', 'Unknown catalog run.');
            if (run.mode !== 'seed' || run.status !== 'running') throw new CatalogError('conflict', 'Only a staged seed run can be promoted.');
            const seed = run.summary ? JSON.parse(run.summary).seed : null;
            if (seed?.batchId && seed.part > 1) {
                const earlier = await db.query("SELECT summary, status FROM catalog_runs WHERE mode = 'seed' AND summary LIKE ? ESCAPE '!'", [`%${seed.batchId.replace(/[!%_]/g, m => `!${m}`)}%`]);
                const pending = earlier.filter(r => { const s = JSON.parse(r.summary ?? 'null')?.seed; return s?.batchId === seed.batchId && s.part < seed.part && r.status !== 'succeeded'; });
                if (pending.length) throw new CatalogError('conflict', 'Promote the earlier parts of this seed first.');
            }
            const preview = new Error('preview');
            let simulated;
            try {
                await db.transaction(async tx => {
                    simulated = { revision: await lockRevision(tx), ...(await measuredProjection(tx, runId)) };
                    throw preview;
                });
            } catch (e) {
                if (e !== preview) throw e instanceof CatalogError ? e : new CatalogError('projection_failed', 'The staged run cannot be projected.', { cause: e });
            }
            return db.transaction(async tx => {
                const revision = await lockRevision(tx);
                if (revision !== simulated.revision) throw new CatalogError('conflict', 'The catalog changed while the preview was built; try again.');
                const { counts } = simulated;
                const id = uuid();
                const expiresAt = new Date(now() + PLAN_TTL_MS).toISOString();
                const confirmation = promotionConfirmationFor(runId, counts);
                await tx.query('INSERT INTO catalog_deletion_plans (id, action, target_run_id, revision, expected_counts, confirmation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [id, 'promote', runId, revision, JSON.stringify(counts), confirmation, iso(), expiresAt]);
                return { id, action: 'promote', targetRunId: runId, expectedCounts: counts, confirmation, expiresAt };
            });
        },

        /** Retires a staged seed run that was never promoted; its observations stay as provenance. */
        async discardStagedRun(runId) {
            const { affectedRows } = await db.query("UPDATE catalog_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND mode = 'seed' AND status = 'running'", [iso(), runId]);
            if (!affectedRows) {
                const [run] = await db.query('SELECT status FROM catalog_runs WHERE id = ?', [runId]);
                if (!run) throw new CatalogError('not_found', 'Unknown catalog run.');
                throw new CatalogError('conflict', 'Only a staged seed run can be discarded.');
            }
        },

        /**
         * AC-CAT-009, AC-CAT-010: executes an unexpired, unused plan whose revision is current and whose
         * confirmation matches exactly. Denials throw CatalogError (plan_*) and change nothing.
         */
        async executePlan(planId, { confirmation } = {}) {
            const result = await db.transaction(async tx => {
                const revision = await lockRevision(tx);
                const [plan] = await tx.query('SELECT * FROM catalog_deletion_plans WHERE id = ? FOR UPDATE', [planId]);
                if (!plan) throw new CatalogError('not_found', 'Unknown plan.');
                if (plan.used_at) throw new CatalogError('plan_used', 'This plan was already used.');
                if (Date.parse(plan.expires_at) <= now()) throw new CatalogError('plan_expired', 'This plan has expired; build a new preview.');
                if (Number(plan.revision) !== revision) throw new CatalogError('plan_stale', 'The catalog changed since this preview; build a new one.');
                if (typeof confirmation !== 'string' || confirmation !== plan.confirmation) throw new CatalogError('plan_confirmation', 'The confirmation does not match the preview.');

                const runId = plan.target_run_id;
                if (plan.action === 'promote') {
                    let measured;
                    try {
                        measured = await measuredProjection(tx, runId);
                    } catch (e) {
                        throw e instanceof CatalogError ? e : new CatalogError('projection_failed', 'Catalog projection failed; nothing was applied.', { cause: e });
                    }
                    if (canonicalJson(measured.counts) !== canonicalJson(JSON.parse(plan.expected_counts))) {
                        throw new CatalogError('plan_stale', 'The affected counts changed since this preview; build a new one.');
                    }
                    await tx.query('UPDATE catalog_deletion_plans SET used_at = ? WHERE id = ?', [iso(), planId]);
                    await bumpRevision(tx);
                    return { runId, action: 'promote', status: 'succeeded', counts: measured.counts, before: measured.before, after: measured.after };
                }
                const { counts, before, after } = await performRollback(tx, runId, planId);
                if (canonicalJson(counts) !== canonicalJson(JSON.parse(plan.expected_counts))) {
                    throw new CatalogError('plan_stale', 'The affected counts changed since this preview; build a new one.');
                }
                await tx.query('UPDATE catalog_deletion_plans SET used_at = ? WHERE id = ?', [iso(), planId]);
                await bumpRevision(tx);
                return { runId, action: 'rollback', status: 'reverted', counts, before, after };
            });
            invalidateCaches();
            return result;
        },

        /**
         * AC-CAT-013: recomputes completeness of [kind, key] item/creature entities (and entities
         * waiting on an unresolved drop), inside the caller's transaction when q is given.
         */
        async refreshCompleteness(entities, q) {
            if (q) return refreshCompleteness(q, entities);
            return db.transaction(tx => refreshCompleteness(tx, entities));
        },

        /**
         * True when a legacy reload would discard catalog work: projected serving rows, or a recorded
         * run that has not projected yet. scripts/populate_db.mjs then requires the discard flag.
         * @param {{ query: Function }} [q] - a transaction, to check under its revision lock
         */
        async hasDiscardableWork(q = db) {
            if ((await q.query('SELECT 1 AS present FROM catalog_entities LIMIT 1')).length) return true;
            return (await q.query("SELECT 1 AS present FROM catalog_runs WHERE status = 'running' LIMIT 1")).length > 0;
        },

        /**
         * For an explicit legacy full reload: serving rows stop being under catalog provenance. Every
         * succeeded or still-running run (baseline snapshots included) keeps its observations but
         * becomes 'discarded': it is never replayed, projected, or rolled back again; open plans go stale. Call inside the reload transaction, before it writes anything: the check for
         * projections happens here, under the revision lock that every projection also takes, so a
         * projection committed after an earlier (unlocked) check is never discarded by surprise.
         * @param {{ query: Function }} tx
         * @param {{ allowDiscard: boolean }} opts - the owner passed --discard-catalog-projections
         */
        async discardProjections(tx, { allowDiscard }) {
            await lockRevision(tx);
            if (!allowDiscard && await this.hasDiscardableWork(tx)) {
                throw new CatalogError('conflict', 'The catalog has projected data or a recorded run waiting to project. Re-run with --discard-catalog-projections to replace it (those runs become discarded and cannot be projected or rolled back).');
            }
            await tx.query('DELETE FROM catalog_entities');
            // Baseline snapshots describe the rows being replaced, and a recorded but unprojected run
            // would repopulate them, so both are retired too. Only runs recorded later can project.
            const { affectedRows } = await tx.query("UPDATE catalog_runs SET status = 'discarded' WHERE status IN ('succeeded', 'running')");
            await bumpRevision(tx);
            return { discardedRuns: affectedRows };
        },

        // --- durable jobs (AC-CAT-008 store side) ---

        /** Creates a queued job. A second active job of the same kind is a conflict (409). */
        async createJob({ kind, cursor, requestBudget }) {
            if (!JOB_KINDS.includes(kind)) throw invalid('Unknown job kind.', 'kind');
            if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > MAX_REQUEST_BUDGET) throw invalid(`requestBudget must be 1-${MAX_REQUEST_BUDGET}.`, 'requestBudget');
            const json = validateCursor(kind, cursor);
            const id = uuid();
            const at = iso();
            try {
                await db.query('INSERT INTO catalog_jobs (id, kind, cursor_json, state, request_budget, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [id, kind, json, 'queued', requestBudget, at, at]);
            } catch (e) {
                if (e?.code === 'ER_DUP_ENTRY') throw new CatalogError('conflict', `An active ${kind} job already exists.`);
                throw e;
            }
            return id;
        },

        async getJob(id) {
            const [r] = await db.query('SELECT * FROM catalog_jobs WHERE id = ?', [id]);
            return jobRow(r) ?? null;
        },

        async listJobs() {
            return (await db.query('SELECT * FROM catalog_jobs ORDER BY created_at DESC, id LIMIT 100')).map(jobRow);
        },

        /** Moves a job along an allowed transition; a concurrent change or a bad transition is a conflict. */
        async transitionJob(id, to) {
            const [r] = await db.query('SELECT state FROM catalog_jobs WHERE id = ?', [id]);
            if (!r) throw new CatalogError('not_found', 'Unknown job.');
            if (!(JOB_TRANSITIONS[r.state] ?? []).includes(to)) throw new CatalogError('conflict', `A ${r.state} job cannot become ${String(to).slice(0, 16)}.`);
            try {
                const { affectedRows } = await db.query('UPDATE catalog_jobs SET state = ?, updated_at = ? WHERE id = ? AND state = ?', [to, iso(), id, r.state]);
                if (!affectedRows) throw new CatalogError('conflict', 'The job changed concurrently.');
            } catch (e) {
                if (e?.code === 'ER_DUP_ENTRY') throw new CatalogError('conflict', 'Another job of this kind is already active.');
                throw e;
            }
            return this.getJob(id);
        },

        /** Saves a validated cursor for a running job (the collector checkpoints after each validated response). */
        async checkpointJob(id, cursor) {
            const [r] = await db.query('SELECT kind, state FROM catalog_jobs WHERE id = ?', [id]);
            if (!r) throw new CatalogError('not_found', 'Unknown job.');
            const json = validateCursor(r.kind, cursor);
            const { affectedRows } = await db.query("UPDATE catalog_jobs SET cursor_json = ?, updated_at = ? WHERE id = ? AND state = 'running'", [json, iso(), id]);
            if (!affectedRows) throw new CatalogError('conflict', 'Only a running job can checkpoint.');
        },
    };
}
