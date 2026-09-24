// tests/data-storage/operations.test.mjs - DATA-TASK-003/004/005 / AC-DATA-001, AC-DATA-002, AC-DATA-005, AC-DATA-007, AC-DATA-008
// Runs on the in-process MySQL fake by default, or on a real MySQL when GG_TEST_MYSQL_URL is set
// (tests/helpers/test-database.mjs). Each test process starts with an empty database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const db = await import('../../_gg_data/handler/gg_database.js');
const { runMigrations, splitStatements } = await import('../../_gg_data/handler/migrationRunner.js');
const { createMysqlClient, mysqlOptions } = await import('../../_gg_data/handler/mysqlClient.js');
const { itemCache, creatureCache, realmCache } = await import('../../_gg_data/handler/cacheLayer.js');
const FAKE = globalThis.__GG_TEST_DATABASE__ === 'fake';
const fake = FAKE ? await import('../helpers/fake-mysql.mjs') : null;

const tmp = mkdtempSync(path.join(tmpdir(), 'gg-db-ops-'));
const extraClients = [];
after(async () => {
    for (const c of extraClients) await c.close();
    await db.closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
});

async function quietly(fn) {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const lines = [];
    console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
    try { return { result: await fn(), lines }; } finally { Object.assign(console, saved); }
}

/** A client on its own, empty database (so custom migrations do not mix with the project ones). */
let dbn = 0;
async function isolatedClient() {
    const shared = await db.getConnection();
    const name = `${mysqlOptions().database}_mig${++dbn}`;
    await shared.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
    const c = createMysqlClient({ ...mysqlOptions(), database: name });
    extraClients.push(c);
    return c;
}

const tableExists = (client, table) => client.query(`SELECT COUNT(*) AS n FROM ${table}`).then(() => true, () => false);
const versions = async client => (await client.query('SELECT version FROM schema_migrations ORDER BY id')).map(r => r.version);
const sql = async (text, params) => (await db.getConnection()).query(text, params);

// --- AC-DATA-001: migrations ---------------------------------------------------------------------

test('AC-DATA-001: splitStatements drops comments and keeps quoted semicolons', () => {
    const parts = splitStatements("-- header; not a statement\nCREATE TABLE a (x TEXT); /* c; */ INSERT INTO a VALUES ('x;y');\n");
    assert.deepEqual(parts, ['CREATE TABLE a (x TEXT)', "INSERT INTO a VALUES ('x;y')"]);
});

test('AC-DATA-001: a new database gets schema_migrations and every pending migration in order', async () => {
    const client = await isolatedClient();
    const dir = mkdtempSync(path.join(tmp, 'mig-'));
    writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE IF NOT EXISTS second (id BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB;');
    writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE IF NOT EXISTS first (id BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB;');
    writeFileSync(path.join(dir, 'README.md'), 'not a migration');
    await quietly(() => runMigrations(client, dir));
    assert.deepEqual(await versions(client), ['001_first.sql', '002_second.sql']);
    // Re-running applies nothing new.
    const { result } = await quietly(() => runMigrations(client, dir));
    assert.deepEqual(result, []);
    assert.equal((await client.query('SELECT COUNT(*) AS n FROM schema_migrations'))[0].n, 2);
});

test('AC-DATA-001: an invalid migration stops, is not recorded, logs, and re-runs once fixed', async () => {
    const client = await isolatedClient();
    const dir = mkdtempSync(path.join(tmp, 'mig-bad-'));
    writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE IF NOT EXISTS ok (id BIGINT NOT NULL PRIMARY KEY);');
    await quietly(() => runMigrations(client, dir));
    writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE IF NOT EXISTS half (id BIGINT);\nTHIS IS NOT SQL;\nCREATE TABLE IF NOT EXISTS after_bad (id BIGINT);');
    await assert.rejects(() => quietly(() => runMigrations(client, dir)));
    assert.equal(await tableExists(client, 'ok'), true);
    assert.equal(await tableExists(client, 'after_bad'), false, 'statements after the failure never run');
    assert.deepEqual(await versions(client), ['001_ok.sql']);

    // Fixed file: idempotent statements re-run cleanly and the version is recorded.
    writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE IF NOT EXISTS half (id BIGINT);\nCREATE TABLE IF NOT EXISTS after_bad (id BIGINT);');
    await quietly(() => runMigrations(client, dir));
    assert.deepEqual(await versions(client), ['001_ok.sql', '002_bad.sql']);
    assert.equal(await tableExists(client, 'after_bad'), true);
});

test('AC-DATA-001: a failed migration logs the file name', async () => {
    const client = await isolatedClient();
    const dir = mkdtempSync(path.join(tmp, 'mig-log-'));
    writeFileSync(path.join(dir, '001_broken.sql'), 'THIS IS NOT SQL;');
    const { result: error, lines } = await quietly(() => runMigrations(client, dir).then(() => null, e => e));
    assert.ok(error, 'the run rejects');
    assert.ok(lines.some(l => l.includes('Failed to apply migration 001_broken.sql')));
});

test('AC-DATA-001: the project migrations create the expected tables, once per process', async () => {
    assert.equal(db.initDatabase(), db.initDatabase(), 'concurrent callers share one migration run');
    const client = await db.getConnection();
    for (const t of ['key_value_store', 'items', 'creatures', 'master_realms', 'realms', 'relics', 'schema_migrations',
        'config_overrides', 'module_preferences', 'account_profiles', 'audit_events']) {
        assert.ok(await tableExists(client, t), `missing table ${t}`);
    }
    assert.deepEqual(await versions(client), ['001_initial_schema.sql', '002_control_plane.sql']);
});

// --- AC-DATA-002: FIFO lists -----------------------------------------------------------------------

test('AC-DATA-002: setContent appends and trims the oldest items past maxSize', async () => {
    for (let i = 1; i <= 5; i++) await db.setContent('fifo', String(i), 3);
    assert.deepEqual(JSON.parse(await db.getContent('fifo')), ['3', '4', '5']);
});

test('AC-DATA-002: setContent defaults to a 100-item cap', async () => {
    for (let i = 0; i < 105; i++) await db.setContent('fifo_default', i);
    const list = JSON.parse(await db.getContent('fifo_default'));
    assert.equal(list.length, 100);
    assert.equal(list[0], 5);
});

test('AC-DATA-002: concurrent setContent calls on one key lose no item', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => db.setContent('fifo_concurrent', i, 100)));
    const list = JSON.parse(await db.getContent('fifo_concurrent'));
    assert.deepEqual([...list].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});

