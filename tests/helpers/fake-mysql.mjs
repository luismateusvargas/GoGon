// tests/helpers/fake-mysql.mjs - DATA-TASK-005 / AC-DATA-008
// An in-process stand-in for the part of mysql2/promise GoGon uses (createPool, pool.query,
// pool.getConnection, connection.beginTransaction/commit/rollback/release, pool.end).
// Statements run on node:sqlite after a small, explicit MySQL -> SQLite translation. Anything the
// translation does not cover throws, naming the statement, instead of passing silently.
// tests/helpers/test-database.mjs installs it for every test process; CI also runs the data-layer
// tests against a real MySQL (GG_TEST_MYSQL_URL) so the fake cannot drift unnoticed.
import { DatabaseSync } from 'node:sqlite';

/** Shared state, like one MySQL server per test process: databases survive pool.end(). */
const databases = new Map();          // database name -> DatabaseSync
export const fakeMysql = {
    statements: [],                   // every translated statement run, for "no query happened" checks
    unavailable: null,                // an error code (e.g. 'ECONNREFUSED') makes every call fail
    poolOptions: [],                  // options passed to createPool, newest last
};

/** Drops every fake database and resets the counters. */
export function resetFakeMysql() {
    for (const db of databases.values()) db.close();
    databases.clear();
    fakeMysql.statements.length = 0;
    fakeMysql.unavailable = null;
    fakeMysql.poolOptions.length = 0;
}

function database(name) {
    if (!databases.has(name)) databases.set(name, new DatabaseSync(':memory:'));
    return databases.get(name);
}

class FakeMysqlError extends Error {
    constructor(message, code, errno) {
        super(message);
        this.code = code;
        this.errno = errno;
    }
}

const untranslatable = (sql, what) =>
    new FakeMysqlError(`fake-mysql cannot translate ${what}: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`, 'ER_FAKE_UNSUPPORTED', 0);

/**
 * MySQL -> SQLite for the dialect GoGon's migrations and queries use.
 * @returns {string[]} one or more SQLite statements
 */
export function translate(sql) {
    let s = sql.trim().replace(/;\s*$/, '');
    if (/\bON\s+DUPLICATE\s+KEY\b/i.test(s)) throw untranslatable(sql, 'ON DUPLICATE KEY UPDATE (use REPLACE INTO)');
    if (/;\s*\S/.test(s.replace(/'(?:[^'\\]|\\.)*'|`[^`]*`|"(?:[^"\\]|\\.)*"/g, ''))) {
        throw new FakeMysqlError('fake-mysql: multiple statements in one query are disabled (as in the pool).', 'ER_PARSE_ERROR', 1064);
    }

    // Databases are created on first use by createPool({ database }); nothing to run.
    if (/^(CREATE|DROP)\s+DATABASE\b/i.test(s)) return [];

    const extra = [];
    if (/^CREATE\s+TABLE/i.test(s)) {
        const table = s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i)?.[1];
        s = s.replace(/\)\s*((?:ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE)\s*=?\s*\w+\s*)+$/i, ')');
        s = s.replace(/\b\w*INT\b(\s+NOT\s+NULL)?\s+AUTO_INCREMENT\s+PRIMARY\s+KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
        // Inline, non-unique INDEX name (cols) -> separate CREATE INDEX.
        s = s.replace(/,\s*(?:INDEX|KEY)\s+`?(\w+)`?\s*\(([^)]*)\)/gi, (_, name, cols) => {
            extra.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            return '';
        });
    }
    s = s.replace(/\s+FOR\s+UPDATE\s*$/i, '');
    s = s.replace(/^INSERT\s+IGNORE\b/i, 'INSERT OR IGNORE');
    if (/\b(AUTO_INCREMENT|ENGINE\s*=|UNSIGNED)\b/i.test(s)) throw untranslatable(sql, 'MySQL-only syntax');
    return [s, ...extra];
}

