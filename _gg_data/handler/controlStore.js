// _gg_data/handler/controlStore.js - CTRL-TASK-002 / AC-CTRL-003, AC-CTRL-004 (async MySQL since DATA-TASK-007)
// Data access for the control plane: configuration overrides, module preferences, encrypted account
// profiles, and redacted audit events. Every mutation and its audit event commit in one transaction.
// Secret values are sealed with the keyring before they reach MySQL, so the database and any dump
// of it only ever hold ciphertext. Every method returns a Promise.
import crypto from 'node:crypto';
import { CONFIG_BY_KEY } from '../../config/registry.mjs';

const REDACT_KEY = /pass|token|secret|webhook|cookie|email|cipher|credential|hash|key$/i;

/**
 * Keeps only small, non-sensitive facts in audit details: sensitive-looking keys are dropped and
 * URL-like or long strings are replaced. Callers pass labels, keys, and outcomes, never values.
 */
export function redactDetail(detail) {
    if (detail == null || typeof detail !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(detail)) {
        if (REDACT_KEY.test(k)) { out[k] = '[redacted]'; continue; }
        if (typeof v === 'string') out[k] = /:\/\/|^v1:|@/.test(v) || v.length > 200 ? '[redacted]' : v;
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
        else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string' && x.length <= 64 && !/:\/\/|@/.test(x)).slice(0, 20);
    }
    return out;
}

const SQL = {
    audit: 'INSERT INTO audit_events (occurred_at, actor, action, subject, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
    listAudit: 'SELECT id, occurred_at AS occurredAt, actor, action, subject, outcome, detail FROM audit_events ORDER BY id DESC LIMIT ?',
    listOverrides: 'SELECT `key`, `value`, encrypted FROM config_overrides ORDER BY `key`',
    lockOverrides: 'SELECT `key`, `value`, encrypted FROM config_overrides ORDER BY `key` FOR UPDATE',
    upsertOverride: 'REPLACE INTO config_overrides (`key`, `value`, encrypted, updated_at) VALUES (?, ?, ?, ?)',
    deleteOverride: 'DELETE FROM config_overrides WHERE `key` = ?',
    listModules: 'SELECT module_id AS id, enabled, interval_ms AS intervalMs FROM module_preferences',
    upsertModule: 'REPLACE INTO module_preferences (module_id, enabled, interval_ms, updated_at) VALUES (?, ?, ?, ?)',
    listProfiles: 'SELECT id, label, active, created_at AS createdAt, updated_at AS updatedAt FROM account_profiles ORDER BY label',
    getProfile: 'SELECT * FROM account_profiles WHERE id = ?',
    labelTaken: 'SELECT id FROM account_profiles WHERE label = ? AND id <> ?',
    insertProfile: 'INSERT INTO account_profiles (id, label, email_ciphertext, password_ciphertext, active, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    updateProfileSecrets: 'UPDATE account_profiles SET email_ciphertext = ?, password_ciphertext = ?, updated_at = ? WHERE id = ?',
    deleteProfile: 'DELETE FROM account_profiles WHERE id = ? AND active = 0',
    clearActive: 'UPDATE account_profiles SET active = 0 WHERE active = 1',
    setActive: 'UPDATE account_profiles SET active = 1 WHERE id = ?',
    getActive: 'SELECT id, label FROM account_profiles WHERE active = 1 ORDER BY updated_at DESC LIMIT 1',
    lockSecrets: 'SELECT id, email_ciphertext, password_ciphertext FROM account_profiles FOR UPDATE',
};

const nowIso = () => new Date().toISOString();
const labelError = () => Object.assign(new Error('A profile with this label already exists.'), { field: 'label' });

/**
 * @param {{ query: Function, transaction: Function }} db - The migrated MySQL client (gg_database getConnection()).
 * @param {ReturnType<import('../../control-plane/crypto.mjs').createKeyring>} keyring
 */
