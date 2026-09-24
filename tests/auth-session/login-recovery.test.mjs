// tests/auth-session/login-recovery.test.mjs - AUTH-TASK-002 / AC-AUTH-001..AC-AUTH-005
// A fake fetch plays the game and the HuntedCow SSO; no real network call is made and .env is never read.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installFakeFetch, formOf } from '../helpers/fake-fetch.mjs';

const EMAIL = 'owner@example.test';
const PASSWORD = 'correct-horse-fixture';
const GAME = 'https://www.fallensword.com';
const SSO = 'https://account.huntedcow.com';

for (const k of ['GG_BASE', 'SWS_BASE', 'FS_BASE', 'GG_SSO_URL', 'GG_LOGIN_DEBUG', 'SWS_LOGIN_DEBUG']) delete process.env[k];
for (const k of ['EMAIL', 'PASSWORD']) for (const p of ['SWS_', 'FS_']) delete process.env[p + k];
process.env.GG_EMAIL = EMAIL;          // ensureLogin() inside secureFetch reads the configured credentials
process.env.GG_PASSWORD = PASSWORD;
process.env.GG_UA = 'gogon-test-ua';

const fake = installFakeFetch();
const session = await import('../../session.mjs');
const utils = await import('../../utils.js');
const { RETRY_DELAY } = await import('../../webhooks.js');

const tmp = mkdtempSync(path.join(tmpdir(), 'gg-auth-'));
after(() => { fake.restore(); rmSync(tmp, { recursive: true, force: true }); });

// --- Fake game + SSO -------------------------------------------------------------------------------
let validSession;       // the cookie value the game currently accepts
let ssoDown;            // 'unreachable' | 503 | undefined
let apiScript;          // queue of responses for /fetchdata/api.php; falls back to { s: true }

function cookieOf(req, name) {
    const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1] : undefined;
}
const loggedInPage = '<html><body><div id="pCC">Welcome</div></body></html>';
const loggedOutPage = '<html><body><a id="hc-account-link" href="/sso">Log in</a></body></html>';

function route(req) {
    const u = new URL(req.url);
    if (u.origin === SSO) {
        if (ssoDown === 'unreachable') throw new TypeError('fetch failed');
        if (ssoDown) return { status: ssoDown, body: 'Service Unavailable' };
        if (u.pathname === '/auth' && req.method === 'GET') {
            return { body: `<form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"><input type="hidden" name="csrf" value="c1"></form>` };
        }
        if (u.pathname === '/login' && req.method === 'POST') {
            const f = formOf(req);
            if (f.email === EMAIL && f.password === PASSWORD && f.csrf === 'c1') {
                return { body: `<form method="post" action="${GAME}/sso/relay"><input type="hidden" name="ticket" value="t-ok"><input type="submit"></form>` };
            }
            return { body: '<p>Invalid login</p><form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"></form>' };
        }
    }
    if (u.origin === GAME) {
        if (u.pathname === '/sso/relay' && formOf(req).ticket === 't-ok') {
            validSession = `s${Date.now()}${Math.random()}`.replace('.', '');
            return { headers: { 'set-cookie': `sess=${validSession}; Path=/` }, body: loggedInPage };
        }
        const authed = validSession && cookieOf(req, 'sess') === validSession;
        if (u.pathname === '/index.php') return { body: authed ? loggedInPage : loggedOutPage };
        if (u.pathname === '/fetchdata/api.php') {
            const next = apiScript.length ? apiScript.shift() : { json: { s: true, r: [] } };
            return typeof next === 'function' ? next(req) : next;
        }
    }
    if (u.origin === 'https://discord.com') return { json: { ok: true } };
    return { status: 404, body: 'no route' };
}

beforeEach(() => {
    ssoDown = undefined;
    apiScript = [];
    fake.calls.length = 0;
    fake.setHandler(route);
});

/** Captures console output so tests can assert that secrets never reach logs. */
async function captureConsole(fn) {
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const lines = [];
    for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(x => (x instanceof Error ? x.stack : String(x))).join(' '));
    try { return { value: await fn(), lines }; } catch (error) { return { error, lines }; } finally { Object.assign(console, saved); }
}

/** Runs fn while fast-forwarding setTimeout, so RETRY_DELAY sleeps do not slow the suite. */
async function withFakeTimers(t, fn) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let done = false;
    const p = fn().finally(() => { done = true; });
    while (!done) {
        await new Promise(r => setImmediate(r));
        t.mock.timers.tick(RETRY_DELAY);
    }
    t.mock.timers.reset();
    return p;
}

