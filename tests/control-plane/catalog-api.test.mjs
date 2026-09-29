// tests/control-plane/catalog-api.test.mjs - CAT-TASK-005 / AC-CAT-002, AC-CAT-007..AC-CAT-010
// The Catalog API on a real control-plane server (ephemeral loopback port) over a migrated
// database. The game contracts are the committed ones (unverified), so observe_realm is refused.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createControlStore } from '../../_gg_data/handler/controlStore.js';
import { createCatalogStore } from '../../_gg_data/handler/catalogStore.js';
import { createGuideDiscoveryStore } from '../../_gg_data/handler/guideDiscoveryStore.js';
import { createCatalogService } from '../../catalog/catalogService.js';
import { createSeedService } from '../../catalog/seedService.js';
import { SEED_SOURCES } from '../../catalog/sourceRegistry.js';
import { createGuideRelay } from '../../catalog/guideRelay.js';
import { createKeyring, hashPassword } from '../../control-plane/crypto.mjs';
import { createControlPlane } from '../../control-plane/server.mjs';

const ADMIN = 'owner';
const PASSWORD = 'catalog-api-password-fixture';
let cp, base, controlStore, catalogStore, db, clock, runNowResult, paused;

before(async () => {
    const log = console.log;
    console.log = () => {};
    db = await freshClient();
    console.log = log;
    clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const now = () => clock.t;
    controlStore = createControlStore(db, createKeyring(crypto.randomBytes(32).toString('base64')));
    catalogStore = createCatalogStore(db, { now, invalidateCaches: () => {} });
    const seedData = { master_realm: [{ id: 501, name: 'Seeded Master' }], realm: [], creature: [], item: [{ id: 50001, name: 'Seeded Item' }] };
    const seeds = createSeedService({ db, store: catalogStore, fetchJson: async url => seedData[Object.keys(SEED_SOURCES.fsdatabase.files).find(k => SEED_SOURCES.fsdatabase.files[k] === url)] });
    const guideStore = createGuideDiscoveryStore(db, { now });
    const relay = createGuideRelay({ db, store: catalogStore, guideStore, now });
    const service = createCatalogService({ db, store: catalogStore, guideStore, now, seeds, relay });
    const engine = { engineEvents: new EventEmitter(), isPaused: () => paused, listModuleIds: () => [], getTasksStatus: () => [] };
    const switcher = { events: new EventEmitter(), status: () => ({ state: 'idle', activeLabel: null, lastError: null }) };
    const config = { username: ADMIN, passwordHash: hashPassword(PASSWORD), sessionSecret: 'y'.repeat(48), host: '127.0.0.1', port: 0, cookieSecure: false };
    cp = createControlPlane({ config, store: controlStore, engine, switcher, now, catalog: { service, relay, runNow: async () => runNowResult } });
    const { port } = await cp.listen(0, '127.0.0.1');
    cp.allowHost(`127.0.0.1:${port}`);
    base = `http://127.0.0.1:${port}`;
});
after(async () => { await cp.close(); await closeClients(); });
beforeEach(() => { clock.t += 3600_000; paused = false; runNowResult = { ran: [] }; });

async function req(method, url, { body, cookie, csrf, origin = base } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && origin) headers.Origin = origin;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
}

async function fetchCookie() {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: ADMIN, password: PASSWORD }) });
    const json = await r.json();
    fetchCookie.csrf = json.csrf;
    return r.headers.get('set-cookie').split(';')[0];
}
async function session() {
    const cookie = await fetchCookie();
    return { cookie, csrf: fetchCookie.csrf };
}
const lastAudit = async () => (await controlStore.listAudit(1))[0];

async function seed() {
    await catalogStore.ingest({ mode: 'seed', source: 'guide_baseline', observations: [
        { kind: 'realm', payload: { id: 1200, name: 'Mountain Path' } },
        { kind: 'creature', payload: { id: 7001, name: '<img src=x onerror=alert(1)>Golem', stats: { level: 5 } } },
        { kind: 'item', payload: { id: 17048, name: 'Montmarr Helm' } },
        { kind: 'item', payload: { id: 17049, name: 'Dusk Gauntlets' } },
        { kind: 'relation', payload: { type: 'realm_creature', realm_id: 1200, creature_id: 7001 } },
        { kind: 'relation', payload: { type: 'creature_drop', creature_id: 7001, item_id: 17048 } },
    ] });
}

