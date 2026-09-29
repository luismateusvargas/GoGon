// catalog/contracts/gameLocation.js - CAT-TASK-001 / AC-CAT-001, AC-CAT-003 (catalog-sync-v1 1.2.x)
// The game's current-location read, game_modules/API.js world.fetchLocation
// (fetchdata.php?a=-1&d=1409&passback=kta). It is a JSON read with the envelope API.js documents
// ('s', 'r', 't', 'h'), but its body has never been captured. Owner decision 2026-09-28: build it
// fail-closed. `verified` stays false and `mapping` null until an owner captures one response, saves a
// redacted fixture under tests/catalog-sync/fixtures/, and fills in the mapping below; until then
// observe_realm jobs are refused (catalog/requestPolicy.js).
//
// mapping (when verified) names where the permitted fields live, as dotted paths:
//   { realm: { id, name }, creatures: { list, where?: { path, equals }, id, name, imageUrl } }
// Only these fields are ever read; everything else in the response is ignored and never stored.

export const GAME_LOCATION_CONTRACT = Object.freeze({
    id: 'game.current_location',
    endpoint: 'world.fetchLocation',   // key path into apiEndpoints; the URL itself is code-owned there
    method: 'GET',
    expect: 'json',
    verified: false,
    verifiedOn: null,
    fixture: null,
    mapping: null,
    allowedFields: Object.freeze({ realm: ['id', 'name'], creature: ['id', 'name', 'imageUrl'] }),
});

/**
 * Game-side detail reads for optional frontiers. API.js has no creature- or item-detail read, so
 * neither exists; item_frontier stays unavailable until one is added and validated (CAT-TASK-001).
 */
export const GAME_DETAIL_CONTRACTS = Object.freeze({ creature: null, item: null });

/** Resolves a dotted path ("a.b.0.c") in parsed JSON; missing segments give undefined. */
export function pick(value, dotted) {
    if (typeof dotted !== 'string' || !dotted) return undefined;
    let v = value;
    for (const part of dotted.split('.')) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, part)) return undefined;
        v = v[part];
    }
    return v;
}

/** True when a contract may drive live requests: verified, dated, with a fixture and a mapping. */
export function isContractUsable(contract) {
    return Boolean(contract && contract.verified === true && contract.verifiedOn && contract.fixture && contract.mapping);
}
