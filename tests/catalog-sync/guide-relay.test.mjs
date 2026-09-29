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
import { createGuideRelay, hashToken, TOKEN_PREFIX, MAX_RELAY_BODY, SERVER_WORKER_ID } from '../../catalog/guideRelay.js';
import { createCatalogService } from '../../catalog/catalogService.js';
import { runLease, relayCycle } from '../../catalog/relayClient.js';
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
        repeatFinalPage: true,                // the live guide repeats its final page past the end
        changedLayout: null,                  // { kind, id } whose detail page is a guide page in a layout the parser does not know
        itemName: id => `Item ${id}`,
        requests: [],
        perPage: PER_PAGE,                    // index entries per page
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
            if (site.changedLayout && site.changedLayout.kind === kind && site.changedLayout.id === id) return html(page('<tr><td>A redesigned record page</td></tr>'));
            return site.ids[kind].includes(id) ? html(details[kind](id)) : { status: 404, contentType: 'text/html', cfMitigated: null, body: page('') };
        }
        const p = Number(u.searchParams.get('index'));
        if (site.challengeAt && site.challengeAt.kind === kind && site.challengeAt.page === p) return { status: 403, contentType: 'text/html', cfMitigated: 'challenge', body: CHALLENGE };
        if (site.emptyPage && site.emptyPage.kind === kind && site.emptyPage.page === p) return html(page(''));
        let ids = site.ids[kind].slice(p * site.perPage, (p + 1) * site.perPage);
        if (site.repeatFinalPage && ids.length === 0 && p > 0 && site.ids[kind].length) {
            const finalPage = Math.ceil(site.ids[kind].length / site.perPage) - 1;
            ids = site.ids[kind].slice(finalPage * site.perPage);
        }
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
        const results = await runLease(next.lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {}, now });
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

test('existing snapshot items and creatures enter guide coverage without an immediate detail backlog', async () => {
    const { db, relay, guideStore, clock } = await setup();
    await db.query('INSERT INTO items (id, name) VALUES (?, ?)', [17049, 'Snapshot item']);
    await db.query('INSERT INTO creatures (id, name) VALUES (?, ?)', [7001, 'Snapshot creature']);
    await db.query('INSERT INTO realms (id, name) VALUES (?, ?)', [1200, 'Snapshot realm']);

    await relay.scheduleSeededDetails();
    await relay.scheduleSeededDetails();
    const tracked = await db.query('SELECT entity_kind, entity_id, detail_status, next_detail_at FROM catalog_guide_ids ORDER BY entity_kind');
    assert.deepEqual(tracked.map(row => row.entity_kind), ['creature', 'item']);
    assert.ok(tracked.every(row => row.detail_status === 'pending' && Date.parse(row.next_detail_at) > clock.t));
    assert.equal((await guideStore.getIdState('realm', 1200)), null);

    await guideStore.markDetail('item', 17049, { outcome: 'ok', hash: 'a'.repeat(64) }, GUIDE_POLICY);
    await relay.scheduleSeededDetails();
    assert.equal((await guideStore.getIdState('item', 17049)).status, 'ok');

    await guideStore.recordIndexIds('item', [17050, 17049]);
    assert.ok(Date.parse((await guideStore.getIdState('item', 17050)).nextDetailAt) <= clock.t);
    assert.ok(Date.parse((await guideStore.getIdState('item', 17049)).nextDetailAt) > clock.t);
});

