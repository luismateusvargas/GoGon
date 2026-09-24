// metrics.mjs - GoGon Metrics Collection System
// Provides performance metrics for monitoring
// Project: GoGon (GG) v1.8.0

import { getDatabaseCacheStats } from './_gg_data/handler/gg_database.js';
import { getTasksStatus } from './engine.js';

// Internal metrics storage
const metrics = {
    // API Metrics
    apiRequests: 0,
    apiErrors: 0,
    apiRateLimits: 0,

    // Discord Metrics
    discordSent: 0,
    discordBatches: 0,
    discordErrors: 0,
    discordRateLimits: 0,
    discordMessagesSaved: 0, // Batched messages saved

    // System Metrics
    startTime: Date.now(),
    lastCollection: Date.now()
};

/**
 * Increments a metric counter
 * @param {string} key - Metric key to increment
 * @param {number} value - Value to add (default: 1)
 */
export function incrementMetric(key, value = 1) {
    if (metrics.hasOwnProperty(key)) {
        metrics[key] += value;
    }
}

/**
 * Gets formatted metrics for Prometheus (future compatibility) or JSON output
 * @returns {object} Collected metrics
 */
export function getMetrics() {
    const uptime = Date.now() - metrics.startTime;
    const cacheStats = getDatabaseCacheStats(); // Get latest cache stats
    const tasks = getTasksStatus();
    
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
            rateLimits: metrics.discordRateLimits,
            messagesSaved: metrics.discordMessagesSaved,
            efficiency: metrics.discordSent > 0 
                ? ((metrics.discordMessagesSaved / (metrics.discordSent + metrics.discordMessagesSaved)) * 100).toFixed(1) + '%'
                : '0%'
        },
        database: {
            cache: cacheStats
        },
        tasks: {
            total: tasks.length,
            active: activeTasks,
            healthScore: taskHealth
        }
    };
}

/**
 * Resets counter metrics (optional, mostly for intervals)
 */
export function resetMetrics() {
    metrics.apiRequests = 0;
    metrics.apiErrors = 0;
    metrics.apiRateLimits = 0;
    metrics.discordSent = 0;
    metrics.discordBatches = 0;
    metrics.discordErrors = 0;
    metrics.discordRateLimits = 0;
    metrics.discordMessagesSaved = 0;
    metrics.lastCollection = Date.now();
}
