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
 * Guide discovery through the owner's validated browser (AC-CAT-011, AC-CAT-015). Index sizes come
 * from the supplied reconciliation/scrappers userscripts (item index 0..660, creature 0..320,
 * realm 0..281, master realm 0..14); they are estimates for the schedule, never page ceilings: a
 * sweep ends at the first valid empty page past the last known one.
 */
export const GUIDE_POLICY = Object.freeze({
    source: 'guide_baseline',
    maxInFlight: 1,                       // the relay is serial
    minDelayMs: 3_000,                    // between two guide requests
    maxRequestsPerExecution: 50,          // one relay work lease (catalog_jobs.request_budget <= 50)
    dailyRequestCap: 2_000,               // all guide requests in one UTC day
    checkIntervalMs: 24 * 3600_000,       // a kind becomes due 24 h after its last successful check
    overlapPages: 1,                      // extra pages read past the one that reaches last_seen_id
    fullSweepIntervalMs: 7 * 24 * 3600_000,   // a periodic full sweep still catches gaps and edits
    detailRefreshAfterMs: 30 * 24 * 3600_000, // older details are re-read when this old
    detailRefreshPerExecution: 10,        // at most this many due refreshes per lease
    maxDetailAttempts: 5,                 // then the ID stays incomplete with reason detail_failed
    leaseTtlMs: 10 * 60_000,              // an unanswered work lease expires and is re-issued
    estimatedIndexPages: Object.freeze({ item: 661, creature: 321, realm: 282, master_realm: 15 }),
});

/** Full-sweep feasibility under GUIDE_POLICY (AC-CAT-015): request count, duration, lease count. */
export function fullSweepEstimate(policy = GUIDE_POLICY) {
    const pages = Object.values(policy.estimatedIndexPages).reduce((a, b) => a + b, 0);
    return {
        indexPages: pages,
        minDurationMs: pages * policy.minDelayMs,
        leases: Math.ceil(pages / policy.maxRequestsPerExecution),
        fitsDailyCap: pages <= policy.dailyRequestCap,
        detailBudgetLeft: Math.max(0, policy.dailyRequestCap - pages),
    };
}