test('server guide worker has a stable lease identity without an external bearer token', async () => {
    const { db, relay, store } = await setup();
    assert.equal(await relay.ensureServerWorker(), SERVER_WORKER_ID);
    assert.equal(await relay.ensureServerWorker(), SERVER_WORKER_ID);
    const rows = await db.query('SELECT id, token_hash FROM catalog_relay_tokens WHERE id = ?', [SERVER_WORKER_ID]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash.length, 64);
    assert.ok((await relay.listTokens()).every(token => token.id !== SERVER_WORKER_ID));
    await assert.rejects(relay.revokeToken(SERVER_WORKER_ID), error => error.code === 'invalid');
    await enableJob(store);
    const issued = await relay.nextLease(SERVER_WORKER_ID);
    assert.equal(issued.status, 'lease');
    await relay.submit(SERVER_WORKER_ID, issued.lease.leaseId, { results: [], requests: 0 });
});

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
        assert.equal(s.orderState, 'attested', kind);
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
    const masterRealm = await createCatalogService({ db, store, guideStore }).getEntity('master_realm', '5');
    assert.deepEqual(masterRealm.fields.connected_realms, [{ realmId: 1200, realmName: 'Mountain Path', minLevel: 1 }]);
    assert.deepEqual(masterRealm.relations.connectedRealms, [{ id: 1200, name: 'Mountain Path', minLevel: 1 }]);
    assert.equal(await guideStore.usage(), site.requests.length, 'every guide request is counted');
    assert.ok(site.requests.every(u => u.startsWith('https://guide.fallensword.com/index.php?cmd=')), 'only code-owned guide URLs');
    assert.equal((await db.query("SELECT DISTINCT mode FROM catalog_runs WHERE mode <> 'baseline_snapshot'")).map(r => r.mode).join(), 'guide_discovery');
});

test('a repeated final index page completes a sweep without reading the rest of its lease', async () => {
    const { store, guideStore, site, cycle } = await setup();
    await enableJob(store);
    site.repeatFinalPage = true;
    const first = await cycle();
    assert.deepEqual(first.results.map(result => result.page), [0, 1]);
    assert.equal(first.summary.sweepComplete, true);
    const masterRealm = await state(guideStore, 'master_realm');
    assert.equal(masterRealm.status, 'idle');
    assert.equal(masterRealm.lastPageSeen, 0);
    assert.equal(masterRealm.sweepPrevPageIds, null);
    assert.equal(site.requests.filter(url => /cmd=masterrealms&index=/.test(url)).length, 2);
});

test('a repeated final index page is recognized across two one-page leases', async () => {
    const { store, guideStore, site, cycle } = await setup();
    await store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 1 });
    site.repeatFinalPage = true;
    site.perPage = 1;
    site.ids.master_realm = [4, 5];
    await cycle();
    await cycle();
    const terminal = await cycle();
    assert.deepEqual(terminal.lease.previousPageIds, [5]);
    assert.deepEqual(terminal.results.map(result => result.page), [2]);
    assert.equal(terminal.summary.sweepComplete, true);
    const masterRealm = await state(guideStore, 'master_realm');
    assert.equal(masterRealm.lastPageSeen, 1);
    assert.equal(masterRealm.lastSeenId, 5);
    assert.equal(masterRealm.status, 'idle');
    assert.deepEqual(site.requests.filter(url => /cmd=masterrealms&index=/.test(url))
        .map(url => Number(new URL(url).searchParams.get('index'))), [0, 1, 2]);
});

test('an existing sweep with no saved page IDs stops after two repeated pages', async () => {
    const { store, guideStore, site, cycle } = await setup();
    await enableJob(store);
    site.repeatFinalPage = true;
    await guideStore.updateState('master_realm', {
        sweepMode: 'full', nextPage: 100, sweepPagesChecked: 100,
        sweepMaxId: 5, sweepPrevMinId: 5, sweepPrevPageIds: null,
        orderState: 'violated', status: 'running',
    });

    const resumed = await cycle();
    assert.deepEqual(resumed.results.map(result => result.page), [100, 101]);
    assert.equal(resumed.summary.sweepComplete, true);
    const masterRealm = await state(guideStore, 'master_realm');
    assert.equal(masterRealm.status, 'idle');
    assert.equal(masterRealm.lastPageSeen, 100);
    assert.equal(masterRealm.orderState, 'attested');
    assert.equal(site.requests.filter(url => /cmd=masterrealms&index=/.test(url)).length, 2);
});

