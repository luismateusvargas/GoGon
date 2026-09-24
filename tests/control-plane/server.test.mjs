// tests/control-plane/server.test.mjs - CTRL-TASK-005 / AC-CTRL-001, AC-CTRL-002, AC-CTRL-003, AC-CTRL-006
// A real control-plane server on an ephemeral loopback port, backed by an in-memory encrypted store
// and fake engine/switcher. No game or Discord request is made.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createControlStore } from '../../_gg_data/handler/controlStore.js';
import { createKeyring, hashPassword } from '../../control-plane/crypto.mjs';
import { createControlPlane, loadControlPlaneConfig, SECURITY_HEADERS } from '../../control-plane/server.mjs';
import { loadOverrides, getSetting } from '../../config/runtime.mjs';

const ADMIN = 'owner';
const ADMIN_PASSWORD = 'dashboard-password-fixture';
const HASH = hashPassword(ADMIN_PASSWORD);
const SECRET_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/server-fixture-secret-token-00';

let cp, base, origin, store, engine, rebinds, clock;

function makeEngine() {
    const modules = new Map([
        ['SuperElites', { name: 'SuperElites', enabled: true, isActive: true, isRunning: false, interval: 15000, defaultInterval: 15000, lastRun: { startedAt: 1, durationMs: 20, outcome: 'ok', error: null } }],
        ['Crates', { name: 'Crates', enabled: true, isActive: true, isRunning: false, interval: 60000, defaultInterval: 60000, lastRun: null }],
    ]);
    return {
        engineEvents: new EventEmitter(),
        calls: [],
        isPaused: () => false,
        listModuleIds: () => [...modules.keys()],
        getTasksStatus: () => [...modules.values()].map(m => ({ ...m })),
        async setModuleEnabled(id, enabled) { this.calls.push(['enabled', id, enabled]); Object.assign(modules.get(id), { enabled, isActive: enabled }); },
        async setModuleInterval(id, ms) { this.calls.push(['interval', id, ms]); modules.get(id).interval = ms; },
    };
}

before(async () => {
    store = createControlStore(await freshClient(), createKeyring(crypto.randomBytes(32).toString('base64')));
    engine = makeEngine();
    rebinds = [];
    clock = { t: Date.now() };
    const switcher = { events: new EventEmitter(), status: () => ({ state: 'idle', activeLabel: null, lastError: null }), switchTo: async () => ({ activeLabel: 'X', resumed: [] }) };
    const config = { username: ADMIN, passwordHash: HASH, sessionSecret: 'x'.repeat(48), host: '127.0.0.1', port: 0, cookieSecure: false };
    cp = createControlPlane({ config, store, engine, switcher, rebind: async s => { rebinds.push(s); }, now: () => clock.t, healthReport: () => ({ status: 'ok' }), metrics: () => ({ system: { uptime: 1 } }) });
    const { port } = await cp.listen(0, '127.0.0.1');
    cp.allowHost(`127.0.0.1:${port}`);
    base = `http://127.0.0.1:${port}`;
    origin = base;
});
after(async () => { await cp.close(); loadOverrides([]); await closeClients(); });

/** Polls an async condition: denial audits are written without delaying the response. */
async function eventually(check, ms = 2000) {
    const until = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > until) return false;
        await new Promise(r => setTimeout(r, 10));
    }
    return true;
}
beforeEach(() => { clock.t += 60 * 60_000; });   // a fresh rate-limit window per test

