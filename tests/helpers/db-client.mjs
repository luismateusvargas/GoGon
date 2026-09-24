// tests/helpers/db-client.mjs - DATA-TASK-005 / AC-DATA-008
// freshClient(): a migrated MySQL client on its own, empty database, for tests that need isolation
// from the shared gg_database connection (control-plane store, account switch, server).
// Works on the in-process fake and on a real MySQL (GG_TEST_MYSQL_URL); see test-database.mjs.
import path from 'node:path';
import { createMysqlClient, mysqlOptions } from '../../_gg_data/handler/mysqlClient.js';
import { runMigrations } from '../../_gg_data/handler/migrationRunner.js';

const MIGRATIONS = path.resolve('_gg_data/migrations');
const open = [];
let n = 0;

/** Created databases, dropped by test-database.mjs when the process ends (real MySQL only). */
globalThis.__GG_TEST_DATABASES__ ??= [];

export async function freshClient({ migrate = true } = {}) {
    const base = mysqlOptions();
    const database = `${base.database}_c${++n}`;
    const admin = createMysqlClient({ ...base, database: undefined });
    try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    } finally {
        await admin.close();
    }
    globalThis.__GG_TEST_DATABASES__.push(database);
    const client = createMysqlClient({ ...base, database });
    open.push(client);
    if (migrate) {
        const log = console.log;
        console.log = () => {};
        try { await runMigrations(client, MIGRATIONS); } finally { console.log = log; }
    }
    return client;
}

/** Closes every client created by freshClient() (call from after()). */
export async function closeClients() {
    while (open.length) await open.pop().close();
}