test('AC-DATA-002: corrupted or non-array stored JSON is reset with a warning', async () => {
    await db.setObject('corrupt', { not: 'a list' });
    let { lines } = await quietly(() => db.setContent('corrupt', 'a'));
    assert.deepEqual(JSON.parse(await db.getContent('corrupt')), ['a']);
    assert.ok(lines.some(l => l.includes('corrupt')));

    await sql('REPLACE INTO key_value_store (`key`, `value`) VALUES (?, ?)', ['broken', '{not json']);
    ({ lines } = await quietly(() => db.setContent('broken', 'b')));
    assert.deepEqual(JSON.parse(await db.getContent('broken')), ['b']);
    assert.ok(lines.some(l => l.includes('broken')));
});

test('AC-DATA-002: keys are exact and case-sensitive', async () => {
    await db.setObject('CaseKey', 'upper');
    await db.setObject('casekey', 'lower');
    assert.equal(await db.getObject('CaseKey', ''), 'upper');
    assert.equal(await db.getObject('casekey', ''), 'lower');
});

// --- AC-DATA-005: LRU cache ------------------------------------------------------------------------

test('AC-DATA-005: lookups query MySQL once, then serve from cache without a database query', async () => {
    db.clearDatabaseCaches();
    await sql('REPLACE INTO items (id, name, stats) VALUES (?, ?, ?)', [582558641, 'Cuirass of the Fallen', '{"attack":120}']);
    await sql('REPLACE INTO creatures (id, name) VALUES (?, ?)', [1542, 'Chupacabra (Super Elite)']);
    await sql('REPLACE INTO realms (id, name, creatures) VALUES (?, ?, ?)', [412, 'Eldham (North)', '[1542]']);

    const item = await db.getItemById(582558641);
    assert.deepEqual(item.stats, { attack: 120 });
    const creature = await db.getCreatureById(1542);
    const realm = await db.getRealmById(412);
    assert.deepEqual(realm.creatures, [1542]);

    // Remove the rows behind the cache: a second lookup must not touch the database.
    await sql('DELETE FROM items WHERE id = ?', [582558641]);
    await sql('DELETE FROM creatures WHERE id = ?', [1542]);
    await sql('DELETE FROM realms WHERE id = ?', [412]);
    const before = fake?.fakeMysql.statements.length;
    assert.equal(await db.getItemById(582558641), item);
    assert.equal(await db.getCreatureById(1542), creature);
    assert.equal(await db.getRealmById(412), realm);
    if (fake) assert.equal(fake.fakeMysql.statements.length, before, 'no statement ran for cache hits');

    db.clearDatabaseCaches();
    assert.equal(await db.getItemById(582558641), undefined);
});

test('AC-DATA-005: a missing ID resolves undefined and the miss is not cached', async () => {
    db.clearDatabaseCaches();
    assert.equal(await db.getItemById(999), undefined);
    assert.equal(await db.getCreatureById(999), undefined);
    assert.equal(await db.getRealmById(999), undefined);
    assert.equal(itemCache.has('item:999'), false);
    assert.equal(creatureCache.has('creature:999'), false);
    assert.equal(realmCache.has('realm:999'), false);
    // Once the row appears, the next lookup finds it.
    await sql('INSERT INTO creatures (id, name) VALUES (?, ?)', [999, 'Late Arrival']);
    assert.equal((await db.getCreatureById(999)).name, 'Late Arrival');
});

