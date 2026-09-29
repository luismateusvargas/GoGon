// tests/catalog-sync/guide-relay.test.mjs - CAT-TASK-010 / AC-CAT-011..AC-CAT-015
// The browser relay client (catalog/relayClient.js, as inlined into the userscript) against the
// server relay (catalog/guideRelay.js) and a simulated guide site. No network: the site is a
// function from URL to HTML, parsed with linkedom. The clock is controlled.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOMParser } from 'linkedom';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createCatalogStore, CatalogError } from '../../_gg_data/handler/catalogStore.js';
import { createGuideDiscoveryStore } from '../../_gg_data/handler/guideDiscoveryStore.js';
import { createGuideRelay, hashToken, TOKEN_PREFIX } from '../../catalog/guideRelay.js';
import { runLease } from '../../catalog/relayClient.js';
import { GUIDE_POLICY } from '../../catalog/contracts/policy.js';
import { buildRelayUserscript, OUTPUT } from '../../scripts/catalog/build-relay-userscript.mjs';

after(() => closeClients());
const PER_PAGE = 3;
const CHALLENGE = fs.readFileSync('tests/catalog-sync/fixtures/cloudflare-challenge.html', 'utf8');

/** A guide with newest-first indexes of PER_PAGE entries and detail pages built from `db` records. */
function createSite() {
    const site = {
        ids: { item: [17050, 17049, 17048, 17047, 17046, 17045, 17044], creature: [7002, 7001], realm: [1200], master_realm: [5] },
        challengeAt: null,                    // { kind, page } to answer with a Cloudflare challenge
        ascending: false,                     // serve an ascending (order-violating) index
        emptyPage: null,                      // { kind, page } to answer with an empty page
        itemName: id => `Item ${id}`,
        requests: [],
    };
    const cmd = { item: 'items', creature: 'creatures', realm: 'realms', master_realm: 'masterrealms' };
    const param = { item: 'item_id', creature: 'creature_id', realm: 'realm_id', master_realm: 'masterrealm_id' };
    const nav = '<div><a href="index.php?cmd=items">Items</a></div>';
    const page = body => `<html><body>${nav}<table>${body}</table></body></html>`;
    const details = {
        item: id => page(`<tr><td class="tHeader" colspan="10"><b>${site.itemName(id)}</b> (Rare)</td></tr>
            <tr><td class="tHeader" colspan="10"><b>Statistics</b></td></tr><tr><td>Level:</td><td>10</td></tr>
            <tr><td class="tHeader" colspan="10"><b>Dropped By</b></td></tr><tr><td>Creature ${id === 17048 ? 7001 : 7002} (Beast):</td><td>1%</td></tr>`),
        creature: id => page(`<tr><td class="tHeader" colspan="10"><b>Creature ${id}</b></td></tr>
            <tr><td>Level:</td><td>5</td></tr>
            <tr><td><a href="index.php?cmd=items&subcmd=view&item_id=${id === 7001 ? 17048 : 17049}">drop</a></td></tr>
            <tr><td><a href="index.php?cmd=realms&subcmd=view&realm_id=1200">Mountain Path</a></td></tr>`),
        realm: id => page(`<tr><td class="tHeader" colspan="10"><b>Mountain Path (Min Level: 1)</b></td></tr>
            <tr><td><a href="index.php?cmd=relics&subcmd=view&relic_id=8">Stone of Echoes</a></td></tr>
            <tr><td><a href="index.php?cmd=creatures&subcmd=view&creature_id=7001">Creature 7001</a></td></tr>`),
        master_realm: id => page(`<tr><td class="tHeader" colspan="10"><b>Elya Desert (Min Level: 5)</b></td></tr>
            <tr><td><a href="index.php?cmd=realms&subcmd=view&realm_id=1200">Mountain Path</a></td><td>1</td></tr>`),
    };
    site.fetchPage = async url => {
        site.requests.push(url);
        const u = new URL(url);
        const kind = Object.keys(cmd).find(k => cmd[k] === u.searchParams.get('cmd'));
        const html = body => ({ status: 200, contentType: 'text/html', cfMitigated: null, body });
        if (u.searchParams.get('subcmd') === 'view') {
            const id = Number(u.searchParams.get(param[kind]));
            return site.ids[kind].includes(id) ? html(details[kind](id)) : { status: 404, contentType: 'text/html', cfMitigated: null, body: page('') };
        }
        const p = Number(u.searchParams.get('index'));
        if (site.challengeAt && site.challengeAt.kind === kind && site.challengeAt.page === p) return { status: 403, contentType: 'text/html', cfMitigated: 'challenge', body: CHALLENGE };
        if (site.emptyPage && site.emptyPage.kind === kind && site.emptyPage.page === p) return html(page(''));
        let ids = site.ids[kind].slice(p * PER_PAGE, (p + 1) * PER_PAGE);
        if (site.ascending) ids = [...ids].reverse();
        return html(page(ids.map(id => `<tr><td><a href="index.php?cmd=${cmd[kind]}&subcmd=view&${param[kind]}=${id}">${kind === 'item' ? site.itemName(id) : `Name ${id}`}</a></td></tr>`).join('')));
    };
    return site;
}

