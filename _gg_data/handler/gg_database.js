// === MySQL Database Module for Fallen Sword Data (GoGon Edition) ===================
// Async data layer over the MySQL service bundled in compose.yaml (data-storage-v1 2.0.0).
// Every public function returns a Promise. The pool and the migrations start on first use (or
// explicitly with initDatabase() at boot), exactly once per process.
// Project: GoGon (GG)
//
import { fileURLToPath } from 'node:url';
import { creatureCache, itemCache, realmCache, getCacheStats, clearAllCaches } from './cacheLayer.js';
import { runMigrations } from './migrationRunner.js';
import { createMysqlClient } from './mysqlClient.js';
import { getBooleanSetting } from '../../config/runtime.mjs';

// --- DATABASE SETUP ---

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const BULK_CHUNK_ROWS = 500;

let client = null;   // mysqlClient.js wrapper, created lazily
let ready = null;    // Promise<client> once migrations have run

/**
 * Opens the pool and applies pending migrations (AC-DATA-001, AC-DATA-007). Safe to call many
 * times and concurrently; a failure is not cached, so a later call retries.
 * @returns {Promise<ReturnType<typeof createMysqlClient>>}
 */
export function initDatabase() {
    if (!ready) {
        ready = (async () => {
            client ??= createMysqlClient();
            await runMigrations(client, MIGRATIONS_DIR);
            return client;
        })().catch(error => {
            ready = null;
            throw error;
        });
    }
    return ready;
}

/** Closes the pool (shutdown, tests). The next call to the data layer opens a new one. */
export async function closeDatabase() {
    const c = client;
    client = null;
    ready = null;
    if (c) await c.close();
}

const db = () => initDatabase();

// --- SQL INJECTION PROTECTION ---
// Whitelist of allowed table names (prevents SQL injection via table name parameter)
const ALLOWED_TABLES = new Set([
    'key_value_store',
    'items',
    'creatures',
    'master_realms',
    'realms',
    'relics'
]);
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Validates that a table name is in the allowed whitelist.
 * @param {string} tableName - The table name to validate
 * @throws {Error} If table name is not allowed
 */
function validateTableName(tableName) {
    if (!ALLOWED_TABLES.has(tableName)) {
        throw new Error(`[GG_DB] Invalid table name: "${tableName}". Allowed tables: ${Array.from(ALLOWED_TABLES).join(', ')}`);
    }
}

/**
 * A utility to parse JSON strings from the database safely.
 * @param {string} jsonString - The string to parse.
 * @param {any} defaultValue - The default value to return on parse failure (default: null)
 * @returns {object | any} The parsed object, or defaultValue on failure.
 */
function safeJsonParse(jsonString, defaultValue = null) {
    if (!jsonString || jsonString === 'null') return defaultValue;
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.warn(`[GG_DB] Failed to parse JSON: ${e.message}. String: "${jsonString?.substring(0, 100)}..."`);
        return defaultValue;
    }
}

// --- PUBLIC API ---

/**
 * Clears all data from a specified table.
 * @param {string} tableName - The name of the table to clear (e.g., 'items').
 */
export async function clearTable(tableName) {
    try {
        validateTableName(tableName);
        console.log(`[GG_DB] Attempting to clear all data from table: ${tableName}...`);
        const info = await (await db()).query(`DELETE FROM ${tableName}`);
        console.log(`[GG_DB] Successfully cleared ${info.affectedRows} records from ${tableName}.`);
    } catch (error) {
        console.log(`[GG_DB] Error clearing table '${tableName}':`, error);
    }
}

/**
 * A generic function to bulk-insert/update data into a table from a scraper.
 * Rows are replaced in chunks inside one transaction.
 * @param {string} tableName - The name of the table ('items', 'creatures', ...).
 * @param {Array<object>} data - The array of objects from the scraper.
 */