const expireSession = () => { validSession = undefined; };

// --- AC-AUTH-001 -------------------------------------------------------------------------------------

test('AC-AUTH-001: login completes the SSO form and relay, then confirms #pCC', async () => {
    expireSession();
    const { value, error } = await captureConsole(() => session.login(EMAIL, PASSWORD));
    assert.equal(error, undefined);
    assert.equal(value, true);
    assert.equal(await session.isLoggedIn(), true);
    const post = fake.calls.find(c => c.url === `${SSO}/login`);
    assert.equal(post.method, 'POST');
    assert.equal(formOf(post).csrf, 'c1', 'hidden SSO fields are submitted');
    assert.ok(fake.calls.some(c => c.url === `${GAME}/sso/relay`), 'relay form is followed back to the game');
});

test('AC-AUTH-001: rejected credentials throw a descriptive error without the password', async () => {
    expireSession();
    const { error, lines } = await captureConsole(() => session.login(EMAIL, 'wrong-password-fixture'));
    assert.match(error?.message ?? '', /Authentication failed/);
    assert.ok(!`${error.stack}\n${lines.join('\n')}`.includes('wrong-password-fixture'));
});

test('AC-AUTH-001: login without credentials fails before any request', async () => {
    await assert.rejects(session.login('', ''), /Credentials missing/);
    assert.equal(fake.calls.length, 0);
});

for (const failure of ['unreachable', 503]) {
    test(`AC-AUTH-001: SSO ${failure === 503 ? 'returning 5xx' : 'unreachable'} throws a connection failure without the password`, async () => {
        expireSession();
        ssoDown = failure;
        const { error, lines } = await captureConsole(() => session.login(EMAIL, PASSWORD));
        assert.match(error?.message ?? '', /Connection failure/);
        assert.match(error.message, /account\.huntedcow\.com/);
        assert.ok(!`${error.stack}\n${lines.join('\n')}`.includes(PASSWORD));
    });
}

test('AC-AUTH-001: a failed login makes the boot sequence exit with code 1', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../app.mjs', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('// 4. Login Sequence'), src.indexOf('// 5. Engine Initialization'));
    assert.match(block, /await login\(email, pass\)/);
    assert.match(block, /catch \(e\) \{[\s\S]*process\.exit\(1\)/);
});

// --- AC-AUTH-002 -------------------------------------------------------------------------------------

test('AC-AUTH-002: ensureLogin with a valid session does one GET /index.php and no SSO', async () => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    fake.calls.length = 0;
    await captureConsole(() => session.ensureLogin(EMAIL, PASSWORD));
    assert.deepEqual(fake.calls.map(c => `${c.method} ${c.url}`), [`GET ${GAME}/index.php`]);
});

test('AC-AUTH-002: ensureLogin re-authenticates an expired session and logs it', async () => {
    expireSession();
    const { error, lines } = await captureConsole(() => session.ensureLogin(EMAIL, PASSWORD));
    assert.equal(error, undefined);
    assert.ok(fake.calls.some(c => c.url === `${SSO}/login`), 'SSO login was performed');
    assert.ok(lines.some(l => /re-authenticat/i.test(l)));
    assert.equal(await session.isLoggedIn(), true);
});

// --- AC-AUTH-003 -------------------------------------------------------------------------------------

const API = `${GAME}/fetchdata/api.php?a=profile`;
const apiCalls = () => fake.calls.filter(c => c.url.startsWith(`${GAME}/fetchdata/api.php`));

test('AC-AUTH-003: 5xx responses are retried after RETRY_DELAY until one succeeds', async (t) => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    apiScript = [{ status: 500 }, { status: 502 }, { status: 503 }, { json: { s: true, r: 'ok' } }];
    const { value: res } = await captureConsole(() => withFakeTimers(t, () => utils.secureFetch(API)));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { s: true, r: 'ok' });
    assert.equal(apiCalls().length, 4, 'one attempt plus the default three retries');
});

test('AC-AUTH-003: after the retry limit the last 5xx response is returned', async (t) => {
    apiScript = [{ status: 504 }, { status: 504 }, { status: 504 }, { status: 504 }, { json: { s: true } }];
    const { value: res } = await captureConsole(() => withFakeTimers(t, () => utils.secureFetch(API)));
    assert.equal(res.status, 504);
    assert.equal(apiCalls().length, 4);
});

