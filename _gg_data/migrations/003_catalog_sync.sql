-- 003_catalog_sync.sql - CAT-TASK-002 / AC-CAT-005, AC-CAT-006, AC-CAT-010 (catalog-sync-v1 1.1.0)
-- Normalized serving relations (quests, realm_creatures, creature_drops) and the catalog provenance
-- store: runs, durable jobs, content-addressed observations, the run <-> observation links that make
-- per-run rollback possible, the current projection of each entity, and one-use action plans.
-- Every statement is idempotent (AC-DATA-001). Foreign keys to serving tables CASCADE, so a removed
-- entity never leaves a dangling relation; foreign keys inside the catalog store RESTRICT, so
-- provenance cannot silently disappear. Writers must upsert serving rows with
-- INSERT ... ON DUPLICATE KEY UPDATE, never REPLACE INTO (REPLACE deletes the parent row first).
-- Existing serving columns get their foreign keys in 004_serving_relations.mjs.

-- --- Normalized serving relations -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS quests (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    realm_id BIGINT NOT NULL,
    name VARCHAR(191) NOT NULL,
    min_level INT,
    details LONGTEXT,
    CONSTRAINT quests_realm_name UNIQUE (realm_id, name),
    CONSTRAINT quests_realm_fk FOREIGN KEY (realm_id) REFERENCES realms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS realm_creatures (
    realm_id BIGINT NOT NULL,
    creature_id BIGINT NOT NULL,
    PRIMARY KEY (realm_id, creature_id),
    INDEX realm_creatures_creature (creature_id),
    CONSTRAINT realm_creatures_realm_fk FOREIGN KEY (realm_id) REFERENCES realms (id) ON DELETE CASCADE,
    CONSTRAINT realm_creatures_creature_fk FOREIGN KEY (creature_id) REFERENCES creatures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS creature_drops (
    creature_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    PRIMARY KEY (creature_id, item_id),
    INDEX creature_drops_item (item_id),
    CONSTRAINT creature_drops_creature_fk FOREIGN KEY (creature_id) REFERENCES creatures (id) ON DELETE CASCADE,
    CONSTRAINT creature_drops_item_fk FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- --- Catalog provenance store ---------------------------------------------------------------

-- One row. revision increases on every projection, rollback, and legacy reload; a plan built at an
-- older revision is stale (AC-CAT-009). Projections lock this row, so they run one at a time.
CREATE TABLE IF NOT EXISTS catalog_state (
    id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
    revision BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT IGNORE INTO catalog_state (id, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS catalog_runs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    mode VARCHAR(32) NOT NULL CHECK (mode IN ('observe_realm', 'item_frontier', 'seed', 'promote', 'revert', 'baseline_snapshot')),
    source VARCHAR(32) NOT NULL CHECK (source IN ('game_session', 'guide_baseline', 'manual_import')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'reverted', 'discarded')),
    started_at VARCHAR(30) NOT NULL,
    finished_at VARCHAR(30),
    summary LONGTEXT CHECK (summary IS NULL OR JSON_VALID(summary)),   -- counts and redacted error code only
    INDEX catalog_runs_status (status),
    INDEX catalog_runs_started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- active_kind is non-NULL only while a job can still run, so its UNIQUE constraint allows at most
-- one active job per kind (per cursor): a second one fails with ER_DUP_ENTRY (AC-CAT-008 -> 409).
CREATE TABLE IF NOT EXISTS catalog_jobs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('observe_realm', 'item_frontier')),
    cursor_json TEXT NOT NULL CHECK (JSON_VALID(cursor_json)),
    state VARCHAR(16) NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    request_budget INT NOT NULL CHECK (request_budget BETWEEN 1 AND 50),
    active_kind VARCHAR(32) GENERATED ALWAYS AS (CASE WHEN state IN ('queued', 'running', 'paused') THEN kind ELSE NULL END) VIRTUAL,
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30) NOT NULL,
    CONSTRAINT catalog_jobs_one_active UNIQUE (active_kind),
    INDEX catalog_jobs_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Content-addressed and immutable: one row per distinct canonical payload of an entity per source.
-- Which runs saw it is recorded in catalog_run_observations.
CREATE TABLE IF NOT EXISTS catalog_observations (
    id CHAR(36) NOT NULL PRIMARY KEY,
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm', 'relic', 'quest', 'relation')),
    entity_key VARCHAR(255) NOT NULL,     -- game ID, realm_id:name (<= 211), or relation type:ids
    external_id VARCHAR(64),
    source VARCHAR(32) NOT NULL CHECK (source IN ('game_session', 'guide_baseline', 'manual_import')),
    payload_hash CHAR(64) NOT NULL,
    payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
    first_observed_at VARCHAR(30) NOT NULL,
    CONSTRAINT catalog_observations_content UNIQUE (source, entity_kind, entity_key, payload_hash),
    INDEX catalog_observations_entity (entity_kind, entity_key),
    INDEX catalog_observations_hash (payload_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- seq gives replay its deterministic order (AC-CAT-010).
CREATE TABLE IF NOT EXISTS catalog_run_observations (
    seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_id CHAR(36) NOT NULL,
    observation_id CHAR(36) NOT NULL,
    observed_at VARCHAR(30) NOT NULL,
    CONSTRAINT catalog_run_observations_pair UNIQUE (run_id, observation_id),
    INDEX catalog_run_observations_observation (observation_id),
    INDEX catalog_run_observations_observed_at (observed_at),
    CONSTRAINT catalog_run_observations_run_fk FOREIGN KEY (run_id) REFERENCES catalog_runs (id) ON DELETE RESTRICT,
    CONSTRAINT catalog_run_observations_observation_fk FOREIGN KEY (observation_id) REFERENCES catalog_observations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- The catalog's view of each projected serving entity. A row here means the serving row is under
-- catalog provenance (and scripts/populate_db.mjs refuses to replace it without an explicit flag).
CREATE TABLE IF NOT EXISTS catalog_entities (
    entity_kind VARCHAR(16) NOT NULL,
    entity_key VARCHAR(255) NOT NULL,
    observation_id CHAR(36) NOT NULL,     -- the latest observation applied to the serving row
    last_run_id CHAR(36) NOT NULL,
    first_seen_at VARCHAR(30) NOT NULL,
    last_seen_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (entity_kind, entity_key),
    INDEX catalog_entities_last_seen (last_seen_at),
    CONSTRAINT catalog_entities_observation_fk FOREIGN KEY (observation_id) REFERENCES catalog_observations (id) ON DELETE RESTRICT,
    CONSTRAINT catalog_entities_run_fk FOREIGN KEY (last_run_id) REFERENCES catalog_runs (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Short-lived, one-use previews for destructive actions (AC-CAT-009). Named "deletion plans" in the
-- spec; action 'promote' is reserved for CAT-TASK-007.
CREATE TABLE IF NOT EXISTS catalog_deletion_plans (
    id CHAR(36) NOT NULL PRIMARY KEY,
    action VARCHAR(16) NOT NULL CHECK (action IN ('rollback', 'promote')),
    target_run_id CHAR(36) NOT NULL,
    revision BIGINT NOT NULL,
    expected_counts TEXT NOT NULL CHECK (JSON_VALID(expected_counts)),
    confirmation VARCHAR(128) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    expires_at VARCHAR(30) NOT NULL,
    used_at VARCHAR(30),
    INDEX catalog_deletion_plans_run (target_run_id),
    CONSTRAINT catalog_deletion_plans_run_fk FOREIGN KEY (target_run_id) REFERENCES catalog_runs (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