export async function bulkUpdateDatabase(tableName, data) {
    validateTableName(tableName);

    if (!data || data.length === 0) {
        console.log(`[GG_DB] No data provided for bulk update of ${tableName}.`);
        return;
    }

    const columns = Object.keys(data[0]);
    const bad = columns.find(col => !COLUMN_NAME.test(col));
    if (bad !== undefined) throw new Error(`[GG_DB] Invalid column name for ${tableName}: "${String(bad).slice(0, 64)}"`);
    const columnList = columns.map(col => `\`${col}\``).join(', ');
    const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;

    console.log(`[GG_DB] Starting bulk update for ${tableName}...`);
    await (await db()).transaction(async tx => {
        for (let start = 0; start < data.length; start += BULK_CHUNK_ROWS) {
            const chunk = data.slice(start, start + BULK_CHUNK_ROWS);
            const values = [];
            for (const row of chunk) {
                for (const col of columns) {
                    // Nested objects/arrays are stored as JSON strings.
                    const value = row[col];
                    values.push(value === undefined ? null : (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value);
                }
            }
            await tx.query(`REPLACE INTO ${tableName} (${columnList}) VALUES ${chunk.map(() => rowPlaceholder).join(', ')}`, values);
        }
    });
    console.log(`[GG_DB] Successfully updated ${data.length} records in ${tableName}.`);
}

/**
 * Gets a value from the simple key-value store.
 * @param {string} key - The key to retrieve (e.g., 'processed_se_kill_ids').
 * @returns {Promise<string | null>} The stored value as a string, or null if not found.
 */
export async function getContent(key) {
    const rows = await (await db()).query('SELECT `value` FROM key_value_store WHERE `key` = ?', [key]);
    return rows.length ? rows[0].value : null;
}

/**
* Adds a new item to a key's stored list, maintaining a configurable max size (FIFO).
* When the list is full, it removes the oldest item before adding the new one.
* The row is locked for the read-modify-write, so concurrent calls lose nothing. AC-DATA-002
*
* @param {string} key - The key for the list (e.g., 'processed_se_kill_ids').
* @param {any} newItem - The new item/value to add to the list. It will be JSON serialized.
* @param {number} [maxSize=100] - The maximum number of items to store in the list.
*/
export async function setContent(key, newItem, maxSize = 100) {
    await (await db()).transaction(async tx => {
        // 1. Fetch the existing data, locking the row until commit
        const rows = await tx.query('SELECT `value` FROM key_value_store WHERE `key` = ? FOR UPDATE', [key]);
        const existingJson = rows.length ? rows[0].value : null;
        let currentList = [];

        // 2. Parse the existing JSON array or initialize a new one
        if (existingJson) {
            try {
                const parsedData = JSON.parse(existingJson);
                if (Array.isArray(parsedData)) {
                    currentList = parsedData;
                } else {
                    console.warn(`[GG_DB] Stored value for key "${key}" is not a list. Starting with a fresh list.`);
                }
            } catch (error) {
                console.warn(`[GG_DB] Error parsing JSON for key "${key}". Starting with a fresh list.`, error.message);
            }
        }

        // 3. Add the new item to the end of the list
        currentList.push(newItem);

        // 4. If the list is over the limit, remove the oldest items from the beginning
        while (currentList.length > maxSize) {
            currentList.shift();
        }

        // 5. Save the updated list back to the database
        await tx.query('REPLACE INTO key_value_store (`key`, `value`) VALUES (?, ?)', [key, JSON.stringify(currentList)]);
    });
}

/**
 * Saves a single scalar or object state under a key, replacing any previous value.
 * Unlike setContent, the value is serialized as-is and never wrapped in a list.
 * An undefined value deletes the key (the column is NOT NULL). DATA-TASK-001 / AC-DATA-003
 *
 * @param {string} key - The key to store (e.g., 'current_gear_state').
 * @param {any} value - The value to store. It will be JSON serialized.
 */
export async function setObject(key, value) {
    if (value === undefined) {
        await deleteContent(key);
        return;
    }
    await (await db()).query('REPLACE INTO key_value_store (`key`, `value`) VALUES (?, ?)', [key, JSON.stringify(value)]);
}

/**
 * Reads a state saved with setObject, tolerating the legacy shapes older code wrote:
 * values stringified more than once, and scalar/object states that setContent had
 * appended to a list (the last entry is the latest state). MON-TASK-002
 *
 * @param {string} key - The key to read (e.g., 'active_guild_conflicts').
 * @param {object|string|number|boolean} defaultValue - Returned when the key is missing or unusable;
 *   its type (plain object, string, number, or boolean) is the type the caller expects.
 * @returns {Promise<any>} The stored state, or defaultValue.
 */
export async function getObject(key, defaultValue) {
    const raw = await getContent(key);
    if (raw === null) return defaultValue;

    const wantPlainObject = typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue);
    let data = raw;
    for (let depth = 0; depth < 5; depth++) {
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { break; } // a bare, non-JSON string is itself the value
        } else if (Array.isArray(data) && !Array.isArray(defaultValue) && data.length > 0) {
            data = data[data.length - 1];
        } else {
            break;
        }
    }

    const valid = wantPlainObject
        ? typeof data === 'object' && data !== null && !Array.isArray(data)
        : typeof data === typeof defaultValue;
    if (!valid) {
        console.warn(`[GG_DB] State for key "${key}" has an unexpected shape. Using default.`);
        return defaultValue;
    }
    return data;
}