async function setup() {
    const log = console.log;
    console.log = () => {};
    const db = await freshClient();
    console.log = log;
    const clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const now = () => clock.t;
    const store = createCatalogStore(db, { now, invalidateCaches: () => {} });
    const guideStore = createGuideDiscoveryStore(db, { now });
    const relay = createGuideRelay({ db, store, guideStore, now });
    const { id: tokenId, token } = await relay.issueToken({ label: 'test browser', ttlDays: 7 });
    const site = createSite();
    const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
    /** One relay cycle: lease, read, submit. Returns the lease status and the submit summary. */
    async function cycle() {
        const next = await relay.nextLease(tokenId);
        if (next.status !== 'lease') return next;
        const results = await runLease(next.lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {} });
        return { status: 'lease', lease: next.lease, results, summary: await relay.submit(tokenId, next.lease.leaseId, { results }) };
    }
    async function drain(max = 50) {
        const out = [];
        for (let i = 0; i < max; i++) { const c = await cycle(); out.push(c); if (c.status !== 'lease' || c.results.at(-1)?.outcome === 'challenge') break; }
        return out;
    }
    return { db, store, guideStore, relay, tokenId, token, site, clock, cycle, drain };
}
const state = async (g, kind) => g.getState(kind);
const count = async (db, table) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
const enableJob = store => store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 50 });

test('AC-CAT-014: without an owner-enabled guide job there is no work; a paused job gives none either', async () => {
    const { relay, tokenId, store } = await setup();
    assert.deepEqual(await relay.nextLease(tokenId), { status: 'disabled' });
    const job = await enableJob(store);
    await store.transitionJob(job, 'paused');
    assert.deepEqual(await relay.nextLease(tokenId), { status: 'paused' });
});

test('AC-CAT-011 / AC-CAT-013: the first daily check sweeps every index, stages minimal records, then reads details', async () => {
    const { db, store, guideStore, site, drain } = await setup();
    await enableJob(store);
    const cycles = await drain();
    assert.equal(cycles.at(-1).status, 'idle');
    for (const [kind, top, lastPage] of [['item', 17050, 2], ['creature', 7002, 0], ['realm', 1200, 0], ['master_realm', 5, 0]]) {
        const s = await state(guideStore, kind);
        assert.equal(s.lastSeenId, top, kind);
        assert.ok(s.lastSuccessfulCheckAt, kind);
        assert.ok(s.lastFullSweepAt, `${kind}: the first check is a full sweep`);
        assert.equal(s.lastPageSeen, lastPage, kind);
        assert.equal(s.orderState, 'verified', kind);
        assert.equal(s.status, 'idle', kind);
    }
    assert.equal(await count(db, 'items'), 7);
    assert.deepEqual((await db.query('SELECT name FROM items WHERE id = 17048'))[0], { name: 'Item 17048' });
    assert.equal((await db.query("SELECT completeness FROM catalog_entities WHERE entity_kind = 'creature' AND entity_key = '7001'"))[0].completeness, 'complete');
    assert.equal((await db.query("SELECT completeness FROM catalog_entities WHERE entity_kind = 'item' AND entity_key = '17048'"))[0].completeness, 'complete');
    const incomplete = await db.query("SELECT entity_key, incomplete_reason FROM catalog_entities WHERE entity_kind = 'item' AND completeness = 'incomplete' ORDER BY entity_key");
    assert.ok(incomplete.every(r => r.incomplete_reason === 'known_drop_unresolved'), 'only unresolvable drop names remain');
    assert.equal(await count(db, 'realm_creatures'), 2, 'both creatures link realm 1200');
    assert.equal(await count(db, 'creature_drops'), 2);
    assert.deepEqual((await db.query('SELECT name FROM relics')).map(r => r.name), ['Stone of Echoes']);
    assert.equal(await guideStore.usage(), site.requests.length, 'every guide request is counted against the daily cap');
    assert.ok(site.requests.every(u => u.startsWith('https://guide.fallensword.com/index.php?cmd=')), 'only code-owned guide URLs');
    assert.equal((await db.query("SELECT DISTINCT mode FROM catalog_runs WHERE mode <> 'baseline_snapshot'")).map(r => r.mode).join(), 'guide_discovery');
});

