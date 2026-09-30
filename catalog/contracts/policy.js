// catalog/contracts/policy.js - CAT-TASK-001 / AC-CAT-002, AC-CAT-015 (catalog-sync-v1 1.2.x)
// Request policies for the two catalog sources. They are separate on purpose: the guide never
// inherits the game budget by accident, and neither policy is editable from the dashboard. A change
// here is an owner decision recorded in docs/catalog-sync-control-plane-plan.md.

/** Game-session reads through the existing authenticated cookie jar (AC-CAT-002). */
export const GAME_POLICY = Object.freeze({
    source: 'game_session',
    maxInFlight: 1,               // process-wide
    minDelayMs: 3_000,            // between two game requests
    maxRequestsPerExecution: 50,  // a job's request_budget may not exceed this
    backoffMs: Object.freeze([30_000, 120_000, 600_000]),   // after 429 / 5xx / timeout, by consecutive failure
    requestTimeoutMs: 15_000,
});

/**
 * Guide discovery through the server worker or owner's validated browser (AC-CAT-011, AC-CAT-015).
 * Page counts are estimates, never ceilings. Every check reads all index pages, stopping at the
 * guide's repeated final page. An empty page is partial coverage. Details are scheduled independently.
 */
export const GUIDE_POLICY = Object.freeze({
    source: 'guide_baseline',
    maxInFlight: 1,                       // the relay is serial
    minDelayMs: 3_000,                    // between two guide requests
    maxRequestsPerExecution: 50,          // one relay work lease (catalog_jobs.request_budget <= 50)
    dailyRequestCap: null,                // owner disabled the daily cap; usage is still counted
    checkIntervalMs: 7 * 24 * 3600_000,   // a kind becomes due a week after its last successful check (DEC-CAT-023)
    detailRefreshAfterMs: 7 * 24 * 3600_000, // every detail is re-read weekly; a weekly sweep start also makes all due
    maxDetailAttempts: 5,                 // then the ID stays incomplete with reason detail_failed
    leaseTtlMs: 10 * 60_000,              // an unanswered work lease expires and is re-issued
    partialRetryMs: 60 * 60_000,          // a sweep stopped by a bad or failed page waits this long before retrying
    estimatedIndexPages: Object.freeze({ item: 661, creature: 330, realm: 289, master_realm: 15 }),
});

/** Full-sweep feasibility under GUIDE_POLICY (AC-CAT-015): request count, duration, lease count. */
export function fullSweepEstimate(policy = GUIDE_POLICY) {
    const pages = Object.values(policy.estimatedIndexPages).reduce((a, b) => a + b, 0);
    return {
        indexPages: pages,
        minDurationMs: pages * policy.minDelayMs,
        leases: Math.ceil(pages / policy.maxRequestsPerExecution),
    };
}
