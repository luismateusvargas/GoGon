-- 014_notification_outbox.sql - specs/tasks/2026-10-notification-outbox.md (discord-integration, data-storage)
-- Durable hand-off between a monitor's dedupe claim and Discord delivery. A monitor appends the
-- event ID to its key_value_store list and inserts these rows in one transaction, so a claimed
-- alert survives a webhook error or a restart. (source, event_id, part) makes a repeated claim a
-- no-op; part numbers the messages of one event (a long game update, ladder band results).
-- setting_key names the webhook setting (e.g. GG_CRATES_WEBHOOK); the URL is resolved at dispatch
-- and never stored. payload is the Discord message body built from game data, never a secret.
-- account_scope is 'env' or 'profile:<account_profiles.id>': a row is only sent while that account
-- is active. Additive; the processed_* lists stay the dedupe history. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS notification_outbox (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(32) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    part SMALLINT NOT NULL DEFAULT 0,
    account_scope VARCHAR(64) NOT NULL,
    setting_key VARCHAR(64) NOT NULL,
    payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
    state VARCHAR(16) NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at VARCHAR(30) NOT NULL,
    last_error VARCHAR(64),                  -- sanitized category and HTTP status; never a URL or body
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30) NOT NULL,
    delivered_at VARCHAR(30),
    INDEX notification_outbox_due (state, account_scope, next_attempt_at),
    CONSTRAINT notification_outbox_event UNIQUE (source, event_id, part)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
