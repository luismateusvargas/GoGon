// tests/data-storage/catalog-store.test.mjs - CAT-TASK-002 / AC-CAT-005, AC-CAT-006, AC-CAT-009, AC-CAT-010
// Catalog provenance store, migrations 003/004, the FK-safe serving writers, and the populate_db
// guard. Runs on the in-process MySQL fake by default and on a real MySQL with GG_TEST_MYSQL_URL
// (retrofitted foreign keys are enforced there only; see tests/helpers/fake-mysql.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshClient, closeClients } from '../helpers/db-client.mjs';

const { createCatalogStore, CatalogError, canonicalJson, normalizeObservation, PLAN_TTL_MS, MAX_PAYLOAD_BYTES } = await import('../../_gg_data/handler/catalogStore.js');
const { runMigrations, splitStatements } = await import('../../_gg_data/handler/migrationRunner.js');
const { up: migration004 } = await import('../../_gg_data/migrations/004_serving_relations.mjs');
const { up: migration012 } = await import('../../_gg_data/migrations/012_media_host.mjs');
const { canonicalImageUrl } = await import('../../_gg_data/handler/mediaUrl.js');
const { idsFrom, namesFrom } = await import('../../_gg_data/handler/servingRelations.js');
const ggdb = await import('../../_gg_data/handler/gg_database.js');
const REAL_MYSQL = globalThis.__GG_TEST_DATABASE__ === 'mysql';

const tmp = mkdtempSync(path.join(tmpdir(), 'gg-catalog-'));
after(async () => {
    await closeClients();
    await ggdb.closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
});

async function quietly(fn) {
    const saved = { log: console.log, warn: console.warn };
    console.log = console.warn = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
}

/** A migrated database plus a store whose clock and cache invalidation the test controls. */
async function setup() {
    const db = await quietly(() => freshClient());
    const clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const invalidations = { n: 0 };
    const store = createCatalogStore(db, { now: () => clock.t, invalidateCaches: () => { invalidations.n++; } });
    return { db, store, clock, invalidations };
}

