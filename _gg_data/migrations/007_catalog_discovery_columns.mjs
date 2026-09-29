// 007_catalog_discovery_columns.mjs - CAT-TASK-009 / AC-CAT-011, AC-CAT-013 (catalog-sync-v1 1.3.0)
// Changes to catalog tables created by 003, made safe to re-run (AC-DATA-001):
//   - catalog_entities gains completeness, incomplete_reason, verified_at (item/creature coverage).
//     MySQL has no ADD COLUMN IF NOT EXISTS, so a duplicate column (ER_DUP_FIELDNAME) means done.
//   - catalog_runs.mode and catalog_jobs.kind accept 'guide_discovery'. Their CHECKs were declared
//     inline in 003, so MySQL named them <table>_chk_<n>. Databases created from the current 003
//     already accept the value; on older ones the CHECK is found through information_schema and
//     replaced under a stable name in a single statement, so an interrupted run cannot leave the
//     column unchecked and a re-run adds the allow-list back if it is absent.

const COLUMNS = [
    "ALTER TABLE catalog_entities ADD COLUMN completeness VARCHAR(16) CHECK (completeness IS NULL OR completeness IN ('complete', 'incomplete'))",
    'ALTER TABLE catalog_entities ADD COLUMN incomplete_reason VARCHAR(64)',
    'ALTER TABLE catalog_entities ADD COLUMN verified_at VARCHAR(30)',
];

export const RUN_MODES_CHECK = "mode IN ('observe_realm', 'item_frontier', 'guide_discovery', 'seed', 'promote', 'revert', 'baseline_snapshot')";
export const JOB_KINDS_CHECK = "kind IN ('observe_realm', 'item_frontier', 'guide_discovery')";

const CHECKS = [
    { table: 'catalog_runs', column: 'mode', name: 'catalog_runs_mode_chk', check: RUN_MODES_CHECK },
    { table: 'catalog_jobs', column: 'kind', name: 'catalog_jobs_kind_chk', check: JOB_KINDS_CHECK },
];

/** @param {{ query: Function }} client */
export async function up(client) {
    for (const sql of COLUMNS) {
        try {
            await client.query(sql);
        } catch (e) {
            if (e?.code !== 'ER_DUP_FIELDNAME') throw e;
        }
    }
    for (const c of CHECKS) {
        const rows = await client.query(
            `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
             JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
             WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`, [c.table]);
        // The allow-list CHECK on this column is the one naming 'observe_realm'.
        const current = rows.find(r => /observe_realm/.test(String(r.clause)));
        if (current && /guide_discovery/.test(String(current.clause))) continue;
        // Drop and add in one ALTER TABLE, which MySQL 8 applies atomically: the column is never left
        // without its allow-list. If none is found (the column lost it some other way), it is added.
        const drop = current ? `DROP CHECK \`${current.name}\`, ` : '';
        await client.query(`ALTER TABLE ${c.table} ${drop}ADD CONSTRAINT ${c.name} CHECK (${c.check})`);
        console.log(`[GG_DB] ${c.table}.${c.column} now accepts guide_discovery.`);
    }
}