test('AC-AUTH-003: a "Not logged in" JSON answer triggers one re-login and a retry', async () => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    apiScript = [
        (req) => { expireSession(); return { json: { s: false, e: { message: 'Not logged in' } } }; },
        (req) => (cookieOf(req, 'sess') === validSession ? { json: { s: true, r: 'fresh' } } : { json: { s: false, e: { message: 'Not logged in' } } }),
    ];
    const { value: res, error } = await captureConsole(() => utils.secureFetch(API));
    assert.equal(error, undefined);
    assert.deepEqual(await res.json(), { s: true, r: 'fresh' });
    assert.equal(fake.calls.filter(c => c.url === `${SSO}/login`).length, 1);
});

test('AC-AUTH-003: an HTML login page also triggers re-login, and later logouts still recover', async () => {
    // Regression: a process-wide flag used to make every logout after the first one fatal.
    for (let round = 0; round < 2; round++) {
        apiScript = [
            () => { expireSession(); return { body: loggedOutPage }; },
            { json: { s: true, r: round } },
        ];
        const { value: res, error } = await captureConsole(() => utils.secureFetch(API));
        assert.equal(error, undefined, `round ${round}`);
        assert.deepEqual(await res.json(), { s: true, r: round });
    }
});

test('AC-AUTH-003: a session still invalid after re-login fails without further retries', async () => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    apiScript = Array.from({ length: 6 }, () => ({ json: { s: false, e: { message: 'Not logged in' } } }));
    const { error } = await captureConsole(() => utils.secureFetch(API));
    assert.match(error?.message ?? '', /still invalid/);
    assert.equal(apiCalls().length, 2, 'original request plus exactly one post-login retry');
});

// --- AC-AUTH-004 -------------------------------------------------------------------------------------

test('AC-AUTH-004: bootstrap cookies are loaded into the jar and verified before SSO', async () => {
    validSession = 'bootstrap-fixture';
    const file = path.join(tmp, 'cookies.bootstrap.json');
    writeFileSync(file, JSON.stringify([{ name: 'sess', value: 'bootstrap-fixture', domain: 'www.fallensword.com', path: '/' }]));
    assert.equal(await session.loadCookieBootstrap(file), true);
    fake.calls.length = 0;
    assert.equal(await session.isLoggedIn(), true);
    assert.equal(fake.calls.some(c => c.url.startsWith(SSO)), false);
});

test('AC-AUTH-004: a missing or invalid bootstrap file is ignored', async () => {
    assert.equal(await session.loadCookieBootstrap(path.join(tmp, 'absent.json')), false);
    const bad = path.join(tmp, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(await session.loadCookieBootstrap(bad), false);
    writeFileSync(bad, '{"not":"a list"}');
    assert.equal(await session.loadCookieBootstrap(bad), false);
});

// --- AC-AUTH-005 -------------------------------------------------------------------------------------

test('AC-AUTH-005: game requests carry User-Agent, game Origin, and the last good Referer', async () => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    await captureConsole(() => utils.secureFetch(`${GAME}/index.php?cmd=profile`));
    fake.calls.length = 0;
    await captureConsole(() => utils.secureFetch(API));
    const req = apiCalls()[0];
    assert.equal(req.headers.get('user-agent'), 'gogon-test-ua');
    assert.equal(req.headers.get('origin'), 'https://www.fallensword.com');
    assert.equal(req.headers.get('referer'), `${GAME}/index.php?cmd=profile`);
    assert.match(req.headers.get('cookie') || '', /sess=/);
});

test('AC-AUTH-005: external hosts get no game cookies, Origin, Referer, or login check', async () => {
    await session.login(EMAIL, PASSWORD).catch(() => {});
    fake.calls.length = 0;
    await captureConsole(() => utils.secureFetch('https://discord.com/api/fixture'));
    await captureConsole(() => utils.secureFetchExternal('https://discord.com/api/fixture'));
    assert.equal(fake.calls.length, 2, 'no proactive /index.php login check for external hosts');
    for (const req of fake.calls) {
        assert.equal(new URL(req.url).host, 'discord.com');
        assert.equal(req.headers.get('cookie'), null);
        assert.equal(req.headers.get('origin'), null);
        assert.equal(req.headers.get('referer'), null);
    }
});
