// tests/helpers/test-database.mjs - DATA-TASK-005 / AC-DATA-008
// Preloaded into every test process (npm test). Chooses the database the data layer talks to:
//   - default: mysql2/promise is mocked with the in-process fake (tests/helpers/fake-mysql.mjs);
//     each test process starts with an empty database.
//   - GG_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306 (CI): a real MySQL. Each test process
//     gets its own throwaway database, dropped when the process ends.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { mock } from 'node:test';
import crypto from 'node:crypto';

// node:sqlite is still flagged experimental on Node 22; its one-time warning is noise in test output.
const emitWarning = process.emitWarning;
process.emitWarning = function filteredWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/.test(text ?? '')) return;
    return emitWarning.call(this, warning, ...rest);
};

const realUrl = process.env.GG_TEST_MYSQL_URL;

if (realUrl) {
    const url = new URL(realUrl);
    const database = `gg_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
    Object.assign(process.env, {
        GG_MYSQL_HOST: url.hostname,
        GG_MYSQL_PORT: url.port || '3306',
        GG_MYSQL_USER: decodeURIComponent(url.username),
        GG_MYSQL_PASSWORD: decodeURIComponent(url.password),
        GG_MYSQL_DATABASE: database,
    });
    const { default: mysql } = await import('mysql2/promise');
    const admin = () => mysql.createConnection({
        host: url.hostname, port: Number(url.port || 3306),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    });
    const conn = await admin();
    await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await conn.end();
    globalThis.__GG_TEST_DATABASES__ ??= [];
    let dropped = false;
    process.on('beforeExit', async () => {
        if (dropped) return;
        dropped = true;
        try {
            const c = await admin();
            for (const name of [database, ...globalThis.__GG_TEST_DATABASES__]) await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
            await c.end();
        } catch { /* the CI service container is discarded anyway */ }
    });
} else {
    const { fakeMysql2 } = await import('./fake-mysql.mjs');
    mock.module('mysql2/promise', { defaultExport: fakeMysql2, namedExports: fakeMysql2 });
    process.env.GG_MYSQL_PASSWORD ||= 'fake-mysql-password';
}

globalThis.__GG_TEST_DATABASE__ = realUrl ? 'mysql' : 'fake';