test('AC-CAT-007 error case: catalog endpoints deny unauthenticated, cross-origin, and CSRF-less requests', async () => {
    assert.equal((await req('GET', '/api/catalog/summary')).status, 401);
    assert.equal((await req('POST', '/api/catalog/jobs', { body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 401);
    const { cookie, csrf } = await session();
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 403, 'no CSRF token');
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, csrf, origin: 'http://evil.example', body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 403);
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, csrf, origin: null, body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 403);
    assert.equal((await catalogStore.listJobs()).length, 0);
});

test('AC-CAT-007: browse is paginated, filtered by an allow-list, and returns catalog state', async () => {
    await seed();
    const { cookie } = await session();
    const page = await req('GET', '/api/catalog/entities?kind=item&page=1&pageSize=1', { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.json.total, 2);
    assert.deepEqual(page.json.items.map(i => i.id), [17049]);
    assert.equal(page.json.items[0].catalog.completeness, 'incomplete');
    assert.deepEqual(page.json.items[0].catalog.incompleteReasons, ['guide_detail_missing']);
    const q = await req('GET', '/api/catalog/entities?kind=item&q=helm', { cookie });
    assert.deepEqual(q.json.items.map(i => i.name), ['Montmarr Helm'], 'search ignores case on MySQL and SQLite alike');
    assert.deepEqual((await req('GET', '/api/catalog/entities?kind=item&q=50%25', { cookie })).json.items, [], '% is literal, not a wildcard');
    assert.equal((await req('GET', '/api/catalog/entities?kind=item&completeness=complete', { cookie })).json.total, 0);
    assert.equal((await req('GET', '/api/catalog/entities?kind=item&completeness=incomplete', { cookie })).json.total, 2);
    const c = await req('GET', '/api/catalog/entities?kind=creature', { cookie });
    assert.equal(c.json.items[0].name, '<img src=x onerror=alert(1)>Golem', 'text is returned as data; the UI renders it as text');
    for (const bad of ['kind=items', 'kind=item&pageSize=101', 'kind=item&page=0', 'kind=item&table=users', 'kind=item&q=' + 'x'.repeat(65),
        'kind=realm&completeness=complete', 'kind=item&completeness=maybe', 'kind=item&page=1&page=2', "kind=item&q=%27%3B%20DROP%20TABLE%20items%3B--"]) {
        const r = await req('GET', `/api/catalog/entities?${bad}`, { cookie });
        if (bad.startsWith('kind=item&q=%27')) { assert.equal(r.status, 200, 'SQL-looking text is only a search string'); continue; }
        assert.equal(r.status, 400, bad);
        assert.ok(!/at .*\.js/.test(r.text), 'no stack trace');
    }
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM items'))[0].n, 2);
});

test('AC-CAT-007: entity detail carries provenance and relations; bad keys and unknown entities are refused', async () => {
    await seed();
    const { cookie } = await session();
    const r = await req('GET', '/api/catalog/entities/creature/7001', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.fields.stats.level, 5);
    assert.deepEqual(r.json.relations.realms, [{ id: 1200, name: 'Mountain Path' }]);
    assert.deepEqual(r.json.relations.drops, [{ id: 17048, name: 'Montmarr Helm' }]);
    assert.equal(r.json.provenance[0].source, 'guide_baseline');
    assert.equal(r.json.provenance[0].mode, 'seed');
    assert.equal((await req('GET', '/api/catalog/entities/creature/99', { cookie })).status, 404);
    assert.equal((await req('GET', '/api/catalog/entities/creature/abc', { cookie })).status, 400);
    assert.equal((await req('GET', '/api/catalog/entities/users/1', { cookie })).status, 400);
    assert.equal((await req('GET', '/api/catalog/entities/relic/nope', { cookie })).status, 400);
    const summary = await req('GET', '/api/catalog/summary', { cookie });
    assert.equal(summary.json.kinds.item.rows >= 2, true);
    assert.equal(summary.json.policy.guide.minDelayMs, 3000);
    assert.deepEqual(summary.json.guide.map(g => g.entityKind), ['creature', 'item', 'master_realm', 'realm']);
    assert.equal(summary.json.guide[0].display, 'waiting_for_browser', 'never checked and no relay seen');
    assert.equal(summary.json.available.observe_realm, 'contract_unverified');
});

test('AC-CAT-002 error case: a job kind outside the allow-list is rejected with 400, creates nothing, and is audited', async () => {
    const { cookie, csrf } = await session();
    for (const kind of ['attack', 'move', '../../etc', 7]) {
        const r = await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind, requestBudget: 1 } });
        assert.equal(r.status, 400);
        const a = await lastAudit();
        assert.deepEqual([a.action, a.outcome], ['catalog.job.create', 'denied']);
    }
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind: 'guide_discovery', requestBudget: 5, url: 'https://x' } })).status, 400, 'no extra fields');
    assert.equal((await catalogStore.listJobs()).length, 0);
});