async function req(method, url, { body, cookie, csrf, headers = {}, rawBody } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (body !== undefined || rawBody !== undefined) h['Content-Type'] ??= 'application/json';
    if (method !== 'GET' && !('Origin' in h)) h.Origin = origin;
    const res = await fetch(base + url, { method, headers: h, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, json };
}

async function login() {
    const r = await req('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PASSWORD } });
    assert.equal(r.status, 200, r.text);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: r.json.csrf, setCookie: r.headers.get('set-cookie') };
}

// --- AC-CTRL-001 --------------------------------------------------------------------------------------

test('AC-CTRL-001: unauthenticated requests get no operational data', async () => {
    for (const url of ['/api/state', '/api/events', '/api/audit', '/api/metrics', '/api/health', '/assets/app.js']) {
        const r = await req('GET', url);
        assert.equal(r.status, 401, url);
        assert.ok(!r.text.includes('SuperElites'), url);
    }
    const root = await req('GET', '/');
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/login');
    assert.equal((await req('GET', '/login')).status, 200);
});

test('AC-CTRL-001: login sets an HttpOnly, SameSite=Strict session cookie and returns a CSRF token', async () => {
    const { setCookie, csrf } = await login();
    assert.match(setCookie, /^gg_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    assert.ok(csrf.length >= 32);
    assert.equal((await store.listAudit(1))[0].action, 'login');
});

test('AC-CTRL-001 error case: wrong credentials are denied and audited without the attempted password', async () => {
    const r = await req('POST', '/api/login', { body: { username: ADMIN, password: 'wrong-attempt-fixture' } });
    assert.equal(r.status, 401);
    const wrongUser = await req('POST', '/api/login', { body: { username: 'someone', password: ADMIN_PASSWORD } });
    assert.equal(wrongUser.status, 401);
    const audit = JSON.stringify(await store.listAudit(5));
    assert.match(audit, /"action":"login".*"outcome":"denied"/);
    assert.ok(!audit.includes('wrong-attempt-fixture') && !audit.includes(ADMIN_PASSWORD));
});

test('AC-CTRL-001/006: repeated failed logins are rate-limited with Retry-After', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/login', { body: { username: ADMIN, password: `bad-${i}-password` } })).status, 401);
    const blocked = await req('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PASSWORD } });
    assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    clock.t += 16 * 60_000;
    assert.equal((await req('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PASSWORD } })).status, 200, 'window expires');
});

test('AC-CTRL-001 error case: forged, expired, and logged-out sessions are rejected', async () => {
    const { cookie, csrf } = await login();
    assert.equal((await req('GET', '/api/state', { cookie: cookie.replace(/\.[^.]+$/, '.forged') })).status, 401);
    assert.equal((await req('GET', '/api/state', { cookie })).status, 200);
    clock.t += 31 * 60_000;
    assert.equal((await req('GET', '/api/state', { cookie })).status, 401, 'idle timeout');

    const s2 = await login();
    assert.equal((await req('POST', '/api/logout', { cookie: s2.cookie, csrf: s2.csrf })).status, 200);
    assert.equal((await req('GET', '/api/state', { cookie: s2.cookie })).status, 401);
    assert.ok(csrf);
});

test('AC-CTRL-001 error case: state changes need a CSRF token and a same-origin Origin', async () => {
    const { cookie, csrf } = await login();
    const body = { value: 'Guild X' };
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, body })).status, 403, 'missing CSRF');
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf: 'wrong', body })).status, 403, 'wrong CSRF');
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, body, headers: { Origin: 'https://evil.example' } })).status, 403, 'cross-origin');
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, body, headers: { Origin: '' } })).status, 403, 'no Origin');
    assert.equal((await req('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PASSWORD }, headers: { Origin: 'https://evil.example' } })).status, 403, 'login CSRF');
    assert.notEqual(getSetting('GG_GUILD_NAME'), 'Guild X');
    assert.ok(await eventually(async () => (await store.listAudit(10)).some(e => e.action === 'request.csrf' && e.outcome === 'denied')));
});

// --- AC-CTRL-002 --------------------------------------------------------------------------------------

test('AC-CTRL-002: state lists every registry entry, modules, and account, with secrets as set/unset only', async () => {
    const { cookie, csrf } = await login();
    assert.equal((await req('PUT', '/api/config/GG_RELIC_WEBHOOK', { cookie, csrf, body: { value: SECRET_WEBHOOK } })).status, 200);
    const r = await req('GET', '/api/state', { cookie });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('server-fixture-secret-token'), 'secret value never returned');
    const relic = r.json.settings.find(s => s.key === 'GG_RELIC_WEBHOOK');
    assert.deepEqual([relic.isSet, relic.source, 'value' in relic], [true, 'override', false]);
    assert.ok(r.json.settings.length >= 40);
    for (const s of r.json.settings) assert.ok(s.reloadMode && s.source && 'editable' in s, s.key);
    assert.deepEqual(r.json.modules.map(m => [m.id, m.enabled, m.intervalMs, m.health]), [['SuperElites', true, 15000, 'ok'], ['Crates', true, 60000, 'ok']]);
    assert.equal(r.json.modules[0].lastRun.outcome, 'ok');
    assert.deepEqual(r.json.account, { state: 'idle', activeLabel: null, lastError: null, source: 'env' });
    assert.ok(!JSON.stringify(r.json.audit).includes('server-fixture-secret-token'));
});

