// catalog/guideRelay.js - CAT-TASK-010 / AC-CAT-011, AC-CAT-012, AC-CAT-013, AC-CAT-014, AC-CAT-015
// The server half of the guide relay (DEC-CAT-015). The relay userscript in the owner's browser
// authenticates with a stage-only token and asks for a lease: the server picks one guide kind and
// the exact index pages or detail IDs to read, within the guide policy and the daily cap. The relay
// returns results in lease order; the server validates them (catalog/guideNormalizers.js), stages the
// observations under the owner-enabled guide_discovery job, and only then moves the checkpoints.
//
// Sweeps: page 0 holds the newest records (DEC-CAT-017). An incremental sweep stops one overlap page
// after the page that reaches last_seen_id; a full sweep (first sweep, weekly, or after an order
// violation) reads until the first valid empty page. Every page is checked for descending IDs; a
// violation turns the sweep full. Only a sweep that covered every required page moves
// last_successful_check_at and last_seen_id (AC-CAT-015). A challenge, invalid page, or failed request
// stops the lease and leaves the cursor at that page.
import crypto from 'node:crypto';
import { CatalogError } from '../_gg_data/handler/catalogStore.js';
import { GUIDE_KINDS } from '../_gg_data/handler/guideDiscoveryStore.js';
import { GUIDE_POLICY } from './contracts/policy.js';
import { isDescendingPage } from './contracts/guide.js';
import { normalizeGuideRecord, indexEntry } from './guideNormalizers.js';

export const TOKEN_PREFIX = 'ggr_';
export const MAX_TOKEN_TTL_DAYS = 7;
export const MAX_ACTIVE_TOKENS = 3;
export const MAX_RELAY_BODY = 512 * 1024;
const INDEX_OUTCOMES = ['ok', 'empty', 'challenge', 'invalid', 'error'];
const DETAIL_OUTCOMES = ['ok', 'missing', 'challenge', 'invalid', 'error'];
const LEASE_ORDER = ['master_realm', 'realm', 'creature', 'item'];   // small indexes first
const SERVING_TABLE = { item: 'items', creature: 'creatures', realm: 'realms', master_realm: 'master_realms' };
const DAY = 24 * 3600_000;

const invalid = (message, field) => new CatalogError('invalid', message, field ? { field } : {});
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export const hashToken = token => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

/**
 * @param {object} deps
 * @param {{ query: Function, transaction: Function }} deps.db
 * @param {object} deps.store - catalogStore
 * @param {object} deps.guideStore - guideDiscoveryStore
 */
