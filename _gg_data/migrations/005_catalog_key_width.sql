-- 005_catalog_key_width.sql - CAT-TASK-002 (catalog-sync-v1 1.1.3)
-- Databases that applied the first version of 003_catalog_sync.sql have entity_key VARCHAR(191),
-- too narrow for a relic or quest key "realm_id:name" (up to 211 characters). 003 now creates
-- VARCHAR(255) directly; this widens existing columns. Re-running MODIFY with the same definition
-- is a no-op, so the migration is idempotent (AC-DATA-001). Index sizes stay within InnoDB's
-- 3072-byte limit (largest: the observation content key, 1468 bytes).

ALTER TABLE catalog_observations MODIFY entity_key VARCHAR(255) NOT NULL;

ALTER TABLE catalog_entities MODIFY entity_key VARCHAR(255) NOT NULL;
