// _gg_data/handler/mysqlClient.js - DATA-TASK-004 / AC-DATA-007
// The one place GoGon opens MySQL. A small wrapper over a mysql2/promise pool:
//   query(sql, params)   -> rows for SELECT, { affectedRows, insertId } for writes
//   transaction(fn)      -> runs fn(tx) on one connection; commits, or rolls back and rethrows
// Values are always bound through ? placeholders by the driver. Tests replace mysql2/promise with
// tests/helpers/fake-mysql.mjs (AC-DATA-008), so nothing here may depend on a live server at import.
import mysql from 'mysql2/promise';
import { getSetting, getBooleanSetting } from '../../config/runtime.mjs';

export const POOL_SIZE = 5;

/** Connection options from the registry. The password never appears in errors or logs. */
export function mysqlOptions() {
    const password = getSetting('GG_MYSQL_PASSWORD');
    if (!password) throw new Error('[GG_DB] GG_MYSQL_PASSWORD is not set.');
    return {
        host: getSetting('GG_MYSQL_HOST'),
        port: Number(getSetting('GG_MYSQL_PORT')),
        user: getSetting('GG_MYSQL_USER'),
        password,
        database: getSetting('GG_MYSQL_DATABASE'),
        connectionLimit: POOL_SIZE,
        charset: 'utf8mb4',
        multipleStatements: false,
        waitForConnections: true,
        enableKeepAlive: true,
    };
}

/** Normalizes mysql2's [rows, fields] / [ResultSetHeader] into rows or { affectedRows, insertId }. */
function unwrap([result]) {
    if (Array.isArray(result)) return result;
    return { affectedRows: result.affectedRows ?? 0, insertId: result.insertId ?? 0 };
}

/**
 * @param {object} [options] - mysql2 pool options (defaults to mysqlOptions()).
 * @param {{ createPool: Function }} [driver] - mysql2/promise, or an in-process stand-in (demo server).
 */
export function createMysqlClient(options = mysqlOptions(), driver = mysql) {
    const pool = driver.createPool(options);
    const debug = getBooleanSetting('GG_DB_DEBUG');
    const where = `${options.host}:${options.port}`;

    function unreachable(error) {
        return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|PROTOCOL_CONNECTION_LOST/.test(error?.code ?? '')
            ? new Error(`[GG_DB] MySQL at ${where} is unreachable (${error.code}).`, { cause: error })
            : error;
    }

    async function run(target, sql, params = []) {
        if (debug) console.log('[GG_DB] SQL:', sql);
        try {
            return unwrap(await target.query(sql, params));
        } catch (error) {
            throw unreachable(error);
        }
    }

    return {
        query: (sql, params) => run(pool, sql, params),

        async transaction(fn) {
            const conn = await pool.getConnection().catch(e => { throw unreachable(e); });
            try {
                await conn.beginTransaction();
                const tx = { query: (sql, params) => run(conn, sql, params) };
                const result = await fn(tx);
                await conn.commit();
                return result;
            } catch (error) {
                try { await conn.rollback(); } catch { /* connection already broken */ }
                throw error;
            } finally {
                conn.release();
            }
        },

        close: () => pool.end(),
    };
}