test('AC-DATA-005: the LRU evicts the least recently used entry at capacity', () => {
    db.clearDatabaseCaches();
    const { maxSize } = realmCache;
    for (let i = 0; i < maxSize; i++) realmCache.set(`realm:${i}`, i);
    realmCache.get('realm:0');            // touch the oldest
    realmCache.set('realm:new', 'x');     // evicts realm:1, not realm:0
    assert.equal(realmCache.has('realm:0'), true);
    assert.equal(realmCache.has('realm:1'), false);
    assert.equal(realmCache.cache.size, maxSize);
    db.clearDatabaseCaches();
});

test('bulkUpdateDatabase replaces rows in chunks and stores nested values as JSON', async () => {
    const rows = Array.from({ length: 1203 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}`, stats: { attack: i } }));
    await quietly(() => db.bulkUpdateDatabase('items', rows));
    await quietly(() => db.bulkUpdateDatabase('items', [{ id: 7, name: 'Renamed', stats: null }]));
    db.clearDatabaseCaches();
    assert.equal((await sql('SELECT COUNT(*) AS n FROM items WHERE id <= 1203'))[0].n, 1203);
    assert.deepEqual((await db.getItemById(1203)).stats, { attack: 1202 });
    assert.equal((await db.getItemById(7)).name, 'Renamed');
    await quietly(() => db.clearTable('items'));
    assert.equal((await sql('SELECT COUNT(*) AS n FROM items'))[0].n, 0);
    db.clearDatabaseCaches();
});

test('clearTable and bulkUpdateDatabase reject tables and columns outside the allow-list', async () => {
    await assert.rejects(() => db.bulkUpdateDatabase('sqlite_master; DROP TABLE items', [{ id: 1 }]), /Invalid table name/);
    await assert.rejects(() => db.bulkUpdateDatabase('items', [{ id: 1, 'name) VALUES (1); --': 'x' }]), /Invalid column name/);
    const { lines } = await quietly(() => db.clearTable('schema_migrations'));
    assert.ok(lines.some(l => l.includes('Invalid table name')));
});

// --- AC-DATA-007: connection configuration ---------------------------------------------------------

test('AC-DATA-007: pool options come from the registry settings, bounded and single-statement', () => {
    const saved = { ...process.env };
    try {
        Object.assign(process.env, { GG_MYSQL_HOST: 'mysql', GG_MYSQL_PORT: '3307', GG_MYSQL_USER: 'bot', GG_MYSQL_PASSWORD: 'pw-fixture', GG_MYSQL_DATABASE: 'gg' });
        const o = mysqlOptions();
        assert.deepEqual({ host: o.host, port: o.port, user: o.user, database: o.database }, { host: 'mysql', port: 3307, user: 'bot', database: 'gg' });
        assert.equal(o.connectionLimit, 5);
        assert.equal(o.multipleStatements, false);
        assert.equal(o.charset, 'utf8mb4');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('AC-DATA-007: a missing password is rejected by name, without a connection attempt', () => {
    const saved = process.env.GG_MYSQL_PASSWORD;
    process.env.GG_MYSQL_PASSWORD = '';
    try {
        assert.throws(() => mysqlOptions(), /GG_MYSQL_PASSWORD is not set/);
    } finally { process.env.GG_MYSQL_PASSWORD = saved; }
});

test('AC-DATA-007: an unreachable server is reported by host:port, never with the password', { skip: !FAKE && 'needs the fake to simulate an outage' }, async () => {
    const options = { ...mysqlOptions(), host: 'db.invalid', port: 3399, password: 'unreachable-password-fixture' };
    const client = createMysqlClient(options);
    extraClients.push(client);
    fake.fakeMysql.unavailable = 'ECONNREFUSED';
    try {
        for (const attempt of [() => client.query('SELECT 1'), () => client.transaction(async tx => tx.query('SELECT 1'))]) {
            await assert.rejects(attempt, e => {
                assert.match(e.message, /MySQL at db\.invalid:3399 is unreachable \(ECONNREFUSED\)/);
                assert.ok(!e.message.includes('unreachable-password-fixture'));
                return true;
            });
        }
    } finally { fake.fakeMysql.unavailable = null; }
});

test('AC-DATA-007: a failed transaction rolls back every statement', async () => {
    const client = await db.getConnection();
    await assert.rejects(() => client.transaction(async tx => {
        await tx.query('REPLACE INTO key_value_store (`key`, `value`) VALUES (?, ?)', ['tx_probe', '"written"']);
        throw new Error('abort');
    }), /abort/);
    assert.equal(await db.getContent('tx_probe'), null);
});

// --- AC-DATA-008: the fake refuses what it cannot translate ---------------------------------------

test('AC-DATA-008: the fake names statements it cannot translate and refuses multi-statement queries', { skip: !FAKE && 'fake only' }, async () => {
    const client = await db.getConnection();
    await assert.rejects(() => client.query('INSERT INTO key_value_store (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', ['k', 'v']),
        /fake-mysql cannot translate ON DUPLICATE KEY UPDATE.*INSERT INTO key_value_store/);
    await assert.rejects(() => client.query('SELECT 1; SELECT 2'), /multiple statements/);
    await assert.rejects(() => client.query('SELECT ?', [{ nested: true }]), /cannot translate a object parameter/);
});