test('a later full sweep clears an obsolete ordering violation', async () => {
    const { store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    site.repeatFinalPage = true;
    await drain();
    await guideStore.updateState('master_realm', { orderState: 'violated' });
    clock.t += GUIDE_POLICY.checkIntervalMs;

    await drain();
    const masterRealm = await state(guideStore, 'master_realm');
    assert.equal(masterRealm.orderState, 'attested');
    assert.equal(masterRealm.lastPageSeen, 0);
});

test('CAT-TASK-013 / AC-CAT-012: level-sorted items discover a new low-level ID on a later page', async () => {
    const { db, store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    site.ids.item.push(17052, 17051);
    site.requests.length = 0;
    clock.t += GUIDE_POLICY.checkIntervalMs;
    await drain();
    const itemIndexReads = site.requests.filter(u => /cmd=items&index=/.test(u));
    assert.deepEqual(itemIndexReads.map(u => Number(new URL(u).searchParams.get('index'))), [0, 1, 2, 3], 'all level-sorted index pages must be covered');
    const s = await state(guideStore, 'item');
    assert.equal(s.lastSeenId, 17052);
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17052'))[0].name, 'Item 17052');
    assert.equal((await guideStore.getIdState('item', 17052)).status, 'ok', 'its detail was read in the same check');
});

test('CAT-TASK-013 / AC-CAT-012: a daily scan finds low-level creature and realm IDs without rereading known details', async () => {
    const { store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    site.perPage = 1;
    site.ids.creature.splice(1, 0, 7003);
    site.ids.realm.unshift(1201);
    site.requests.length = 0;
    clock.t += GUIDE_POLICY.checkIntervalMs;

    await drain();
    const indexPages = kind => site.requests.filter(url => url.includes(`cmd=${kind}&index=`))
        .map(url => Number(new URL(url).searchParams.get('index')));
    assert.deepEqual(indexPages('creatures'), [0, 1, 2, 3]);
    assert.deepEqual(indexPages('realms'), [0, 1, 2]);
    assert.equal((await guideStore.getIdState('creature', 7003)).status, 'ok');
    assert.equal((await guideStore.getIdState('realm', 1201)).status, 'ok');
    assert.equal(site.requests.filter(url => /subcmd=view&creature_id=7001|subcmd=view&realm_id=1200/.test(url)).length, 0);
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
    clock.t += GUIDE_POLICY.checkIntervalMs;
    site.emptyPage = { kind: 'item', page: 1 };
    await drain();
    const s = await state(guideStore, 'item');
    assert.deepEqual([s.status, s.statusReason], ['partial', 'unexpected empty page']);
    assert.equal(s.lastSuccessfulCheckAt, before.lastSuccessfulCheckAt);
    assert.equal(s.sweepMode, 'full');
    // No tight retry loop: the stopped page is not asked for again until the retry interval passes.
    const pageOneReads = () => site.requests.filter(u => /cmd=items&index=1$/.test(u)).length;
    const readsSoFar = pageOneReads();
    await drain();
    assert.equal(pageOneReads(), readsSoFar);
    site.emptyPage = null;
    clock.t += GUIDE_POLICY.partialRetryMs;
    await drain();
    assert.equal((await state(guideStore, 'item')).status, 'idle', 'the retry completes the sweep');
});

test('CAT-TASK-013 / AC-CAT-012: level-sorted item IDs are not claimed to have verified ID order', async () => {
    const { store, guideStore, site, drain, clock } = await setup();
    await enableJob(store);
    await drain();
    site.ascending = true;
    site.requests.length = 0;
    clock.t += GUIDE_POLICY.checkIntervalMs;
    await drain();
    const s = await state(guideStore, 'item');
    assert.equal(s.orderState, 'attested');
    assert.equal(s.lastFullSweepAt, s.lastSuccessfulCheckAt, 'the check became a full sweep');
    assert.equal(site.requests.filter(u => /cmd=items&index=/.test(u)).length, 4, 'every item page plus the repeated final page');
});

test('CAT-TASK-013 / AC-CAT-015: daily usage above 2000 does not stop bounded leases', async () => {
    const { store, guideStore, relay, tokenId } = await setup();
    const job = await store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 2 });
    const a = await relay.nextLease(tokenId);
    assert.equal(a.lease.work.length, 2);
    assert.equal(a.lease.minDelayMs, GUIDE_POLICY.minDelayMs);
    assert.deepEqual(await relay.nextLease(tokenId), a, 'the open lease is handed out again, never a second one');
    await relay.submit(tokenId, a.lease.leaseId, { results: [] });
    await guideStore.addUsage(200_000);
    const next = await relay.nextLease(tokenId);
    assert.equal(next.status, 'lease');
    assert.equal(next.lease.work.length, 2);
    assert.ok(await guideStore.usage() > 200_000);
    assert.ok(job);
});

test('AC-CAT-011 error case: a detail page in an unknown layout is invalid and retried, not missing; only a 404 is missing', async () => {
    const { store, guideStore, relay, tokenId, site, drain } = await setup();
    await enableJob(store);
    await guideStore.registerIds('item', [99999]);   // no such record: the guide answers 404
    site.changedLayout = { kind: 'item', id: 17048 };
    const cycles = await drain();
    const stopped = cycles.find(c => c.results?.some(r => r.id === 17048));
    assert.deepEqual(stopped.results.at(-1), { type: 'detail', id: 17048, outcome: 'invalid' }, 'the lease stops at the page it cannot read');
    const s = await guideStore.getIdState('item', 17048);
    assert.deepEqual([s.status, s.attempts], ['pending', 1], 'failed with backoff, not a confirmed absence');
    assert.equal((await guideStore.getIdState('item', 99999)).status, 'missing');
    assert.equal((await guideStore.coverage()).item.missing, 1);
    assert.equal((await guideStore.getIdState('item', 17049)).status, 'ok', 'the rest of the kind is read on the next lease');

    // A submission cannot carry results past a stopping one.
    await guideStore.registerIds('creature', [7003, 7004]);
    const { lease } = await relay.nextLease(tokenId);
    assert.deepEqual(lease.work, [{ type: 'detail', id: 7003 }, { type: 'detail', id: 7004 }]);
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results: [{ type: 'detail', id: 7003, outcome: 'invalid' }, { type: 'detail', id: 7004, outcome: 'missing' }] }),
        e => e instanceof CatalogError && e.code === 'invalid');
});