function bindable(value, sql) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint' || Buffer.isBuffer(value)) return value;
    throw untranslatable(sql, `a ${typeof value} parameter`);
}

function mapError(error, sql) {
    if (error instanceof FakeMysqlError) return error;
    const m = error.message ?? '';
    const as = (code, errno) => Object.assign(new FakeMysqlError(`${m} [${sql.replace(/\s+/g, ' ').slice(0, 120)}]`, code, errno), { cause: error });
    if (/UNIQUE constraint failed/.test(m)) return as('ER_DUP_ENTRY', 1062);
    if (/CHECK constraint failed/.test(m)) return as('ER_CHECK_CONSTRAINT_VIOLATED', 3819);
    if (/NOT NULL constraint failed/.test(m)) return as('ER_BAD_NULL_ERROR', 1048);
    if (/no such table/.test(m)) return as('ER_NO_SUCH_TABLE', 1146);
    if (/syntax error|incomplete input|unrecognized token/.test(m)) return as('ER_PARSE_ERROR', 1064);
    return as('ER_UNKNOWN_ERROR', 1105);
}

function execute(db, sql, params = []) {
    if (fakeMysql.unavailable) {
        throw Object.assign(new Error(`connect ${fakeMysql.unavailable}`), { code: fakeMysql.unavailable });
    }
    if (!Array.isArray(params)) throw untranslatable(sql, 'non-array parameters');
    const statements = translate(sql);
    let result = statements.length ? undefined : [{ affectedRows: 0, insertId: 0 }, undefined];
    for (const [i, statement] of statements.entries()) {
        fakeMysql.statements.push(statement);
        try {
            const stmt = db.prepare(statement);
            const args = i === 0 ? params.map(v => bindable(v, sql)) : [];
            if (/^\s*(SELECT|SHOW|WITH|PRAGMA)\b/i.test(statement)) {
                result ??= [stmt.all(...args).map(row => ({ ...row })), []];
            } else {
                const info = stmt.run(...args);
                result ??= [{ affectedRows: Number(info.changes), insertId: Number(info.lastInsertRowid) }, undefined];
            }
        } catch (error) {
            throw mapError(error, sql);
        }
    }
    return result;
}

/** A promise mutex: one transaction at a time, like row locks on a single-writer database. */
function createLock() {
    let tail = Promise.resolve();
    return () => {
        let release;
        const next = new Promise(r => { release = r; });
        const acquired = tail.then(() => release);
        tail = tail.then(() => next);
        return acquired;
    };
}
const locks = new Map();

function createPool(options = {}) {
    fakeMysql.poolOptions.push({ ...options, password: options.password ? '[set]' : '' });
    const name = options.database ?? 'gogon';
    const db = database(name);
    if (!locks.has(name)) locks.set(name, createLock());
    const lock = locks.get(name);
    let ended = false;
    const guard = () => { if (ended) throw new Error('Pool is closed.'); };

    return {
        async query(sql, params) {
            guard();
            return execute(db, sql, params);
        },
        async execute(sql, params) {
            guard();
            return execute(db, sql, params);
        },
        async getConnection() {
            guard();
            if (fakeMysql.unavailable) throw Object.assign(new Error(`connect ${fakeMysql.unavailable}`), { code: fakeMysql.unavailable });
            const release = await lock();
            let inTx = false;
            let released = false;
            return {
                query: async (sql, params) => execute(db, sql, params),
                execute: async (sql, params) => execute(db, sql, params),
                async beginTransaction() { db.exec('BEGIN'); inTx = true; },
                async commit() { if (inTx) { db.exec('COMMIT'); inTx = false; } },
                async rollback() { if (inTx) { db.exec('ROLLBACK'); inTx = false; } },
                release() {
                    if (released) return;
                    released = true;
                    if (inTx) { db.exec('ROLLBACK'); inTx = false; }
                    release();
                },
            };
        },
        async end() { ended = true; },
    };
}

export const fakeMysql2 = { createPool };
export default fakeMysql2;