test('AC-CTRL-002: the live stream sends the state on connect', async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n', text.indexOf('data:'))) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /event: state\ndata: \{/);
    assert.ok(!text.includes('server-fixture-secret-token'));
});

// --- AC-CTRL-003 --------------------------------------------------------------------------------------

test('AC-CTRL-003: a valid hot update is persisted, audited, applied, and revertible', async () => {
    const { cookie, csrf } = await login();
    const r = await req('PUT', '/api/config/GG_CONFLICT_PING_MENTION', { cookie, csrf, body: { value: '123456789012345678' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, 'hot');
    assert.equal(getSetting('GG_CONFLICT_PING_MENTION'), '123456789012345678', 'next run reads the new value');
    assert.equal(new Map(await store.loadOverrides()).get('GG_CONFLICT_PING_MENTION'), '123456789012345678');
    assert.equal((await store.listAudit(1))[0].subject, 'GG_CONFLICT_PING_MENTION');
    const { conflictPingMention } = await import('../../app_modules/GuildConflicts.js');
    assert.equal(conflictPingMention(), '<@&123456789012345678>');

    assert.equal((await req('DELETE', '/api/config/GG_CONFLICT_PING_MENTION', { cookie, csrf })).status, 200);
    assert.equal(getSetting('GG_CONFLICT_PING_MENTION'), '@everyone');
    assert.equal(conflictPingMention(), '@everyone');
});

test('AC-CTRL-003: subsystem-rebind settings restart only the named subsystem', async () => {
    const { cookie, csrf } = await login();
    const r = await req('PUT', '/api/config/GG_DISCORD_GUILD_ID', { cookie, csrf, body: { value: '223456789012345678' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, 'restarted discord');
    assert.deepEqual(rebinds, ['discord']);
    await req('DELETE', '/api/config/GG_DISCORD_GUILD_ID', { cookie, csrf });
});

test('AC-CTRL-003 error case: unknown keys, bad types, unsafe URLs, and .env-only keys change nothing', async () => {
    const { cookie, csrf } = await login();
    const before = JSON.stringify(await store.loadOverrides());
    const cases = [
        ['PUT', '/api/config/PATH', { value: '/tmp' }, 404],
        ['PUT', '/api/config/NODE_OPTIONS', { value: '--require=x' }, 404],
        ['PUT', '/api/config/GG_MYSQL_HOST', { value: 'attacker.example' }, 400],
        ['PUT', '/api/config/GG_MYSQL_PASSWORD', { value: 'x' }, 400],
        ['PUT', '/api/config/GG_ADMIN_PASSWORD_HASH', { value: 'x' }, 400],
        ['PUT', '/api/config/GG_PASSWORD', { value: 'x' }, 400],
        ['PUT', '/api/config/GG_RELIC_WEBHOOK', { value: 'http://169.254.169.254/latest/meta-data' }, 400],
        ['PUT', '/api/config/GG_RELIC_WEBHOOK', { value: 'https://attacker.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstu' }, 400],
        ['PUT', '/api/config/GG_BOT_ID_CHARACTER', { value: 12345 }, 400],
        ['PUT', '/api/config/GG_GUILD_NAME', { value: 'x', extra: 1 }, 400],
        ['PUT', '/api/config/gg_guild_name', { value: 'x' }, 404],
    ];
    for (const [m, url, body, status] of cases) {
        const r = await req(m, url, { cookie, csrf, body });
        assert.equal(r.status, status, `${url} ${JSON.stringify(body)} -> ${r.text}`);
        assert.ok(r.json.error);
    }
    const fieldErr = await req('PUT', '/api/config/GG_RELIC_WEBHOOK', { cookie, csrf, body: { value: 'http://x' } });
    assert.match(fieldErr.json.fields.value, /discord\.com\/api\/webhooks/);
    assert.equal(JSON.stringify(await store.loadOverrides()), before, 'no state changed');
});

test('AC-CTRL-003: module enablement and interval changes are validated, persisted, and applied', async () => {
    const { cookie, csrf } = await login();
    engine.calls.length = 0;
    let r = await req('PATCH', '/api/modules/Crates', { cookie, csrf, body: { enabled: false, intervalMs: 120000 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(engine.calls, [['interval', 'Crates', 120000], ['enabled', 'Crates', false]]);
    assert.deepEqual((await store.listModulePreferences()).get('Crates'), { enabled: false, intervalMs: 120000 });
    for (const [body, field] of [[{ intervalMs: 1000 }, 'intervalMs'], [{ intervalMs: 1.5e10 }, 'intervalMs'], [{ intervalMs: '60000' }, 'intervalMs'], [{ enabled: 'yes' }, 'enabled'], [{}, 'body']]) {
        r = await req('PATCH', '/api/modules/Crates', { cookie, csrf, body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.ok(r.json.fields[field], JSON.stringify(r.json));
    }
    assert.equal((await req('PATCH', '/api/modules/NoSuchModule', { cookie, csrf, body: { enabled: true } })).status, 404);
    assert.equal(engine.calls.length, 2, 'rejected requests never reach the engine');
});

// --- AC-CTRL-006 --------------------------------------------------------------------------------------

test('AC-CTRL-006: security headers on every response and no CORS headers', async () => {
    const { cookie } = await login();
    for (const [url, opts] of [['/login', {}], ['/api/state', { cookie }], ['/api/nope', { cookie }], ['/api/state', {}]]) {
        const r = await req('GET', url, opts);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(name), value, `${url} ${name}`);
        assert.equal(r.headers.get('access-control-allow-origin'), null, url);
    }
    const preflight = await req('OPTIONS', '/api/state', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('AC-CTRL-006: malformed, oversized, and wrongly typed bodies are rejected', async () => {
    const { cookie, csrf } = await login();
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, rawBody: '{"value":' })).status, 400);
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, rawBody: '["x"]' })).status, 400);
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, rawBody: JSON.stringify({ value: 'x'.repeat(20000) }) })).status, 413);
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, rawBody: 'value=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await req('POST', '/api/profiles', { cookie, csrf, body: { label: 'L', email: 'not-an-email', password: 'p' } })).status, 400);
    assert.equal((await req('POST', '/api/profiles', { cookie, csrf, body: { label: 'bad\u0000label', email: 'a@b.c', password: 'p' } })).status, 400);
});