test('AC-CAT-012: the next day an incremental sweep stops one overlap page past last_seen_id and finds new IDs', async () => {
    const { db, store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    site.ids.item.unshift(17052, 17051);
    site.requests.length = 0;
    clock.t += GUIDE_POLICY.checkIntervalMs;
    await drain();
    const itemIndexReads = site.requests.filter(u => /cmd=items&index=/.test(u));
    assert.deepEqual(itemIndexReads.map(u => Number(new URL(u).searchParams.get('index'))), [0, 1], 'page 0 reaches last_seen_id, page 1 is the overlap');
    const s = await state(guideStore, 'item');
    assert.equal(s.lastSeenId, 17052);
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17052'))[0].name, 'Item 17052');
    assert.equal((await guideStore.getIdState('item', 17052)).status, 'ok', 'its detail was read in the same check');
});

test('AC-CAT-012 error case: an edited older record is re-read when due and staged as a new observation', async () => {
    const { db, store, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    const runs = await count(db, 'catalog_runs');
    clock.t += GUIDE_POLICY.detailRefreshAfterMs;
    await drain();
    const unchangedRuns = await count(db, 'catalog_runs');
    site.itemName = id => (id === 17044 ? 'Item 17044 (renamed)' : `Item ${id}`);
    clock.t += GUIDE_POLICY.detailRefreshAfterMs;
    await drain();
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17044'))[0].name, 'Item 17044 (renamed)');
    assert.ok(unchangedRuns - runs <= 2, 'an unchanged refresh stages little or nothing');
});

test('AC-CAT-011 error case: a Cloudflare challenge pauses the sweep at that page; the checkpoint is kept and resumes', async () => {
    const { store, guideStore, site, drain, cycle } = await setup();
    await enableJob(store);
    site.challengeAt = { kind: 'item', page: 1 };
    const cycles = await drain();
    assert.equal(cycles.at(-1).results.at(-1).outcome, 'challenge');
    let s = await state(guideStore, 'item');
    assert.deepEqual([s.status, s.statusReason, s.nextPage, s.lastSuccessfulCheckAt, s.lastSeenId], ['challenged', 'cloudflare challenge', 1, null, 0]);
    site.challengeAt = null;   // the owner completed the check in the browser
    await cycle();
    s = await state(guideStore, 'item');
    assert.equal(s.status, 'idle');
    assert.equal(s.lastSeenId, 17050);
    assert.ok(s.lastSuccessfulCheckAt);
});

test('AC-CAT-015 error case: an unexpected empty page leaves the check partial; no success is claimed', async () => {
    const { store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    const before = await state(guideStore, 'item');
    clock.t += GUIDE_POLICY.fullSweepIntervalMs;
    site.emptyPage = { kind: 'item', page: 1 };
    await drain();
    const s = await state(guideStore, 'item');
    assert.deepEqual([s.status, s.statusReason], ['partial', 'unexpected empty page']);
    assert.equal(s.lastSuccessfulCheckAt, before.lastSuccessfulCheckAt);
    assert.equal(s.sweepMode, 'full');
});

test('AC-CAT-012: IDs that do not descend mark the order violated and force a full sweep', async () => {
    const { store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    site.ascending = true;
    site.requests.length = 0;
    clock.t += GUIDE_POLICY.checkIntervalMs;
    await drain();
    const s = await state(guideStore, 'item');
    assert.equal(s.orderState, 'violated');
    assert.equal(s.lastFullSweepAt, s.lastSuccessfulCheckAt, 'the check became a full sweep');
    assert.equal(site.requests.filter(u => /cmd=items&index=/.test(u)).length, 4, 'every item page plus the empty end page');
});

test('AC-CAT-015: leases respect the per-run budget and the daily cap', async () => {
    const { store, guideStore, relay, tokenId } = await setup();
    const job = await store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 2 });
    const a = await relay.nextLease(tokenId);
    assert.equal(a.lease.work.length, 2);
    assert.equal(a.lease.minDelayMs, GUIDE_POLICY.minDelayMs);
    assert.deepEqual(await relay.nextLease(tokenId), a, 'the open lease is handed out again, never a second one');
    await relay.submit(tokenId, a.lease.leaseId, { results: [] });
    await guideStore.addUsage(GUIDE_POLICY.dailyRequestCap);
    assert.deepEqual(await relay.nextLease(tokenId), { status: 'cap_reached' });
    assert.ok(job);
});

test('AC-CAT-014 error case: submissions that do not match their lease, carry extra fields, or come late write nothing', async () => {
    const { db, store, relay, tokenId, clock } = await setup();
    await enableJob(store);
    const { lease } = await relay.nextLease(tokenId);
    const page = lease.work[0].page;
    const bad = [
        { results: [{ type: 'index', page: page + 5, outcome: 'ok', entries: [{ id: 1 }] }] },
        { results: [{ type: 'index', page, outcome: 'ok', entries: [{ id: 1 }], html: '<html>' }] },
        { results: [{ type: 'index', page, outcome: 'ok', entries: [{ id: 1, name: 'x', url: 'https://evil.example' }] }] },
        { results: [{ type: 'index', page, outcome: 'ok', entries: [{ id: -3 }] }] },
        { results: [{ type: 'detail', id: 1, outcome: 'ok', record: {} }] },
        { results: [], cookie: 'cf_clearance=x' },
        [],
    ];
    for (const body of bad) await assert.rejects(relay.submit(tokenId, lease.leaseId, body), e => e instanceof CatalogError && e.code === 'invalid');
    await assert.rejects(relay.submit('someone-else', lease.leaseId, { results: [] }), e => e.code === 'not_found');
    assert.equal(await count(db, 'catalog_runs'), 0);
    assert.equal(await count(db, 'catalog_guide_ids'), 0);
    clock.t += GUIDE_POLICY.leaseTtlMs;
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results: [] }), e => e.code === 'conflict');
    const again = await relay.nextLease(tokenId);
    assert.notEqual(again.lease.leaseId, lease.leaseId, 'an expired lease is replaced');
    await relay.submit(tokenId, again.lease.leaseId, { results: [] });
    await assert.rejects(relay.submit(tokenId, again.lease.leaseId, { results: [] }), e => e.code === 'conflict', 'one submission per lease');
});

