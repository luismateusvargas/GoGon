// catalog/collector.js - CAT-TASK-003 / AC-CAT-001..AC-CAT-005 (catalog-sync-v1 1.3.0)
// The passive game collector. It runs one catalog job execution at a time through the shared game
// queue (one request in flight, GAME_POLICY delay), using the caller's authenticated fetch (the
// session.mjs cookie jar) and never logging in itself: a login page or a rejected session backs the
// job off until GoGon's own session upkeep has signed in again; a Cloudflare challenge pauses it for
// the owner. Only a classified 'ok' response that normalizes cleanly moves a cursor; everything else
// leaves it where it was, with a redacted reason and a backoff.
//
// Job kinds: observe_realm (recurring: one current-location read per execution) and item_frontier
// (up to request_budget item-detail reads from its cursor). Both need a verified read contract;
// with the committed contracts neither is available (DEC-CAT-019), and the collector refuses them
// without making a request. guide_discovery uses the server guide worker or legacy relay, not here.
import { classifyResponse } from './contracts/classify.js';
import { GAME_POLICY } from './contracts/policy.js';
import { gameQueue, readOperations, unavailableReason } from './requestPolicy.js';
import { normalizeLocation, normalizeItem, NormalizeError } from './normalizers.js';

// item_frontier: this many consecutive known-not-found IDs end the frontier for an execution; the
// next execution starts FRONTIER_OVERLAP IDs below the highest confirmed one (AC-CAT-004).
export const FRONTIER_END_MISSES = 25;
export const FRONTIER_OVERLAP = 10;

const SESSION_CLASSES = new Set(['login', 'unauthenticated']);
const RETRY_CLASSES = new Set(['rate_limited', 'server_error', 'http_error']);

/**
 * @param {object} deps
 * @param {object} deps.store - catalogStore
 * @param {(url: string, init: object) => Promise<Response>} deps.fetchFn - the authenticated fetch
 * @param {object} [deps.queue] - request queue (default: the process-wide game queue)
 * @param {object} [deps.operations] - read operations (test seam for contracts)
 * @param {() => { ok: boolean, reason?: string }} [deps.sessionReady] - engine/account state
 */
