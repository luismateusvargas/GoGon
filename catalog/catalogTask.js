// catalog/catalogTask.js - CAT-TASK-004 / AC-CAT-001, AC-CAT-002, AC-CAT-008 (catalog-sync-v1 1.3.0)
// The CatalogSync engine task. engine.js registers it disabled by default; the owner enables it
// like any module (persisted in module_preferences). Each run executes the queued game jobs once,
// serially, through the collector. The engine never starts a task while it is paused for an account
// switch, and pauseAll() aborts a run in flight, so a switch never overlaps a catalog request.
// withCatalogLock() is shared with foreground catalog commands (control plane), so a scheduled run
// and an owner-triggered one never overlap: the second one is told the catalog is busy.

let service = null;        // { store, collector } - built lazily, or injected by configureCatalogTask()
let recovered = false;     // jobs left 'running' by a crash are handed back once per process
let locked = false;

/** Runs fn while holding the process-wide catalog lock; null when another holder has it. */
export async function withCatalogLock(fn) {
    if (locked) return null;
    locked = true;
    try { return { value: await fn() }; } finally { locked = false; }
}

export function isCatalogBusy() {
    return locked;
}

/**
 * Wires the task to a store and collector (control plane boot, tests). Without it, the first run
 * builds them from the shared database connection and the session.mjs authenticated fetch.
 */
export function configureCatalogTask(deps) {
    service = deps;
    recovered = false;
}

async function ensureService() {
    if (service) return service;
    const [{ getConnection }, { createCatalogStore }, { createCollector }, { authedFetch }] = await Promise.all([
        import('../_gg_data/handler/gg_database.js'),
        import('../_gg_data/handler/catalogStore.js'),
        import('./collector.js'),
        import('../session.mjs'),
    ]);
    const store = createCatalogStore(await getConnection());
    service = { store, collector: createCollector({ store, fetchFn: authedFetch }) };
    return service;
}

/** Game job kinds this task runs; guide_discovery belongs to the browser relay. */
const GAME_JOB_KINDS = new Set(['observe_realm', 'item_frontier']);

/**
 * Engine handler. Returns a small summary (the engine records only ok/error/aborted).
 * @param {{ signal?: AbortSignal }} ctx
 */
export async function runCatalogSync({ signal } = {}) {
    const { store, collector } = await ensureService();
    const held = await withCatalogLock(async () => {
        if (!recovered) {
            for (const job of await store.listJobs()) {
                if (job.state === 'running') {
                    try { await store.transitionJob(job.id, 'queued'); } catch (e) { if (e?.code !== 'conflict') throw e; }
                }
            }
            recovered = true;
        }
        const results = [];
        for (const job of await store.listJobs()) {
            if (signal?.aborted) break;
            if (!GAME_JOB_KINDS.has(job.kind) || job.state !== 'queued') continue;
            const r = await collector.runJob(job, { signal });
            results.push({ jobId: job.id, kind: job.kind, outcome: r.outcome, reason: r.reason ?? null, requests: r.requests ?? 0 });
        }
        return results;
    });
    return held ? { ran: held.value } : { skipped: 'busy' };
}