/**
 * Deletes a value from the key-value store. DATA-TASK-001 / AC-DATA-004
 * @param {string} key - The key to delete (e.g., 'processed_se_kill_ids').
 * @returns {Promise<number>} The number of deleted rows (0 when the key does not exist).
 */
export async function deleteContent(key) {
    const info = await (await db()).query('DELETE FROM key_value_store WHERE `key` = ?', [key]);
    if (getBooleanSetting('GG_DB_DEBUG')) console.log(`[GG_DB] deleteContent('${key}') removed ${info.affectedRows} row(s).`);
    return info.affectedRows;
}

/**
 * Gets a complete item object by its ID from the database, with LRU caching.
 * @param {number} id - The numerical ID of the item.
 * @returns {Promise<object | undefined>} The full item object, or undefined if not found.
 */
export async function getItemById(id) {
    // Check cache first
    const cacheKey = `item:${id}`;
    if (itemCache.has(cacheKey)) {
        return itemCache.get(cacheKey);
    }

    // Cache miss - query database
    const [row] = await (await db()).query('SELECT * FROM items WHERE id = ?', [id]);
    if (!row) return undefined;

    // Parse the JSON string fields back into objects
    const item = {
        ...row,
        stats: safeJsonParse(row.stats),
        enhancements: safeJsonParse(row.enhancements),
        droppedBy: safeJsonParse(row.droppedBy),
        setBonuses: safeJsonParse(row.setBonuses)
    };

    itemCache.set(cacheKey, item);
    return item;
}

/**
 * Gets a complete creature object by its ID from the database, with LRU caching.
 * @param {number} id - The numerical ID of the creature.
 * @returns {Promise<object | undefined>} The full creature object, or undefined if not found.
 */
export async function getCreatureById(id) {
    // Check cache first
    const cacheKey = `creature:${id}`;
    if (creatureCache.has(cacheKey)) {
        return creatureCache.get(cacheKey);
    }

    // Cache miss - query database
    const [row] = await (await db()).query('SELECT * FROM creatures WHERE id = ?', [id]);
    if (!row) return undefined;

    // Parse JSON fields
    const creature = {
        ...row,
        stats: safeJsonParse(row.stats),
        enhancements: safeJsonParse(row.enhancements),
        droppedItems: safeJsonParse(row.droppedItems)
    };

    creatureCache.set(cacheKey, creature);
    return creature;
}

/**
 * Gets a complete realm object by its ID from the database, with LRU caching.
 * @param {number} id - The numerical ID of the realm.
 * @returns {Promise<object | undefined>} The full realm object, or undefined if not found.
 */
export async function getRealmById(id) {
    // Check cache first
    const cacheKey = `realm:${id}`;
    if (realmCache.has(cacheKey)) {
        return realmCache.get(cacheKey);
    }

    // Cache miss - query database
    const [row] = await (await db()).query('SELECT * FROM realms WHERE id = ?', [id]);
    if (!row) return undefined;

    // Parse all JSON fields back into objects
    const realm = {
        ...row,
        creatures: safeJsonParse(row.creatures, []),
        relics: safeJsonParse(row.relics, []),
        quests: safeJsonParse(row.quests, []),
        shops: safeJsonParse(row.shops, []),
        connections: safeJsonParse(row.connections, {}),
        map_objects: safeJsonParse(row.map_objects, []),
    };

    realmCache.set(cacheKey, realm);
    return realm;
}

/**
 * The shared, migrated client, for modules with their own SQL (control-plane store, health probe).
 * @returns {Promise<ReturnType<typeof createMysqlClient>>}
 */
export function getConnection() {
    return initDatabase();
}

// --- CACHE MANAGEMENT ---

/**
 * Get statistics about database cache usage
 * @returns {object} Cache statistics
 */
export function getDatabaseCacheStats() {
    const stats = getCacheStats();
    console.log('[GG_DB] Cache Stats:', JSON.stringify(stats, null, 2));
    return stats;
}

/**
 * Clear all database caches (useful for testing)
 */
export function clearDatabaseCaches() {
    clearAllCaches();
}