test('AC-CAT-014 / AC-CAT-015: concurrent relays get one lease, a lease is applied once, and requests are reserved against the cap', async () => {
    const { db, store, guideStore, relay, tokenId, site, clock } = await setup();
    await enableJob(store);
    const { id: otherId } = await relay.issueToken({ label: 'second browser', ttlDays: 1 });
    const [a, b] = await Promise.all([relay.nextLease(tokenId), relay.nextLease(otherId)]);
    assert.deepEqual([a.status, b.status].sort(), ['busy', 'lease']);
    assert.equal(await count(db, 'catalog_guide_leases'), 1);
    const [owner, next] = a.status === 'lease' ? [tokenId, a] : [otherId, b];
    const [c, d] = await Promise.all([relay.nextLease(owner), relay.nextLease(owner)]);
    assert.equal(c.lease.leaseId, next.lease.leaseId);
    assert.equal(d.lease.leaseId, next.lease.leaseId);
    // Issued once and handed back twice: a relay that asks again may read again, so each hand-back is reserved too.
    assert.equal(await guideStore.usage(), 3 * next.lease.work.length, 'the whole lease is reserved when issued and when handed back');

    const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
    const results = await runLease(next.lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {}, now: () => clock.t });
    // A failed apply releases the claim, so the same lease can be submitted again.
    const ingest = store.ingest;
    store.ingest = async () => { throw new Error('database went away'); };
    await assert.rejects(relay.submit(owner, next.lease.leaseId, { results }), /database went away/);
    store.ingest = ingest;
    const both = await Promise.allSettled([relay.submit(owner, next.lease.leaseId, { results }), relay.submit(owner, next.lease.leaseId, { results })]);
    assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(both.find(r => r.status === 'rejected').reason.code, 'conflict');
    assert.equal(await count(db, "catalog_runs WHERE mode = 'guide_discovery'"), 1, 'staged once');
    assert.equal(await guideStore.usage(), 2 * next.lease.work.length + results.length, 'unused requests of the read that was sent are given back once');

    // An unanswered lease keeps its reservation after it expires: its requests may have been made.
    const used = await guideStore.usage();
    const open = await relay.nextLease(owner);
    clock.t += GUIDE_POLICY.leaseTtlMs;
    const replaced = await relay.nextLease(owner);
    assert.notEqual(replaced.lease.leaseId, open.lease.leaseId);
    assert.equal(await guideStore.usage(), used + open.lease.work.length + replaced.lease.work.length);
});

