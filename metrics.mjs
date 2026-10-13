// metrics.mjs - GoGon Metrics Collection System
// Provides performance metrics for monitoring
// Project: GoGon (GG) v1.8.0

import { getDatabaseCacheStats } from './_gg_data/handler/gg_database.js';
import { getTasksStatus } from './engine.js';
import { incrementMetric, metricCounters, resetMetricCounters } from './app_modules/metricsStore.js';
import { deliveryMonitor } from './deliveryHealth.mjs';

// Counters live in app_modules/metricsStore.js so the Discord queue can record outcomes without importing
// this module (which imports the engine). incrementMetric stays exported here for existing callers.
export { incrementMetric };

const startTime = Date.now();

/**
 * Gets formatted metrics for Prometheus (future compatibility) or JSON output.
 * Never includes a webhook URL or message body: counters, times, and failure categories only.
 * @returns {Promise<object>} Collected metrics
 */
export async function getMetrics({ delivery = () => deliveryMonitor.check() } = {}) {
    const metrics = metricCounters();
    const uptime = Date.now() - startTime;
    const cacheStats = getDatabaseCacheStats(); // Get latest cache stats
    const tasks = getTasksStatus();
    let progress;
    try {
        progress = await delivery();
    } catch {
        progress = null; // the outbox could not be read; counters are still reported
    }

    // Calculate simple health score (0-100)
    const activeTasks = tasks.filter(t => t.isActive).length;
    const taskHealth = tasks.length > 0 ? (activeTasks / tasks.length) * 100 : 100;

    return {
        system: {
            uptime: uptime,
            uptimeSeconds: Math.floor(uptime / 1000),
            timestamp: new Date().toISOString(),
            memory: (({ rss, heapUsed, heapTotal }) => ({ rss, heapUsed, heapTotal }))(process.memoryUsage()) // AC-HLTH-002
        },
        api: {
            requests: metrics.apiRequests,
            errors: metrics.apiErrors,
            rateLimits: metrics.apiRateLimits,
            errorRate: metrics.apiRequests > 0 ? (metrics.apiErrors / metrics.apiRequests).toFixed(4) : 0
        },
        discord: {
            sent: metrics.discordSent,
            batches: metrics.discordBatches,
            errors: metrics.discordErrors,
            retries: metrics.discordRetries,
            timeouts: metrics.discordTimeouts,
            rateLimits: metrics.discordRateLimits,
            dropped: metrics.discordDropped,
            messagesSaved: metrics.discordMessagesSaved,
            efficiency: metrics.discordSent > 0
                ? ((metrics.discordMessagesSaved / (metrics.discordSent + metrics.discordMessagesSaved)) * 100).toFixed(1) + '%'
                : '0%'
        },
        outbox: {
            delivered: metrics.outboxDelivered,
            retried: metrics.outboxRetried,
            failed: metrics.outboxFailed
        },
        delivery: progress
            ? {
                state: progress.state,
                pending: progress.pending,
                lastProgressAt: progress.lastProgressAt,
                lastSuccessAt: progress.lastSuccessAt,
                lastFailure: progress.lastFailure
            }
            : { state: 'unknown' },
        database: {
            cache: cacheStats
        },
        tasks: {
            total: tasks.length,
            active: activeTasks,
            overdue: tasks.filter(t => t.overdue).length,
            healthScore: taskHealth
        }
    };
}

/**
 * Resets counter metrics (optional, mostly for intervals)
 */
export function resetMetrics() {
    resetMetricCounters();
}
