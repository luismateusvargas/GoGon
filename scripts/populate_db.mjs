// scripts/populate_db.mjs
// GoGon - Database Population Script (MySQL since data-storage 2.0.0 / DATA-TASK-010)
// Fetches game data from JSON sources and replaces the master-data tables (master_realms, realms,
// relics, creatures, items) and the relations derived from them (quests, realm_creatures,
// creature_drops) in one MySQL transaction. Key-value state and control-plane tables are never
// touched. MySQL starts empty, so run this once after the first `docker compose up`:
//   docker compose run --rm gogon node scripts/populate_db.mjs
// Manual only (catalog-sync DEC-CAT-005). Once the catalog has projected data, the script refuses to
// run unless --discard-catalog-projections is given; that flag keeps the catalog's provenance but
// marks its runs discarded, so they can no longer be rolled back (CAT-TASK-002).

import { pathToFileURL } from 'node:url';
import { getConnection, closeDatabase, clearDatabaseCaches } from '../_gg_data/handler/gg_database.js';
import { createCatalogStore } from '../_gg_data/handler/catalogStore.js';
import { deriveRelations, namesFrom, writeRelations } from '../_gg_data/handler/servingRelations.js';

export const DISCARD_FLAG = '--discard-catalog-projections';

// Data Sources (GitHub RAW URLs)
const URLS = {
    masterRealms: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/master_realms.json',
    realms: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/74dba6f82cabbdf282958b1775bedce8f6636b8e/all_realms.json',
    creatures: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/all_creatures.json',
    items: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/all_items.json' // Try different name if all_items fails
};

const CHUNK_ROWS = 500;

async function fetchJson(url) {
    console.log(`[DB_INIT] Fetching ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    const data = await res.json();
    console.log(`[DB_INIT] Fetched ${Array.isArray(data) ? data.length : 'OK'} records.`);
    return data;
}

// Utility to safely serialize objects for TEXT columns
const safeStringify = (obj) => {
    if (obj === undefined || obj === null) return null;
    return JSON.stringify(obj);
};

/**
 * Inserts rows (arrays in column order) in chunks; a repeated key in the source keeps the last row.
 * An upsert, not REPLACE INTO, so no row is deleted through a foreign key. Table and column names
 * are fixed in this file.
 */
async function insertRows(tx, table, columns, rows) {
    const placeholder = `(${columns.map(() => '?').join(', ')})`;
    const updates = columns.filter(c => c !== 'id').map(c => `${c} = new.${c}`).join(', ');
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        const chunk = rows.slice(start, start + CHUNK_ROWS);
        await tx.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => placeholder).join(', ')} AS new ON DUPLICATE KEY UPDATE ${updates}`, chunk.flat());
    }
    return rows.length;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - command-line arguments
 * @param {(url: string) => Promise<any>} [opts.fetchJson] - test seam
 */