test('AC-CAT-014 error case: a submission retried after a failure past staging reuses the lease\'s run', async () => {
    const { db, store, guideStore, relay, tokenId, site, clock } = await setup();
    await enableJob(store);
    const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
    const read = lease => runLease(lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {}, now: () => clock.t });
    const guideRuns = async () => db.query("SELECT id, status FROM catalog_runs WHERE mode = 'guide_discovery'");

    // The run is recorded and projected, then the checkpoint transaction fails.
    let { lease } = await relay.nextLease(tokenId);
    let results = await read(lease);
    const refund = guideStore.refundUsage;
    guideStore.refundUsage = async () => { throw new Error('checkpoint failed'); };
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results }), /checkpoint failed/);
    guideStore.refundUsage = refund;
    const [staged] = await guideRuns();
    assert.equal(staged.status, 'succeeded');
    assert.equal((await state(guideStore, lease.kind)).nextPage, 0, 'the checkpoint did not move');
    const retried = await relay.submit(tokenId, lease.leaseId, { results });
    assert.equal(retried.runId, staged.id);
    assert.equal((await guideRuns()).length, 1, 'the retry did not stage the lease again');
    assert.ok(retried.sweepComplete);

    // The run is recorded, then the process stops before projecting it.
    ({ lease } = await relay.nextLease(tokenId));
    results = await read(lease);
    const project = store.projectRun;
    store.projectRun = async () => { throw new Error('process stopped'); };
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results }), /process stopped/);
    store.projectRun = project;
    assert.deepEqual((await guideRuns()).map(r => r.status).sort(), ['running', 'succeeded']);
    await relay.submit(tokenId, lease.leaseId, { results });
    assert.deepEqual((await guideRuns()).map(r => r.status), ['succeeded', 'succeeded'], 'the recorded run was projected, not recorded again');
});

/** A first full check done; the relay's reader and a one-shot checkpoint failure. */
async function detailLeaseSetup() {
    const ctx = await setup();
    await enableJob(ctx.store);
    await ctx.drain();
    const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
    ctx.read = lease => runLease(lease, { fetchPage: ctx.site.fetchPage, parseHtml, sleep: async () => {}, now: () => ctx.clock.t });
    ctx.failCheckpointOnce = () => {
        const refund = ctx.guideStore.refundUsage;
        ctx.guideStore.refundUsage = async () => { ctx.guideStore.refundUsage = refund; throw new Error('checkpoint failed'); };
    };
    return ctx;
}

test('AC-CAT-012 error case: a retry with different results than the lease staged checkpoints nothing; the page is read again', async () => {
    const { db, guideStore, relay, tokenId, site, clock, read, failCheckpointOnce } = await detailLeaseSetup();
    const before = await guideStore.getIdState('item', 17048);
    await db.query("UPDATE catalog_guide_ids SET next_detail_at = ? WHERE entity_kind = 'item' AND entity_id = 17048", [new Date(clock.t).toISOString()]);
    site.itemName = id => (id === 17048 ? 'Version A' : `Item ${id}`);
    const { lease } = await relay.nextLease(tokenId);
    assert.deepEqual(lease.work, [{ type: 'detail', id: 17048 }]);
    const resultsA = await read(lease);
    failCheckpointOnce();
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results: resultsA }), /checkpoint failed/);
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17048'))[0].name, 'Version A');

    site.itemName = id => (id === 17048 ? 'Version B' : `Item ${id}`);   // the page changed before the retry
    const resultsB = await read(lease);
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results: resultsB }), e => e.code === 'conflict' && /differ/.test(e.message));
    const s = await guideStore.getIdState('item', 17048);
    assert.equal(s.hash, before.hash, 'no hash for results the catalog does not serve');
    assert.ok(Date.parse(s.nextDetailAt) <= clock.t, 'the detail is still due');

    const again = await relay.nextLease(tokenId);
    assert.notEqual(again.lease.leaseId, lease.leaseId, 'the refused lease was closed, so a new one is issued at once');
    await relay.submit(tokenId, again.lease.leaseId, { results: await read(again.lease) });
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17048'))[0].name, 'Version B');
    assert.equal((await guideStore.getIdState('item', 17048)).status, 'ok');
});