export function createGuideRelay({ db, store, guideStore, policy = GUIDE_POLICY, now = Date.now }) {
    const iso = (t = now()) => new Date(t).toISOString();

    async function activeGuideJob() {
        return (await store.listJobs()).find(j => j.kind === 'guide_discovery' && ['queued', 'running', 'paused'].includes(j.state)) ?? null;
    }

    function due(s, t) {
        return !s.lastSuccessfulCheckAt || t - Date.parse(s.lastSuccessfulCheckAt) >= policy.checkIntervalMs;
    }

    function sweepModeFor(s, t) {
        const full = !s.lastSuccessfulCheckAt || !s.lastFullSweepAt || s.lastSeenId === 0 || s.orderState === 'violated'
            || t - Date.parse(s.lastFullSweepAt) >= policy.fullSweepIntervalMs;
        return full ? 'full' : 'incremental';
    }

    /** The lease as the relay sees it; an incremental index lease also carries its stop hint. */
    const leaseOut = (row, s) => {
        const work = JSON.parse(row.work);
        const incremental = work[0]?.type === 'index' && s?.sweepMode === 'incremental' && s.stopAfterPage === null && s.orderState !== 'violated';
        return {
            leaseId: row.id, kind: row.entity_kind, work, minDelayMs: policy.minDelayMs, expiresAt: row.expires_at,
            stopAtId: incremental ? s.lastSeenId : null, overlapPages: policy.overlapPages,
        };
    };

    async function exists(kind, id) {
        return (await db.query(`SELECT 1 AS present FROM ${SERVING_TABLE[kind]} WHERE id = ?`, [id])).length > 0;
    }

    /** Validates the whole submission against its lease before anything is written. */
    function validateResults(body, work) {
        if (!isPlain(body) || Object.keys(body).some(k => k !== 'results')) throw invalid('Body must be { results }.', 'body');
        const { results } = body;
        if (!Array.isArray(results) || results.length > work.length) throw invalid('results must follow the lease.', 'results');
        results.forEach((r, i) => {
            const w = work[i];
            if (!isPlain(r) || r.type !== w.type) throw invalid(`Result ${i} does not match the lease.`, 'results');
            if (w.type === 'index') {
                if (r.page !== w.page || !INDEX_OUTCOMES.includes(r.outcome)) throw invalid(`Result ${i} does not match the lease.`, 'results');
                const allowed = r.outcome === 'ok' ? ['type', 'page', 'outcome', 'entries'] : ['type', 'page', 'outcome'];
                if (Object.keys(r).some(k => !allowed.includes(k))) throw invalid(`Result ${i} has unexpected fields.`, 'results');
                if (r.outcome === 'ok' && !(Array.isArray(r.entries) && r.entries.length >= 1 && r.entries.length <= 500 && r.entries.every(indexEntry))) {
                    throw invalid(`Result ${i} has invalid index entries.`, 'results');
                }
            } else {
                if (r.id !== w.id || !DETAIL_OUTCOMES.includes(r.outcome)) throw invalid(`Result ${i} does not match the lease.`, 'results');
                const allowed = r.outcome === 'ok' ? ['type', 'id', 'outcome', 'record'] : ['type', 'id', 'outcome'];
                if (Object.keys(r).some(k => !allowed.includes(k))) throw invalid(`Result ${i} has unexpected fields.`, 'results');
                if (r.outcome === 'ok' && !isPlain(r.record)) throw invalid(`Result ${i} has no record.`, 'results');
            }
        });
        return results;
    }

    return {
        // --- tokens (issued and revoked through the owner session only) ---

        async issueToken({ label, ttlDays }) {
            if (typeof label !== 'string' || !/^[\w .-]{1,64}$/.test(label)) throw invalid('label: 1-64 letters, digits, spaces, dot, dash, underscore.', 'label');
            if (!(Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= MAX_TOKEN_TTL_DAYS)) throw invalid(`ttlDays must be 1-${MAX_TOKEN_TTL_DAYS}.`, 'ttlDays');
            const t = now();
            const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM catalog_relay_tokens WHERE revoked_at IS NULL AND expires_at > ?', [iso(t)]);
            if (Number(n) >= MAX_ACTIVE_TOKENS) throw new CatalogError('conflict', `At most ${MAX_ACTIVE_TOKENS} relay tokens can be active; revoke one first.`);
            const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
            const id = crypto.randomUUID();
            const expiresAt = iso(t + ttlDays * DAY);
            await db.query('INSERT INTO catalog_relay_tokens (id, token_hash, label, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
                [id, hashToken(token), label, 'guide_stage', iso(t), expiresAt]);
            return { id, token, label, expiresAt };
        },

        async listTokens() {
            return (await db.query('SELECT id, label, scope, created_at, expires_at, revoked_at, last_used_at FROM catalog_relay_tokens ORDER BY created_at DESC LIMIT 20'))
                .map(r => ({ id: r.id, label: r.label, scope: r.scope, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, active: !r.revoked_at && Date.parse(r.expires_at) > now() }));
        },

        async revokeToken(id) {
            const { affectedRows } = await db.query('UPDATE catalog_relay_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [iso(), id]);
            if (!affectedRows) throw new CatalogError('not_found', 'Unknown or already revoked token.');
        },

        /** The token row for a bearer value, or null (unknown, revoked, expired, or wrong scope). */
        async authenticate(bearer) {
            if (typeof bearer !== 'string' || !bearer.startsWith(TOKEN_PREFIX) || bearer.length > 100) return null;
            const [row] = await db.query('SELECT id, scope, expires_at, revoked_at FROM catalog_relay_tokens WHERE token_hash = ?', [hashToken(bearer)]);
            if (!row || row.revoked_at || row.scope !== 'guide_stage' || Date.parse(row.expires_at) <= now()) return null;
            await db.query('UPDATE catalog_relay_tokens SET last_used_at = ? WHERE id = ?', [iso(), row.id]);
            return { id: row.id };
        },

        async lastSeenAt() {
            const [r] = await db.query('SELECT MAX(last_used_at) AS t FROM catalog_relay_tokens');
            return r?.t ?? null;
        },

        // --- leases ---

        /** The work the relay should do next, or why there is none. */
        async nextLease(tokenId) {
            const job = await activeGuideJob();
            if (!job) return { status: 'disabled' };
            if (job.state === 'paused') return { status: 'paused' };
            const t = now();
            const [open] = await db.query('SELECT * FROM catalog_guide_leases WHERE completed_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1', [iso(t)]);
            if (open) return open.token_id === tokenId ? { status: 'lease', lease: leaseOut(open, await guideStore.getState(open.entity_kind)) } : { status: 'busy' };
            const budget = Math.min(job.requestBudget, policy.maxRequestsPerExecution, policy.dailyRequestCap - (await guideStore.usage()));
            if (budget <= 0) return { status: 'cap_reached' };

            let kind = null;
            let work = [];
            const states = new Map((await guideStore.listStates()).map(s => [s.entityKind, s]));
            for (const k of LEASE_ORDER) {
                const s = states.get(k);
                // A sweep stopped at a bad or failed page is retried later, not in a tight loop.
                if (s.sweepMode && s.status === 'partial' && t - Date.parse(s.updatedAt) < policy.partialRetryMs) continue;
                if (!s.sweepMode) {
                    if (!due(s, t)) continue;
                    await guideStore.updateState(k, {
                        sweepMode: sweepModeFor(s, t), sweepStartedAt: iso(t), nextPage: 0, sweepPagesChecked: 0,
                        sweepMaxId: 0, sweepPrevMinId: null, stopAfterPage: null, status: 'running', statusReason: null,
                    });
                    Object.assign(s, await guideStore.getState(k));
                }
                const last = s.stopAfterPage ?? Infinity;
                for (let p = s.nextPage; p <= last && work.length < budget; p++) work.push({ type: 'index', page: p });
                if (work.length) { kind = k; break; }
            }
            if (!kind) {
                for (const k of LEASE_ORDER) {
                    const pending = (await db.query(
                        `SELECT entity_id, detail_status FROM catalog_guide_ids WHERE entity_kind = ? AND next_detail_at <= ?
                         ORDER BY CASE WHEN detail_status = 'pending' THEN 0 ELSE 1 END, next_detail_at, entity_id LIMIT ${budget}`, [k, iso(t)]));
                    let refreshes = 0;
                    work = pending.filter(r => r.detail_status === 'pending' || refreshes++ < policy.detailRefreshPerExecution)
                        .map(r => ({ type: 'detail', id: Number(r.entity_id) }));
                    if (work.length) { kind = k; break; }
                }
            }
            if (!kind) {
                const next = [...states.values()].filter(s => s.lastSuccessfulCheckAt).map(s => Date.parse(s.lastSuccessfulCheckAt) + policy.checkIntervalMs);
                return { status: 'idle', nextCheckAt: next.length ? iso(Math.min(...next)) : null };
            }
            const row = { id: crypto.randomUUID(), entity_kind: kind, work: JSON.stringify(work), expires_at: iso(t + policy.leaseTtlMs) };
            await db.query('INSERT INTO catalog_guide_leases (id, token_id, job_id, entity_kind, work, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [row.id, tokenId, job.id, kind, row.work, iso(t), row.expires_at]);
            return { status: 'lease', lease: leaseOut(row, await guideStore.getState(kind)) };
        },

        /**
         * AC-CAT-014: accepts the results of an open lease from its own token. Everything is validated
         * first (a bad submission writes nothing); observations are staged and projected under the
         * guide job; then checkpoints and detail refresh times move.
         */
        async submit(tokenId, leaseId, body) {
            const [lease] = await db.query('SELECT * FROM catalog_guide_leases WHERE id = ?', [leaseId]);
            if (!lease || lease.token_id !== tokenId) throw new CatalogError('not_found', 'Unknown lease.');
            if (lease.completed_at) throw new CatalogError('conflict', 'This lease was already submitted.');
            if (Date.parse(lease.expires_at) <= now()) throw new CatalogError('conflict', 'This lease expired; ask for a new one.');
            const job = await activeGuideJob();
            if (!job || job.state === 'paused') throw new CatalogError('conflict', 'The guide job is not enabled.');
            const kind = lease.entity_kind;
            const results = validateResults(body, JSON.parse(lease.work));

            // 1. Build observations (read-only).
            const observations = [];
            const detailMarks = [];     // [id, outcome, hash]
            const register = [];        // [kind, id] discovered through links
            const staged = new Set();   // `${kind}|${id}` of entities in this batch (the row will exist)
            const named = new Set();    // ... of those staged with a name
            const references = [];
            const relations = [];
            let stopReason = null;
            for (const r of results) {
                if (r.outcome === 'challenge') { stopReason = 'cloudflare challenge'; break; }
                if (r.type === 'index') {
                    if (r.outcome !== 'ok') break;
                    // AC-CAT-011: a new ID gets a minimal (incomplete) record until its detail is read.
                    for (const e of r.entries) {
                        const key = `${kind}|${e.id}`;
                        if (e.name && !named.has(key) && !(await exists(kind, e.id))) {
                            observations.push({ kind, payload: { id: e.id, name: e.name } });
                            staged.add(key);
                            named.add(key);
                        }
                    }
                    continue;
                }
                if (r.outcome !== 'ok') { detailMarks.push([r.id, r.outcome === 'missing' ? 'missing' : 'failed', null]); continue; }
                const n = normalizeGuideRecord(kind, r.record, r.id);
                if (!n) { detailMarks.push([r.id, 'failed', null]); continue; }
                const prev = await guideStore.getIdState(kind, r.id);
                detailMarks.push([r.id, 'ok', n.hash]);
                if (prev?.hash === n.hash && await exists(kind, r.id)) continue;   // unchanged since the last read
                observations.push(...n.observations);
                for (const o of n.observations) {
                    if (o.payload.id === undefined) continue;
                    staged.add(`${o.kind}|${o.payload.id}`);
                    if (o.payload.name) named.add(`${o.kind}|${o.payload.id}`);
                }
                references.push(...n.references);
                relations.push(...n.relations);
            }
            // Linked entities the catalog does not have yet: a named minimal record and a pending detail.
            for (const ref of references) {
                const key = `${ref.kind}|${ref.id}`;
                if (named.has(key) || (await exists(ref.kind, ref.id))) continue;
                register.push([ref.kind, ref.id]);
                if (ref.name) { observations.push({ kind: ref.kind, payload: { id: ref.id, name: ref.name } }); staged.add(key); named.add(key); }
            }
            const present = async (k, id) => staged.has(`${k}|${id}`) || exists(k, id);
            for (const rel of relations) {
                const [a, b] = rel.type === 'realm_creature' ? [['realm', rel.realm_id], ['creature', rel.creature_id]] : [['creature', rel.creature_id], ['item', rel.item_id]];
                if ((await present(...a)) && (await present(...b))) observations.push({ kind: 'relation', payload: rel });
            }

            // 2. Stage and project under the guide job (DEC-CAT-015). A failure leaves every cursor put.
            let run = null;
            if (observations.length) run = await store.ingest({ mode: 'guide_discovery', source: 'guide_baseline', observations });

            // 3. Move checkpoints and detail refresh times.
            const outcome = await db.transaction(async tx => {
                const summary = { requests: results.length, pages: 0, newIds: 0, details: 0, sweepComplete: false, status: null };
                let s = await guideStore.getState(kind, tx, { lock: true });
                const set = async fields => { await guideStore.updateState(kind, fields, tx); s = { ...s, ...fields }; };
                const complete = async lastPage => {
                    const fields = {
                        lastSeenId: Math.max(s.lastSeenId, s.sweepMaxId), lastSuccessfulCheckAt: iso(), status: 'idle', statusReason: null,
                        sweepMode: null, sweepStartedAt: null, nextPage: 0, sweepPagesChecked: 0, sweepMaxId: 0, sweepPrevMinId: null, stopAfterPage: null,
                        orderState: s.orderState === 'violated' ? 'violated' : 'verified',
                    };
                    if (s.sweepMode === 'full') Object.assign(fields, { lastFullSweepAt: iso(), lastPageSeen: lastPage });
                    await set(fields);
                    summary.sweepComplete = true;
                };
                for (const r of results) {
                    if (r.type !== 'index' || !s.sweepMode) continue;
                    if (r.outcome === 'ok') {
                        const ids = [...new Set(r.entries.map(e => e.id))];
                        const fields = {};
                        if (!isDescendingPage(ids, s.sweepPrevMinId) && s.orderState !== 'violated') {
                            fields.orderState = 'violated';
                            if (s.sweepMode === 'incremental') { fields.sweepMode = 'full'; fields.stopAfterPage = null; }
                        }
                        summary.newIds += (await guideStore.recordIndexIds(kind, ids, tx)).length;
                        const minId = Math.min(...ids);
                        Object.assign(fields, { sweepMaxId: Math.max(s.sweepMaxId, ...ids), sweepPrevMinId: minId, nextPage: r.page + 1, sweepPagesChecked: s.sweepPagesChecked + 1, status: 'running', statusReason: null });
                        await set(fields);
                        summary.pages++;
                        if (s.sweepMode === 'incremental' && s.stopAfterPage === null && minId <= s.lastSeenId) await set({ stopAfterPage: r.page + policy.overlapPages });
                        if (s.stopAfterPage !== null && r.page >= s.stopAfterPage) { await complete(r.page); break; }
                    } else if (r.outcome === 'empty') {
                        const unexpected = r.page === 0 || (s.sweepMode === 'full' && s.lastPageSeen !== null && r.page <= s.lastPageSeen);
                        if (unexpected) { await set({ status: 'partial', statusReason: 'unexpected empty page' }); break; }
                        await complete(r.page - 1);
                        break;
                    } else {
                        await set({ status: r.outcome === 'challenge' ? 'challenged' : 'partial', statusReason: { challenge: 'cloudflare challenge', invalid: 'not a guide page', error: 'request failed' }[r.outcome] });
                        break;
                    }
                }
                const detailLease = results.some(r => r.type === 'detail');
                if (stopReason && detailLease) await set({ status: 'challenged', statusReason: stopReason });
                else if (detailLease && !s.sweepMode && s.status === 'challenged') await set({ status: 'idle', statusReason: null });
                for (const [id, out, hash] of detailMarks) { await guideStore.markDetail(kind, id, { outcome: out, hash }, policy, tx); summary.details++; }
                for (const [k, id] of register) await guideStore.registerIds(k, [id], tx);
                if (kind === 'item' || kind === 'creature') await store.refreshCompleteness(detailMarks.map(([id]) => [kind, String(id)]), tx);
                await guideStore.addUsage(results.length, tx);
                await tx.query('UPDATE catalog_guide_leases SET completed_at = ? WHERE id = ?', [iso(), leaseId]);
                summary.status = s.status;
                return summary;
            });
            return { ...outcome, runId: run?.runId ?? null, observations: observations.length };
        },
    };
}

export { GUIDE_KINDS };
