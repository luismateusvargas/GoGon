// tests/catalog-sync/collector.test.mjs - CAT-TASK-003 / AC-CAT-001..AC-CAT-005
// The passive collector against an in-process fetch double and a migrated database. The committed
// game contracts are unverified (DEC-CAT-019), so the positive paths use a SYNTHETIC verified
// contract defined here; it documents the shape a captured contract must provide, not the game's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createCatalogStore } from '../../_gg_data/handler/catalogStore.js';
import { createCollector, FRONTIER_END_MISSES, FRONTIER_OVERLAP } from '../../catalog/collector.js';
import { readOperations, unavailableReason, assertPassiveGameUrl, createRequestQueue } from '../../catalog/requestPolicy.js';
import { GAME_LOCATION_CONTRACT } from '../../catalog/contracts/gameLocation.js';
import { GAME_POLICY } from '../../catalog/contracts/policy.js';
import { apiEndpoints } from '../../game_modules/API.js';

after(() => closeClients());
const FIXTURES = path.resolve('tests/catalog-sync/fixtures');

const LOCATION = Object.freeze({
    ...GAME_LOCATION_CONTRACT, verified: true, verifiedOn: '2026-09-28', fixture: 'synthetic (tests only)',
    mapping: { realm: { id: 'r.realm.id', name: 'r.realm.name' }, creatures: { list: 'r.actions', where: { path: 'type', equals: 'creature' }, id: 'data.id', name: 'data.name', imageUrl: 'data.img' } },
});
const ITEM = Object.freeze({
    verified: true, verifiedOn: '2026-09-28', fixture: 'synthetic (tests only)',
    mapping: { item: { id: 'r.id', name: 'r.name' }, notFound: { path: 'r', equals: null } },
    request: id => ({ url: `https://www.fallensword.com/fetchdata.php?a=-1&d=9999&id=${id}`, expect: 'json' }),
    passive: url => url,
});
const LOCATION_BODY = {
    s: true,
    r: {
        realm: { id: 1200, name: 'Mountain Path' },
        actions: [
            { type: 'creature', data: { id: 7001, name: 'Montmarr the Dragon Golem', img: 'https://cdn2.fallensword.com/creatures/7001.jpg' } },
            { type: 'creature', data: { id: 7003, name: 'Ridge Hawk', img: 'javascript:alert(1)' } },
            { type: 'player', data: { id: 5, name: 'SomeOtherPlayer' } },
        ],
    },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (file, status = 200, headers = {}) => new Response(fs.readFileSync(path.join(FIXTURES, file), 'utf8'), { status, headers: { 'content-type': 'text/html', ...headers } });

async function setup({ contracts = { location: LOCATION, itemDetail: ITEM }, respond, sessionReady } = {}) {
    const log = console.log;
    console.log = () => {};
    const db = await freshClient();
    console.log = log;
    const clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const now = () => clock.t;
    const store = createCatalogStore(db, { now, invalidateCaches: () => {} });
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, init }); return respond(url, calls.length); };
    const queue = createRequestQueue({ minDelayMs: 0 });
    const collector = createCollector({ store, fetchFn, queue, operations: readOperations(contracts), now, sessionReady });
    return { db, store, collector, calls, clock };
}
const count = async (db, table) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);

test('CAT-TASK-003 / DEC-CAT-019: with the committed contracts, game jobs are unavailable and make no request', async () => {
    assert.equal(unavailableReason('observe_realm'), 'contract_unverified');
    assert.equal(unavailableReason('item_frontier'), 'contract_unverified');
    assert.equal(unavailableReason('guide_discovery'), null);
    assert.equal(unavailableReason('attack'), 'unknown_kind');
    const { store } = await setup({ respond: () => json(LOCATION_BODY) });
    const calls = [];
    const prod = createCollector({ store, fetchFn: async url => { calls.push(url); throw new Error('no request expected'); } });
    const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const r = await prod.runJob(await store.getJob(id));
    assert.deepEqual({ outcome: r.outcome, reason: r.reason, requests: r.requests }, { outcome: 'unavailable', reason: 'contract_unverified', requests: 0 });
    assert.equal((await store.getJob(id)).state, 'queued');
    assert.equal(calls.length, 0);
});

test('AC-CAT-002: only passive fetchdata reads are allowed; action endpoints are refused', () => {
    assert.ok(assertPassiveGameUrl(apiEndpoints.world.fetchLocation));
    assert.ok(assertPassiveGameUrl(apiEndpoints.world.fetchWorldMap));
    for (const url of [apiEndpoints.world.attack(1), apiEndpoints.world.move(1, 2), apiEndpoints.world.travel,
        'http://www.fallensword.com/fetchdata.php?a=-1&d=1409', 'https://evil.example/fetchdata.php?a=-1&d=1409',
        'https://www.fallensword.com/fetchdata.php?a=-1&d=1683', apiEndpoints.profile?.equipItem?.(1) ?? 'https://www.fallensword.com/index.php?cmd=profile&subcmd=equipitem']) {
        assert.throws(() => assertPassiveGameUrl(url), /not an allow-listed passive read|invalid/, url);
    }
});

