// Preserve existing IDs and natural realm/name keys while adding full Guide coverage.
const KINDS = "entity_kind IN ('item', 'creature', 'realm', 'master_realm', 'relic', 'quest')";

/** Expands Guide tracking without replacing stored records; safe to resume after interruption.
 * @param {{query: Function}} client Migration connection.
 * @returns {Promise<void>}
 */
export async function up(client) {
    for (const sql of [
        'ALTER TABLE catalog_guide_ids ADD COLUMN entity_key VARCHAR(255)',
        'ALTER TABLE relics ADD COLUMN details LONGTEXT',
    ]) {
        try { await client.query(sql); } catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
    }
    for (const table of ['catalog_guide_state', 'catalog_guide_ids', 'catalog_guide_leases']) {
        const checks = await client.query(
            `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
             JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
             WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`, [table]);
        const current = checks.find(row => /entity_kind/.test(String(row.clause)));
        if (current && /'quest'/.test(String(current.clause))) continue;
        const drop = current ? `DROP CHECK \`${current.name}\`, ` : '';
        await client.query(`ALTER TABLE ${table} ${drop}ADD CONSTRAINT ${table}_kind_chk CHECK (${KINDS})`);
    }
    for (const kind of ['relic', 'quest']) await client.query(
        'INSERT IGNORE INTO catalog_guide_state (entity_kind, updated_at) VALUES (?, ?)', [kind, '1970-01-01T00:00:00.000Z']);
    try { await client.query('CREATE INDEX catalog_guide_ids_entity_key ON catalog_guide_ids (entity_kind, entity_key)'); }
    catch (error) { if (error?.code !== 'ER_DUP_KEYNAME') throw error; }
}
