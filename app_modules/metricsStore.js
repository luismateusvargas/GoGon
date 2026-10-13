// app_modules/metricsStore.js - in-process counters (specs/tasks/2026-10-notification-progress-health.md)
// Has no imports, so the Discord queue (utils.js) and the outbox dispatcher can record outcomes without
// pulling in metrics.mjs, which imports the engine and the database layer. Counters hold numbers only:
// never a webhook URL, payload, or message text.

const counters = {
    // API Metrics
    apiRequests: 0,
    apiErrors: 0,
    apiRateLimits: 0,

    // Discord webhook queue (utils.js), counted at actual outcomes, not at enqueue
    discordSent: 0,           // requests Discord accepted
    discordBatches: 0,        // merged batches sent
    discordMessagesSaved: 0,  // messages merged into another message's request
    discordErrors: 0,         // failed requests of any kind (timeout, network, 5xx, 4xx, 429)
    discordRetries: 0,        // failed requests scheduled for another attempt (not counting 429 waits)
    discordTimeouts: 0,       // requests that hit the request deadline
    discordRateLimits: 0,     // 429 responses
    discordDropped: 0,        // messages given up: permanent failure or bounded retries exhausted

    // Notification outbox rounds (notificationDispatcher.js)
    outboxDelivered: 0,
    outboxRetried: 0,         // round failed, row rescheduled with backoff
    outboxFailed: 0,          // row became 'failed' (permanent or rounds exhausted)
};

/**
 * Increments a metric counter; unknown keys are ignored.
 * @param {string} key - Metric key to increment
 * @param {number} value - Value to add (default: 1)
 */
export function incrementMetric(key, value = 1) {
    if (Object.hasOwn(counters, key)) counters[key] += value;
}

/** A copy of every counter. */
export function metricCounters() {
    return { ...counters };
}

/** Sets every counter back to zero. */
export function resetMetricCounters() {
    for (const key of Object.keys(counters)) counters[key] = 0;
}
