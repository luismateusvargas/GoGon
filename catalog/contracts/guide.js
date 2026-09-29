// catalog/contracts/guide.js - CAT-TASK-001 / AC-CAT-011, AC-CAT-012, AC-CAT-015 (catalog-sync-v1 1.2.x)
// The Fallen Sword guide as a catalog source, taken from the supplied userscripts in
// reconciliation/scrappers (item, creature, and realm/master-realm scrapers). This module is also
// inlined into the relay userscript (scripts/catalog/build-relay-userscript.mjs), so it has no
// imports and only plain data and pure functions.
//
// Ordering: owner-attested 2026-09-28 (DEC-CAT-017). Index page 0 holds the newest records and the
// last page the oldest. It is still checked on every run (descending IDs within and across pages);
// a violation turns that kind back to full sweeps (AC-CAT-012).

export const GUIDE_ORIGIN = 'https://guide.fallensword.com';
export const GUIDE_KINDS = Object.freeze(['item', 'creature', 'realm', 'master_realm']);

/** Code-owned URL shapes. Only a non-negative page index or a positive ID is ever substituted. */
export const GUIDE_URLS = Object.freeze({
    item: Object.freeze({
        index: '/index.php?cmd=items&index={page}',
        detail: '/index.php?cmd=items&subcmd=view&item_id={id}',
        idParam: 'item_id',
    }),
    creature: Object.freeze({
        index: '/index.php?cmd=creatures&index={page}&search_name=&search_level_min=-1&search_level_max=-1&search_class=-1&search_type=-1',
        detail: '/index.php?cmd=creatures&subcmd=view&creature_id={id}',
        idParam: 'creature_id',
    }),
    realm: Object.freeze({
        index: '/index.php?cmd=realms&index={page}',
        detail: '/index.php?cmd=realms&subcmd=view&realm_id={id}',
        idParam: 'realm_id',
    }),
    master_realm: Object.freeze({
        index: '/index.php?cmd=masterrealms&index={page}',
        detail: '/index.php?cmd=masterrealms&subcmd=view&masterrealm_id={id}',
        idParam: 'masterrealm_id',
    }),
});

export const GUIDE_ORDERING = Object.freeze({
    order: 'newest_first',
    firstIndex: 0,
    attestedBy: 'owner',
    attestedOn: '2026-09-28',
    runtimeCheck: 'descending_ids',
});

export const MAX_GUIDE_ID = 10_000_000;
export const MAX_GUIDE_PAGE = 10_000;

/** Builds a guide URL from a code-owned template; anything but a bounded integer is refused. */
export function guideUrl(kind, phase, value) {
    const spec = GUIDE_URLS[kind];
    if (!spec || (phase !== 'index' && phase !== 'detail')) throw new Error('Unknown guide request.');
    const ok = phase === 'index'
        ? Number.isSafeInteger(value) && value >= 0 && value <= MAX_GUIDE_PAGE
        : Number.isSafeInteger(value) && value > 0 && value <= MAX_GUIDE_ID;
    if (!ok) throw new Error('Guide page or ID out of range.');
    return GUIDE_ORIGIN + spec[phase].replace(phase === 'index' ? '{page}' : '{id}', String(value));
}

/**
 * The newest-first check for one page of IDs in document order (duplicates already removed).
 * @param {number[]} ids - this page
 * @param {number|null} previousMin - the smallest ID of the previous page, or null for page 0
 * @returns {boolean} true when the page is strictly descending and entirely below previousMin
 */
export function isDescendingPage(ids, previousMin) {
    for (let i = 1; i < ids.length; i++) if (!(ids[i] < ids[i - 1])) return false;
    return previousMin === null || ids.length === 0 || ids[0] < previousMin;
}
