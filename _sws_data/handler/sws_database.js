// === SQLite Database Module for Fallen Sword Data ==================
// This module replaces the multi-file JSON system with a single, efficient SQLite database.
// It provides a robust and high-performance way to store and query game data.
//
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// --- DATABASE SETUP ---

const DB_DIR = './_sws_data/database';
const DB_PATH = path.join(DB_DIR, 'sws_data.db');

// Ensure the data directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

// Initialize the database connection. This is a singleton instance.
const db = new Database(DB_PATH, { verbose: console.log });

/**
 * Initializes the database schema. Creates tables if they don't already exist.
 * This should be run once when the application starts.
 */
function initializeSchema() {
    db.exec(`
        -- A simple key-value store for miscellaneous data like processed IDs
        CREATE TABLE IF NOT EXISTS key_value_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY,
            name TEXT,
            rarity TEXT,
            imageUrl TEXT,
            stats TEXT, -- Storing as JSON string
            enhancements TEXT, -- Storing as JSON string
            droppedBy TEXT, -- Storing as JSON string
            setBonuses TEXT, -- Storing as JSON string
            setId INTEGER,
            setName TEXT
        );

        CREATE TABLE IF NOT EXISTS creatures (
            id INTEGER PRIMARY KEY,
            name TEXT,
            imageUrl TEXT,
            description TEXT,
            stats TEXT, -- Storing as JSON string
            enhancements TEXT, -- Storing as JSON string
            droppedItems TEXT -- Storing as JSON string
        );

        CREATE TABLE IF NOT EXISTS master_realms (
            id INTEGER PRIMARY KEY,
            name TEXT
        );

        CREATE TABLE IF NOT EXISTS realms (
            id INTEGER PRIMARY KEY,
            name TEXT,
            min_level INTEGER,
            master_realm_id INTEGER,
            creatures TEXT,     -- JSON string of creature IDs
            relics TEXT,        -- JSON string of relic IDs
            quests TEXT,        -- JSON string of quest IDs
            shops TEXT,         -- JSON string of shop IDs
            connections TEXT,   -- JSON string of {north, south, east, west}
            map_objects TEXT,   -- JSON string of all objects with their x,y coordinates
            FOREIGN KEY (master_realm_id) REFERENCES master_realms (id)
        );

        CREATE TABLE IF NOT EXISTS relics (
            id INTEGER PRIMARY KEY,
            name TEXT,
            realm_id INTEGER,
            FOREIGN KEY (realm_id) REFERENCES realms (id)
        );
    `);
    console.log('[SWS_DB] Database schema initialized successfully.');
}

// Run schema setup on module load.
initializeSchema();


// --- PUBLIC API ---

/**
 * Clears all data from a specified table.
 * @param {string} tableName - The name of the table to clear (e.g., 'items').
 */
export function clearTable(tableName) {
    try {
        console.log(`[SWS_DB] Attempting to clear all data from table: ${tableName}...`);
        const stmt = db.prepare(`DELETE FROM ${tableName}`);
        const info = stmt.run();
        console.log(`[SWS_DB] Successfully cleared ${info.changes} records from ${tableName}.`);
    } catch (error) {
        console.error(`[SWS_DB] Error clearing table '${tableName}':`, error);
    }
}

/**
 * Rebuilds the database file, repacking it into a minimal amount of disk space.
 * This is useful after deleting a large amount of data to reduce the file size.
 */
export function vacuumDatabase() {
    try {
        console.log(`[SWS_DB] Attempting to vacuum the database to reclaim disk space...`);
        db.exec('VACUUM');
        console.log(`[SWS_DB] Vacuum process completed successfully.`);
    } catch (error) {
        console.error(`[SWS_DB] Error during vacuum process:`, error);
    }
}

/**
 * Gets a value from the simple key-value store.
 * Replaces the old file-based getContent for simple data.
 * @param {string} key - The key to retrieve (e.g., 'processed_se_kill_ids').
 * @returns {string | null} The stored value as a string, or null if not found.
 */
export function getContent(key) {
    const stmt = db.prepare('SELECT value FROM key_value_store WHERE key = ?');
    const result = stmt.get(key);
    return result ? result.value : null;
}

/**
 * Sets a value in the simple key-value store.
 * Replaces the old file-based setContent for simple data.
 * @param {string} key - The key to set (e.g., 'processed_se_kill_ids').
 * @param {string} value - The value to store (should be a string, often JSON).
 */
export function setContent(key, value) {
    const stmt = db.prepare('INSERT OR REPLACE INTO key_value_store (key, value) VALUES (?, ?)');
    stmt.run(key, value);
}

