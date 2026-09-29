// catalog/seedService.js - CAT-TASK-007 / AC-CAT-005, AC-CAT-006, AC-CAT-009 (catalog-sync-v1 1.3.0)
// Staged baseline seeding. An approved source key's files are downloaded (size-capped), checked for
// structure, mapped to catalog observations, and validated in full BEFORE anything is written; an
// unapproved key, an oversized file, or a structurally wrong file writes nothing. The valid
// observations are then staged as 'seed' runs of at most SEED_CHUNK observations, in projection
// order (master realms, realms, creatures, items, relics, quests, relations), and each part is
// promoted separately through a previewed, confirmed plan (catalogStore.planPromotion). The legacy
// full-replace script is never called.
import crypto from 'node:crypto';
import { CatalogError, normalizeObservation } from '../_gg_data/handler/catalogStore.js';
import { deriveRelations, namesFrom } from '../_gg_data/handler/servingRelations.js';
import { SEED_SOURCES } from './sourceRegistry.js';

export const SEED_CHUNK = 2000;
export const MAX_UNUSABLE_SHARE = 0.05;   // more unusable records than this in any file rejects the seed
const ORDER = ['master_realm', 'realm', 'creature', 'item', 'relic', 'quest', 'relation'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const invalid = (message, field) => new CatalogError('invalid', message, field ? { field } : {});

function toId(v) {
    const n = typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v) : v;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function toInt(v) {
    const n = typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim()) ? Number(v) : v;
    return Number.isSafeInteger(n) ? n : null;
}
function text(v, max) {
    if (typeof v !== 'string') return null;
    const t = v.replace(CONTROL, ' ').trim();
    return t ? t.slice(0, max) : null;
}
const json = v => (v === undefined ? null : v);

/** Default downloader: https only, a byte cap enforced while streaming, 60 s timeout. */
export async function fetchJsonCapped(url, maxBytes) {
    if (!url.startsWith('https://')) throw invalid('Seed sources must be https.');
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!res.ok) throw invalid(`Seed source returned HTTP ${res.status}.`);
    if (Number(res.headers.get('content-length') || 0) > maxBytes) throw invalid('Seed file exceeds its size limit.');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw invalid('Seed file exceeds its size limit.');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('Seed file is not valid JSON.'); }
}

/**
 * Maps the source records (populate_db field names) to observations. Records without an ID or name
 * are unusable and counted; a file whose root is not an array of objects is rejected.
 */
export function mapSeed(data, { existingCreatureIds = new Set(), existingItemIds = new Set() } = {}) {
    const observations = [];
    const unusable = {};
    for (const kind of ['master_realm', 'realm', 'creature', 'item']) {
        const list = data[kind];
        if (!Array.isArray(list) || list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
            throw invalid(`The ${kind} file is not an array of records.`, kind);
        }
        unusable[kind] = 0;
    }
    const push = (kind, payload) => observations.push({ kind, payload });
    for (const mr of data.master_realm) {
        const id = toId(mr.id ?? mr.realm_group_id ?? mr.group_id ?? mr.masterRealmId);
        const name = text(mr.name ?? mr.group_name, 256);
        if (!id || !name) { unusable.master_realm++; continue; }
        push('master_realm', { id, name });
    }
    const realms = [];
    for (const r of data.realm) {
        const id = toId(r.id ?? r.realm_id ?? r.realmId);
        const name = text(r.name ?? r.realm_name, 256);
        if (!id || !name) { unusable.realm++; continue; }
        realms.push({ id, creatures: r.creatures, quests: r.quests });
        push('realm', {
            id, name,
            min_level: toInt(r.min_level ?? r.min_level_id ?? r.level ?? r.minLevel),
            master_realm_id: toId(r.master_realm_id ?? r.realm_group_id ?? r.parent_id),
            shops: json(r.shops), connections: json(r.connections ?? r.stairways), map_objects: json(r.map_objects ?? r.mapObjects),
        });
        for (const relic of namesFrom(r.relics)) push('relic', { realm_id: id, name: relic });
    }
    const creatures = [];
    for (const c of data.creature) {
        const id = toId(c.id ?? c.creature_id ?? c.creatureId);
        if (!id) { unusable.creature++; continue; }
        const droppedItems = json(c.drops ?? c.dropped_items ?? c.droppedItems ?? c.items);
        creatures.push({ id, droppedItems });
        push('creature', {
            id, name: text(c.name ?? c.creature_name ?? c.creatureName, 256),
            imageUrl: text(c.imageUrl ?? c.image_url ?? c.image ?? c.creature_image ?? c.creatureImg, 512),
            description: text(c.description, 8192), stats: json(c.stats ?? c.statistics), enhancements: json(c.enhancements), droppedItems,
        });
    }
    for (const i of data.item) {
        const id = toId(i.id ?? i.itemId ?? i.item_id);
        if (!id) { unusable.item++; continue; }
        push('item', {
            id, name: text(i.name ?? i.item_name, 256), rarity: text(i.rarity, 64),
            imageUrl: text(i.imageUrl ?? i.image ?? i.image_url, 512), stats: json(i.stats ?? i.statistics),
            enhancements: json(i.enhancements), droppedBy: json(i.dropped_by ?? i.droppedBy), setBonuses: json(i.set_bonuses ?? i.setBonuses),
            setId: toId(i.set_id ?? i.setId), setName: text(i.set_name ?? i.setName, 256),
        });
    }
    for (const kind of ['master_realm', 'realm', 'creature', 'item']) {
        const total = data[kind].length;
        if (total && unusable[kind] / total > MAX_UNUSABLE_SHARE) throw invalid(`Too many unusable ${kind} records (${unusable[kind]} of ${total}).`, kind);
    }
    const creatureIds = new Set([...existingCreatureIds, ...creatures.map(c => c.id)]);
    const itemIds = new Set([...existingItemIds, ...observations.filter(o => o.kind === 'item').map(o => o.payload.id)]);
    const relations = deriveRelations({ realms, creatures, creatureIds, itemIds });
    for (const [realmId, name] of relations.quests) push('quest', { realm_id: realmId, name });
    for (const [realmId, creatureId] of relations.realmCreatures) push('relation', { type: 'realm_creature', realm_id: realmId, creature_id: creatureId });
    for (const [creatureId, itemId] of relations.creatureDrops) push('relation', { type: 'creature_drop', creature_id: creatureId, item_id: itemId });
    // Undefined and null fields are the same to the catalog; drop them so payloads stay small.
    for (const o of observations) for (const k of Object.keys(o.payload)) if (o.payload[k] === null) delete o.payload[k];
    return { observations, unusable, unresolvedReferences: relations.skipped };
}

