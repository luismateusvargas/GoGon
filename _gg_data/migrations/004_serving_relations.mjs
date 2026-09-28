// 004_serving_relations.mjs - CAT-TASK-002 (catalog-sync-v1 1.1.0, data-storage-v1 2.1.0)
// Adds foreign keys to the existing serving columns and backfills the normalized relations from
// the legacy JSON columns. MySQL has no ADD CONSTRAINT IF NOT EXISTS, so each key is guarded by an
// information_schema lookup; every step is safe to re-run (AC-DATA-001).
//   realms.master_realm_id -> master_realms.id  ON DELETE SET NULL (dangling IDs are cleared first)
//   relics.realm_id        -> realms.id         ON DELETE CASCADE  (orphan relics are deleted first)
import { deriveRelations, writeRelations } from '../handler/servingRelations.js';

const RETROFITS = [
    {
        table: 'realms', name: 'realms_master_realm_fk',
        cleanup: 'UPDATE realms SET master_realm_id = NULL WHERE master_realm_id IS NOT NULL AND master_realm_id NOT IN (SELECT id FROM master_realms)',
        add: 'ALTER TABLE realms ADD CONSTRAINT realms_master_realm_fk FOREIGN KEY (master_realm_id) REFERENCES master_realms (id) ON DELETE SET NULL',
    },
    {
        table: 'relics', name: 'relics_realm_fk',
        cleanup: 'DELETE FROM relics WHERE realm_id IS NOT NULL AND realm_id NOT IN (SELECT id FROM realms)',
        add: 'ALTER TABLE relics ADD CONSTRAINT relics_realm_fk FOREIGN KEY (realm_id) REFERENCES realms (id) ON DELETE CASCADE',
    },
];

/** @param {{ query: Function }} client */
export async function up(client) {
    for (const fk of RETROFITS) {
        const existing = await client.query(
            "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
            [fk.table, fk.name]);
        if (existing.length) continue;
        const { affectedRows } = await client.query(fk.cleanup);
        if (affectedRows) console.log(`[GG_DB] ${fk.name}: fixed ${affectedRows} dangling row(s) in ${fk.table} before adding the key.`);
        await client.query(fk.add);
    }

    const ids = async table => new Set((await client.query(`SELECT id FROM ${table}`)).map(r => Number(r.id)));
    const relations = deriveRelations({
        realms: await client.query('SELECT id, creatures, quests FROM realms'),
        creatures: await client.query('SELECT id, droppedItems FROM creatures'),
        creatureIds: await ids('creatures'),
        itemIds: await ids('items'),
    });
    const written = await writeRelations(client, relations);
    console.log(`[GG_DB] Backfilled relations: ${written.realmCreatures} realm-creature, ${written.creatureDrops} creature-drop, ${written.quests} quest; ${relations.skipped} unresolved reference(s) left unknown.`);
}
