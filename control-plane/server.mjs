// control-plane/server.mjs - CTRL-TASK-005 / AC-CTRL-001, AC-CTRL-002, AC-CTRL-003, AC-CTRL-006
// Authenticated owner dashboard and JSON API. node:http only; no CORS is ever sent.
//   - Login: scrypt-verified GG_ADMIN_PASSWORD_HASH, bounded per-IP and global failure limits.
//   - Session: random ID in an HMAC-signed, HttpOnly, SameSite=Strict cookie; idle and absolute expiry.
//   - Every state-changing request: session + X-CSRF-Token + same-origin Origin + JSON body <= 16 KiB.
//   - Host header allow-list (DNS rebinding), CSP and other security headers on every response.
//   - Settings are allow-listed by config/registry.mjs; secrets are write-only (set/unset only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac, randomToken, safeEqual, verifyPassword } from './crypto.mjs';
import { VALIDATORS, CONFIG_BY_KEY, SECTIONS, MODULE_INTERVAL_BOUNDS, validateSetting } from '../config/registry.mjs';
import { describeSettings, applyOverride, getSetting } from '../config/runtime.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8', auth: true },
    '/login': { file: 'login.html', type: 'text/html; charset=utf-8', auth: false },
    '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', auth: true },
    '/assets/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8', auth: false },
    '/assets/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8', auth: false },
};

export const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-store',
});

const COOKIE = 'gg_session';
const MAX_BODY = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;

/**
 * Reads and validates the bootstrap values from the environment (AC-CTRL-005: fail closed).
 * Error messages name variables only, never their values.
 */
export function loadControlPlaneConfig(env = process.env) {
    const errors = [];
    const setting = key => getSetting(key, env).trim();
    const need = (key, validator) => {
        const v = setting(key);
        if (!v) { errors.push(`${key} is not set`); return ''; }
        if (VALIDATORS[validator](v)) errors.push(`${key} is invalid: ${VALIDATORS[validator](v)}`);
        return v;
    };
    const cfg = {
        username: need('GG_ADMIN_USERNAME', 'username'),
        passwordHash: need('GG_ADMIN_PASSWORD_HASH', 'scrypt-hash'),
        sessionSecret: need('GG_CONTROL_SESSION_SECRET', 'min-32-chars'),
        encryptionKey: need('GG_CONTROL_ENCRYPTION_KEY', 'base64-32-bytes'),
        previousEncryptionKey: setting('GG_CONTROL_ENCRYPTION_KEY_PREVIOUS') || null,
        host: setting('GG_CONTROL_HOST'),
        port: Number(setting('GG_CONTROL_PORT')),
        cookieSecure: setting('GG_CONTROL_COOKIE_SECURE') === '1',
    };
    if (cfg.previousEncryptionKey && VALIDATORS['base64-32-bytes'](cfg.previousEncryptionKey)) errors.push('GG_CONTROL_ENCRYPTION_KEY_PREVIOUS is invalid');
    if (VALIDATORS['bind-host'](cfg.host)) errors.push('GG_CONTROL_HOST is invalid');
    if (VALIDATORS.port(String(cfg.port))) errors.push('GG_CONTROL_PORT is invalid');
    if (errors.length) throw Object.assign(new Error(`Control plane bootstrap is incomplete: ${errors.join('; ')}.`), { errors });
    return cfg;
}

/** Fixed-window counter keyed by client; used for login failures and general API traffic. */
function createLimiter({ max, windowMs, now }) {
    const hits = new Map();
    return {
        hit(key) {
            const t = now();
            let r = hits.get(key);
            if (!r || t >= r.resetAt) { r = { count: 0, resetAt: t + windowMs }; hits.set(key, r); }
            r.count++;
            if (hits.size > 10_000) for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
            return { limited: r.count > max, retryAfterS: Math.max(1, Math.ceil((r.resetAt - t) / 1000)) };
        },
        peek(key) {
            const r = hits.get(key);
            const t = now();
            return r && t < r.resetAt && r.count >= max ? { limited: true, retryAfterS: Math.max(1, Math.ceil((r.resetAt - t) / 1000)) } : { limited: false };
        },
        reset(key) { hits.delete(key); },
    };
}

