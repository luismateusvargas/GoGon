// catalog/guideNormalizers.js - CAT-TASK-010 / AC-CAT-011, AC-CAT-013, AC-CAT-014 (catalog-sync-v1 1.3.0)
// Server-side validation of what the guide relay sends. The relay runs catalog/guideParsers.js in the
// owner's browser, but nothing it sends is trusted: every record is checked against a strict wire
// schema (allowed keys, types, lengths, counts, https image URLs on fallensword.com) and mapped to
// catalog observations here. A record that fails is an invalid detail, never stored.
import { canonicalJson, sha256 } from '../_gg_data/handler/catalogStore.js';
import { MAX_GUIDE_ID } from './contracts/guide.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const S = {
    id: v => Number.isSafeInteger(v) && v > 0 && v <= MAX_GUIDE_ID,
    int: v => Number.isSafeInteger(v) && Math.abs(v) <= 1e12,
    num: (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi,
    str: max => v => typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL.test(v),
    opt: f => v => v === null || v === undefined || f(v),
    arr: (f, max) => v => Array.isArray(v) && v.length <= max && v.every(f),
    obj: (shape, required = []) => v => isPlain(v) && Object.keys(v).every(k => Object.hasOwn(shape, k))
        && required.every(k => v[k] !== undefined) && Object.entries(v).every(([k, x]) => shape[k](x)),
    url: v => {
        if (typeof v !== 'string' || v.length > 512) return false;
        try { const u = new URL(v); return u.protocol === 'https:' && /(^|\.)fallensword\.com$/i.test(u.hostname) && !u.username && !u.password; } catch { return false; }
    },
};

const range = S.obj({ min: S.int, max: S.int }, ['min', 'max']);
const itemStats = { type: S.opt(S.str(64)), level: S.opt(S.int), attack: S.opt(S.int), defense: S.opt(S.int), armor: S.opt(S.int), damage: S.opt(S.int), hp: S.opt(S.int), xpGain: S.opt(S.int), stamina: S.opt(S.int), staminaGain: S.opt(S.int), goldGain: S.opt(S.int) };
const enhancement = S.obj({ name: S.str(191), value: S.num(0, 100000) }, ['name', 'value']);

export const RECORD_SCHEMAS = Object.freeze({
    item: S.obj({
        id: S.id, name: S.str(191), rarity: S.opt(S.str(64)), imageUrl: S.opt(S.url),
        stats: S.obj(itemStats), enhancements: S.arr(enhancement, 64),
        droppedBy: S.arr(S.obj({ creatureName: S.str(191), dropRate: S.num(0, 100) }, ['creatureName', 'dropRate']), 200),
        setId: S.opt(S.id), setName: S.opt(S.str(191)),
        setBonuses: S.opt(S.obj({ ...itemStats, enhancements: S.arr(enhancement, 64) })),
    }, ['id', 'name', 'stats', 'enhancements', 'droppedBy']),
    creature: S.obj({
        id: S.id, name: S.str(191), description: S.opt(S.str(8192)), imageUrl: S.opt(S.url),
        stats: S.obj({ class: S.opt(S.str(64)), level: S.opt(S.int), attack: range, defense: range, armor: range, damage: range, hp: range, gold: range, xp: range }),
        enhancements: S.arr(S.str(256), 64),
        droppedItems: S.arr(S.obj({ itemId: S.id, itemName: S.opt(S.str(191)) }, ['itemId']), 200),
        realms: S.arr(S.obj({ realmId: S.id, realmName: S.opt(S.str(191)) }, ['realmId']), 200),
    }, ['id', 'name', 'stats', 'enhancements', 'droppedItems', 'realms']),
    realm: S.obj({
        id: S.id, name: S.str(191), minLevel: S.opt(S.int),
        shops: S.arr(S.obj({ shopId: S.id, shopName: S.opt(S.str(191)) }, ['shopId']), 200),
        relics: S.arr(S.str(191), 200),
        quests: S.arr(S.obj({ questId: S.id, questName: S.str(191) }, ['questId', 'questName']), 200),
        creatures: S.arr(S.obj({ creatureId: S.id, creatureName: S.opt(S.str(191)) }, ['creatureId']), 200),
        stairways: S.arr(S.obj({ targetRealmId: S.id, targetRealmName: S.opt(S.str(191)) }, ['targetRealmId']), 200),
    }, ['id', 'name', 'shops', 'relics', 'quests', 'creatures', 'stairways']),
    master_realm: S.obj({
        id: S.id, name: S.str(191), minLevel: S.opt(S.int), imageUrl: S.opt(S.url),
        realms: S.arr(S.obj({ realmId: S.id, realmName: S.opt(S.str(191)), minLevel: S.opt(S.int) }, ['realmId']), 200),
    }, ['id', 'name', 'realms']),
});

export const indexEntry = S.obj({ id: S.id, name: S.opt(S.str(191)) }, ['id']);

const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * Maps one validated guide record to catalog observations.
 * @returns {null | { hash: string, observations: object[], references: Array<{ kind, id, name }>, relations: object[] }}
 *   null when the record fails its schema. references: entities the page links to (staged as
 *   minimal records only when unknown). relations: staged only when both ends exist.
 */
export function normalizeGuideRecord(kind, record, expectedId) {
    const schema = RECORD_SCHEMAS[kind];
    if (!schema || !schema(record) || record.id !== expectedId) return null;
    const hash = sha256(canonicalJson(record));
    const observations = [];
    const references = [];
    const relations = [];
    if (kind === 'item') {
        observations.push({ kind: 'item', payload: compact({
            id: record.id, name: record.name, rarity: record.rarity, imageUrl: record.imageUrl, stats: record.stats,
            enhancements: record.enhancements, droppedBy: record.droppedBy, setId: record.setId, setName: record.setName, setBonuses: record.setBonuses,
        }) });
    } else if (kind === 'creature') {
        observations.push({ kind: 'creature', payload: compact({
            id: record.id, name: record.name, imageUrl: record.imageUrl, description: record.description, stats: record.stats,
            enhancements: record.enhancements, droppedItems: record.droppedItems,
        }) });
        for (const d of record.droppedItems) {
            references.push({ kind: 'item', id: d.itemId, name: d.itemName ?? null });
            relations.push({ type: 'creature_drop', creature_id: record.id, item_id: d.itemId });
        }
        for (const r of record.realms) {
            references.push({ kind: 'realm', id: r.realmId, name: r.realmName ?? null });
            relations.push({ type: 'realm_creature', realm_id: r.realmId, creature_id: record.id });
        }
    } else if (kind === 'realm') {
        observations.push({ kind: 'realm', payload: compact({
            id: record.id, name: record.name, min_level: record.minLevel, shops: record.shops, connections: record.stairways,
        }) });
        for (const relic of record.relics) observations.push({ kind: 'relic', payload: { realm_id: record.id, name: relic } });
        for (const q of record.quests) observations.push({ kind: 'quest', payload: { realm_id: record.id, name: q.questName } });
        for (const c of record.creatures) {
            references.push({ kind: 'creature', id: c.creatureId, name: c.creatureName ?? null });
            relations.push({ type: 'realm_creature', realm_id: record.id, creature_id: c.creatureId });
        }
    } else {
        observations.push({ kind: 'master_realm', payload: {
            id: record.id, name: record.name, connected_realms: record.realms,
        } });
        for (const r of record.realms) {
            observations.push({ kind: 'realm', payload: { id: r.realmId, master_realm_id: record.id } });
            references.push({ kind: 'realm', id: r.realmId, name: r.realmName ?? null });
        }
    }
    return { hash, observations, references, relations };
}
