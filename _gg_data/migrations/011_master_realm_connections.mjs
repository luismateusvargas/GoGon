// Keep guide master-realm teleport destinations independent of realm membership.
// An interrupted migration can safely retry the column addition and detail refresh.
export async function up(client) {
    try {
        await client.query('ALTER TABLE master_realms ADD COLUMN connected_realms LONGTEXT');
    } catch (error) {
        if (error?.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    // Force one reread of previously verified details. The stored detail hash otherwise causes
    // guideRelay to skip projection even though the new field was absent from older observations.
    await client.query("UPDATE catalog_guide_ids SET detail_hash = NULL, next_detail_at = '1970-01-01T00:00:00.000Z' WHERE entity_kind = 'master_realm' AND detail_status = 'ok' AND detail_hash IS NOT NULL");
}