/**
 * @param {object} deps
 * @param {{ query: Function }} deps.db
 * @param {object} deps.store - catalogStore
 * @param {(url: string, maxBytes: number) => Promise<any>} [deps.fetchJson]
 * @param {number} [deps.chunk] - observations per staged run (test seam)
 */
export function createSeedService({ db, store, fetchJson = fetchJsonCapped, chunk: chunkSize = SEED_CHUNK }) {
    let staging = false;
    return {
        /**
         * AC-CAT-006: stages an approved source as ordered seed runs. Nothing is written unless every
         * file is within limits and structurally valid; unrepresentable records are excluded and
         * reported, never guessed.
         */
        async stage(sourceKey) {
            const src = typeof sourceKey === 'string' && Object.hasOwn(SEED_SOURCES, sourceKey) ? SEED_SOURCES[sourceKey] : null;
            if (!src) throw invalid('Unapproved seed source key.', 'sourceKey');
            if (staging) throw new CatalogError('conflict', 'A seed is already being staged.');
            staging = true;
            try {
                const data = {};
                for (const [kind, url] of Object.entries(src.files)) data[kind] = await fetchJson(url, src.maxBytes);
                const ids = async table => new Set((await db.query(`SELECT id FROM ${table}`)).map(r => Number(r.id)));
                const mapped = mapSeed(data, { existingCreatureIds: await ids('creatures'), existingItemIds: await ids('items') });
                const valid = [];
                const excluded = {};
                for (const o of mapped.observations) {
                    try { normalizeObservation(o.kind, o.payload); valid.push(o); } catch { excluded[o.kind] = (excluded[o.kind] ?? 0) + 1; }
                }
                if (!valid.length) throw invalid('The seed has no usable records.');
                valid.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
                const batchId = crypto.randomUUID();
                const parts = Math.ceil(valid.length / chunkSize);
                const runs = [];
                for (let p = 0; p < parts; p++) {
                    const chunk = valid.slice(p * chunkSize, (p + 1) * chunkSize);
                    const kinds = [...new Set(chunk.map(o => o.kind))];
                    const r = await store.recordRun({
                        mode: 'seed', source: src.source, observations: chunk,
                        summary: { seed: { sourceKey, batchId, part: p + 1, parts, kinds } },
                    });
                    runs.push({ runId: r.runId, part: p + 1, observations: r.observations, kinds });
                }
                return { sourceKey, batchId, parts, runs, observations: valid.length, unusable: mapped.unusable, excluded, unresolvedReferences: mapped.unresolvedReferences };
            } finally {
                staging = false;
            }
        },
    };
}