export function createControlStore(db, keyring) {
    const isSecret = key => CONFIG_BY_KEY.get(key)?.sensitivity === 'secret';
    const overrideAad = key => `override:${key}`;
    const profileAad = (id, field) => `profile:${id}:${field}`;

    /** Writes one redacted audit event, inside the caller's transaction when q is given. */
    async function audit({ actor = 'system', action, subject, outcome = 'success', detail = null }, q = db) {
        const d = redactDetail(detail);
        await q.query(SQL.audit, [nowIso(), String(actor).slice(0, 64), String(action).slice(0, 64), String(subject).slice(0, 128), outcome, d ? JSON.stringify(d) : null]);
    }

    async function getProfile(id, q = db) {
        const [p] = await q.query(SQL.getProfile, [id]);
        return p ?? null;
    }

    return {
        audit: entry => audit(entry),

        async listAudit(limit = 50) {
            const rows = await db.query(SQL.listAudit, [Math.min(Math.max(1, limit | 0), 500)]);
            return rows.map(r => ({ ...r, id: Number(r.id), detail: r.detail ? JSON.parse(r.detail) : null }));
        },

        /** Decrypted overrides for config/runtime.mjs. Unregistered or unreadable rows are skipped. */
        async loadOverrides() {
            const entries = [];
            for (const row of await db.query(SQL.listOverrides)) {
                if (!CONFIG_BY_KEY.has(row.key)) continue;
                try {
                    entries.push([row.key, Number(row.encrypted) ? keyring.open(row.value, overrideAad(row.key)) : row.value]);
                } catch (e) {
                    await audit({ action: 'config.load', subject: row.key, outcome: 'failed', detail: { reason: 'decrypt' } });
                }
            }
            return entries;
        },

        /** Persists a validated override; secret keys are sealed. The caller validates first. */
        async setOverride(key, value, actor) {
            if (!CONFIG_BY_KEY.has(key)) throw new Error('Unregistered setting.');
            const secret = isSecret(key);
            await db.transaction(async tx => {
                await tx.query(SQL.upsertOverride, [key, secret ? keyring.seal(value, overrideAad(key)) : value, secret ? 1 : 0, nowIso()]);
                await audit({ actor, action: 'config.set', subject: key, detail: secret ? { value: '[redacted]' } : { value } }, tx);
            });
        },

        async clearOverride(key, actor) {
            return db.transaction(async tx => {
                const { affectedRows } = await tx.query(SQL.deleteOverride, [key]);
                await audit({ actor, action: 'config.clear', subject: key, detail: { existed: affectedRows > 0 } }, tx);
                return affectedRows > 0;
            });
        },

        async listModulePreferences() {
            const rows = await db.query(SQL.listModules);
            return new Map(rows.map(r => [r.id, { enabled: Number(r.enabled) === 1, intervalMs: Number(r.intervalMs) }]));
        },

        async setModulePreference(id, { enabled, intervalMs }, actor) {
            await db.transaction(async tx => {
                await tx.query(SQL.upsertModule, [id, enabled ? 1 : 0, intervalMs, nowIso()]);
                await audit({ actor, action: 'module.set', subject: id, detail: { enabled, intervalMs } }, tx);
            });
        },

        async listProfiles() {
            return (await db.query(SQL.listProfiles)).map(p => ({ ...p, active: Number(p.active) === 1 }));
        },

        async getActiveProfile() {
            const [p] = await db.query(SQL.getActive);
            return p ?? null;
        },

        async createProfile({ label, email, password }, actor) {
            const id = crypto.randomUUID();
            try {
                await db.transaction(async tx => {
                    if ((await tx.query(SQL.labelTaken, [label, id])).length) throw labelError();
                    const at = nowIso();
                    await tx.query(SQL.insertProfile, [id, label, keyring.seal(email, profileAad(id, 'email')), keyring.seal(password, profileAad(id, 'password')), at, at]);
                    await audit({ actor, action: 'profile.create', subject: label }, tx);
                });
            } catch (e) {
                if (e?.code === 'ER_DUP_ENTRY') throw labelError(); // a concurrent create won the race
                throw e;
            }
            return id;
        },

        async rotateProfileCredentials(id, { email, password }, actor) {
            return db.transaction(async tx => {
                const p = await getProfile(id, tx);
                if (!p) return false;
                await tx.query(SQL.updateProfileSecrets, [keyring.seal(email, profileAad(id, 'email')), keyring.seal(password, profileAad(id, 'password')), nowIso(), id]);
                await audit({ actor, action: 'profile.rotate', subject: p.label }, tx);
                return true;
            });
        },

        /** Deletes an inactive profile. The active profile cannot be deleted. */
        async deleteProfile(id, actor) {
            return db.transaction(async tx => {
                const p = await getProfile(id, tx);
                if (!p) return false;
                const { affectedRows } = await tx.query(SQL.deleteProfile, [id]);
                await audit({ actor, action: 'profile.delete', subject: p.label, outcome: affectedRows ? 'success' : 'denied', detail: affectedRows ? null : { reason: 'active' } }, tx);
                return affectedRows > 0;
            });
        },

        /** Decrypted credentials, for the account-switch coordinator only. Never serialize them. */
        async getProfileCredentials(id) {
            const p = await getProfile(id);
            if (!p) return null;
            return {
                label: p.label,
                email: keyring.open(p.email_ciphertext, profileAad(id, 'email')),
                password: keyring.open(p.password_ciphertext, profileAad(id, 'password')),
            };
        },

        /** Marks one profile active (or none with null) atomically; at most one is ever active. */
        async setActiveProfile(id) {
            await db.transaction(async tx => {
                await tx.query(SQL.clearActive);
                if (id) await tx.query(SQL.setActive, [id]);
            });
        },

        /**
         * Re-seals every secret with the keyring's current key in one transaction (key rotation).
         * @returns {Promise<{ profiles: number, overrides: number }>}
         */
        async reencryptAll() {
            return db.transaction(async tx => {
                const result = { profiles: 0, overrides: 0 };
                const at = nowIso();
                for (const p of await tx.query(SQL.lockSecrets)) {
                    const email = keyring.open(p.email_ciphertext, profileAad(p.id, 'email'));
                    const password = keyring.open(p.password_ciphertext, profileAad(p.id, 'password'));
                    await tx.query(SQL.updateProfileSecrets, [keyring.seal(email, profileAad(p.id, 'email')), keyring.seal(password, profileAad(p.id, 'password')), at, p.id]);
                    result.profiles++;
                }
                for (const row of await tx.query(SQL.lockOverrides)) {
                    if (!Number(row.encrypted)) continue;
                    await tx.query(SQL.upsertOverride, [row.key, keyring.seal(keyring.open(row.value, overrideAad(row.key)), overrideAad(row.key)), 1, at]);
                    result.overrides++;
                }
                await audit({ action: 'keys.rotate', subject: 'encryption-key', detail: { keyId: keyring.currentKeyId, ...result } }, tx);
                return result;
            });
        },
    };
}