const count = async (db, from, params = []) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${from}`, params))[0].n);
const revision = async db => Number((await db.query('SELECT revision FROM catalog_state WHERE id = 1'))[0].revision);
const obs = (kind, payload) => ({ kind, payload });

async function rejectsWith(promise, code) {
    await assert.rejects(promise, e => e instanceof CatalogError && e.code === code, `expected CatalogError ${code}`);
}

// --- migrations --------------------------------------------------------------------------------------

test('CAT-TASK-002: migrations 003/004 create the catalog tables and re-run as a no-op', async () => {
    const { db } = await setup();
    for (const table of ['quests', 'realm_creatures', 'creature_drops', 'catalog_state', 'catalog_runs', 'catalog_jobs', 'catalog_observations', 'catalog_run_observations', 'catalog_entities', 'catalog_deletion_plans']) {
        assert.equal(await count(db, table) >= 0, true, table);
    }
    assert.equal(await revision(db), 0);
    const applied = await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations')));
    assert.deepEqual(applied, []);
    const fks = (await db.query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_NAME IN ('realms', 'relics')"))
        .map(r => r.CONSTRAINT_NAME).sort();
    assert.deepEqual(fks, ['realms_master_realm_fk', 'relics_realm_fk']);
});

test('a guide cursor reset and startup migration check preserve the last completed check', async () => {
    const { db } = await setup();
    const completedAt = '2026-09-28T11:00:00.000Z';
    await db.query("UPDATE catalog_guide_state SET last_successful_check_at = ?, last_full_sweep_at = ?, last_page_seen = 14, next_page = 8, status = 'running' WHERE entity_kind = 'master_realm'", [completedAt, completedAt]);
    for (const statement of splitStatements(readFileSync(path.resolve('_gg_data/migrations/010_guide_full_index_scan.sql'), 'utf8'))) {
        await db.query(statement);
    }
    await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations')));
    const [state] = await db.query("SELECT last_successful_check_at, last_full_sweep_at, last_page_seen, next_page, status FROM catalog_guide_state WHERE entity_kind = 'master_realm'");
    assert.deepEqual(state, {
        last_successful_check_at: completedAt, last_full_sweep_at: completedAt,
        last_page_seen: 14, next_page: 0, status: 'idle',
    });
});

test('image URLs move off the challenged cdn host; other URLs are untouched', () => {
    assert.equal(canonicalImageUrl('http://cdn.fallensword.com/items/23.gif'), 'https://cdn2.fallensword.com/items/23.gif');
    assert.equal(canonicalImageUrl('https://cdn.fallensword.com/creatures/426bc.png'), 'https://cdn2.fallensword.com/creatures/426bc.png');
    assert.equal(canonicalImageUrl('//CDN.fallensword.com/items/1.gif'), 'https://cdn2.fallensword.com/items/1.gif');
    assert.equal(canonicalImageUrl('http://cdn2.fallensword.com/items/1.gif'), 'https://cdn2.fallensword.com/items/1.gif');
    assert.equal(canonicalImageUrl('https://cdn2.fallensword.com/items/1.gif'), 'https://cdn2.fallensword.com/items/1.gif');
    assert.equal(canonicalImageUrl('https://www.fallensword.com/cdn.fallensword.com/x.gif'), 'https://www.fallensword.com/cdn.fallensword.com/x.gif');
    assert.equal(canonicalImageUrl('https://cdn.fallensword.com.evil.test/x.gif'), 'https://cdn.fallensword.com.evil.test/x.gif');
    assert.equal(canonicalImageUrl(null), null);
    assert.equal(normalizeObservation('item', { id: 23, name: 'Padded Armor', imageUrl: 'http://cdn.fallensword.com/items/23.gif' }).payload.imageUrl,
        'https://cdn2.fallensword.com/items/23.gif');
});

test('migration 012 moves stored images to cdn2 and re-runs as a no-op', async () => {
    const { db } = await setup();
    await db.query("INSERT INTO items (id, name, imageUrl) VALUES (23, 'Padded Armor', 'http://cdn.fallensword.com/items/23.gif'), (24, 'Kept', 'https://cdn2.fallensword.com/items/24.gif'), (25, 'None', NULL)");
    await db.query("INSERT INTO creatures (id, name, imageUrl) VALUES (426, 'Baron', 'https://cdn.fallensword.com/creatures/426bc.png')");
    await quietly(() => migration012(db));
    await quietly(() => migration012(db));
    assert.deepEqual((await db.query('SELECT id, imageUrl FROM items ORDER BY id')).map(r => r.imageUrl),
        ['https://cdn2.fallensword.com/items/23.gif', 'https://cdn2.fallensword.com/items/24.gif', null]);
    assert.equal((await db.query('SELECT imageUrl FROM creatures WHERE id = 426'))[0].imageUrl, 'https://cdn2.fallensword.com/creatures/426bc.png');
});

test('CAT-TASK-002: relation tables reject dangling references and cascade with their parents', async () => {
    const { db } = await setup();
    await assert.rejects(db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (1, 2)'), e => e.code === 'ER_NO_REFERENCED_ROW_2');
    await db.query("INSERT INTO realms (id, name) VALUES (1, 'R')");
    await db.query("INSERT INTO creatures (id, name) VALUES (2, 'C')");
    await db.query("INSERT INTO items (id, name) VALUES (3, 'I')");
    await db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (1, 2)');
    await db.query('INSERT INTO creature_drops (creature_id, item_id) VALUES (2, 3)');
    await db.query("INSERT INTO quests (realm_id, name) VALUES (1, 'Q')");
    await db.query('DELETE FROM creatures WHERE id = 2');
    assert.equal(await count(db, 'realm_creatures'), 0);
    assert.equal(await count(db, 'creature_drops'), 0);
    await db.query('DELETE FROM realms WHERE id = 1');
    assert.equal(await count(db, 'quests'), 0);
});

test('CAT-TASK-002 (real MySQL): retrofitted keys null dangling master realms and cascade relics', { skip: !REAL_MYSQL && 'retrofitted foreign keys are enforced on MySQL only' }, async () => {
    const { db } = await setup();
    await assert.rejects(db.query("INSERT INTO realms (id, name, master_realm_id) VALUES (5, 'R', 999)"), e => e.code === 'ER_NO_REFERENCED_ROW_2');
    await db.query("INSERT INTO master_realms (id, name) VALUES (9, 'M')");
    await db.query("INSERT INTO realms (id, name, master_realm_id) VALUES (5, 'R', 9)");
    await db.query("INSERT INTO relics (name, realm_id) VALUES ('Relic', 5)");
    await db.query('DELETE FROM master_realms WHERE id = 9');
    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 5'))[0].master_realm_id, null);
    await db.query('DELETE FROM realms WHERE id = 5');
    assert.equal(await count(db, 'relics'), 0);
});

test('CAT-TASK-002: migration 004 fixes dangling legacy rows, then adds keys and backfills relations', async () => {
    const dir = path.join(tmp, 'pre004');
    (await import('node:fs')).mkdirSync(dir, { recursive: true });
    for (const f of ['001_initial_schema.sql', '002_control_plane.sql', '003_catalog_sync.sql']) copyFileSync(path.resolve('_gg_data/migrations', f), path.join(dir, f));
    const db = await quietly(() => freshClient({ migrate: false }));
    await quietly(() => runMigrations(db, dir));
    await db.query("INSERT INTO master_realms (id, name) VALUES (1, 'M')");
    await db.query("INSERT INTO realms (id, name, master_realm_id, creatures, quests) VALUES (10, 'Kept', 1, ?, ?)", ['[100, {"id": 101}, 999]', '["Find the key", {"name": "Slay"}]']);
    await db.query("INSERT INTO realms (id, name, master_realm_id, creatures) VALUES (11, 'Dangling master', 77, 'not json')");
    await db.query("INSERT INTO relics (name, realm_id) VALUES ('Orphan', 404), ('Good', 10)");
    await db.query("INSERT INTO creatures (id, name, droppedItems) VALUES (100, 'A', '[500, 501]'), (101, 'B', NULL)");
    await db.query("INSERT INTO items (id, name) VALUES (500, 'Sword')");

    await quietly(() => migration004(db));
    await quietly(() => migration004(db)); // idempotent

    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 11'))[0].master_realm_id, null);
    assert.deepEqual((await db.query('SELECT name FROM relics ORDER BY name')).map(r => r.name), ['Good']);
    assert.deepEqual((await db.query('SELECT realm_id, creature_id FROM realm_creatures ORDER BY creature_id')).map(r => [Number(r.realm_id), Number(r.creature_id)]), [[10, 100], [10, 101]]);
    assert.deepEqual((await db.query('SELECT creature_id, item_id FROM creature_drops')).map(r => [Number(r.creature_id), Number(r.item_id)]), [[100, 500]]);
    assert.deepEqual((await db.query('SELECT name FROM quests ORDER BY name')).map(r => r.name), ['Find the key', 'Slay']);
});

test('CAT-TASK-002: legacy JSON parsers accept the guide shapes and skip what they cannot resolve', () => {
    assert.deepEqual(idsFrom([1, '2', { id: 3 }, { creature_id: 4 }, 'x', -1, 1]), [1, 2, 3, 4]);
    assert.deepEqual(idsFrom({ 7: 'Seven', other: { itemId: 8 } }), [7, 8]);
    assert.deepEqual(namesFrom(['A', { name: 'B' }, ' ', 'A']), ['A', 'B']);
    assert.deepEqual(namesFrom({ 1: 'C', D: true }), ['C', 'D']);
});

// --- validation (AC-CAT-006 error case) ----------------------------------------------------------

test('AC-CAT-006: an invalid observation batch is rejected before any catalog or serving write', async () => {
    const { db, store } = await setup();
    const valid = obs('item', { id: 1, name: 'Ok' });
    const cases = [
        [{ mode: 'seed', source: 'guide_baseline', observations: [valid, obs('item', { id: 2, url: 'https://evil.example/' })] }, 'unknown field'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [valid, obs('item', { name: 'no id' })] }, 'missing id'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('item', { id: 3, name: 'x'.repeat(300) })] }, 'text too long'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('item', { id: 4, stats: { blob: 'y'.repeat(MAX_PAYLOAD_BYTES) } })] }, 'byte limit'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('account', { id: 5 })] }, 'unknown kind'],
        [{ mode: 'seed', source: 'wiki_scrape', observations: [valid] }, 'unapproved source'],
        [{ mode: 'attack', source: 'game_session', observations: [valid] }, 'unknown mode'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('relation', { type: 'realm_creature', realm_id: 1 })] }, 'incomplete relation'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('creature', { id: 6, description: 'bell\u0007' })] }, 'control character'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [] }, 'empty batch'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [null] }, 'null observation'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [valid, 'item'] }, 'string observation'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [[valid]] }, 'array observation'],
        [{ mode: 'seed', source: 'guide_baseline', observations: [obs('item', null)] }, 'null payload'],
        [{ mode: 'seed', source: 'guide_baseline', observations: 'item' }, 'observations not a list'],
    ];
    for (const [input, label] of cases) await rejectsWith(store.recordRun(input), 'invalid').catch(e => { throw new Error(`${label}: ${e.message}`); });
    assert.equal(await count(db, 'catalog_runs'), 0);
    assert.equal(await count(db, 'catalog_observations'), 0);
    assert.equal(await count(db, 'items'), 0);
});

test('CAT-TASK-002: observations are canonical and content-addressed', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    const one = normalizeObservation('item', { name: 'Blade', id: 7 });
    const two = normalizeObservation('item', { id: 7, name: 'Blade' });
    assert.equal(one.hash, two.hash);
    assert.equal(one.key, '7');
    assert.equal(normalizeObservation('relic', { realm_id: 3, name: 'Idol' }).key, '3:Idol');
    assert.equal(normalizeObservation('relation', { type: 'creature_drop', creature_id: 4, item_id: 9 }).key, 'creature_drop:4:9');
});

// --- provenance and projection (AC-CAT-005) --------------------------------------------------------

test('AC-CAT-005: provenance is stored before an incremental, field-level projection', async () => {
    const { db, store, invalidations } = await setup();
    const first = await store.ingest({
        mode: 'observe_realm', source: 'game_session', observations: [
            obs('realm', { id: 20, name: 'Glade', min_level: 5 }),
            obs('creature', { id: 30, name: 'Wolf', stats: { attack: 9 } }),
            obs('relation', { type: 'realm_creature', realm_id: 20, creature_id: 30 }),
        ],
    });
    assert.equal(first.projected, 3);
    const run = await store.getRun(first.runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.summary.observations, 3);
    assert.deepEqual(JSON.parse((await db.query('SELECT creatures FROM realms WHERE id = 20'))[0].creatures), [30]);
    assert.equal(await count(db, 'realm_creatures'), 1);
    assert.equal(invalidations.n, 1);

    // A later observation changes one field; the others keep their values.
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 30, description: 'Grey' })] });
    const [wolf] = await db.query('SELECT name, description, stats FROM creatures WHERE id = 30');
    assert.deepEqual({ ...wolf, stats: JSON.parse(wolf.stats) }, { name: 'Wolf', description: 'Grey', stats: { attack: 9 } });

    // The same content seen again is one observation linked to both runs, and projects as unchanged.
    const again = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('realm', { name: 'Glade', min_level: 5, id: 20 })] });
    assert.equal(again.newObservations, 0);
    assert.equal(again.unchanged, 1);
    assert.equal(await count(db, "catalog_observations WHERE entity_kind = 'realm'"), 1);
    assert.equal(await count(db, 'catalog_run_observations ro JOIN catalog_observations o ON o.id = ro.observation_id WHERE o.entity_kind = ?', ['realm']), 2);
    const [entity] = await db.query("SELECT first_seen_at, last_seen_at, last_run_id FROM catalog_entities WHERE entity_kind = 'realm' AND entity_key = '20'");
    assert.equal(entity.last_run_id, again.runId);
});

test('AC-CAT-005 error case: a failed projection applies nothing and leaves a diagnosable failed run', async () => {
    const { db, store } = await setup();
    const recorded = await store.recordRun({
        mode: 'observe_realm', source: 'game_session', observations: [
            obs('realm', { id: 21, name: 'Marsh' }),
            obs('relation', { type: 'realm_creature', realm_id: 21, creature_id: 404 }), // creature 404 does not exist
        ],
    });
    const rev = await revision(db);
    await rejectsWith(store.projectRun(recorded.runId), 'projection_failed');
    assert.equal(await count(db, 'realms'), 0, 'the realm from the same run was rolled back');
    assert.equal(await count(db, 'catalog_entities'), 0);
    assert.equal(await revision(db), rev);
    const run = await store.getRun(recorded.runId);
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.summary, { error: { stage: 'projection', code: 'ER_NO_REFERENCED_ROW_2' } });
    assert.equal(await count(db, 'catalog_run_observations WHERE run_id = ?', [recorded.runId]), 2, 'provenance is kept');
    await rejectsWith(store.projectRun(recorded.runId), 'conflict');
});

// --- plans and rollback (AC-CAT-009, AC-CAT-010) ----------------------------------------------------

test('AC-CAT-010: rollback restores a legacy row exactly from its first-touch baseline', async () => {
    const { db, store, invalidations } = await setup();
    const legacyStats = '{ "attack": 120,"defense":4 }'; // stored text, deliberately not canonical
    await db.query("INSERT INTO items (id, name, rarity, stats, setId) VALUES (582558641, 'Cuirass of the Fallen', 'Epic', ?, 12)", [legacyStats]);
    const run = await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 582558641, name: 'Cuirass (renamed)', stats: { attack: 130 } })] });
    assert.equal(run.baselines, 1);
    assert.equal((await db.query('SELECT name FROM items WHERE id = 582558641'))[0].name, 'Cuirass (renamed)');

    const plan = await store.planRollback(run.runId);
    assert.deepEqual(plan.expectedCounts, { observations: 1, entities: 1, restore: 1, remove: 0, relations: 0, cascade: 0, orphaned: 0, rows: {} });
    const result = await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal(result.status, 'reverted');
    const [row] = await db.query('SELECT name, rarity, stats, setId, imageUrl FROM items WHERE id = 582558641');
    assert.deepEqual({ ...row, setId: Number(row.setId) }, { name: 'Cuirass of the Fallen', rarity: 'Epic', stats: legacyStats, setId: 12, imageUrl: null });
    assert.equal((await store.getRun(run.runId)).status, 'reverted');
    assert.deepEqual((await store.getRun(run.runId)).summary.revert.before.items, 1);
    assert.equal(invalidations.n, 2);
});

test('AC-CAT-010: rollback replays the provenance that remains, in observation order', async () => {
    const { db, store } = await setup();
    await db.query("INSERT INTO items (id, name, rarity) VALUES (1, 'Legacy', 'Common')");
    const a = await store.ingest({ mode: 'seed', source: 'manual_import', observations: [obs('item', { id: 1, name: 'From A' })] });
    await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 1, rarity: 'Rare' })] });
    const plan = await store.planRollback(a.runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.deepEqual({ ...(await db.query('SELECT name, rarity FROM items WHERE id = 1'))[0] }, { name: 'Legacy', rarity: 'Rare' });
});

test('AC-CAT-010 error case: entities with no earlier provenance are removed with every dependent relation', async () => {
    const { db, store } = await setup();
    await db.query("INSERT INTO realms (id, name, creatures) VALUES (40, 'Old realm', '[7]')");
    await db.query("INSERT INTO creatures (id, name) VALUES (7, 'Legacy beast')");
    await db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (40, 7)');
    const a = await store.ingest({
        mode: 'observe_realm', source: 'game_session', observations: [
            obs('creature', { id: 8, name: 'New beast' }),
            obs('item', { id: 900, name: 'Fang' }),
            obs('relation', { type: 'realm_creature', realm_id: 40, creature_id: 8 }),
            obs('relation', { type: 'creature_drop', creature_id: 8, item_id: 900 }),
        ],
    });
    assert.deepEqual(JSON.parse((await db.query('SELECT creatures FROM realms WHERE id = 40'))[0].creatures), [7, 8]);

    const plan = await store.planRollback(a.runId);
    assert.deepEqual(plan.expectedCounts, { observations: 4, entities: 4, restore: 0, remove: 4, relations: 2, cascade: 0, orphaned: 0, rows: { creatures: -1, items: -1, realm_creatures: -1, creature_drops: -1 } });
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal(await count(db, 'creatures WHERE id = 8'), 0);
    assert.equal(await count(db, 'items WHERE id = 900'), 0);
    assert.equal(await count(db, 'realm_creatures WHERE creature_id = 8'), 0);
    assert.equal(await count(db, 'creature_drops'), 0);
    assert.deepEqual(JSON.parse((await db.query('SELECT creatures FROM realms WHERE id = 40'))[0].creatures), [7], 'legacy view restored');
    assert.equal(await count(db, 'realm_creatures WHERE creature_id = 7'), 1, 'untouched legacy link kept');
    assert.equal(await count(db, 'catalog_entities'), 0);
});

test('AC-CAT-010: removing a realm cascades relics another run projected into it, with their provenance', async () => {
    const { db, store } = await setup();
    const a = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('realm', { id: 50, name: 'New realm' })] });
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('relic', { realm_id: 50, name: 'Idol' }), obs('quest', { realm_id: 50, name: 'Quest', min_level: 3 })] });
    const plan = await store.planRollback(a.runId);
    assert.deepEqual(plan.expectedCounts, { observations: 1, entities: 1, restore: 0, remove: 1, relations: 0, cascade: 2, orphaned: 0, rows: { realms: -1, relics: -1, quests: -1 } });
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal(await count(db, 'realms'), 0);
    assert.equal(await count(db, 'relics'), 0);
    assert.equal(await count(db, 'quests'), 0);
    assert.equal(await count(db, 'catalog_entities'), 0);
});

test('AC-CAT-009: a plan is a preview with exact counts, a short expiry, and no state change', async () => {
    const { db, store, clock } = await setup();
    const run = await store.ingest({ mode: 'seed', source: 'manual_import', observations: [obs('master_realm', { id: 3, name: 'Isles' })] });
    const rev = await revision(db);
    const plan = await store.planRollback(run.runId);
    assert.match(plan.id, /^[0-9a-f-]{36}$/);
    assert.equal(Date.parse(plan.expiresAt) - clock.t, PLAN_TTL_MS);
    assert.equal(plan.confirmation, `ROLLBACK ${run.runId.slice(0, 8)} 1`);
    assert.equal(await revision(db), rev);
    assert.equal(await count(db, 'master_realms'), 1);
    assert.equal((await store.getRun(run.runId)).status, 'succeeded');
});

test('AC-CAT-009 error case: expired, reused, stale, and unconfirmed plans are rejected and preserve data', async () => {
    const { db, store, clock } = await setup();
    const run = await store.ingest({ mode: 'seed', source: 'manual_import', observations: [obs('item', { id: 60, name: 'Keep me' })] });

    const wrong = await store.planRollback(run.runId);
    await rejectsWith(store.executePlan(wrong.id, { confirmation: 'ROLLBACK' }), 'plan_confirmation');
    await rejectsWith(store.executePlan(wrong.id, {}), 'plan_confirmation');

    const expired = await store.planRollback(run.runId);
    clock.t += PLAN_TTL_MS;
    await rejectsWith(store.executePlan(expired.id, { confirmation: expired.confirmation }), 'plan_expired');

    const stale = await store.planRollback(run.runId);
    await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 61, name: 'Other' })] });
    await rejectsWith(store.executePlan(stale.id, { confirmation: stale.confirmation }), 'plan_stale');

    await rejectsWith(store.executePlan('00000000-0000-4000-8000-000000000000', { confirmation: 'x' }), 'not_found');
    assert.equal(await count(db, 'items WHERE id = 60'), 1, 'no denial changed data');
    assert.equal((await store.getRun(run.runId)).status, 'succeeded');

    const good = await store.planRollback(run.runId);
    await store.executePlan(good.id, { confirmation: good.confirmation });
    await rejectsWith(store.executePlan(good.id, { confirmation: good.confirmation }), 'plan_used');
    await rejectsWith(store.planRollback(run.runId), 'conflict');
});

// --- jobs (AC-CAT-008, store side) ------------------------------------------------------------------

test('AC-CAT-008: one active job per kind; transitions and checkpoints are validated', async () => {
    const { store } = await setup();
    const id = await store.createJob({ kind: 'item_frontier', cursor: { nextItemId: 17049 }, requestBudget: 50 });
    await rejectsWith(store.createJob({ kind: 'item_frontier', cursor: { nextItemId: 1 }, requestBudget: 5 }), 'conflict');
    const realmJob = await store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 1 });

    await rejectsWith(store.checkpointJob(id, { nextItemId: 17050 }), 'conflict');   // only running jobs checkpoint
    assert.equal((await store.transitionJob(id, 'running')).state, 'running');
    await store.checkpointJob(id, { nextItemId: 17050, highestConfirmedItemId: 17048 });
    assert.deepEqual((await store.getJob(id)).cursor, { highestConfirmedItemId: 17048, nextItemId: 17050 });
    await rejectsWith(store.transitionJob(id, 'running'), 'conflict');   // not a transition
    // running -> queued is the collector's hand-back after an execution (CAT-TASK-003).
    assert.equal((await store.transitionJob(id, 'queued')).state, 'queued');
    await store.transitionJob(id, 'running');
    await store.transitionJob(id, 'completed');
    await rejectsWith(store.transitionJob(id, 'running'), 'conflict');
    await store.createJob({ kind: 'item_frontier', cursor: { nextItemId: 17050 }, requestBudget: 10 }); // the kind is free again

    await rejectsWith(store.createJob({ kind: 'attack', cursor: {}, requestBudget: 1 }), 'invalid');
    await rejectsWith(store.createJob({ kind: 'observe_realm', cursor: {}, requestBudget: 51 }), 'invalid');
    await rejectsWith(store.createJob({ kind: 'item_frontier', cursor: { url: 'https://x' }, requestBudget: 1 }), 'invalid');
    await rejectsWith(store.checkpointJob(realmJob, { nextItemId: -1 }), 'invalid');
});

// --- FK-safe serving writers and the legacy reload guard -------------------------------------------

test('CAT-TASK-002: bulkUpdateDatabase upserts, so rewriting a parent never cascades its relations away', async () => {
    const db = await ggdb.getConnection();
    await db.query("INSERT INTO realms (id, name) VALUES (70, 'R')");
    await quietly(() => ggdb.bulkUpdateDatabase('creatures', [{ id: 71, name: 'Before', description: 'kept' }]));
    await db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (70, 71)');
    await quietly(() => ggdb.bulkUpdateDatabase('creatures', [{ id: 71, name: 'After' }]));
    assert.equal(await count(db, 'realm_creatures WHERE creature_id = 71'), 1);
    assert.deepEqual({ ...(await db.query('SELECT name, description FROM creatures WHERE id = 71'))[0] }, { name: 'After', description: 'kept' });
    await db.query('DELETE FROM realms WHERE id = 70');
    await db.query('DELETE FROM creatures WHERE id = 71');
});

test('AC-CAT-006: populate_db refuses to replace catalog projections unless explicitly told to', async () => {
    const db = await ggdb.getConnection();
    const { main, DISCARD_FLAG } = await import('../../scripts/populate_db.mjs');
    const store = createCatalogStore(db, { invalidateCaches: () => {} });
    const run = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 80, name: 'Observed' })] });

    let fetched = 0;
    const sources = {
        master_realms: [{ id: 1, name: 'Master' }],
        all_realms: [{ id: 10, name: 'Realm', master_realm_id: 1, creatures: [80, 81, 999], relics: ['Idol'], quests: ['Q1'] }, { id: 11, name: 'Stray', master_realm_id: 42 }],
        all_creatures: [{ id: 80, name: 'Guide beast', drops: [{ id: 500 }] }, { id: 81, name: 'Other' }],
        all_items: [{ id: 500, name: 'Fang' }],
    };
    const fetchJson = async url => { fetched++; return sources[Object.keys(sources).find(k => url.includes(`${k}.json`))]; };

    await assert.rejects(quietly(() => main({ argv: [], fetchJson })), /--discard-catalog-projections/);
    assert.equal(fetched, 0, 'refused before fetching anything');
    assert.equal((await db.query('SELECT name FROM creatures WHERE id = 80'))[0].name, 'Observed');

    const counts = await quietly(() => main({ argv: [DISCARD_FLAG], fetchJson }));
    assert.equal(fetched, 4);
    assert.deepEqual({ realmCreatures: counts.realmCreatures, creatureDrops: counts.creatureDrops, quests: counts.quests, relics: counts.relics }, { realmCreatures: 2, creatureDrops: 1, quests: 1, relics: 1 });
    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 11'))[0].master_realm_id, null, 'unknown master realm -> NULL');
    assert.equal((await db.query('SELECT name FROM creatures WHERE id = 80'))[0].name, 'Guide beast');
    assert.equal(await store.hasDiscardableWork(), false);
    assert.equal((await store.getRun(run.runId)).status, 'discarded');
    await rejectsWith(store.planRollback(run.runId), 'conflict');
});

// --- review fixes (2026-09-28) ------------------------------------------------------------------

test('catalog-sync constraint: guide data never overwrites a field a game observation supplied', async () => {
    const { db, store } = await setup();
    const game = await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 90, name: 'Live name' })] });
    await store.ingest({ mode: 'seed', source: 'guide_baseline', observations: [obs('item', { id: 90, name: 'Guide name', rarity: 'Rare' })] });
    assert.deepEqual({ ...(await db.query('SELECT name, rarity FROM items WHERE id = 90'))[0] }, { name: 'Live name', rarity: 'Rare' }, 'guide fills only the fields the game did not supply');

    await store.ingest({ mode: 'seed', source: 'manual_import', observations: [obs('item', { id: 90, name: 'Owner name' })] });
    assert.equal((await db.query('SELECT name FROM items WHERE id = 90'))[0].name, 'Live name', 'a manual import does not outrank the game either');

    const plan = await store.planRollback(game.runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.deepEqual({ ...(await db.query('SELECT name, rarity FROM items WHERE id = 90'))[0] }, { name: 'Owner name', rarity: 'Rare' }, 'without the game run, the next-ranked source applies');
});

test('AC-CAT-006: the legacy reload rechecks for projections under the revision lock', async () => {
    const db = await ggdb.getConnection();
    const { main } = await import('../../scripts/populate_db.mjs');
    const store = createCatalogStore(db, { invalidateCaches: () => {} });
    await db.query('DELETE FROM catalog_entities'); // start from no projections, so the pre-fetch check passes
    let run;
    const fetchJson = async url => {
        if (!run) run = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 95, name: 'Seen during fetch' })] });
        return url.includes('master_realms') ? [{ id: 1, name: 'M' }] : [];
    };
    await assert.rejects(quietly(() => main({ argv: [], fetchJson })), /--discard-catalog-projections/);
    assert.equal((await db.query('SELECT name FROM creatures WHERE id = 95'))[0].name, 'Seen during fetch');
    assert.equal((await store.getRun(run.runId)).status, 'succeeded');
    assert.equal(await store.hasDiscardableWork(), true);
});

test('AC-CAT-010: a later rollback never restores a reference to a master realm that is gone', async () => {
    const { db, store } = await setup();
    const a = await store.ingest({ mode: 'seed', source: 'manual_import', observations: [obs('master_realm', { id: 7, name: 'Isles' })] });
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('realm', { id: 70, name: 'Shore', master_realm_id: 7 })] });
    const c = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('realm', { id: 70, name: 'Shore (renamed)' })] });

    let plan = await store.planRollback(a.runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 70'))[0].master_realm_id, null);

    plan = await store.planRollback(c.runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.deepEqual({ ...(await db.query('SELECT name, master_realm_id FROM realms WHERE id = 70'))[0] }, { name: 'Shore', master_realm_id: null });
    assert.equal(await count(db, 'realms WHERE master_realm_id IS NOT NULL AND master_realm_id NOT IN (SELECT id FROM master_realms)'), 0);

    // A new observation of the realm replays the old master ID too; it must not come back either.
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('realm', { id: 70, min_level: 9 })] });
    assert.equal((await db.query('SELECT master_realm_id FROM realms WHERE id = 70'))[0].master_realm_id, null);
});

test('AC-CAT-010: a relation whose parent is gone is not restored and stops being projected', async () => {
    const { db, store } = await setup();
    await db.query("INSERT INTO realms (id, name) VALUES (75, 'Keep')");
    const a = await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 76, name: 'Beast' })] });
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('relation', { type: 'realm_creature', realm_id: 75, creature_id: 76 })] });
    const c = await store.ingest({ mode: 'observe_realm', source: 'manual_import', observations: [obs('relation', { type: 'realm_creature', realm_id: 75, creature_id: 76 })] });
    let plan = await store.planRollback(a.runId);                // removes the creature and cascades the relation
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    plan = await store.planRollback(c.runId);                    // the relation's other provenance points at a missing creature
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal(await count(db, 'realm_creatures'), 0);
    assert.equal(await count(db, "catalog_entities WHERE entity_kind = 'relation'"), 0);
});

// --- review fixes, round 2 (2026-09-28) ---------------------------------------------------------

/** What populate_db does around a reload: discard under the lock, then replace the serving rows. */
async function reload(db, store, fn) {
    await db.transaction(async tx => {
        await store.discardProjections(tx, { allowDiscard: true });
        await fn(tx);
    });
}

test('AC-CAT-010: a discard retires baseline snapshots too, so pre-reload values never come back', async () => {
    const { db, store } = await setup();
    await db.query("INSERT INTO items (id, name, rarity) VALUES (1, 'Legacy', 'Epic')");
    await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 1, name: 'Live' })] });
    await reload(db, store, tx => tx.query('DELETE FROM items'));   // the reloaded snapshot no longer has item 1
    assert.equal(await count(db, "catalog_runs WHERE status = 'succeeded'"), 0, 'baseline runs are discarded with the rest');

    await store.ingest({ mode: 'item_frontier', source: 'game_session', observations: [obs('item', { id: 1, setId: 4 })] });
    const [row] = await db.query('SELECT name, rarity, setId FROM items WHERE id = 1');
    assert.deepEqual({ ...row, setId: Number(row.setId) }, { name: null, rarity: null, setId: 4 });
});

test('AC-CAT-006: a run recorded before a discard can no longer project after it', async () => {
    const { db, store } = await setup();
    const recorded = await store.recordRun({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 5, name: 'Pre-reload' })] });
    await reload(db, store, async () => {});
    assert.equal((await store.getRun(recorded.runId)).status, 'discarded');
    await rejectsWith(store.projectRun(recorded.runId), 'conflict');
    assert.equal(await count(db, 'creatures'), 0);
    assert.equal(await count(db, 'catalog_entities'), 0);
    assert.equal((await store.getRun(recorded.runId)).status, 'discarded', 'the refusal does not relabel it failed');
});

test('CAT-TASK-002: a maximum-length relic or quest name fits the entity-key columns', async () => {
    const { db, store } = await setup();
    await db.query("INSERT INTO realms (id, name) VALUES (9007199254740991, 'Far')");
    const name = 'N'.repeat(191);
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [obs('relic', { realm_id: 9007199254740991, name }), obs('quest', { realm_id: 9007199254740991, name })] });
    const keys = (await db.query('SELECT entity_key FROM catalog_entities')).map(r => r.entity_key);
    assert.deepEqual(keys, [`9007199254740991:${name}`, `9007199254740991:${name}`]);
    // SQLite ignores VARCHAR lengths, so pin the declared width against the longest possible key.
    const { MAX_ENTITY_KEY } = await import('../../_gg_data/handler/catalogStore.js');
    assert.ok(keys[0].length <= MAX_ENTITY_KEY);
    const ddl = (await import('node:fs')).readFileSync('_gg_data/migrations/003_catalog_sync.sql', 'utf8');
    assert.equal([...ddl.matchAll(/entity_key VARCHAR\((\d+)\)/g)].map(m => Number(m[1])).filter(n => n !== MAX_ENTITY_KEY).length, 0);
});

test('AC-CAT-006: a reload without the discard flag refuses to cancel a recorded run', async () => {
    const { db, store } = await setup();
    const recorded = await store.recordRun({ mode: 'observe_realm', source: 'game_session', observations: [obs('creature', { id: 6, name: 'Pending' })] });
    assert.equal(await count(db, 'catalog_entities'), 0, 'nothing is projected yet');
    await rejectsWith(db.transaction(tx => store.discardProjections(tx, { allowDiscard: false })), 'conflict');
    assert.equal((await store.getRun(recorded.runId)).status, 'running');
    await store.projectRun(recorded.runId);
    assert.equal((await db.query('SELECT name FROM creatures WHERE id = 6'))[0].name, 'Pending');
});

test('CAT-TASK-002: a database that applied the narrow 003 gets 255-character entity keys from 005', async () => {
    const fsm = await import('node:fs');
    const dir = path.join(tmp, 'narrow003');
    fsm.mkdirSync(dir, { recursive: true });
    for (const f of ['001_initial_schema.sql', '002_control_plane.sql']) copyFileSync(path.resolve('_gg_data/migrations', f), path.join(dir, f));
    const current = fsm.readFileSync(path.resolve('_gg_data/migrations/003_catalog_sync.sql'), 'utf8');
    const narrow = current.replace(/entity_key VARCHAR\(255\)/g, 'entity_key VARCHAR(191)');
    assert.notEqual(narrow, current);
    fsm.writeFileSync(path.join(dir, '003_catalog_sync.sql'), narrow);   // the first, released-to-branch version
    const db = await quietly(() => freshClient({ migrate: false }));
    await quietly(() => runMigrations(db, dir));
    const applied = await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations')));
    assert.deepEqual(applied, ['004_serving_relations.mjs', '005_catalog_key_width.sql', '006_catalog_discovery.sql', '007_catalog_discovery_columns.mjs', '008_catalog_relay.sql', '009_guide_repeated_page.mjs', '010_guide_full_index_scan.sql', '011_master_realm_connections.mjs', '012_media_host.mjs'], '003 is skipped by name; 005 widens it');
    if (REAL_MYSQL) {
        const widths = await db.query("SELECT TABLE_NAME AS t, CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'entity_key' ORDER BY TABLE_NAME");
        assert.deepEqual(widths.map(w => [w.t, Number(w.n)]), [['catalog_entities', 255], ['catalog_observations', 255]]);
    }
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), [], 'idempotent');
});