test('AC-CAT-002: no catalog module references a game action, a login, or cookie export', () => {
    const files = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p); } };
    walk(path.resolve('catalog'));
    const forbidden = [/\bworld\.(attack|move|travel)\b/, /\b(equipItem|useItem|removeBuff|inventItem)\b/, /\bsecurePost\b/,
        /\b(autoJoinAllGroups|checkAndSwapGear)\b/, /['"][./]*app_modules\//, /\b(ensureLogin|loadCookieBootstrap|dumpDomainCookies)\b/, /\blogin\s*\(/];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const re of forbidden) assert.doesNotMatch(src, re, `${path.relative(process.cwd(), f)} matches ${re}`);
    }
    assert.ok(files.length >= 6);
});

test('AC-CAT-002: the game queue keeps one request in flight and the minimum delay between starts', async () => {
    let t = 0;
    const sleeps = [];
    const q = createRequestQueue({ minDelayMs: GAME_POLICY.minDelayMs, now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; } });
    const starts = [];
    await Promise.all([1, 2, 3].map(n => q.run(async () => { starts.push(t); await new Promise(r => setImmediate(r)); return n; })));
    assert.deepEqual(starts, [0, 3000, 6000]);
    assert.equal(q.maxInFlight, 1);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await assert.rejects(q.run(async () => 'x', ac.signal), /stop/);
});

test('AC-CAT-003 / AC-CAT-005: a current-location read records realm, creature identities, and relations; nothing else', async () => {
    const { db, store, collector, calls } = await setup({ respond: () => json(LOCATION_BODY) });
    const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const r = await collector.runJob(await store.getJob(id));
    assert.equal(r.outcome, 'ok');
    assert.equal(r.requests, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, apiEndpoints.world.fetchLocation);
    assert.equal(calls[0].init.method, 'GET');
    const job = await store.getJob(id);
    assert.equal(job.state, 'queued', 'recurring job hands back');
    assert.deepEqual(job.cursor, { observations: 1, realmId: 1200 });
    assert.deepEqual((await db.query('SELECT id, name, imageUrl FROM creatures ORDER BY id')).map(c => ({ ...c, id: Number(c.id) })), [
        { id: 7001, name: 'Montmarr the Dragon Golem', imageUrl: 'https://cdn2.fallensword.com/creatures/7001.jpg' },
        { id: 7003, name: 'Ridge Hawk', imageUrl: null },
    ]);
    assert.equal(await count(db, 'realm_creatures'), 2);
    assert.equal((await db.query("SELECT source FROM catalog_observations WHERE entity_kind = 'creature' LIMIT 1"))[0].source, 'game_session');
    const everything = JSON.stringify(await db.query('SELECT payload FROM catalog_observations'));
    assert.ok(!everything.includes('SomeOtherPlayer'), 'fields outside the contract are never stored');
    // An identical second read changes nothing but freshness.
    const again = await collector.runJob(await store.getJob(id));
    assert.equal(again.outcome, 'ok');
    assert.equal(await count(db, 'catalog_observations'), 5);
});

test('AC-CAT-001 error case: a login page or rejected session backs the job off; the collector never logs in', async () => {
    for (const respond of [() => html('game-login.html'), () => new Response(fs.readFileSync(path.join(FIXTURES, 'game-logged-out.json')), { headers: { 'content-type': 'application/json' } })]) {
        const { db, store, collector, calls } = await setup({ respond });
        const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
        const r = await collector.runJob(await store.getJob(id));
        assert.deepEqual({ outcome: r.outcome, reason: r.reason }, { outcome: 'backoff', reason: 'session_unavailable' });
        assert.equal((await store.getJob(id)).state, 'queued');
        assert.equal((await collector.runJob(await store.getJob(id))).reason, 'backoff', 'no request until the retry time');
        assert.deepEqual((await store.getJob(id)).cursor, {});
        assert.equal(calls.length, 1, 'no login or retry request');
        assert.equal(await count(db, 'creatures'), 0);
    }
});

test('AC-CAT-001 error case: an account switch or paused engine means no request at all', async () => {
    const { store, collector, calls } = await setup({ respond: () => json(LOCATION_BODY), sessionReady: () => ({ ok: false, reason: 'account_switch' }) });
    const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const r = await collector.runJob(await store.getJob(id));
    assert.deepEqual({ outcome: r.outcome, reason: r.reason }, { outcome: 'waiting', reason: 'account_switch' });
    assert.equal(calls.length, 0);
    assert.equal((await store.getJob(id)).state, 'queued');
});

