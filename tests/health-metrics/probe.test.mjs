// tests/health-metrics/probe.test.mjs - HLTH-TASK-001/002, CTRL-TASK-005 / AC-HLTH-001, AC-HLTH-003, AC-HLTH-004, AC-HLTH-005
// The unauthenticated loopback probe: status only, no CORS, no configuration or metrics data.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';


let tasks = [{ name: 'A', isActive: true }, { name: 'B', isActive: false }];
mock.module(new URL('../../engine.js', import.meta.url).href, { namedExports: { getTasksStatus: () => tasks } });
const { createProbeHandler, healthReport, startHealthCheckServer, stopHealthCheckServer } = await import('../../healthCheck.mjs');
const db = await import('../../_gg_data/handler/gg_database.js');

async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise(r => server.close(r)) };
}

test('AC-HLTH-001: GET /health returns JSON status, uptime, and task counts', async () => {
    const { base, close } = await serve(createProbeHandler());
    try {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /application\/json/);
        const body = await res.json();
        assert.equal(body.status, 'ok');
        assert.deepEqual(body.tasks, { active: 1, total: 2 });
        assert.ok(body.uptime);
        assert.equal(res.headers.get('access-control-allow-origin'), null, 'no wildcard CORS');
        assert.ok(JSON.stringify(body).length < 64 * 1024);
    } finally { await close(); }
});

test('AC-HLTH-001 error case: a failing database or engine answers 503 unhealthy', async () => {
    assert.equal((await healthReport({ database: () => { throw new Error('disk'); } })).status, 'unhealthy');
    assert.equal((await healthReport({ database: async () => { throw new Error('connection lost'); } })).status, 'unhealthy');
    assert.equal((await healthReport({ tasksStatus: () => { throw new Error('engine'); } })).status, 'unhealthy');
    assert.notEqual((await healthReport()).error, 'database unavailable', 'the real check passes against the test database');
    const { base, close } = await serve(createProbeHandler({ report: () => healthReport({ database: () => { throw new Error('locked'); } }) }));
    try {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.status, 'unhealthy');
        assert.equal(body.error, 'database unavailable');
    } finally { await close(); }
});

test('AC-HLTH-003 / CTRL-TASK-005: the probe exposes no config, metrics, cache, or task details', async () => {
    const { base, close } = await serve(createProbeHandler());
    try {
        for (const p of ['/config', '/metrics', '/cache', '/tasks', '/']) assert.equal((await fetch(base + p)).status, 404, p);
        assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
    } finally { await close(); }
});

test('AC-HLTH-003: the configuration summary never contains secret values', async (t) => {
    const keys = ['GG_EMAIL', 'GG_PASSWORD', 'GG_DISCORD_TOKEN', 'GG_BOT_CHARACTER', 'GG_BOT_ID_CHARACTER'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    Object.assign(process.env, { GG_EMAIL: 'probe@example.test', GG_PASSWORD: 'probe-password-fixture', GG_DISCORD_TOKEN: 'probe-token-fixture', GG_BOT_CHARACTER: 'Bot', GG_BOT_ID_CHARACTER: '1' });
    const { getConfigSummary } = await import('../../configValidator.mjs');
    const json = JSON.stringify(getConfigSummary());
    for (const secret of ['probe@example.test', 'probe-password-fixture', 'probe-token-fixture']) assert.ok(!json.includes(secret), secret);
});

test('AC-HLTH-004: more than 60 requests a minute get 429 with Retry-After: 60, then the window resets', async () => {
    let now = 1_000_000;
    const { base, close } = await serve(createProbeHandler({ now: () => now }));
    try {
        for (let i = 0; i < 60; i++) assert.equal((await fetch(`${base}/health`)).status, 200, `request ${i + 1}`);
        const limited = await fetch(`${base}/health`);
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get('retry-after'), '60');
        now += 60_001;
        assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally { await close(); }
});

test('AC-HLTH-005 / loopback only: a non-loopback host setting still binds 127.0.0.1', async (t) => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const server = startHealthCheckServer({ port: 0, host: '0.0.0.0' });
    await new Promise(r => server.once('listening', r));
    assert.equal(server.address().address, '127.0.0.1');
    await stopHealthCheckServer();
});

test('AC-HLTH-005 error case: an occupied port is logged and does not throw', async (t) => {
    const blocker = http.createServer();
    await new Promise(r => blocker.listen(0, '127.0.0.1', r));
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    t.mock.method(console, 'log', () => {});
    const server = startHealthCheckServer({ port: blocker.address().port, host: '127.0.0.1' });
    await new Promise(r => server.once('error', () => setImmediate(r)));
    assert.ok(errors.some(e => e.includes('already in use')));
    await new Promise(r => blocker.close(r));
});

after(async () => {
    await stopHealthCheckServer();
    await db.closeDatabase();
});
