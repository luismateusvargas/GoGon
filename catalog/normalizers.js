// catalog/normalizers.js - CAT-TASK-003 / AC-CAT-003, AC-CAT-004, AC-CAT-005 (catalog-sync-v1 1.3.0)
// Turns a classified 'ok' game response into catalog observations using only the fields its
// validated contract maps (catalog/contracts/gameLocation.js). Everything else in the response is
// ignored and never stored. A missing or ill-typed required field throws NormalizeError, which the
// collector records as a failed run without advancing its cursor.
import { pick } from './contracts/gameLocation.js';

export class NormalizeError extends Error {
    constructor(reason) { super(`Unrecognized response: ${reason}.`); this.code = 'schema'; this.reason = reason; }
}

export const MAX_LOCATION_CREATURES = 200;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function id(value, what) {
    const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
    if (!(Number.isSafeInteger(n) && n > 0)) throw new NormalizeError(`${what} id`);
    return n;
}

function name(value, what, { required = true } = {}) {
    if (value === undefined || value === null) {
        if (required) throw new NormalizeError(`${what} name`);
        return undefined;
    }
    if (typeof value !== 'string') throw new NormalizeError(`${what} name`);
    const t = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 256);
    if (!t && required) throw new NormalizeError(`${what} name`);
    return t || undefined;
}

/** An https URL on a fallensword.com host, or undefined (never stored otherwise). */
export function safeImageUrl(value) {
    if (typeof value !== 'string' || value.length > 512) return undefined;
    try {
        const u = new URL(value, 'https://www.fallensword.com/');
        if (!/^https?:$/.test(u.protocol) || !/(^|\.)fallensword\.com$/i.test(u.hostname) || u.username || u.password) return undefined;
        u.protocol = 'https:';
        return u.toString();
    } catch { return undefined; }
}

/**
 * Current location -> realm, creature identities (ID, name, image), and realm_creature relations.
 * @returns {{ realmId: number, observations: Array<{ kind: string, payload: object }> }}
 */
export function normalizeLocation(json, contract) {
    const m = contract?.mapping;
    if (!m?.realm || !m?.creatures) throw new NormalizeError('no field mapping');
    const realmId = id(pick(json, m.realm.id), 'realm');
    const realm = { id: realmId };
    const realmName = name(pick(json, m.realm.name), 'realm', { required: false });
    if (realmName) realm.name = realmName;
    const list = pick(json, m.creatures.list);
    if (list !== undefined && !Array.isArray(list)) throw new NormalizeError('creature list');
    const observations = [{ kind: 'realm', payload: realm }];
    const seen = new Set();
    for (const entry of list ?? []) {
        if (m.creatures.where && pick(entry, m.creatures.where.path) !== m.creatures.where.equals) continue;
        const creatureId = id(pick(entry, m.creatures.id), 'creature');
        if (seen.has(creatureId)) continue;
        if (seen.size >= MAX_LOCATION_CREATURES) throw new NormalizeError('too many creatures');
        seen.add(creatureId);
        const creature = { id: creatureId, name: name(pick(entry, m.creatures.name), 'creature') };
        const image = m.creatures.imageUrl ? safeImageUrl(pick(entry, m.creatures.imageUrl)) : undefined;
        if (image) creature.imageUrl = image;
        observations.push({ kind: 'creature', payload: creature });
    }
    for (const creatureId of seen) observations.push({ kind: 'relation', payload: { type: 'realm_creature', realm_id: realmId, creature_id: creatureId } });
    return { realmId, observations };
}

/**
 * Game item detail (item_frontier). notFound: the contract's known-not-found shape, a negative
 * outcome that is recorded separately and never treated as proof of absence (AC-CAT-004).
 * @returns {{ found: false } | { found: true, observation: { kind: 'item', payload: object } }}
 */
export function normalizeItem(json, contract, expectedId) {
    const m = contract?.mapping;
    if (!m?.item) throw new NormalizeError('no field mapping');
    if (m.notFound && pick(json, m.notFound.path) === m.notFound.equals) return { found: false };
    const itemId = id(pick(json, m.item.id), 'item');
    if (itemId !== expectedId) throw new NormalizeError('item id mismatch');
    const payload = { id: itemId, name: name(pick(json, m.item.name), 'item') };
    if (m.item.rarity) {
        const r = name(pick(json, m.item.rarity), 'item rarity', { required: false });
        if (r) payload.rarity = r.slice(0, 64);
    }
    const image = m.item.imageUrl ? safeImageUrl(pick(json, m.item.imageUrl)) : undefined;
    if (image) payload.imageUrl = image;
    return { found: true, observation: { kind: 'item', payload } };
}
