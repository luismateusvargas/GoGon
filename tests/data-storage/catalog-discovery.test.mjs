// tests/data-storage/catalog-discovery.test.mjs - CAT-TASK-009 / AC-CAT-011, AC-CAT-012, AC-CAT-013, AC-CAT-015
// Migrations 006/007, guide discovery state, per-ID refresh metadata, the guide daily counter, and
// completeness through projection and rollback. Fake MySQL by default; real MySQL with
// GG_TEST_MYSQL_URL (the CHECK replacement on an upgraded database runs there only).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshClient, closeClients } from '../helpers/db-client.mjs';

const { createCatalogStore, CatalogError } = await import('../../_gg_data/handler/catalogStore.js');
const { createGuideDiscoveryStore } = await import('../../_gg_data/handler/guideDiscoveryStore.js');
const { runMigrations } = await import('../../_gg_data/handler/migrationRunner.js');
const { GUIDE_POLICY } = await import('../../catalog/contracts/policy.js');
const REAL_MYSQL = globalThis.__GG_TEST_DATABASE__ === 'mysql';

after(() => closeClients());

async function quietly(fn) {
    const saved = { log: console.log, warn: console.warn };
    console.log = console.warn = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
}

async function setup() {
    const db = await quietly(() => freshClient());
    const clock = { t: Date.parse('2026-09-28T12:00:00.000Z') };
    const now = () => clock.t;
    const store = createCatalogStore(db, { now, invalidateCaches: () => {} });
    const guide = createGuideDiscoveryStore(db, { now });
    return { db, store, guide, clock };
}

const entity = async (db, kind, key) => (await db.query('SELECT completeness, incomplete_reason, verified_at FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [kind, String(key)]))[0];
const guideRun = (store, observations) => store.ingest({ mode: 'guide_discovery', source: 'guide_baseline', observations });

test('CAT-TASK-009: migrations 006/007 add discovery state, completeness columns, and guide_discovery; re-run is a no-op', async () => {
    const { db, store, guide } = await setup();
    assert.deepEqual((await guide.listStates()).map(s => s.entityKind), ['creature', 'item', 'master_realm', 'realm']);
    const s = await guide.getState('item');
    assert.equal(s.lastSeenId, 0);
    assert.equal(s.lastSuccessfulCheckAt, null);
    assert.equal(s.orderState, 'attested');
    assert.equal(s.status, 'idle');
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), []);
    const r = await guideRun(store, [{ kind: 'item', payload: { id: 1, name: 'A' } }]);
    assert.equal((await store.getRun(r.runId)).mode, 'guide_discovery');
    const job = await store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 50 });
    assert.equal((await store.getJob(job)).kind, 'guide_discovery');
    await assert.rejects(store.createJob({ kind: 'guide_discovery', cursor: {}, requestBudget: 50 }), e => e instanceof CatalogError && e.code === 'conflict');
    await assert.rejects(db.query("UPDATE catalog_entities SET completeness = 'maybe'"), e => e.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
});

test('CAT-TASK-013: migration 010 restarts an old incremental cursor without losing known IDs', async () => {
    const { db, guide } = await setup();
    await guide.recordIndexIds('realm', [1200]);
    await guide.updateState('realm', {
        lastSeenId: 1200, lastSuccessfulCheckAt: '2026-09-28T12:00:00.000Z',
        lastFullSweepAt: '2026-09-28T12:00:00.000Z', lastPageSeen: 288,
        sweepMode: 'incremental', nextPage: 287, sweepPagesChecked: 1, status: 'running',
        sweepPrevPageIds: [1200],
    });
    await db.query('DELETE FROM schema_migrations WHERE version = ?', ['010_guide_full_index_scan.sql']);
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), ['010_guide_full_index_scan.sql']);

    const checkpoint = await guide.getState('realm');
    assert.deepEqual([checkpoint.sweepMode, checkpoint.nextPage, checkpoint.lastSuccessfulCheckAt,
        checkpoint.lastPageSeen, checkpoint.orderState], [null, 0, '2026-09-28T12:00:00.000Z', 288, 'attested']);
    assert.equal(checkpoint.lastFullSweepAt, '2026-09-28T12:00:00.000Z');
    assert.equal(checkpoint.lastSeenId, 1200);
    assert.ok(await guide.getIdState('realm', 1200));
});