export async function main({ argv = process.argv.slice(2), fetchJson: fetchSource = fetchJson } = {}) {
    console.log('[DB_INIT] Starting database population...');

    // 0. Refuse to overwrite catalog projections unless explicitly told to (before any fetch or write)
    const db = await getConnection();
    const catalog = createCatalogStore(db);
    if (await catalog.hasCatalogProjections() && !argv.includes(DISCARD_FLAG)) {
        throw new Error(`The catalog has projected data into these tables. Re-run with ${DISCARD_FLAG} to replace it (catalog runs become discarded and cannot be rolled back).`);
    }

    // 1. Fetch Data
    const [masterRealms, realms, creatures, items] = await Promise.all([
        fetchSource(URLS.masterRealms),
        fetchSource(URLS.realms),
        fetchSource(URLS.creatures),
        fetchSource(URLS.items)
    ]);

    // 2. Map to rows
    const masterRows = [];
    for (const mr of masterRealms) {
        const id = mr.id || mr.realm_group_id || mr.group_id || mr.masterRealmId;
        const name = mr.name || mr.group_name;
        if (id && name) masterRows.push([id, name]);
    }

    const masterIds = new Set(masterRows.map(([id]) => Number(id)));
    const realmRows = [];
    const relicRows = [];
    for (const r of realms) {
        const id = r.id || r.realm_id || r.realmId;
        const name = r.name || r.realm_name;
        const minLevel = r.min_level || r.min_level_id || r.level || r.minLevel || 0;
        const rawMasterId = r.master_realm_id || r.realm_group_id || r.parent_id || null;
        const masterId = masterIds.has(Number(rawMasterId)) ? rawMasterId : null; // foreign key: unknown -> NULL
        if (!id || !name) continue;
        realmRows.push([
            id, name, minLevel, masterId,
            safeStringify(r.creatures), safeStringify(r.relics), safeStringify(r.quests), safeStringify(r.shops),
            safeStringify(r.connections || r.stairways), safeStringify(r.map_objects || r.mapObjects),
        ]);
        for (const relicName of namesFrom(r.relics)) relicRows.push([relicName, id]);
    }

    const creatureRows = [];
    for (const c of creatures) {
        const id = c.id || c.creature_id || c.creatureId;
        if (!id) continue;
        creatureRows.push([
            id,
            c.name || c.creature_name || c.creatureName,
            // Image might be 'image' or 'image_url' or 'creature_image'
            c.imageUrl || c.image_url || c.image || c.creature_image || c.creatureImg || null,
            c.description || '',
            safeStringify(c.stats || c.statistics),
            safeStringify(c.enhancements),
            safeStringify(c.drops || c.dropped_items || c.droppedItems || c.items),
        ]);
    }

    const itemRows = [];
    for (const i of items) {
        const id = i.id || i.itemId || i.item_id;
        if (!id) continue;
        itemRows.push([
            id,
            i.name || i.item_name || null,
            i.rarity || 'Common',
            i.imageUrl || i.image || i.image_url || null,
            safeStringify(i.stats || i.statistics),
            safeStringify(i.enhancements),
            safeStringify(i.dropped_by || i.droppedBy),
            safeStringify(i.set_bonuses || i.setBonuses),
            i.set_id || i.setId || null,
            i.set_name || i.setName || null,
        ]);
    }

    const loadedRealmIds = new Set(realmRows.map(([id]) => Number(id)));
    const relations = deriveRelations({
        realms: realms.map(r => ({ id: r.id || r.realm_id || r.realmId, creatures: r.creatures, quests: r.quests }))
            .filter(r => loadedRealmIds.has(Number(r.id))),
        creatures: creatureRows.map(([id, , , , , , droppedItems]) => ({ id, droppedItems })),
        creatureIds: new Set(creatureRows.map(([id]) => Number(id))),
        itemIds: new Set(itemRows.map(([id]) => Number(id))),
    });

    // 3. Replace the master-data tables atomically (children first: foreign keys)
    const counts = await db.transaction(async tx => {
        const { discardedRuns } = await catalog.discardProjections(tx);
        if (discardedRuns) console.warn(`[DB_INIT] ${discardedRuns} catalog run(s) marked discarded.`);
        for (const table of ['creature_drops', 'realm_creatures', 'quests', 'relics', 'realms', 'master_realms', 'creatures', 'items']) await tx.query(`DELETE FROM ${table}`);
        const base = {
            masterRealms: await insertRows(tx, 'master_realms', ['id', 'name'], masterRows),
            realms: await insertRows(tx, 'realms', ['id', 'name', 'min_level', 'master_realm_id', 'creatures', 'relics', 'quests', 'shops', 'connections', 'map_objects'], realmRows),
            relics: await insertRows(tx, 'relics', ['name', 'realm_id'], relicRows),
            creatures: await insertRows(tx, 'creatures', ['id', 'name', 'imageUrl', 'description', 'stats', 'enhancements', 'droppedItems'], creatureRows),
            items: await insertRows(tx, 'items', ['id', 'name', 'rarity', 'imageUrl', 'stats', 'enhancements', 'droppedBy', 'setBonuses', 'setId', 'setName'], itemRows),
        };
        return { ...base, ...(await writeRelations(tx, relations)) };
    });
    clearDatabaseCaches();
    console.log(`[DB_INIT] Inserted ${counts.masterRealms} master realms, ${counts.realms} realms, ${counts.relics} relics, ${counts.creatures} creatures, ${counts.items} items.`);
    console.log(`[DB_INIT] Relations: ${counts.realmCreatures} realm-creature, ${counts.creatureDrops} creature-drop, ${counts.quests} quests; ${relations.skipped} unresolved reference(s) left unknown.`);
    console.log('[DB_INIT] Database population complete!');
    return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error('[DB_INIT] Fatal error:', err?.message || err);
        process.exitCode = 1;
    }).finally(() => closeDatabase());
}