/**
 * Deletes a value from the simple key-value store by its key.
 * @param {string} key - The key to delete (e.g., 'processed_se_kill_ids').
 */
export function deleteContent(key) {
    try {
        const stmt = db.prepare('DELETE FROM key_value_store WHERE key = ?');
        const info = stmt.run(key);
        if (info.changes > 0) {
            console.log(`[SWS_DB] Successfully deleted key: ${key}`);
        } else {
            console.log(`[SWS_DB] Key '${key}' not found, nothing to delete.`);
        }
    } catch (error) {
        console.error(`[SWS_DB] Error deleting key '${key}':`, error);
    }
}

/**
 * A generic function to bulk-insert/update data into a table from a scraper.
 * @param {string} tableName - The name of the table ('items', 'creatures', 'sets').
 * @param {Array<object>} data - The array of objects from the scraper.
 */
export function bulkUpdateDatabase(tableName, data) {
    if (!data || data.length === 0) {
        console.log(`[SWS_DB] No data provided for bulk update of ${tableName}.`);
        return;
    }

    const columns = Object.keys(data[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`);

    const insertMany = db.transaction((rows) => {
        for (const row of rows) {
            // Convert nested objects/arrays to JSON strings for storage
            const values = columns.map(col => {
                const value = row[col];
                return (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
            });
            stmt.run(...values);
        }
    });

    console.log(`[SWS_DB] Starting bulk update for ${tableName}...`);
    insertMany(data);
    console.log(`[SWS_DB] Successfully updated ${data.length} records in ${tableName}.`);
}

/**
 * A utility to parse JSON strings from the database safely.
 * @param {string} jsonString - The string to parse.
 * @returns {object | any} The parsed object, or an empty object on failure.
 */
function safeJsonParse(jsonString) {
    try {
        return JSON.parse(jsonString);
    } catch {
        return {};
    }
}


// --- DATA RETRIEVAL FUNCTIONS ---
/**
 * Fetches all primary key IDs from a specified table.
 * @param {string} tableName - The name of the table (e.g., 'items').
 * @returns {Set<number>} A Set containing all IDs for efficient lookups.
 */
export function getAllIdsFromTable(tableName) {
    try {
        // .pluck() is a feature of better-sqlite3 that returns an array of values from a single column.
        const stmt = db.prepare(`SELECT id FROM ${tableName}`).pluck();
        const ids = stmt.all();
        console.log(`[SWS_DB] Fetched ${ids.length} IDs from table: ${tableName}`);
        return new Set(ids); // Return a Set for O(1) complexity checks.
    } catch (error) {
        console.error(`[SWS_DB] Error fetching all IDs from ${tableName}:`, error);
        return new Set(); // Return an empty set on failure.
    }
}
/**
 * Gets a complete item object by its ID from the database.
 * @param {number} id - The numerical ID of the item.
 * @returns {object | undefined} The full item object, or undefined if not found.
 */
export function getItemById(id) {
    const stmt = db.prepare('SELECT * FROM items WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return undefined;

    // Parse the JSON string fields back into objects
    return {
        ...row,
        stats: safeJsonParse(row.stats),
        enhancements: safeJsonParse(row.enhancements),
        droppedBy: safeJsonParse(row.droppedBy),
        setBonuses: safeJsonParse(row.setBonuses)
    };
}

/**
 * Gets a complete creature object by its ID from the database.
 * @param {number} id - The numerical ID of the creature.
 * @returns {object | undefined} The full creature object, or undefined if not found.
 */
export function getCreatureById(id) {
    const stmt = db.prepare('SELECT * FROM creatures WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return undefined;
    
    return {
        ...row,
        stats: safeJsonParse(row.stats),
        enhancements: safeJsonParse(row.enhancements),
        droppedItems: safeJsonParse(row.droppedItems)
    };
}

/**
 * Gets a complete realm object by its ID from the database.
 * @param {number} id - The numerical ID of the realm.
 * @returns {object | undefined} The full realm object, or undefined if not found.
 */
export function getRealmById(id) {
    const stmt = db.prepare('SELECT * FROM realms WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return undefined;
    // Parse all JSON fields back into objects
    return {
        ...row,
        creatures: safeJsonParse(row.creatures),
        relics: safeJsonParse(row.relics),
        quests: safeJsonParse(row.quests),
        shops: safeJsonParse(row.shops),
        connections: safeJsonParse(row.connections),
        map_objects: safeJsonParse(row.map_objects),
    };
}