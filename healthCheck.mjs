// healthCheck.mjs - loopback-only liveness probe for GoGon (CTRL-TASK-005, health-metrics-v1 AC-HLTH-001/004/005)
// Serves GET /health (and /healthz) on 127.0.0.1 only: status, uptime, task counts, and the delivery
// state name. It sends no CORS headers and exposes no configuration, cache, or metrics data; those moved
// behind the authenticated control plane (/api/health, /api/metrics, /api/state).
// Delivery progress (specs/tasks/2026-10-notification-progress-health.md): the probe answers 503 only
// after due notifications made no progress for DELIVERY_UNHEALTHY_AFTER, or when delivery progress cannot
// be read at all; an empty queue is healthy.
// Project: GoGon (GG)

import http from 'node:http';
import { getTasksStatus } from './engine.js';
import { getConnection } from './_gg_data/handler/gg_database.js';
import { SECURITY_HEADERS } from './control-plane/server.mjs';
import { getSetting } from './config/runtime.mjs';
import { deliveryMonitor } from './deliveryHealth.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 60; // 60 requests per minute
const DB_CHECK_TIMEOUT_MS = 3000;

let server = null;
const serverStartTime = Date.now();

/**
 * Formats uptime in human-readable format
 * @param {number} milliseconds - Uptime in milliseconds
 * @returns {string} Formatted uptime
 */
export function formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

/** MySQL answers a trivial query within DB_CHECK_TIMEOUT_MS; rejects when the database is unusable. */
export async function checkDatabase() {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('database check timed out')), DB_CHECK_TIMEOUT_MS); });
    try {
        await Promise.race([getConnection().then(c => c.query('SELECT 1')), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Health summary shared by the probe and the authenticated /api/health (AC-HLTH-001).
 * The probe gets only the delivery state name; with detail (owner API) the delivery progress report and
 * the overdue module names are included. Overdue modules are reported but do not make the probe unhealthy.
 * An unreadable delivery snapshot is unhealthy ('delivery unavailable'); a database failure overrides it.
 * @returns {Promise<{ status: 'ok'|'unhealthy', uptime: string, timestamp: string, tasks: object, delivery: string|object, error?: string }>}
 */
export async function healthReport({ tasksStatus = getTasksStatus, database = checkDatabase, delivery = () => deliveryMonitor.check(), detail = false, startedAt = serverStartTime, now = Date.now } = {}) {
    const report = { status: 'ok', uptime: formatUptime(now() - startedAt), timestamp: new Date(now()).toISOString() };
    try {
        const tasks = tasksStatus();
        const overdue = tasks.filter(t => t.overdue);
        report.tasks = { active: tasks.filter(t => t.isActive).length, total: tasks.length, overdue: overdue.length };
        if (detail) report.tasks.overdueModules = overdue.map(t => t.name);
    } catch {
        report.status = 'unhealthy';
        report.error = 'engine unavailable';
    }
    try {
        const progress = await delivery();
        report.delivery = detail ? progress : progress.state;
        if (progress.unhealthy) {
            report.status = 'unhealthy';
            report.error = 'delivery stalled';
        }
    } catch {
        // Delivery progress cannot be assessed, so the probe cannot report healthy. SELECT 1 alone does not
        // show that the outbox query or dispatcher is usable; a later successful read restores 'ok'.
        report.delivery = 'unknown';
        report.status = 'unhealthy';
        report.error = 'delivery unavailable';
    }
    try {
        await database();
    } catch {
        report.status = 'unhealthy';
        report.error = 'database unavailable';
    }
    return report;
}

/**
 * Creates the probe request handler. Exposed for tests (HLTH-TASK-002).
 */
export function createProbeHandler({ report = () => healthReport(), now = Date.now } = {}) {
    const requestCounts = new Map(); // IP -> { count, resetTime }

    function isRateLimited(ip) {
        const t = now();
        const record = requestCounts.get(ip);
        if (!record || t > record.resetTime) {
            requestCounts.set(ip, { count: 1, resetTime: t + RATE_LIMIT_WINDOW });
            return false;
        }
        record.count++;
        return record.count > RATE_LIMIT_MAX;
    }

    return function handleRequest(req, res) {
        const headers = { ...SECURITY_HEADERS, 'Content-Type': 'application/json' };
        if (isRateLimited(req.socket.remoteAddress)) {
            res.writeHead(429, { ...headers, 'Retry-After': '60' });
            res.end(JSON.stringify({ status: 'error', message: 'Rate limit exceeded. Max 60 requests per minute.' }));
            return;
        }
        const path = (req.url || '').split('?')[0];
        if (req.method !== 'GET') {
            res.writeHead(405, { ...headers, Allow: 'GET' });
            res.end(JSON.stringify({ status: 'error', message: 'Method not allowed. Use GET.' }));
            return;
        }
        if (path !== '/health' && path !== '/healthz') {
            res.writeHead(404, headers);
            res.end(JSON.stringify({ status: 'error', message: 'Not found. The probe serves /health only.' }));
            return;
        }
        Promise.resolve().then(report).then(body => {
            res.writeHead(body.status === 'ok' ? 200 : 503, headers);
            res.end(JSON.stringify(body));
        }, () => {
            res.writeHead(503, headers);
            res.end(JSON.stringify({ status: 'unhealthy', error: 'health report failed' }));
        });
    };
}

/**
 * Start the loopback probe. A non-loopback GG_HEALTH_CHECK_HOST is refused (loopback only).
 */
export function startHealthCheckServer({ port = Number(getSetting('GG_HEALTH_CHECK_PORT')), host = getSetting('GG_HEALTH_CHECK_HOST') } = {}) {
    if (!LOOPBACK_HOSTS.has(host)) {
        console.warn(`[GoGon] ⚠️ GG_HEALTH_CHECK_HOST=${host} is not loopback; the probe binds to 127.0.0.1 instead.`);
        host = '127.0.0.1';
    }
    try {
        server = http.createServer(createProbeHandler());
        server.listen(port, host, () => {
            console.log(`[GoGon] Health probe listening at http://${host}:${port}/health (loopback only)`);
        });
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`[GoGon] Port ${port} is already in use. Health probe not started.`);
            } else {
                console.error('[GoGon] Health probe error:', error.message);
            }
        });
        return server;
    } catch (error) {
        console.error('[GoGon] Failed to start health probe:', error.message);
        return null;
    }
}

/**
 * Stop the probe gracefully
 */
export function stopHealthCheckServer() {
    if (server) {
        return new Promise((resolve) => {
            server.close(() => resolve());
        });
    }
    return Promise.resolve();
}