export function createCollector({ store, fetchFn, queue = gameQueue, operations = readOperations(), sessionReady = () => ({ ok: true }), now = Date.now, policy = GAME_POLICY }) {
    const backoff = new Map();      // jobId -> { until, failures }
    const lastResult = new Map();   // jobId -> redacted summary of its latest execution

    async function request(req, signal) {
        return queue.run(async () => {
            const timeout = AbortSignal.timeout(policy.requestTimeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let res;
            try {
                res = await fetchFn(req.url, { method: 'GET', redirect: 'follow', signal: combined, headers: { accept: req.expect === 'json' ? 'application/json' : 'text/html' } });
            } catch (e) {
                if (signal?.aborted) throw signal.reason ?? e;
                return { class: 'server_error', reason: timeout.aborted ? 'timeout' : 'network error' };
            }
            let body = '';
            try { body = await res.text(); } catch (e) {
                if (signal?.aborted) throw signal.reason ?? e;
                return { class: 'server_error', reason: 'unreadable body' };
            }
            // A stop requested while the response arrived wins: the response is not processed.
            signal?.throwIfAborted();
            return classifyResponse({ status: res.status, contentType: res.headers.get('content-type') ?? '', cfMitigated: res.headers.get('cf-mitigated'), body }, req.expect);
        }, signal);
    }

    function setBackoff(jobId) {
        const prev = backoff.get(jobId);
        const failures = (prev?.failures ?? 0) + 1;
        const delay = policy.backoffMs[Math.min(failures, policy.backoffMs.length) - 1];
        backoff.set(jobId, { until: now() + delay, failures });
        return delay;
    }

    /** Saves a cursor; false when the owner paused or cancelled the job meanwhile. */
    async function checkpoint(jobId, cursor) {
        try { await store.checkpointJob(jobId, cursor); return true; } catch (e) { if (e?.code === 'conflict') return false; throw e; }
    }

    /** Moves the job only if it is still where this execution left it (an owner pause wins). */
    async function settle(jobId, to) {
        try { await store.transitionJob(jobId, to); } catch (e) { if (e?.code !== 'conflict') throw e; }
    }

    async function observeRealm(job, op, signal) {
        const r = await request(op.request(), signal);
        const summary = { requests: 1, class: r.class };
        if (r.class !== 'ok') return { ...summary, ...(await failureOf(r, 'observe_realm')) };
        let normalized;
        try {
            normalized = normalizeLocation(r.json, op.contract);
        } catch (e) {
            if (!(e instanceof NormalizeError)) throw e;
            await store.recordFailedRun({ mode: 'observe_realm', source: 'game_session', stage: 'normalize', reason: e.reason });
            return { ...summary, outcome: 'failed_run', reason: 'unrecognized response' };
        }
        try {
            const run = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: normalized.observations });
            if (!(await checkpoint(job.id, { observations: (job.cursor.observations ?? 0) + 1, realmId: normalized.realmId }))) {
                return { ...summary, outcome: 'interrupted', reason: 'job_state_changed', runId: run.runId };
            }
            return { ...summary, outcome: 'ok', runId: run.runId, observations: run.observations };
        } catch (e) {
            if (e?.code === 'projection_failed' || e?.code === 'invalid') return { ...summary, outcome: 'failed_run', reason: e.code };
            throw e;
        }
    }

    async function itemFrontier(job, op, signal) {
        let { nextItemId, highestConfirmedItemId = 0, misses = 0 } = job.cursor;
        const found = [];
        const summary = { requests: 0, found: 0, notFound: 0 };
        let stop = null;
        let cursor = { nextItemId, highestConfirmedItemId, misses };
        for (let i = 0; i < job.requestBudget; i++) {
            const r = await request(op.request(nextItemId), signal);
            summary.requests++;
            if (r.class !== 'ok') { stop = { class: r.class, ...(await failureOf(r, 'item_frontier')) }; break; }
            let item;
            try {
                item = normalizeItem(r.json, op.contract, nextItemId);
            } catch (e) {
                if (!(e instanceof NormalizeError)) throw e;
                await store.recordFailedRun({ mode: 'item_frontier', source: 'game_session', stage: 'normalize', reason: e.reason });
                stop = { outcome: 'failed_run', reason: 'unrecognized response' };
                break;
            }
            if (item.found) {
                found.push(item.observation);
                summary.found++;
                highestConfirmedItemId = Math.max(highestConfirmedItemId, nextItemId);
                misses = 0;
            } else {
                summary.notFound++;   // a classified negative: counted, never treated as absence
                misses++;
            }
            nextItemId++;
            if (misses >= FRONTIER_END_MISSES) {
                // End of the known frontier: the next execution re-reads an overlap window.
                nextItemId = Math.max(1, highestConfirmedItemId - FRONTIER_OVERLAP + 1);
                misses = 0;
                cursor = { nextItemId, highestConfirmedItemId, misses };
                break;
            }
            cursor = { nextItemId, highestConfirmedItemId, misses };
        }
        // Validated results are stored before the cursor that covers them.
        if (found.length) {
            try {
                const run = await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: found });
                summary.runId = run.runId;
            } catch (e) {
                if (e?.code === 'projection_failed' || e?.code === 'invalid') return { ...summary, outcome: 'failed_run', reason: e.code };
                throw e;
            }
        }
        if (summary.requests && (found.length || summary.notFound) && !(await checkpoint(job.id, cursor))) {
            return { ...summary, outcome: 'interrupted', reason: 'job_state_changed' };
        }
        return stop ? { ...summary, ...stop } : { ...summary, outcome: 'ok' };
    }

    /** Outcome of a non-ok response; unusable content (malformed, too large, 404) records a failed run. */
    async function failureOf(r, mode) {
        // The collector never logs in; GoGon's own session upkeep does, so the job only backs off.
        if (SESSION_CLASSES.has(r.class)) return { outcome: 'backoff', reason: 'session_unavailable' };
        if (r.class === 'challenge') return { outcome: 'paused', reason: 'challenge' };
        if (RETRY_CLASSES.has(r.class)) return { outcome: 'backoff', reason: r.class };
        await store.recordFailedRun({ mode, source: 'game_session', stage: 'response', reason: r.class });
        return { outcome: 'failed_run', reason: r.class };
    }

    return {
        /**
         * Runs one execution of a queued job. Returns a redacted summary; never throws for a game
         * response, only for aborts and store/programming errors.
         */
        async runJob(job, { signal } = {}) {
            const done = result => { lastResult.set(job.id, { ...result, at: new Date(now()).toISOString() }); return result; };
            const why = unavailableReason(job.kind, operations);
            if (why) return done({ outcome: 'unavailable', reason: why, requests: 0 });
            const session = sessionReady();
            if (!session.ok) return done({ outcome: 'waiting', reason: session.reason ?? 'session_unavailable', requests: 0 });
            const b = backoff.get(job.id);
            if (b && b.until > now()) return done({ outcome: 'waiting', reason: 'backoff', requests: 0, retryAt: new Date(b.until).toISOString() });
            if (job.state !== 'queued') return done({ outcome: 'skipped', reason: job.state, requests: 0 });

            try { await store.transitionJob(job.id, 'running'); } catch (e) {
                if (e?.code === 'conflict') return done({ outcome: 'skipped', reason: 'job_state_changed', requests: 0 });
                throw e;
            }
            const running = await store.getJob(job.id);
            let result;
            try {
                const op = operations[job.kind];
                if (job.kind === 'observe_realm') result = await observeRealm(running, op, signal);
                else result = await itemFrontier(running, op, signal);
            } catch (e) {
                await settle(job.id, 'queued');
                if (signal?.aborted) return done({ outcome: 'aborted', requests: 0 });
                throw e;
            }
            if (result.outcome === 'interrupted') {
                // The owner changed the job during the execution; leave it where they put it.
            } else if (result.outcome === 'paused') {
                await settle(job.id, 'paused');
            } else {
                if (result.outcome === 'backoff' || result.outcome === 'failed_run') result.retryInMs = setBackoff(job.id);
                else backoff.delete(job.id);
                await settle(job.id, 'queued');
            }
            return done(result);
        },

        /** Latest execution result per job, for the Catalog tab (redacted). */
        lastResults() { return Object.fromEntries(lastResult); },
    };
}
