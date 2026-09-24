-- 002_control_plane.sql - CTRL-TASK-002 / AC-CTRL-003, AC-CTRL-004 (MySQL 8.4 since data-storage 2.0.0)
-- Control-plane state: configuration overrides, module preferences, encrypted account profiles,
-- and redacted audit events. Secret values are stored only as AES-256-GCM ciphertext.
-- Timestamps are ISO-8601 UTC strings written by controlStore.js. "At most one active profile" is
-- enforced by setActiveProfile() clearing every other flag in the same transaction.

CREATE TABLE IF NOT EXISTS config_overrides (
    `key` VARCHAR(64) NOT NULL PRIMARY KEY,   -- a config/registry.mjs key; never an arbitrary env name
    `value` TEXT NOT NULL,                    -- plaintext for non-secret keys, ciphertext for secret keys
    encrypted TINYINT NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
    updated_at VARCHAR(30) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS module_preferences (
    module_id VARCHAR(64) NOT NULL PRIMARY KEY,   -- stable engine task name, e.g. 'SuperElites'
    enabled TINYINT NOT NULL CHECK (enabled IN (0, 1)),
    interval_ms BIGINT NOT NULL CHECK (interval_ms > 0),
    updated_at VARCHAR(30) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS account_profiles (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    label VARCHAR(100) NOT NULL,
    email_ciphertext TEXT NOT NULL,
    password_ciphertext TEXT NOT NULL,
    active TINYINT NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30) NOT NULL,
    CONSTRAINT account_profiles_label UNIQUE (label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    occurred_at VARCHAR(30) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    subject VARCHAR(128) NOT NULL,
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
    detail TEXT,                              -- redacted JSON; never credentials, tokens, URLs, or ciphertext
    INDEX audit_events_occurred_at (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
