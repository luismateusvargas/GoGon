-- 001_initial_schema.sql - core tables (MySQL 8.4, data-storage-v1 2.0.0 / DATA-TASK-004)
-- MySQL commits DDL implicitly, so every statement is idempotent (AC-DATA-001).
-- utf8mb4_bin keeps key comparison exact and case-sensitive. No foreign keys: scrapers
-- bulk-replace master-data tables in any order.

CREATE TABLE IF NOT EXISTS key_value_store (
    `key` VARCHAR(191) NOT NULL PRIMARY KEY,
    `value` LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS items (
    id BIGINT NOT NULL PRIMARY KEY,
    name TEXT,
    rarity VARCHAR(64),
    imageUrl TEXT,
    stats LONGTEXT,
    enhancements LONGTEXT,
    droppedBy LONGTEXT,
    setBonuses LONGTEXT,
    setId BIGINT,
    setName TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS creatures (
    id BIGINT NOT NULL PRIMARY KEY,
    name TEXT,
    imageUrl TEXT,
    description LONGTEXT,
    stats LONGTEXT,
    enhancements LONGTEXT,
    droppedItems LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS master_realms (
    id BIGINT NOT NULL PRIMARY KEY,
    name TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS realms (
    id BIGINT NOT NULL PRIMARY KEY,
    name TEXT,
    min_level INT,
    master_realm_id BIGINT,
    creatures LONGTEXT,
    relics LONGTEXT,
    quests LONGTEXT,
    shops LONGTEXT,
    connections LONGTEXT,
    map_objects LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- relics.id is assigned by MySQL: scripts/populate_db.mjs inserts relics by name and realm only.
CREATE TABLE IF NOT EXISTS relics (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name TEXT,
    realm_id BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
