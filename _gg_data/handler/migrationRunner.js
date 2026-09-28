// migrationRunner.js - Database Migration System for GoGon
// Applies _gg_data/migrations/*.sql and *.mjs in file-name order. SQL files run one statement at a
// time (the pool never allows multi-statement queries); an .mjs file exports `up(client)`, for steps
// plain SQL cannot make idempotent (CAT-TASK-002: guarded foreign-key retrofits and backfills). MySQL commits DDL implicitly, so a migration is not atomic:
// every statement must be idempotent, and a failed file is not recorded so it re-runs once fixed.
// Project: GoGon (GG) - data-storage-v1 2.0.0 / DATA-TASK-004 / AC-DATA-001

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Splits a SQL script into statements on top-level semicolons, dropping `--` and `/* *\/` comments.
 * Quoted strings and identifiers ('...', "...", `...`) are kept intact.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
    const statements = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            current += ch;
            if (ch === '\\' && quote !== '`') { current += sql[++i] ?? ''; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i++;
            current += '\n';
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 1;
            current += ' ';
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        if (ch === ';') {
            if (current.trim()) statements.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

/**
 * Runs pending migrations.
 * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} client - see mysqlClient.js
 * @param {string} migrationsDir - Path to migrations directory
 * @returns {Promise<string[]>} The file names applied by this run.
 */
export async function runMigrations(client, migrationsDir) {
    console.log('[GG_DB] Checking for pending migrations...');

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        version VARCHAR(191) NOT NULL UNIQUE,
        applied_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);

    const applied = new Set((await client.query('SELECT version FROM schema_migrations')).map(row => row.version));

    const files = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql') || file.endsWith('.mjs'))
        .sort(); // 001, 002, ...

    const done = [];
    for (const file of files) {
        if (applied.has(file)) continue;
        console.log(`[GG_DB] Applying migration: ${file}...`);
        try {
            const full = path.join(migrationsDir, file);
            if (file.endsWith('.mjs')) {
                const { up } = await import(pathToFileURL(full).href);
                if (typeof up !== 'function') throw new Error(`${file} does not export up(client).`);
                await up(client);
            } else {
                for (const statement of splitStatements(fs.readFileSync(full, 'utf8'))) {
                    await client.query(statement);
                }
            }
            await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
        } catch (error) {
            console.error(`[GG_DB] Failed to apply migration ${file}: ${error.message}`);
            throw error; // Stop immediately; the file stays unrecorded.
        }
        console.log(`[GG_DB] Applied migration: ${file}`);
        done.push(file);
    }

    console.log(done.length > 0
        ? `[GG_DB] Successfully applied ${done.length} migrations.`
        : '[GG_DB] Database schema is up to date.');
    return done;
}
