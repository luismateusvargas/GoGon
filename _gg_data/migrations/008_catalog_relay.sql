-- 008_catalog_relay.sql - CAT-TASK-010 / AC-CAT-014 (catalog-sync-v1 1.3.0)
-- Guide relay credentials and work leases. A token is shown to the owner once; only its SHA-256
-- is stored. It is scoped to guide staging, expires within seven days, and can be revoked. A lease
-- is the server-chosen work (one guide kind, index pages or detail IDs) handed to the relay; results
-- are accepted only for an open lease and only in its order. Leases are issued under a lock on the
-- guide state rows, so at most one is open; a submission first claims its lease (claimed_at), so a
-- lease is applied at most once. run_id links the staged run in the transaction that records it,
-- with results_hash, so a retry after a later failure does not stage the lease again and cannot
-- checkpoint different results against it. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS catalog_relay_tokens (
    id CHAR(36) NOT NULL PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    label VARCHAR(64) NOT NULL,
    scope VARCHAR(16) NOT NULL CHECK (scope IN ('guide_stage')),
    created_at VARCHAR(30) NOT NULL,
    expires_at VARCHAR(30) NOT NULL,
    revoked_at VARCHAR(30),
    last_used_at VARCHAR(30),
    CONSTRAINT catalog_relay_tokens_hash UNIQUE (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS catalog_guide_leases (
    id CHAR(36) NOT NULL PRIMARY KEY,
    token_id CHAR(36) NOT NULL,
    job_id CHAR(36) NOT NULL,
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm')),
    work LONGTEXT NOT NULL CHECK (JSON_VALID(work)),
    issued_at VARCHAR(30) NOT NULL,
    expires_at VARCHAR(30) NOT NULL,
    claimed_at VARCHAR(30),               -- set atomically when a submission starts; one submission per lease
    completed_at VARCHAR(30),
    run_id CHAR(36),                      -- the run this lease staged, linked when it is recorded
    results_hash CHAR(64),                -- SHA-256 of the results that run was built from; a retry must match it
    INDEX catalog_guide_leases_open (completed_at, expires_at),
    CONSTRAINT catalog_guide_leases_token_fk FOREIGN KEY (token_id) REFERENCES catalog_relay_tokens (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