test('AC-CAT-009 / AC-CAT-013: rolling back a guide run leaves its details unverified until the next scheduled read, also on a retried lease', async () => {
    const { db, store, guideStore, relay, tokenId, site, clock, read, failCheckpointOnce } = await detailLeaseSetup();
    const rollBack = async runId => { const plan = await store.planRollback(runId); await store.executePlan(plan.id, { confirmation: plan.confirmation }); };

    // A retried lease whose run the owner rolled back in between.
    site.ids.item.push(17051);   // a new item, linked from elsewhere; the index is not read again today
    await guideStore.registerIds('item', [17051]);
    const site17051 = async () => (await db.query('SELECT id FROM items WHERE id = 17051')).length;
    const { lease } = await relay.nextLease(tokenId);
    assert.deepEqual(lease.work, [{ type: 'detail', id: 17051 }]);
    const results = await read(lease);
    failCheckpointOnce();
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results }), /checkpoint failed/);
    assert.equal(await site17051(), 1);
    const [{ run_id: runId }] = await db.query('SELECT run_id FROM catalog_guide_leases WHERE id = ?', [lease.leaseId]);
    await rollBack(runId);
    assert.equal(await site17051(), 0);
    await assert.rejects(relay.submit(tokenId, lease.leaseId, { results }), e => e.code === 'conflict' && /rolled back/.test(e.message));
    let s = await guideStore.getIdState('item', 17051);
    assert.deepEqual([s.status, s.hash], ['pending', null], 'never marked ok for a record the catalog does not hold');
    assert.equal(Date.parse(s.nextDetailAt), clock.t + GUIDE_POLICY.detailRefreshAfterMs, 'the next read keeps the refresh interval');
    assert.equal((await relay.nextLease(tokenId)).status, 'idle', 'the rolled-back detail is not read again at once');

    // A normal, fully checkpointed guide run that is rolled back later.
    const [{ id: itemRun }] = await db.query("SELECT r.id FROM catalog_runs r JOIN catalog_entities e ON e.last_run_id = r.id WHERE r.mode = 'guide_discovery' AND e.entity_kind = 'item' AND e.entity_key = '17049'");
    assert.equal((await guideStore.getIdState('item', 17049)).status, 'ok');
    await rollBack(itemRun);
    s = await guideStore.getIdState('item', 17049);
    assert.deepEqual([s.status, s.hash], ['pending', null]);
    assert.equal(Date.parse(s.nextDetailAt), clock.t + GUIDE_POLICY.detailRefreshAfterMs);
});

/**
 * relayCycle wired to the relay the way the control plane serves it: CatalogError -> HTTP status, and
 * HTTP 413 for a body over bodyLimit (MAX_RELAY_BODY, as control-plane/server.mjs enforces it).
 * posts records each submission's size, result count, and reported requests.
 */
function relayDeps({ relay, tokenId, site, clock }, saved, { bodyLimit = MAX_RELAY_BODY, posts = [] } = {}) {
    const http = async fn => {
        try { return { status: 200, json: await fn() }; } catch (e) {
            return { status: { invalid: 400, not_found: 404, conflict: 409 }[e.code] ?? 500, json: { error: 'x' } };
        }
    };
    let slot = null;
    return {
        getLease: () => http(() => relay.nextLease(tokenId)),
        postResults: (leaseId, body) => {
            const bytes = Buffer.byteLength(JSON.stringify(body));
            posts.push({ bytes, results: body.results.length, requests: body.requests, accepted: bytes <= bodyLimit });
            return bytes > bodyLimit ? Promise.resolve({ status: 413, json: { error: 'x' } }) : http(() => relay.submit(tokenId, leaseId, body));
        },
        saved: saved ?? { get: () => slot, set: v => { slot = v === null ? null : JSON.parse(JSON.stringify(v)); } },
        fetchPage: site.fetchPage, parseHtml: html => new DOMParser().parseFromString(html, 'text/html'),
        sleep: async () => {}, now: () => clock.t,
    };
}

