-- 006_catalog_discovery.sql - CAT-TASK-009 / AC-CAT-011, AC-CAT-012, AC-CAT-013, AC-CAT-015 (catalog-sync-v1 1.3.0)
-- Guide discovery state. One checkpoint row per guide entity kind, one refresh row per guide ID,
-- and a per-UTC-day request counter for the guide daily cap. Every statement is idempotent
-- (AC-DATA-001). Columns and CHECK changes on existing catalog tables are in
-- 007_catalog_discovery_columns.mjs, because MySQL cannot add them idempotently in plain SQL.

-- last_seen_id is a scan hint, never an exclusion rule. next_page/sweep_* are the page cursor of the
-- sweep in progress; they only move after a validated page. last_successful_check_at moves only
-- when a sweep covered every required page (AC-CAT-015).
CREATE TABLE IF NOT EXISTS catalog_guide_state (
    entity_kind VARCHAR(16) NOT NULL PRIMARY KEY CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm')),
    last_seen_id BIGINT NOT NULL DEFAULT 0,
    last_successful_check_at VARCHAR(30),
    last_full_sweep_at VARCHAR(30),
    last_page_seen INT,                      -- last non-empty index page of the latest complete sweep
    sweep_mode VARCHAR(16) CHECK (sweep_mode IS NULL OR sweep_mode IN ('incremental', 'full')),
    sweep_started_at VARCHAR(30),
    next_page INT NOT NULL DEFAULT 0,
    sweep_pages_checked INT NOT NULL DEFAULT 0,
    sweep_max_id BIGINT NOT NULL DEFAULT 0,
    sweep_prev_min_id BIGINT,                -- smallest ID of the last accepted page (order check)
    stop_after_page INT,                     -- incremental sweep: last page to read
    order_state VARCHAR(16) NOT NULL DEFAULT 'attested' CHECK (order_state IN ('attested', 'verified', 'violated')),
    status VARCHAR(16) NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'partial', 'challenged', 'failed')),
    status_reason VARCHAR(64),
    updated_at VARCHAR(30) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- detail_status: pending (seen on an index, detail never read), ok, failed (validation failed after
-- the retry limit), missing (the guide has no page for it). next_detail_at orders refreshes.
CREATE TABLE IF NOT EXISTS catalog_guide_ids (
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm')),
    entity_id BIGINT NOT NULL,
    first_seen_at VARCHAR(30) NOT NULL,
    last_index_seen_at VARCHAR(30),
    detail_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (detail_status IN ('pending', 'ok', 'failed', 'missing')),
    detail_hash CHAR(64),
    detail_checked_at VARCHAR(30),
    detail_attempts INT NOT NULL DEFAULT 0,
    next_detail_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (entity_kind, entity_id),
    INDEX catalog_guide_ids_due (entity_kind, next_detail_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS catalog_guide_usage (
    day CHAR(10) NOT NULL PRIMARY KEY,       -- UTC YYYY-MM-DD
    requests INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT IGNORE INTO catalog_guide_state (entity_kind, updated_at) VALUES ('item', '1970-01-01T00:00:00.000Z');
INSERT IGNORE INTO catalog_guide_state (entity_kind, updated_at) VALUES ('creature', '1970-01-01T00:00:00.000Z');
INSERT IGNORE INTO catalog_guide_state (entity_kind, updated_at) VALUES ('realm', '1970-01-01T00:00:00.000Z');
INSERT IGNORE INTO catalog_guide_state (entity_kind, updated_at) VALUES ('master_realm', '1970-01-01T00:00:00.000Z');
