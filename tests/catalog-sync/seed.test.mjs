// tests/catalog-sync/seed.test.mjs - CAT-TASK-007 / AC-CAT-005, AC-CAT-006, AC-CAT-009, AC-CAT-010
// Staged baseline seeding from an approved source key, with an injected downloader (no network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createCatalogStore, CatalogError } from '../../_gg_data/handler/catalogStore.js';
import { createSeedService, mapSeed } from '../../catalog/seedService.js';
import { SEED_SOURCES, describeSeedSources } from '../../catalog/sourceRegistry.js';

after(() => closeClients());

const FILES = SEED_SOURCES.fsdatabase.files;
function sourceData() {
    return {
        master_realm: [{ id: 5, name: 'Elya Desert', connectedRealms: [
            { realmId: 18, realmName: 'Elya Plains North', minLevel: 4 },
            { realmId: 20, realmName: 'Otha Caves (Level 1)', minLevel: 10 },
        ] }],
        realm: [
            { id: 1200, name: 'Mountain Path', min_level: 1, master_realm_id: 5, creatures: [7001, 7002], relics: ['Stone of Echoes'], quests: [{ name: "The Golem's Heart" }], connections: [{ to: 1201 }] },
            { realm_id: '1201', realm_name: 'Summit', level: '40', master_realm_id: 999 },
        ],
        creature: [
            { id: 7001, name: 'Montmarr the Dragon Golem', imageUrl: 'https://cdn2.fallensword.com/creatures/7001.jpg', stats: { level: 1250 }, droppedItems: [{ itemId: 17048 }] },
            { creature_id: 7002, creature_name: '<b>Wisp</b>', description: 'x'.repeat(9000) },
            { id: 7003, name: 'Oversized', stats: { blob: 'y'.repeat(17 * 1024) } },
        ],
        item: [
            { id: 17048, name: 'Montmarr Helm', rarity: 'Rare', droppedBy: [{ creatureName: 'Montmarr the Dragon Golem' }] },
            { itemId: '17049', item_name: 'Dusk Gauntlets', set_id: 412, set_name: 'Dusk Set' },
        ],
    };
}