test('migration 011 queues old master-realm details for the new connection projection', async () => {
    const { db, guide } = await setup();
    await guide.registerIds('master_realm', [5]);
    await db.query("UPDATE catalog_guide_ids SET detail_status = 'ok', detail_hash = ?, next_detail_at = ? WHERE entity_kind = 'master_realm' AND entity_id = 5", ['a'.repeat(64), '2026-10-28T12:00:00.000Z']);
    await db.query('DELETE FROM schema_migrations WHERE version = ?', ['011_master_realm_connections.mjs']);
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), ['011_master_realm_connections.mjs']);
    const [detail] = await db.query("SELECT detail_hash, next_detail_at FROM catalog_guide_ids WHERE entity_kind = 'master_realm' AND entity_id = 5");
    assert.deepEqual(detail, { detail_hash: null, next_detail_at: '1970-01-01T00:00:00.000Z' });
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), []);
});

test('CAT-TASK-009 (real MySQL): 007 replaces the 003 CHECKs and re-adds columns on an upgraded database', { skip: !REAL_MYSQL && 'CHECK replacement runs on MySQL only' }, async () => {
    const { db } = await setup();
    // Put the database back in its pre-007 shape: the original 003 CHECKs and no new columns.
    const checks = await db.query(`SELECT tc.TABLE_NAME AS t, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
        JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME IN ('catalog_runs', 'catalog_jobs') AND tc.CONSTRAINT_TYPE = 'CHECK'`);
    for (const c of checks.filter(c => /guide_discovery/.test(c.clause))) await db.query(`ALTER TABLE ${c.t} DROP CHECK \`${c.name}\``);
    // MySQL refuses to drop a column a CHECK still uses (ER 3959), so the completeness CHECK goes first.
    const entityChecks = await db.query(`SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
        JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'catalog_entities' AND tc.CONSTRAINT_TYPE = 'CHECK'`);
    for (const c of entityChecks.filter(c => /completeness/.test(c.clause))) await db.query(`ALTER TABLE catalog_entities DROP CHECK \`${c.name}\``);
    await db.query("ALTER TABLE catalog_runs ADD CONSTRAINT catalog_runs_chk_1 CHECK (mode IN ('observe_realm', 'item_frontier', 'seed', 'promote', 'revert', 'baseline_snapshot'))");
    await db.query("ALTER TABLE catalog_jobs ADD CONSTRAINT catalog_jobs_chk_1 CHECK (kind IN ('observe_realm', 'item_frontier'))");
    for (const col of ['completeness', 'incomplete_reason', 'verified_at']) await db.query(`ALTER TABLE catalog_entities DROP COLUMN ${col}`);
    await db.query("DELETE FROM schema_migrations WHERE version = '007_catalog_discovery_columns.mjs'");
    await assert.rejects(db.query("INSERT INTO catalog_runs (id, mode, source, status, started_at) VALUES ('x', 'guide_discovery', 'guide_baseline', 'running', 'now')"));

    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), ['007_catalog_discovery_columns.mjs']);
    await db.query("INSERT INTO catalog_runs (id, mode, source, status, started_at) VALUES ('x', 'guide_discovery', 'guide_baseline', 'running', 'now')");
    await db.query("INSERT INTO catalog_jobs (id, kind, cursor_json, state, request_budget, created_at, updated_at) VALUES ('j', 'guide_discovery', '{}', 'queued', 5, 'now', 'now')");
    await db.query("UPDATE catalog_entities SET completeness = 'complete', incomplete_reason = NULL, verified_at = NULL");
    await assert.rejects(db.query("INSERT INTO catalog_runs (id, mode, source, status, started_at) VALUES ('y', 'attack', 'guide_baseline', 'running', 'now')"));
    // And a second run changes nothing.
    await db.query("DELETE FROM schema_migrations WHERE version = '007_catalog_discovery_columns.mjs'");
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), ['007_catalog_discovery_columns.mjs']);

    // An upgrade that lost the allow-list (the old CHECK dropped, the new one never added) gets it back on re-run.
    await db.query('ALTER TABLE catalog_runs DROP CHECK catalog_runs_mode_chk');
    await db.query("DELETE FROM schema_migrations WHERE version = '007_catalog_discovery_columns.mjs'");
    await db.query("INSERT INTO catalog_runs (id, mode, source, status, started_at) VALUES ('z', 'attack', 'guide_baseline', 'running', 'now')");
    await db.query("DELETE FROM catalog_runs WHERE id = 'z'");
    assert.deepEqual(await quietly(() => runMigrations(db, path.resolve('_gg_data/migrations'))), ['007_catalog_discovery_columns.mjs']);
    await assert.rejects(db.query("INSERT INTO catalog_runs (id, mode, source, status, started_at) VALUES ('z', 'attack', 'guide_baseline', 'running', 'now')"));
});