test('AC-CAT-008: job commands are validated, audited, conflict-checked, and refused without a verified contract', async () => {
    const { cookie, csrf } = await session();
    const refused = await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind: 'observe_realm', requestBudget: 1 } });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /no verified game read contract/);
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind: 'guide_discovery', requestBudget: 51 } })).status, 400);
    const created = await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind: 'guide_discovery', requestBudget: 50 } });
    assert.equal(created.status, 201);
    const id = created.json.job.id;
    assert.deepEqual([(await lastAudit()).action, (await lastAudit()).outcome], ['catalog.job.create', 'success']);
    assert.equal((await req('POST', '/api/catalog/jobs', { cookie, csrf, body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 409, 'one active job per kind');
    assert.equal((await req('POST', `/api/catalog/jobs/${id}/pause`, { cookie, csrf })).json.job.state, 'paused');
    assert.equal((await req('POST', `/api/catalog/jobs/${id}/pause`, { cookie, csrf })).status, 409, 'a paused job cannot pause again');
    assert.equal((await lastAudit()).outcome, 'denied');
    assert.equal((await req('POST', `/api/catalog/jobs/${id}/resume`, { cookie, csrf })).json.job.state, 'queued');
    assert.equal((await req('POST', `/api/catalog/jobs/${id}/cancel`, { cookie, csrf })).json.job.state, 'cancelled');
    assert.equal((await req('POST', `/api/catalog/jobs/${id}/restart`, { cookie, csrf })).status, 404);
    assert.equal((await req('POST', `/api/catalog/jobs/${crypto.randomUUID()}/pause`, { cookie, csrf })).status, 404);
});

test('AC-CAT-008: sync-now refuses to overlap a running catalog pass or an account switch', async () => {
    const { cookie, csrf } = await session();
    runNowResult = { skipped: 'busy' };
    assert.equal((await req('POST', '/api/catalog/sync-now', { cookie, csrf })).status, 409);
    paused = true;
    runNowResult = { ran: [] };
    assert.equal((await req('POST', '/api/catalog/sync-now', { cookie, csrf })).status, 409);
    paused = false;
    const ok = await req('POST', '/api/catalog/sync-now', { cookie, csrf });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.ran, []);
});