async function setup({ data = sourceData(), chunk = 4, fetchJson } = {}) {
    const log = console.log;
    console.log = () => {};
    const db = await freshClient();
    console.log = log;
    const clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const store = createCatalogStore(db, { now: () => clock.t, invalidateCaches: () => {} });
    const fetched = [];
    const seeds = createSeedService({ db, store, chunk, fetchJson: fetchJson ?? (async (url, maxBytes) => { fetched.push([url, maxBytes]); return data[Object.keys(FILES).find(k => FILES[k] === url)]; }) });
    return { db, store, seeds, fetched, clock };
}
const count = async (db, table, where = '') => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`))[0].n);
const rejects = (p, code) => assert.rejects(p, e => e instanceof CatalogError && e.code === code);

async function promote(store, runId) {
    const plan = await store.planPromotion(runId);
    return store.executePlan(plan.id, { confirmation: plan.confirmation });
}

test('CAT-TASK-007: the approved source is the snapshot populate_db loads, described without paths', () => {
    const legacy = fs.readFileSync(path.resolve('scripts/populate_db.mjs'), 'utf8');
    for (const url of Object.values(FILES)) assert.ok(legacy.includes(url), url);
    assert.deepEqual(describeSeedSources(), [{ key: 'fsdatabase', label: SEED_SOURCES.fsdatabase.label, source: 'guide_baseline', kinds: ['master_realm', 'realm', 'creature', 'item'], hosts: ['raw.githubusercontent.com'] }]);
});

test('AC-CAT-006 error case: an unapproved key, an oversized file, or a malformed file writes nothing', async () => {
    const { db, seeds, fetched } = await setup();
    for (const key of ['https://evil.example/x.json', '../fsdatabase', 'constructor', '', null]) await rejects(seeds.stage(key), 'invalid');
    assert.equal(fetched.length, 0, 'no download for an unapproved key');
    const big = await setup({ fetchJson: async () => { throw new CatalogError('invalid', 'Seed file exceeds its size limit.'); } });
    await rejects(big.seeds.stage('fsdatabase'), 'invalid');
    const bad = await setup({ data: { ...sourceData(), item: { not: 'an array' } } });
    await rejects(bad.seeds.stage('fsdatabase'), 'invalid');
    const junk = await setup({ data: { ...sourceData(), creature: [{ name: 'no id' }, { name: 'no id either' }, { id: 1, name: 'ok' }] } });
    await rejects(junk.seeds.stage('fsdatabase'), 'invalid');
    for (const s of [{ db }, big, bad, junk]) {
        assert.equal(await count(s.db, 'catalog_runs'), 0);
        assert.equal(await count(s.db, 'items'), 0);
    }
    assert.ok(fetched.length === 0);
});

test('AC-CAT-006: a seed is staged as ordered runs with no serving write; unrepresentable records are excluded, not guessed', async () => {
    const { db, store, seeds, fetched } = await setup();
    const staged = await seeds.stage('fsdatabase');
    assert.deepEqual(fetched.map(f => f[1]), Array(4).fill(SEED_SOURCES.fsdatabase.maxBytes));
    assert.equal(staged.excluded.creature, 1, 'the 17 KiB payload does not fit and is reported');
    assert.equal(staged.unusable.creature, 0);
    assert.equal(staged.parts, Math.ceil(staged.observations / 4));
    assert.deepEqual(staged.runs[0].kinds, ['master_realm', 'realm', 'creature']);
    assert.deepEqual(staged.runs.at(-1).kinds, ['quest', 'relation'], 'relations come last, after every parent kind');
    for (const r of staged.runs) {
        const run = await store.getRun(r.runId);
        assert.deepEqual([run.mode, run.source, run.status], ['seed', 'guide_baseline', 'running']);
        assert.equal(run.summary.seed.batchId, staged.batchId);
    }
    for (const t of ['master_realms', 'realms', 'creatures', 'items', 'relics', 'quests', 'realm_creatures', 'creature_drops']) assert.equal(await count(db, t), 0, t);
    const mapped = mapSeed(sourceData());
    const masterRealm = mapped.observations.find(o => o.kind === 'master_realm').payload;
    assert.deepEqual(masterRealm.connected_realms, [
        { realmId: 18, realmName: 'Elya Plains North', minLevel: 4 },
        { realmId: 20, realmName: 'Otha Caves (Level 1)', minLevel: 10 },
    ]);
    const wisp = mapped.observations.find(o => o.kind === 'creature' && o.payload.id === 7002).payload;
    assert.equal(wisp.name, '<b>Wisp</b>', 'kept as text; the UI renders it with textContent');
    assert.equal(wisp.description.length, 8192);
    const summit = mapped.observations.find(o => o.kind === 'realm' && o.payload.id === 1201).payload;
    assert.deepEqual({ ...summit }, { id: 1201, name: 'Summit', min_level: 40, master_realm_id: 999 });
});

test('AC-CAT-009: parts are promoted in order through previewed, confirmed plans; the result matches the source', async () => {
    const { db, store, seeds } = await setup();
    const staged = await seeds.stage('fsdatabase');
    await rejects(store.planPromotion(staged.runs[1].runId), 'conflict');
    const plan = await store.planPromotion(staged.runs[0].runId);
    assert.equal(plan.action, 'promote');
    assert.match(plan.confirmation, /^PROMOTE [0-9a-f]{8} 4$/);
    assert.deepEqual(plan.expectedCounts.rows, { master_realms: 1, realms: 2, creatures: 1 });
    assert.equal(await count(db, 'realms'), 0, 'a preview writes nothing');
    await rejects(store.executePlan(plan.id, { confirmation: 'PROMOTE' }), 'plan_confirmation');
    const done = await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.deepEqual([done.action, done.status], ['promote', 'succeeded']);
    await rejects(store.executePlan(plan.id, { confirmation: plan.confirmation }), 'plan_used');
    for (const r of staged.runs.slice(1)) await promote(store, r.runId);
    assert.deepEqual(JSON.parse((await db.query('SELECT connected_realms FROM master_realms WHERE id = 5'))[0].connected_realms), [
        { realmId: 18, realmName: 'Elya Plains North', minLevel: 4 },
        { realmId: 20, realmName: 'Otha Caves (Level 1)', minLevel: 10 },
    ]);
    assert.equal(await count(db, 'realms'), 2);
    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 1201'))[0].master_realm_id, null, 'an unknown master realm becomes NULL');
    assert.deepEqual((await db.query('SELECT name FROM relics')).map(r => r.name), ['Stone of Echoes']);
    assert.deepEqual((await db.query('SELECT name FROM quests')).map(r => r.name), ["The Golem's Heart"]);
    assert.equal(await count(db, 'realm_creatures'), 2);
    assert.equal(await count(db, 'creature_drops'), 1);
    assert.equal(await count(db, 'items'), 2);
    assert.equal((await store.getRun(staged.runs[0].runId)).summary.seed.part, 1, 'projection keeps the seed summary');
    await rejects(store.planPromotion(staged.runs[0].runId), 'conflict');
});

test('AC-CAT-010: a promoted seed over legacy rows keeps a baseline, so rolling it back restores them', async () => {
    const { db, store, seeds } = await setup({ chunk: 50 });
    await db.query("INSERT INTO items (id, name, rarity) VALUES (17048, 'Legacy Helm', 'Common')");
    const staged = await seeds.stage('fsdatabase');
    assert.equal(staged.parts, 1);
    const done = await promote(store, staged.runs[0].runId);
    assert.equal(done.counts.baselines, 1);
    assert.equal((await db.query('SELECT name FROM items WHERE id = 17048'))[0].name, 'Montmarr Helm');
    const plan = await store.planRollback(staged.runs[0].runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.deepEqual({ ...(await db.query('SELECT name, rarity FROM items WHERE id = 17048'))[0] }, { name: 'Legacy Helm', rarity: 'Common' });
    assert.equal(await count(db, 'items'), 1);
    assert.equal(await count(db, 'realms'), 0);
});

test('AC-CAT-009 error case: a promotion plan goes stale when the catalog changes; a staged run can be discarded', async () => {
    const { store, seeds } = await setup({ chunk: 50 });
    const staged = await seeds.stage('fsdatabase');
    const plan = await store.planPromotion(staged.runs[0].runId);
    await store.ingest({ mode: 'seed', source: 'manual_import', observations: [{ kind: 'master_realm', payload: { id: 9, name: 'Other' } }] });
    await rejects(store.executePlan(plan.id, { confirmation: plan.confirmation }), 'plan_stale');
    assert.equal((await store.getRun(staged.runs[0].runId)).status, 'running', 'still staged');
    await store.discardStagedRun(staged.runs[0].runId);
    assert.equal((await store.getRun(staged.runs[0].runId)).status, 'cancelled');
    await rejects(store.planPromotion(staged.runs[0].runId), 'conflict');
    await rejects(store.discardStagedRun(staged.runs[0].runId), 'conflict');
    assert.equal(await store.hasDiscardableWork(), true, 'the manual import is projected');
});