/** A guide whose item index has `pages` full pages of 100 entries with 100-character names. */
async function bigIndexSetup(pages) {
    const ctx = await setup();
    await enableJob(ctx.store);
    ctx.site.perPage = 100;
    ctx.site.ids.item = Array.from({ length: pages * 100 }, (_, i) => 30000 - i);
    ctx.site.itemName = id => `Item ${id} `.padEnd(100, 'x');
    return ctx;
}
/** relayCycle until the item index sweep has completed (or stopped), without reading any details. */
async function sweepItems(ctx, deps, max = 40) {
    const out = [];
    for (let i = 0; i < max; i++) {
        const s = await ctx.guideStore.getState('item');
        if (s.lastSuccessfulCheckAt || s.status === 'partial') break;
        out.push(await relayCycle(deps));
    }
    return out;
}

test('AC-CAT-014 / AC-CAT-015: a lease whose pages would not fit in one submission is sent in parts; nothing is lost or uncounted', async () => {
    const ctx = await bigIndexSetup(60);   // 50 such pages are about 600 KB, over the 512 KiB body limit
    const posts = [];
    const deps = relayDeps(ctx, undefined, { posts });
    await sweepItems(ctx, deps);
    const s = await ctx.guideStore.getState('item');
    assert.ok(s.lastSuccessfulCheckAt, 'the item index sweep completed');
    assert.equal(s.lastSeenId, 30000);
    assert.ok(posts.every(p => p.accepted), 'no submission went over the limit');
    assert.ok(Math.max(...posts.map(p => p.bytes)) <= MAX_RELAY_BODY);
    const cut = posts.find(p => p.requests > p.results);
    assert.ok(cut && cut.results < GUIDE_POLICY.maxRequestsPerExecution, 'the relay stopped before the batch would not fit');
    assert.equal(cut.requests, cut.results + 1, 'the page it read but left out is still reported');
    assert.equal(Number((await ctx.db.query("SELECT COUNT(*) AS n FROM catalog_guide_ids WHERE entity_kind = 'item'"))[0].n), 6000);
    assert.equal(await ctx.guideStore.usage(), ctx.site.requests.length, 'every guide request is counted, none twice');
});

test('AC-CAT-015 error case: a submission the server finds too large is cut and resent, not dropped and read again', async () => {
    const ctx = await bigIndexSetup(10);
    const posts = [];
    const deps = relayDeps(ctx, undefined, { posts, bodyLimit: 60_000 });   // a server with a smaller limit than the lease says
    await sweepItems(ctx, deps);
    assert.ok(posts.some(p => !p.accepted), 'a submission was refused with 413');
    assert.ok((await ctx.guideStore.getState('item')).lastSuccessfulCheckAt, 'the sweep still completed');
    const itemReads = ctx.site.requests.filter(u => /cmd=items&index=/.test(u));
    const cutPages = posts.filter(p => p.accepted).reduce((n, p) => n + p.requests - p.results, 0);
    assert.ok(cutPages > 0);
    assert.equal(itemReads.length, new Set(itemReads).size + cutPages, 'a page is read again only after being cut from a submission');
    assert.equal(await ctx.guideStore.usage(), ctx.site.requests.length);
});

test('AC-CAT-015 error case: a page too large for any submission stops the sweep there as partial', async () => {
    const ctx = await bigIndexSetup(2);
    const deps = relayDeps(ctx);
    const getLease = deps.getLease;
    deps.getLease = async () => {
        const r = await getLease();
        if (r.json?.lease?.kind === 'item') r.json.lease.maxBodyBytes = 4096;   // one 100-entry page is about 12 KB
        return r;
    };
    await sweepItems(ctx, deps);
    const s = await ctx.guideStore.getState('item');
    assert.deepEqual([s.status, s.statusReason, s.nextPage, s.lastSuccessfulCheckAt], ['partial', 'page too large to submit', 0, null]);
    assert.equal(await ctx.guideStore.usage(), ctx.site.requests.length);
});

