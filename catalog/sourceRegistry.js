// catalog/sourceRegistry.js - CAT-TASK-007 / AC-CAT-006 (catalog-sync-v1 1.3.0)
// Approved seed sources. The dashboard may name a source key; it can never supply a URL. The only
// source today is the snapshot scripts/populate_db.mjs already loads (the same four files), staged
// and promoted through the catalog instead of replacing the tables.

export const SEED_SOURCES = Object.freeze({
    fsdatabase: Object.freeze({
        label: 'ColonelReaper fsdatabase_ snapshot (GitHub)',
        source: 'guide_baseline',
        maxBytes: 64 * 1024 * 1024,   // per file
        files: Object.freeze({
            master_realm: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/master_realms.json',
            realm: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/74dba6f82cabbdf282958b1775bedce8f6636b8e/all_realms.json',
            creature: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/all_creatures.json',
            item: 'https://raw.githubusercontent.com/ColonelReaper/fsdatabase_/refs/heads/main/all_items.json',
        }),
    }),
});

/** Browser-safe description: key, label, kinds, and hosts (no paths). */
export function describeSeedSources() {
    return Object.entries(SEED_SOURCES).map(([key, s]) => ({
        key, label: s.label, source: s.source, kinds: Object.keys(s.files),
        hosts: [...new Set(Object.values(s.files).map(u => new URL(u).hostname))],
    }));
}