test('AC-CAT-014: tokens are stage-only, stored hashed, expire within seven days, and can be revoked', async () => {
    const { db, relay, token, tokenId, clock } = await setup();
    assert.ok(token.startsWith(TOKEN_PREFIX));
    const stored = await db.query('SELECT * FROM catalog_relay_tokens');
    assert.ok(!JSON.stringify(stored).includes(token), 'the token itself is never stored');
    assert.equal(stored[0].token_hash, hashToken(token));
    assert.deepEqual(await relay.authenticate(token), { id: tokenId });
    for (const bad of ['', 'Bearer', `${token}x`, 'ggr_short', token.toUpperCase()]) assert.equal(await relay.authenticate(bad), null);
    await assert.rejects(relay.issueToken({ label: 'too long', ttlDays: 8 }), e => e.code === 'invalid');
    await assert.rejects(relay.issueToken({ label: '<script>', ttlDays: 1 }), e => e.code === 'invalid');
    await relay.issueToken({ label: 'b', ttlDays: 1 });
    await relay.issueToken({ label: 'c', ttlDays: 1 });
    await assert.rejects(relay.issueToken({ label: 'd', ttlDays: 1 }), e => e.code === 'conflict', 'at most three active');
    await relay.revokeToken(tokenId);
    assert.equal(await relay.authenticate(token), null);
    const later = await relay.issueToken({ label: 'e', ttlDays: 1 });
    clock.t += 24 * 3600_000;
    assert.equal(await relay.authenticate(later.token), null, 'expired');
    assert.ok((await relay.listTokens()).every(t => !('token' in t) && !('token_hash' in t)));
});

test('CAT-TASK-010: the committed userscript is current, scoped to the guide and 127.0.0.1, and keeps the token out of the page', () => {
    const committed = fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(committed, buildRelayUserscript(), 'run node scripts/catalog/build-relay-userscript.mjs');
    const header = committed.slice(0, committed.indexOf('// ==/UserScript=='));
    const values = tag => [...header.matchAll(new RegExp(`@${tag}\\s+(\\S+)`, 'g'))].map(m => m[1]);
    assert.deepEqual(values('grant'), ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand']);
    assert.deepEqual(values('connect'), ['127.0.0.1']);
    assert.deepEqual(values('match'), ['https://guide.fallensword.com/*']);
    for (const forbidden of [/unsafeWindow/, /@grant\s+none/, /\.innerHTML/, /\bprompt\(/, /localStorage/, /document\.cookie/, /postMessage/]) assert.doesNotMatch(committed, forbidden);
    assert.match(committed, /Authorization: 'Bearer ' \+ token/);
});