test('AC-CAT-009 / AC-CAT-010: rollback is a previewed, confirmed, one-use plan; denials change nothing and are audited', async () => {
    const run = await catalogStore.ingest({ mode: 'seed', source: 'guide_baseline', observations: [{ kind: 'master_realm', payload: { id: 77, name: 'Temporary' } }] });
    const { cookie, csrf } = await session();
    const planRes = await req('POST', `/api/catalog/runs/${run.runId}/rollback-plan`, { cookie, csrf });
    assert.equal(planRes.status, 201);
    const plan = planRes.json.plan;
    assert.equal(plan.expectedCounts.remove, 1);
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM master_realms WHERE id = 77'))[0].n, 1, 'a preview changes nothing');
    const wrong = await req('POST', `/api/catalog/plans/${plan.id}/execute`, { cookie, csrf, body: { confirmation: 'ROLLBACK everything' } });
    assert.equal(wrong.status, 409);
    assert.deepEqual([(await lastAudit()).action, (await lastAudit()).outcome], ['catalog.plan.execute', 'denied']);
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM master_realms WHERE id = 77'))[0].n, 1);
    const ok = await req('POST', `/api/catalog/plans/${plan.id}/execute`, { cookie, csrf, body: { confirmation: plan.confirmation } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.status, 'reverted');
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM master_realms WHERE id = 77'))[0].n, 0);
    assert.equal((await req('POST', `/api/catalog/plans/${plan.id}/execute`, { cookie, csrf, body: { confirmation: plan.confirmation } })).status, 409, 'one use');
    assert.equal((await req('GET', `/api/catalog/runs/${run.runId}`, { cookie })).json.status, 'reverted');
    const runs = await req('GET', '/api/catalog/runs?page=1&pageSize=5', { cookie });
    assert.ok(runs.json.runs.some(r => r.id === run.runId));
    assert.equal((await req('POST', `/api/catalog/runs/${crypto.randomUUID()}/rollback-plan`, { cookie, csrf })).status, 404);
    // An expired plan is refused.
    const run2 = await catalogStore.ingest({ mode: 'seed', source: 'guide_baseline', observations: [{ kind: 'master_realm', payload: { id: 78, name: 'Later' } }] });
    const plan2 = (await req('POST', `/api/catalog/runs/${run2.runId}/rollback-plan`, { cookie, csrf })).json.plan;
    clock.t += 11 * 60_000;
    const s2 = await session();
    const expired = await req('POST', `/api/catalog/plans/${plan2.id}/execute`, { cookie: s2.cookie, csrf: s2.csrf, body: { confirmation: plan2.confirmation } });
    assert.equal(expired.status, 409);
    assert.match(expired.json.error, /expired/);
});

test('AC-CAT-006 / AC-CAT-009: seeds are staged by approved key only, then promoted through a confirmed plan', async () => {
    const { cookie, csrf } = await session();
    assert.deepEqual((await req('GET', '/api/catalog/seed-sources', { cookie })).json.sources.map(s => s.key), ['fsdatabase']);
    const bad = await req('POST', '/api/catalog/seeds', { cookie, csrf, body: { sourceKey: 'https://evil.example/items.json' } });
    assert.equal(bad.status, 400);
    assert.deepEqual([(await lastAudit()).action, (await lastAudit()).outcome], ['catalog.seed.stage', 'denied']);
    assert.equal((await req('POST', '/api/catalog/seeds', { cookie, csrf, body: { sourceKey: 'fsdatabase', url: 'x' } })).status, 400);
    const staged = await req('POST', '/api/catalog/seeds', { cookie, csrf, body: { sourceKey: 'fsdatabase' } });
    assert.equal(staged.status, 201);
    const runId = staged.json.staged.runs[0].runId;
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM items WHERE id = 50001'))[0].n, 0, 'staged, not projected');
    const plan = (await req('POST', `/api/catalog/runs/${runId}/promote-plan`, { cookie, csrf })).json.plan;
    assert.equal(plan.action, 'promote');
    const done = await req('POST', `/api/catalog/plans/${plan.id}/execute`, { cookie, csrf, body: { confirmation: plan.confirmation } });
    assert.equal(done.status, 200);
    assert.equal(done.json.result.action, 'promote');
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM items WHERE id = 50001'))[0].n, 1);
    assert.equal((await req('POST', `/api/catalog/runs/${runId}/discard`, { cookie, csrf })).status, 409, 'a promoted run is not staged anymore');
});

async function relayReq(method, url, { token, body, rawBody, contentType = 'application/json', cookie } = {}) {
    const headers = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

test('AC-CAT-014: the owner issues a stage-only relay token once; it opens the relay routes and nothing else', async () => {
    const { cookie, csrf } = await session();
    assert.equal((await req('POST', '/api/catalog/relay-tokens', { cookie, body: { label: 'laptop', ttlDays: 7 } })).status, 403, 'issuing needs CSRF');
    assert.equal((await req('POST', '/api/catalog/relay-tokens', { cookie, csrf, body: { label: 'laptop', ttlDays: 30 } })).status, 400, 'at most seven days');
    const issued = await req('POST', '/api/catalog/relay-tokens', { cookie, csrf, body: { label: 'laptop', ttlDays: 7 } });
    assert.equal(issued.status, 201);
    const { token, id } = issued.json;
    assert.match(token, /^ggr_/);
    const summary = await req('GET', '/api/catalog/summary', { cookie });
    assert.ok(!summary.text.includes(token), 'the token is never shown again');
    assert.equal(summary.json.relayTokens[0].label, 'laptop');
    assert.ok(!JSON.stringify(await controlStore.listAudit(50)).includes(token), 'nor audited');

    assert.equal((await relayReq('GET', '/relay/guide/lease')).status, 401);
    assert.equal((await relayReq('GET', '/relay/guide/lease', { token: 'ggr_not-a-real-token-value' })).status, 401);
    const lease = await relayReq('GET', '/relay/guide/lease', { token });
    assert.equal(lease.status, 200, 'no session, Origin, or CSRF is needed on the relay route');
    assert.deepEqual(lease.json, { status: 'disabled' }, 'no guide job is enabled yet');
    assert.equal((await relayReq('GET', '/relay/guide/lease?kind=item', { token })).status, 400);

    // The token is not a session: every ordinary Catalog route still refuses it.
    const jobsBefore = (await catalogStore.listJobs()).length;
    assert.equal((await relayReq('GET', '/api/catalog/summary', { token })).status, 401);
    assert.equal((await relayReq('POST', '/api/catalog/jobs', { token, body: { kind: 'guide_discovery', requestBudget: 5 } })).status, 401);
    assert.equal((await relayReq('POST', '/relay/guide/jobs', { token, body: {} })).status, 404);
    assert.equal((await relayReq('POST', `/relay/guide/plans/${crypto.randomUUID()}/execute`, { token, body: {} })).status, 404);
    assert.equal((await catalogStore.listJobs()).length, jobsBefore, 'the token created no job');

    const leaseId = crypto.randomUUID();
    assert.equal((await relayReq('POST', `/relay/guide/leases/${leaseId}`, { token, body: { results: [] } })).status, 404, 'unknown lease');
    assert.equal((await relayReq('POST', `/relay/guide/leases/${leaseId}`, { token, rawBody: 'results=1', contentType: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await relayReq('POST', `/relay/guide/leases/${leaseId}`, { token, rawBody: JSON.stringify({ results: [], pad: 'x'.repeat(600 * 1024) }) })).status, 413);

    // Revoked: denied, and the denial is audited without the token.
    assert.equal((await req('POST', `/api/catalog/relay-tokens/${id}/revoke`, { cookie, csrf })).status, 200);
    assert.equal((await relayReq('GET', '/relay/guide/lease', { token })).status, 401);
    assert.ok(await (async () => { for (let i = 0; i < 100; i++) { const a = await controlStore.listAudit(5); if (a.some(e => e.action === 'catalog.relay' && e.outcome === 'denied')) return true; await new Promise(r => setTimeout(r, 10)); } return false; })());
});

test('AC-CAT-008: dashboard state (SSE) carries catalog jobs and guide status', async () => {
    const { cookie } = await session();
    const state = await req('GET', '/api/state', { cookie });
    assert.ok(Array.isArray(state.json.catalog.jobs));
    assert.equal(state.json.catalog.guide.length, 4);
    assert.equal(state.json.catalog.available.guide_discovery, 'browser_relay');
});
