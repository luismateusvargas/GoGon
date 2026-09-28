// _gg_data/handler/servingRelations.js - CAT-TASK-002 (catalog-sync-v1 1.1.0)
// Derives the normalized serving relations (realm_creatures, creature_drops, quests, relics) from
// the legacy JSON columns that guide data fills (realms.creatures/relics/quests, creatures.droppedItems).
// Shared by scripts/populate_db.mjs and migration 004. A reference that does not resolve to an
// existing row is skipped, never guessed: unknown relationships stay unknown (catalog-sync constraint).

const ID_FIELDS = ['id', 'creature_id', 'creatureId', 'item_id', 'itemId'];
const MAX_NAME = 191;

/** Parses a JSON column value; anything unusable becomes null. */
export function parseJsonColumn(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

function toId(value) {
    const n = typeof value === 'string' && /^\d{1,18}$/.test(value.trim()) ? Number(value) : value;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Positive integer IDs from an array of IDs/objects ({ id } etc.) or an object keyed by ID.
 * @returns {number[]} unique IDs in first-seen order
 */
export function idsFrom(value) {
    const ids = new Set();
    const add = v => {
        let id = toId(v);
        if (id === null && v && typeof v === 'object') {
            for (const f of ID_FIELDS) if ((id = toId(v[f])) !== null) break;
        }
        if (id !== null) ids.add(id);
    };
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
            const id = toId(key);
            if (id !== null) ids.add(id);
            else add(v);
        }
    }
    return [...ids];
}

/**
 * Names from an array of names/objects ({ name }) or an object map (the relic and quest shapes).
 * @returns {string[]} unique, trimmed names of at most 191 characters
 */
export function namesFrom(value) {
    const names = new Set();
    const add = v => {
        const name = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null);
        const trimmed = name?.trim();
        if (trimmed && trimmed.length <= MAX_NAME) names.add(trimmed);
    };
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
            if (typeof v === 'string' || (v && typeof v === 'object' && v.name)) add(v);
            else if (Number.isNaN(Number(key))) add(key);
        }
    }
    return [...names];
}

/**
 * @param {object} input
 * @param {Array<{ id: number, creatures?: any, quests?: any }>} input.realms - JSON columns parsed or raw
 * @param {Array<{ id: number, droppedItems?: any }>} input.creatures
 * @param {Set<number>} input.creatureIds - creatures that exist
 * @param {Set<number>} input.itemIds - items that exist
 * @returns {{ realmCreatures: number[][], creatureDrops: number[][], quests: Array<[number, string]>, skipped: number }}
 */
export function deriveRelations({ realms = [], creatures = [], creatureIds, itemIds }) {
    const realmCreatures = [];
    const creatureDrops = [];
    const quests = [];
    let skipped = 0;
    for (const realm of realms) {
        const realmId = toId(realm.id);
        if (realmId === null) continue;
        for (const creatureId of idsFrom(parseJsonColumn(realm.creatures))) {
            if (creatureIds.has(creatureId)) realmCreatures.push([realmId, creatureId]);
            else skipped++;
        }
        for (const name of namesFrom(parseJsonColumn(realm.quests))) quests.push([realmId, name]);
    }
    for (const creature of creatures) {
        const creatureId = toId(creature.id);
        if (creatureId === null || !creatureIds.has(creatureId)) continue;
        for (const itemId of idsFrom(parseJsonColumn(creature.droppedItems))) {
            if (itemIds.has(itemId)) creatureDrops.push([creatureId, itemId]);
            else skipped++;
        }
    }
    return { realmCreatures, creatureDrops, quests, skipped };
}

const CHUNK_ROWS = 500;

/** Inserts rows in chunks; duplicates are ignored. Table and column names are fixed by callers here. */
async function insertIgnore(q, table, columns, rows) {
    const placeholder = `(${columns.map(() => '?').join(', ')})`;
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        const chunk = rows.slice(start, start + CHUNK_ROWS);
        await q.query(`INSERT IGNORE INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => placeholder).join(', ')}`, chunk.flat());
    }
    return rows.length;
}

/**
 * Writes derived relations. Every row must already resolve (deriveRelations guarantees it), so
 * INSERT IGNORE only skips duplicates, never a foreign-key failure.
 * @param {{ query: Function }} q - client or transaction
 */
export async function writeRelations(q, { realmCreatures, creatureDrops, quests }) {
    return {
        realmCreatures: await insertIgnore(q, 'realm_creatures', ['realm_id', 'creature_id'], realmCreatures),
        creatureDrops: await insertIgnore(q, 'creature_drops', ['creature_id', 'item_id'], creatureDrops),
        quests: await insertIgnore(q, 'quests', ['realm_id', 'name'], quests),
    };
}