class HttpError extends Error {
    constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof loadControlPlaneConfig>} opts.config
 * @param {object} opts.store - controlStore
 * @param {object} opts.engine - { getTasksStatus, setModuleEnabled, setModuleInterval, isPaused, engineEvents, listModuleIds }
 * @param {object} opts.switcher - account switcher
 * @param {(subsystem: string) => Promise<void>} [opts.rebind] - restarts a named subsystem
 * @param {() => object|Promise<object>} [opts.healthReport] - { status, ... } for /api/health
 * @param {() => object} [opts.metrics] - telemetry for /api/metrics
 * @param {() => object} [opts.validation] - configValidator summary
 */
export function createControlPlane({ config, store, engine, switcher, rebind = async () => {}, healthReport = () => ({ status: 'ok' }), metrics = () => ({}), validation = () => null, now = Date.now, sessionIdleMs = 30 * 60_000, sessionMaxMs = 8 * 3600_000 }) {
    const sessions = new Map();     // id -> { csrf, createdAt, lastSeen }
    const loginFailures = createLimiter({ max: 5, windowMs: 15 * 60_000, now });
    const globalLoginFailures = createLimiter({ max: 30, windowMs: 15 * 60_000, now });
    const apiLimiter = createLimiter({ max: 600, windowMs: 60_000, now });
    const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
    const scheme = config.cookieSecure ? 'https' : 'http';
    const sseClients = new Set();
    let broadcastTimer = null;
    const staticCache = new Map();

    // --- helpers -------------------------------------------------------------------------------
    function send(res, status, body, headers = {}) {
        if (res.headersSent) return;
        const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
        res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
        res.end(isJson ? JSON.stringify(body) : body);
    }

    function clientKey(req) {
        return req.socket.remoteAddress || 'unknown';
    }

    function signCookie(id) {
        return `${id}.${hmac(config.sessionSecret, id)}`;
    }

    function readSession(req) {
        const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
        if (!raw) return null;
        const [id, sig] = raw.slice(COOKIE.length + 1).split('.');
        if (!id || !sig || !safeEqual(sig, hmac(config.sessionSecret, id))) return null;
        const s = sessions.get(id);
        if (!s) return null;
        const t = now();
        if (t - s.lastSeen > sessionIdleMs || t - s.createdAt > sessionMaxMs) { sessions.delete(id); return null; }
        s.lastSeen = t;
        return { id, ...s, ref: s };
    }

    function sessionCookie(value, maxAgeS) {
        return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${config.cookieSecure ? '; Secure' : ''}`;
    }

    function deny(req, action, reason) {
        Promise.resolve().then(() => store.audit({ actor: 'anonymous', action, subject: req.url.split('?')[0].slice(0, 100), outcome: 'denied', detail: { reason, client: clientKey(req) } })).catch(() => { /* audit must not break denial */ });
    }

    function assertSameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin || origin !== `${scheme}://${req.headers.host}`) {
            deny(req, 'request.origin', origin ? 'cross-origin' : 'missing origin');
            throw new HttpError(403, 'Cross-origin request denied.');
        }
    }

    async function readJson(req) {
        const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > MAX_BODY) throw new HttpError(413, 'Request body too large.');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
            chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new HttpError(400, 'Malformed JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.');
        return body;
    }

    function allowOnly(body, allowed) {
        const extra = Object.keys(body).filter(k => !allowed.includes(k));
        if (extra.length) throw new HttpError(400, 'Unexpected fields.', { fields: Object.fromEntries(extra.slice(0, 5).map(k => [k.slice(0, 40), 'Not allowed.'])) });
    }

    function text(body, field, { min = 1, max = 256 } = {}) {
        const v = body[field];
        if (typeof v !== 'string' || v.length < min || v.length > max || !PRINTABLE.test(v)) {
            throw new HttpError(400, 'Invalid input.', { fields: { [field]: `Must be ${min}-${max} printable characters.` } });
        }
        return v;
    }

    function profileInput(body) {
        allowOnly(body, ['label', 'email', 'password']);
        const email = text(body, 'email', { max: 254 });
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'Invalid input.', { fields: { email: 'Must be an email address.' } });
        return { email, password: text(body, 'password', { max: 256 }) };
    }

    // --- state ---------------------------------------------------------------------------------
    async function buildState() {
        const account = switcher.status();
        return {
            generatedAt: new Date(now()).toISOString(),
            engine: { paused: engine.isPaused() },
            account: { ...account, source: account.activeLabel ? 'profile' : (account.state === 'failed-closed' ? 'none' : 'env') },
            modules: engine.getTasksStatus().map(m => ({
                id: m.name, enabled: m.enabled, active: m.isActive, running: m.isRunning,
                intervalMs: m.interval, defaultIntervalMs: m.defaultInterval, lastRun: m.lastRun,
                health: m.lastRun?.outcome === 'error' ? 'failing' : m.isActive ? 'ok' : m.enabled ? 'waiting' : 'disabled',
            })),
            intervalBounds: MODULE_INTERVAL_BOUNDS,
            sections: SECTIONS,
            settings: describeSettings(),
            profiles: await store.listProfiles(),
            validation: validation(),
            health: await healthReport(),
            audit: await store.listAudit(25),
        };
    }

    function broadcastSoon() {
        if (broadcastTimer || sseClients.size === 0) return;
        broadcastTimer = setTimeout(async () => {
            broadcastTimer = null;
            let payload;
            try { payload = `event: state\ndata: ${JSON.stringify(await buildState())}\n\n`; } catch { return; }
            for (const c of sseClients) {
                if (!sessions.has(c.sessionId)) { c.res.end(); sseClients.delete(c); continue; }
                c.res.write(payload);
            }
        }, 250);
        broadcastTimer.unref?.();
    }
    const onTask = () => broadcastSoon();
    engine.engineEvents?.on('task', onTask);
    engine.engineEvents?.on('engine', onTask);
    switcher.events?.on('change', onTask);
    const heartbeat = setInterval(() => { for (const c of sseClients) c.res.write(': keep-alive\n\n'); broadcastSoon(); }, 15_000);
    heartbeat.unref?.();

    // --- handlers ------------------------------------------------------------------------------
    async function handleLogin(req, res) {
        assertSameOrigin(req);
        const key = clientKey(req);
        const blocked = loginFailures.peek(key);
        const globalBlocked = globalLoginFailures.peek('all');
        if (blocked.limited || globalBlocked.limited) {
            deny(req, 'login', 'rate-limited');
            throw new HttpError(429, 'Too many failed logins. Try again later.', { retryAfterS: (blocked.limited ? blocked : globalBlocked).retryAfterS });
        }
        const body = await readJson(req);
        allowOnly(body, ['username', 'password']);
        const username = typeof body.username === 'string' ? body.username.slice(0, 64) : '';
        const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
        // Always run scrypt so a wrong username costs the same as a wrong password.
        const passwordOk = await verifyPassword(password, config.passwordHash);
        const ok = passwordOk && safeEqual(username, config.username);
        if (!ok) {
            loginFailures.hit(key);
            globalLoginFailures.hit('all');
            await store.audit({ actor: 'anonymous', action: 'login', subject: 'dashboard', outcome: 'denied', detail: { client: key } });
            throw new HttpError(401, 'Invalid username or password.');
        }
        loginFailures.reset(key);
        const id = randomToken(32);
        const csrf = randomToken(32);
        sessions.set(id, { csrf, createdAt: now(), lastSeen: now() });
        await store.audit({ actor: config.username, action: 'login', subject: 'dashboard' });
        send(res, 200, { ok: true, csrf }, { 'Set-Cookie': sessionCookie(signCookie(id), Math.floor(sessionMaxMs / 1000)) });
    }

    async function handleApi(req, res, url, session) {
        const actor = config.username;
        const m = req.method;
        const p = url.pathname;
        let match;

        if (m === 'GET' && p === '/api/session') return send(res, 200, { authenticated: true, username: config.username, csrf: session.csrf });
        if (m === 'GET' && p === '/api/state') return send(res, 200, await buildState());
        if (m === 'GET' && p === '/api/audit') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
            return send(res, 200, { events: await store.listAudit(limit) });
        }
        if (m === 'GET' && p === '/api/health') { const h = await healthReport(); return send(res, h.status === 'unhealthy' ? 503 : 200, h); }
        if (m === 'GET' && p === '/api/metrics') {
            try { return send(res, 200, metrics()); } catch { return send(res, 500, { status: 'error', message: 'Metrics unavailable.' }); }
        }
        if (m === 'GET' && p === '/api/events') {
            const initial = JSON.stringify(await buildState());
            res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
            res.write(`retry: 3000\nevent: state\ndata: ${initial}\n\n`);
            const client = { res, sessionId: session.id };
            sseClients.add(client);
            req.on('close', () => sseClients.delete(client));
            return;
        }

        // Everything below changes state: CSRF + same-origin required.
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new HttpError(405, 'Method not allowed.');
        assertSameOrigin(req);
        const token = req.headers['x-csrf-token'];
        if (typeof token !== 'string' || !safeEqual(token, session.csrf)) {
            deny(req, 'request.csrf', 'missing or invalid CSRF token');
            throw new HttpError(403, 'Missing or invalid CSRF token.');
        }

        if (m === 'POST' && p === '/api/logout') {
            sessions.delete(session.id);
            await store.audit({ actor, action: 'logout', subject: 'dashboard' });
            return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
        }

        if ((match = p.match(/^\/api\/config\/([A-Z0-9_]{1,64})$/))) {
            const key = match[1];
            const def = CONFIG_BY_KEY.get(key);
            if (!def) throw new HttpError(404, 'Unknown setting.', { fields: { key: 'Unknown setting.' } });
            if (m === 'PUT') {
                const body = await readJson(req);
                allowOnly(body, ['value']);
                const result = validateSetting(key, body.value);
                if (!result.ok) {
                    await store.audit({ actor, action: 'config.set', subject: key, outcome: 'denied', detail: { reason: 'validation' } });
                    throw new HttpError(400, 'Invalid value.', { fields: { value: result.error } });
                }
                await store.setOverride(key, result.value, actor);
                applyOverride(key, result.value);
            } else if (m === 'DELETE') {
                if (!def.editable) throw new HttpError(400, 'Invalid request.', { fields: { value: 'This setting is .env-only.' } });
                await store.clearOverride(key, actor);
                applyOverride(key, null);
            } else {
                throw new HttpError(405, 'Method not allowed.');
            }
            let applied = def.reloadMode;
            if (def.reloadMode === 'subsystem-rebind') {
                try { await rebind(def.subsystem); applied = `restarted ${def.subsystem}`; }
                catch { applied = `saved; ${def.subsystem} restart failed`; await store.audit({ actor, action: 'subsystem.rebind', subject: def.subsystem, outcome: 'failed' }); }
            }
            broadcastSoon();
            const setting = describeSettings().find(s => s.key === key);
            return send(res, 200, { ok: true, applied, setting });
        }

        if ((match = p.match(/^\/api\/modules\/([A-Za-z]{1,40})$/)) && m === 'PATCH') {
            const id = match[1];
            if (!engine.listModuleIds().includes(id)) throw new HttpError(404, 'Unknown module.');
            const body = await readJson(req);
            allowOnly(body, ['enabled', 'intervalMs']);
            const fields = {};
            if ('enabled' in body && typeof body.enabled !== 'boolean') fields.enabled = 'Must be true or false.';
            if ('intervalMs' in body && (!Number.isInteger(body.intervalMs) || body.intervalMs < MODULE_INTERVAL_BOUNDS.min || body.intervalMs > MODULE_INTERVAL_BOUNDS.max)) {
                fields.intervalMs = `Must be a whole number of milliseconds between ${MODULE_INTERVAL_BOUNDS.min} and ${MODULE_INTERVAL_BOUNDS.max}.`;
            }
            if (!('enabled' in body) && !('intervalMs' in body)) fields.body = 'Provide enabled and/or intervalMs.';
            if (Object.keys(fields).length) throw new HttpError(400, 'Invalid input.', { fields });
            const current = engine.getTasksStatus().find(t => t.name === id);
            const next = { enabled: body.enabled ?? current.enabled, intervalMs: body.intervalMs ?? current.interval };
            await store.setModulePreference(id, next, actor);
            if ('intervalMs' in body) await engine.setModuleInterval(id, next.intervalMs);
            if ('enabled' in body) await engine.setModuleEnabled(id, next.enabled);
            broadcastSoon();
            return send(res, 200, { ok: true, module: next });
        }

        if (p === '/api/profiles' && m === 'POST') {
            const body = await readJson(req);
            const label = text(body, 'label', { max: 64 });
            const creds = profileInput(body);
            try {
                const id = await store.createProfile({ label, ...creds }, actor);
                broadcastSoon();
                return send(res, 201, { ok: true, id });
            } catch (e) {
                if (e.field) throw new HttpError(400, 'Invalid input.', { fields: { [e.field]: e.message } });
                throw e;
            }
        }
        if ((match = p.match(/^\/api\/profiles\/([0-9a-f-]{36})(\/credentials|\/activate)?$/))) {
            const id = match[1];
            if (!UUID.test(id)) throw new HttpError(404, 'Unknown profile.');
            if (match[2] === '/credentials' && m === 'PUT') {
                const body = await readJson(req);
                if (!(await store.rotateProfileCredentials(id, profileInput(body), actor))) throw new HttpError(404, 'Unknown profile.');
                broadcastSoon();
                return send(res, 200, { ok: true });
            }
            if (match[2] === '/activate' && m === 'POST') {
                try {
                    const result = await switcher.switchTo(id, actor);
                    broadcastSoon();
                    return send(res, 200, { ok: true, ...result });
                } catch (e) {
                    broadcastSoon();
                    throw new HttpError(e.status || 500, e.status ? e.message : 'Account switch failed.');
                }
            }
            if (!match[2] && m === 'DELETE') {
                if (!(await store.deleteProfile(id, actor))) throw new HttpError(409, 'The active profile cannot be deleted (or it does not exist).');
                broadcastSoon();
                return send(res, 200, { ok: true });
            }
        }
        throw new HttpError(404, 'Not found.');
    }

    async function handle(req, res) {
        // DNS-rebinding guard: only loopback host names for the configured port are served.
        if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
            return send(res, 421, { error: 'Unrecognized Host.' });
        }
        const rate = apiLimiter.hit(clientKey(req));
        if (rate.limited) return send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': String(rate.retryAfterS) });

        const url = new URL(req.url, `${scheme}://${req.headers.host}`);
        if (req.method === 'OPTIONS') return send(res, 405, { error: 'Method not allowed.' });

        try {
            if (url.pathname === '/api/login') {
                if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
                return await handleLogin(req, res);
            }
            const session = readSession(req);
            const asset = STATIC_FILES[url.pathname];
            if (asset && req.method === 'GET') {
                if (asset.auth && !session) {
                    return url.pathname === '/' ? send(res, 303, '', { Location: '/login' }) : send(res, 401, { error: 'Authentication required.' });
                }
                if (url.pathname === '/login' && session) return send(res, 303, '', { Location: '/' });
                if (!staticCache.has(asset.file)) staticCache.set(asset.file, fs.readFileSync(path.join(PUBLIC_DIR, asset.file)));
                return send(res, 200, staticCache.get(asset.file), { 'Content-Type': asset.type });
            }
            if (url.pathname.startsWith('/api/')) {
                if (!session) {
                    if (req.method !== 'GET') deny(req, 'request.auth', 'no session');
                    throw new HttpError(401, 'Authentication required.');
                }
                return await handleApi(req, res, url, session);
            }
            throw new HttpError(404, 'Not found.');
        } catch (e) {
            if (e instanceof HttpError) {
                const headers = e.retryAfterS ? { 'Retry-After': String(e.retryAfterS) } : {};
                return send(res, e.status, { error: e.message, ...(e.fields ? { fields: e.fields } : {}) }, headers);
            }
            console.error('[ControlPlane] Request failed:', e?.message || e);
            return send(res, 500, { error: 'Internal error.' });
        }
    }

    const server = http.createServer((req, res) => { handle(req, res); });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

    return {
        server,
        listen(port = config.port, host = config.host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
            });
        },
        close() {
            clearInterval(heartbeat);
            clearTimeout(broadcastTimer);
            engine.engineEvents?.off('task', onTask);
            engine.engineEvents?.off('engine', onTask);
            switcher.events?.off('change', onTask);
            for (const c of sseClients) c.res.end();
            sseClients.clear();
            return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
        },
        /** For tests: allow the ephemeral port chosen by listen(0). */
        allowHost(hostPort) { allowedHosts.add(hostPort); },
        broadcastSoon,
    };
}