test('CAT-TASK-009: 007 replaces an old allow-list in one statement and restores a missing one', async () => {
    const { up, RUN_MODES_CHECK } = await import('../../_gg_data/migrations/007_catalog_discovery_columns.mjs');
    const run = async checks => {
        const sql = [];
        const client = { async query(s, p) { sql.push(s.replace(/\s+/g, ' ')); return /information_schema/.test(s) ? checks[p[0]] ?? [] : []; } };
        await quietly(() => up(client));
        return sql.filter(s => /DROP CHECK|ADD CONSTRAINT/.test(s));
    };
    const old = { catalog_runs: [{ name: 'catalog_runs_chk_1', clause: "mode in ('observe_realm','seed')" }], catalog_jobs: [{ name: 'catalog_jobs_chk_1', clause: "kind in ('observe_realm')" }] };
    const replaced = await run(old);
    assert.equal(replaced.length, 2, 'one ALTER per table: the drop is never separate from the add');
    assert.match(replaced[0], /^ALTER TABLE catalog_runs DROP CHECK `catalog_runs_chk_1`, ADD CONSTRAINT catalog_runs_mode_chk CHECK/);
    assert.deepEqual(await run({ catalog_runs: [], catalog_jobs: [{ name: 'catalog_jobs_kind_chk', clause: "kind in ('observe_realm','guide_discovery')" }] }),
        [`ALTER TABLE catalog_runs ADD CONSTRAINT catalog_runs_mode_chk CHECK (${RUN_MODES_CHECK})`],
        'an interrupted upgrade that lost the CHECK gets it back; a current one is left alone');
});

test('CAT-TASK-009: a fresh database lists its allow-list CHECKs, so 007 has nothing to replace', async () => {
    const { db } = await setup();
    const rows = await db.query(`SELECT tc.TABLE_NAME AS t, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
        JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME IN ('catalog_runs', 'catalog_jobs') AND tc.CONSTRAINT_TYPE = 'CHECK'`);
    for (const t of ['catalog_runs', 'catalog_jobs']) {
        const allowList = rows.filter(r => r.t === t && /observe_realm/.test(r.clause));
        assert.equal(allowList.length, 1, t);
        assert.match(allowList[0].clause, /guide_discovery/, t);
    }
});

test('CAT-TASK-009 / AC-CAT-011: index IDs become pending details; details refresh by due time; hash changes are detected', async () => {
    const { guide, clock } = await setup();
    assert.deepEqual(await guide.recordIndexIds('item', [30, 20, 10]), [30, 20, 10]);
    assert.deepEqual(await guide.recordIndexIds('item', [31, 30]), [31], 'known IDs are not new; the max ID is not an exclusion rule');
    assert.deepEqual(await guide.dueDetails('item', 10), [10, 20, 30, 31]);
    assert.deepEqual((await guide.markDetail('item', 10, { outcome: 'ok', hash: 'a'.repeat(64) }, GUIDE_POLICY)), { changed: true });
    assert.deepEqual(await guide.dueDetails('item', 10), [20, 30, 31], 'a fresh detail is not due');
    clock.t += GUIDE_POLICY.detailRefreshAfterMs;
    assert.deepEqual((await guide.dueDetails('item', 10))[3], 10, 'refreshes come after never-read IDs');
    assert.deepEqual(await guide.markDetail('item', 10, { outcome: 'ok', hash: 'a'.repeat(64) }, GUIDE_POLICY), { changed: false }, 'same content');
    clock.t += GUIDE_POLICY.detailRefreshAfterMs;
    assert.deepEqual(await guide.markDetail('item', 10, { outcome: 'ok', hash: 'b'.repeat(64) }, GUIDE_POLICY), { changed: true }, 'an edited older record is detected (AC-CAT-012)');
    await assert.rejects(guide.recordIndexIds('item', [0]));
    await assert.rejects(guide.recordIndexIds('shop', [1]));
    assert.deepEqual((await guide.coverage()).item, { pending: 3, ok: 1, failed: 0, missing: 0 });
});

test('CAT-TASK-009: failed details back off and become failed after the attempt limit', async () => {
    const { guide, clock } = await setup();
    await guide.recordIndexIds('creature', [7]);
    for (let i = 1; i < GUIDE_POLICY.maxDetailAttempts; i++) {
        await guide.markDetail('creature', 7, { outcome: 'failed' }, GUIDE_POLICY);
        const s = await guide.getIdState('creature', 7);
        assert.equal(s.status, 'pending');
        assert.equal(s.attempts, i);
        assert.equal(Date.parse(s.nextDetailAt) - clock.t, 3600_000 * 2 ** (i - 1));
    }
    await guide.markDetail('creature', 7, { outcome: 'failed' }, GUIDE_POLICY);
    assert.equal((await guide.getIdState('creature', 7)).status, 'failed');
});