test('AC-CAT-015 error case: a first page over a server limit lower than the lease says is reported too large, not read again', async () => {
    const ctx = await bigIndexSetup(2);
    const posts = [];
    const deps = relayDeps(ctx, undefined, { posts, bodyLimit: 4000 });   // a 100-entry page is about 12 KB
    await sweepItems(ctx, deps);
    const s = await ctx.guideStore.getState('item');
    assert.deepEqual([s.status, s.statusReason, s.nextPage, s.lastSuccessfulCheckAt], ['partial', 'page too large to submit', 0, null]);
    assert.equal(ctx.site.requests.filter(u => /cmd=items&index=0$/.test(u)).length, 1, 'the page was read once');
    assert.ok(posts.every(p => p.results > 0), 'no empty batch was sent for a page that was read');
    assert.equal(await ctx.guideStore.usage(), ctx.site.requests.length);
});

test('AC-CAT-015 error case: after a failed submission the relay resends what it read; it never reads the lease again', async () => {
    const ctx = await detailLeaseSetup();
    const { db, guideStore, site, clock, failCheckpointOnce } = ctx;
    await db.query("UPDATE catalog_guide_ids SET next_detail_at = ? WHERE entity_kind = 'item' AND entity_id = 17048", [new Date(clock.t).toISOString()]);
    const deps = relayDeps(ctx);
    const usage0 = await guideStore.usage();
    const reads0 = site.requests.length;
    site.itemName = id => (id === 17048 ? 'Version A' : `Item ${id}`);
    failCheckpointOnce();
    assert.deepEqual(await relayCycle(deps), { step: 'http', status: 500, kept: true });
    site.itemName = id => (id === 17048 ? 'Version B' : `Item ${id}`);   // the page changes before the retry
    const out = await relayCycle(deps);
    assert.equal(out.step, 'sent');
    assert.equal(out.resent, true);
    assert.equal(site.requests.length - reads0, 1, 'one guide request for the lease');
    assert.equal(await guideStore.usage() - usage0, 1, 'and one counted against the daily cap');
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17048'))[0].name, 'Version A', 'what was read is what was checkpointed');
    assert.equal(deps.saved.get(), null, 'accepted results are not kept');
    assert.equal((await relayCycle(deps)).step, 'no_lease');
});

test('AC-CAT-015: a relay that lost its saved results and reads the lease again is charged for that read', async () => {
    const ctx = await detailLeaseSetup();
    const { db, guideStore, site, clock, failCheckpointOnce } = ctx;
    await db.query("UPDATE catalog_guide_ids SET next_detail_at = ? WHERE entity_kind = 'item' AND entity_id = 17048", [new Date(clock.t).toISOString()]);
    const deps = relayDeps(ctx);
    const usage0 = await guideStore.usage();
    const reads0 = site.requests.length;
    failCheckpointOnce();
    assert.equal((await relayCycle(deps)).kept, true);
    deps.saved.set(null);   // for example, Tampermonkey storage was cleared
    assert.equal((await relayCycle(deps)).step, 'sent');
    assert.equal(site.requests.length - reads0, 2);
    assert.ok(await guideStore.usage() - usage0 >= 2, 'every read the relay can make is counted');
});

test('AC-CAT-015: a lease that can run past UTC midnight is reserved against both days', async () => {
    const { store, guideStore, relay, tokenId, site, clock } = await setup();
    clock.t = Date.parse('2026-09-28T23:55:00.000Z');
    await enableJob(store);
    const { lease } = await relay.nextLease(tokenId);
    assert.equal(await guideStore.usage('2026-09-28'), lease.work.length);
    assert.equal(await guideStore.usage('2026-09-29'), lease.work.length);
    const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
    const results = await runLease(lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {}, now: () => clock.t });
    clock.t = Date.parse('2026-09-29T00:01:00.000Z');
    await relay.submit(tokenId, lease.leaseId, { results });
    assert.equal(await guideStore.usage('2026-09-28'), results.length);
    assert.equal(await guideStore.usage('2026-09-29'), results.length);
    // The relay reads nothing once its lease has expired.
    const next = await relay.nextLease(tokenId);
    const late = await runLease(next.lease, { fetchPage: site.fetchPage, parseHtml, sleep: async () => {}, now: () => Date.parse(next.lease.expiresAt) });
    assert.deepEqual(late, []);
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
        { results: [], requests: lease.work.length + 1 },
        { results: [{ type: 'index', page, outcome: 'empty' }], requests: 0 },
        { results: [], requests: '3' },
        { results: [], requests: 1 },
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
