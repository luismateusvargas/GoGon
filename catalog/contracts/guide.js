// catalog/contracts/guide.js - CAT-TASK-001 / AC-CAT-011, AC-CAT-012, AC-CAT-015 (catalog-sync-v1 1.2.x)
// The Fallen Sword guide as a catalog source, taken from the supplied userscripts in
// reconciliation/scrappers (item, creature, and realm/master-realm scrapers). This module is also
// inlined into the relay userscript (scripts/catalog/build-relay-userscript.mjs), so it has no
// imports and only plain data and pure functions.
//
// New IDs can appear on any index page when a low-level item, creature, or realm is released.
// Every active kind scans all its index pages; page counts are never fixed ceilings.

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
    indexCoverage: 'all_pages',
    firstIndex: 0,
    attestedBy: 'owner',
    attestedOn: '2026-09-29',
    runtimeCheck: 'repeated_final_page',
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

/** The guide repeats its final non-empty page for every later index. */
export function isRepeatedIndexPage(ids, previousIds) {
    return Array.isArray(previousIds) && ids.length > 0 && ids.length === previousIds.length
        && ids.every((id, index) => id === previousIds[index]);
}