test('CAT-TASK-009 / AC-CAT-015: the guide daily counter is per UTC day', async () => {
    const { guide, clock } = await setup();
    assert.equal(await guide.usage(), 0);
    await guide.addUsage(40);
    await guide.addUsage(10);
    assert.equal(await guide.usage(), 50);
    clock.t += 24 * 3600_000;
    assert.equal(await guide.usage(), 0);
    await assert.rejects(guide.addUsage(-1));
});

test('CAT-TASK-009 / AC-CAT-013: completeness follows guide detail status and known drops through projection and rollback', async () => {
    const { db, store, guide } = await setup();
    // A minimal record from an index page: incomplete until its detail is read.
    await guide.recordIndexIds('item', [17048]);
    await guideRun(store, [{ kind: 'item', payload: { id: 17048, name: 'Montmarr Helm' } }]);
    assert.deepEqual({ ...(await entity(db, 'item', 17048)) }, { completeness: 'incomplete', incomplete_reason: 'guide_detail_missing', verified_at: null });

    // A creature whose detail lists a drop the catalog does not have yet.
    await guide.markDetail('creature', 7001, { outcome: 'ok', hash: 'c'.repeat(64) }, GUIDE_POLICY);
    const checkedAt = (await guide.getIdState('creature', 7001)).checkedAt;
    await guideRun(store, [{ kind: 'creature', payload: { id: 7001, name: 'Montmarr the Dragon Golem', stats: { level: 1250 }, droppedItems: [{ itemId: 17048 }, { itemId: 99999 }] } }]);
    assert.deepEqual({ ...(await entity(db, 'creature', 7001)) }, { completeness: 'incomplete', incomplete_reason: 'known_drop_unresolved', verified_at: checkedAt });

    // The missing drop arrives: the waiting creature is rechecked without being re-observed.
    const drop = await guideRun(store, [{ kind: 'item', payload: { id: 99999, name: 'Unlisted Relic Blade' } }]);
    assert.equal((await entity(db, 'creature', 7001)).completeness, 'complete');

    // An item whose detail is valid and whose "Dropped By" names resolve (class suffix stripped).
    await guide.markDetail('item', 17048, { outcome: 'ok', hash: 'd'.repeat(64) }, GUIDE_POLICY);
    await guideRun(store, [{ kind: 'item', payload: { id: 17048, name: 'Montmarr Helm', droppedBy: [{ creatureName: 'Montmarr the Dragon Golem (Dragon LE)', dropRate: 0.5 }] } }]);
    assert.equal((await entity(db, 'item', 17048)).completeness, 'complete');
    await guideRun(store, [{ kind: 'item', payload: { id: 17048, name: 'Montmarr Helm', droppedBy: [{ creatureName: 'Unknown Wisp', dropRate: 2 }] } }]);
    assert.equal((await entity(db, 'item', 17048)).incomplete_reason, 'known_drop_unresolved');

    // Game identity only: incomplete, never complete by default.
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [{ kind: 'creature', payload: { id: 7100, name: 'Ridge Hawk' } }] });
    assert.deepEqual({ ...(await entity(db, 'creature', 7100)) }, { completeness: 'incomplete', incomplete_reason: 'guide_detail_missing,required_field_missing', verified_at: null });

    // Rolling back the run that brought the drop makes the creature incomplete again.
    const plan = await store.planRollback(drop.runId);
    await store.executePlan(plan.id, { confirmation: plan.confirmation });
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM items WHERE id = 99999'))[0].n, 0);
    assert.equal((await entity(db, 'creature', 7001)).incomplete_reason, 'known_drop_unresolved');

    // Realms and other kinds carry no completeness.
    await guideRun(store, [{ kind: 'realm', payload: { id: 1200, name: 'Mountain Path' } }]);
    assert.equal((await entity(db, 'realm', 1200)).completeness, null);
    // A failed detail after the retry limit is reported as such.
    await guide.recordIndexIds('item', [5]);
    for (let i = 0; i < GUIDE_POLICY.maxDetailAttempts; i++) await guide.markDetail('item', 5, { outcome: 'failed' }, GUIDE_POLICY);
    await guideRun(store, [{ kind: 'item', payload: { id: 5, name: 'Five' } }]);
    assert.equal((await entity(db, 'item', 5)).incomplete_reason, 'guide_detail_failed');
    // Item 5 itself, plus creature 7001, which still waits on an unresolved drop; the realm is skipped.
    assert.equal(await store.refreshCompleteness([['item', '5'], ['realm', '1200']]), 2);
});