test('AC-CAT-003 error case: Cloudflare mitigation pauses; malformed or unrecognized responses record a redacted failed run', async () => {
    {
        const { store, collector } = await setup({ respond: () => html('cloudflare-challenge.html', 403, { 'cf-mitigated': 'challenge' }) });
        const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
        assert.equal((await collector.runJob(await store.getJob(id))).reason, 'challenge');
        assert.equal((await store.getJob(id)).state, 'paused');
    }
    for (const [respond, code] of [[() => new Response('{"s":true', { headers: { 'content-type': 'application/json' } }), 'malformed'], [() => json({ s: true, r: { actions: [] } }), 'realm id']]) {
        const { db, store, collector } = await setup({ respond });
        const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
        const r = await collector.runJob(await store.getJob(id));
        assert.equal(r.outcome, 'failed_run');
        assert.ok(r.retryInMs > 0);
        const [run] = await store.listRuns();
        assert.equal(run.status, 'failed');
        assert.deepEqual(run.summary.error.code, code);
        assert.ok(!JSON.stringify(run.summary).includes('fallensword'), 'no URL in the summary');
        assert.equal(await count(db, 'realms'), 0);
        assert.deepEqual((await store.getJob(id)).cursor, {});
    }
});

test('AC-CAT-004: rate limits back off without a request until the retry time', async () => {
    const { store, collector, calls, clock } = await setup({ respond: (url, n) => (n === 1 ? new Response('', { status: 429 }) : json(LOCATION_BODY)) });
    const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const first = await collector.runJob(await store.getJob(id));
    assert.deepEqual({ outcome: first.outcome, reason: first.reason, retryInMs: first.retryInMs }, { outcome: 'backoff', reason: 'rate_limited', retryInMs: GAME_POLICY.backoffMs[0] });
    assert.equal((await collector.runJob(await store.getJob(id))).reason, 'backoff');
    assert.equal(calls.length, 1);
    clock.t += GAME_POLICY.backoffMs[0];
    assert.equal((await collector.runJob(await store.getJob(id))).outcome, 'ok');
    assert.deepEqual((await store.getJob(id)).cursor, { observations: 1, realmId: 1200 });
});

test('AC-CAT-004: the item frontier checkpoints validated reads, counts negatives separately, and keeps an overlap', async () => {
    const present = new Set([1, 2, 4]);
    const { db, store, collector } = await setup({
        respond: url => {
            const itemId = Number(new URL(url).searchParams.get('id'));
            return json({ s: true, r: present.has(itemId) ? { id: itemId, name: `Item ${itemId}` } : null });
        },
    });
    const id = await store.createJob({ kind: 'item_frontier', cursor: { nextItemId: 1 }, requestBudget: 50 });
    const r = await collector.runJob(await store.getJob(id));
    assert.equal(r.found, 3);
    assert.equal(r.notFound, FRONTIER_END_MISSES + 1);
    assert.equal(await count(db, 'items'), 3);
    assert.deepEqual((await store.getJob(id)).cursor, { nextItemId: Math.max(1, 4 - FRONTIER_OVERLAP + 1), highestConfirmedItemId: 4, misses: 0 });
});

test('AC-CAT-004 error case: a failure mid-scan stores what was validated and never moves past the failed ID', async () => {
    const { db, store, collector } = await setup({
        respond: url => {
            const itemId = Number(new URL(url).searchParams.get('id'));
            return itemId === 12 ? new Response('', { status: 503 }) : json({ s: true, r: { id: itemId, name: `Item ${itemId}` } });
        },
    });
    const id = await store.createJob({ kind: 'item_frontier', cursor: { nextItemId: 10 }, requestBudget: 50 });
    const r = await collector.runJob(await store.getJob(id));
    assert.deepEqual({ outcome: r.outcome, reason: r.reason, found: r.found, requests: r.requests }, { outcome: 'backoff', reason: 'server_error', found: 2, requests: 3 });
    assert.deepEqual((await store.getJob(id)).cursor, { nextItemId: 12, highestConfirmedItemId: 11, misses: 0 });
    assert.equal(await count(db, 'items'), 2);
});

test('AC-CAT-002: an aborted execution hands the job back without moving its cursor', async () => {
    const ac = new AbortController();
    const { store, collector } = await setup({ respond: async () => { ac.abort(new Error('engine stop')); return json(LOCATION_BODY); } });
    const id = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const r = await collector.runJob(await store.getJob(id), { signal: ac.signal });
    assert.equal(r.outcome, 'aborted');
    const job = await store.getJob(id);
    assert.equal(job.state, 'queued');
    assert.deepEqual(job.cursor, {});
});

test('AC-CAT-008: an owner pause during an execution wins over the collector hand-back', async () => {
    let store;
    let jobId;
    const ctx = await setup({ respond: async () => { await store.transitionJob(jobId, 'paused'); return json(LOCATION_BODY); } });
    store = ctx.store;
    jobId = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });
    const r = await ctx.collector.runJob(await store.getJob(jobId));
    assert.deepEqual({ outcome: r.outcome, reason: r.reason }, { outcome: 'interrupted', reason: 'job_state_changed' });
    const job = await store.getJob(jobId);
    assert.equal(job.state, 'paused');
    assert.deepEqual(job.cursor, {}, 'the cursor did not move');
});