test('AC-CTRL-006: HTML-like input is stored as data and the pages never render it as markup', async () => {
    const { cookie, csrf } = await login();
    const payload = '<img src=x onerror=alert(1)>';
    assert.equal((await req('PUT', '/api/config/GG_GUILD_NAME', { cookie, csrf, body: { value: payload } })).status, 200);
    const r = await req('GET', '/api/state', { cookie });
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.json.settings.find(s => s.key === 'GG_GUILD_NAME').value, payload);
    await req('DELETE', '/api/config/GG_GUILD_NAME', { cookie, csrf });

    const pub = path.resolve('control-plane/public');
    for (const f of ['index.html', 'login.html']) {
        const html = fs.readFileSync(path.join(pub, f), 'utf8');
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f} has no inline script`);
        assert.doesNotMatch(html, /\son[a-z]+=/i, `${f} has no inline handlers`);
        assert.doesNotMatch(html, /<style/i, `${f} has no inline style`);
    }
    const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8') + fs.readFileSync(path.join(pub, 'login.js'), 'utf8');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test('AC-CTRL-006: requests with a foreign Host header are refused (DNS rebinding)', async () => {
    const { port } = new URL(base);
    const status = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/login', headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
        r.on('error', reject);
        r.end();
    });
    assert.equal(status, 421);
});

test('AC-CTRL-005: loadControlPlaneConfig fails closed and names variables, never values', () => {
    assert.throws(() => loadControlPlaneConfig({}), (e) => /GG_ADMIN_USERNAME is not set/.test(e.message) && /GG_CONTROL_ENCRYPTION_KEY is not set/.test(e.message));
    const env = {
        GG_ADMIN_USERNAME: 'owner', GG_ADMIN_PASSWORD_HASH: 'plaintext-password-value',
        GG_CONTROL_SESSION_SECRET: 'short', GG_CONTROL_ENCRYPTION_KEY: 'not-base64-key-value', GG_CONTROL_HOST: '203.0.113.9',
    };
    assert.throws(() => loadControlPlaneConfig(env), (e) => !/plaintext-password-value|not-base64-key-value/.test(e.message)
        && /GG_ADMIN_PASSWORD_HASH is invalid/.test(e.message) && /GG_CONTROL_HOST is invalid/.test(e.message));
    const ok = loadControlPlaneConfig({
        GG_ADMIN_USERNAME: 'owner', GG_ADMIN_PASSWORD_HASH: HASH, GG_CONTROL_SESSION_SECRET: 's'.repeat(40),
        GG_CONTROL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    });
    assert.deepEqual([ok.host, ok.port, ok.cookieSecure], ['127.0.0.1', 8787, false]);
});
