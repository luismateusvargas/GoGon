// tests/control-plane/store.test.mjs - CTRL-TASK-002 / AC-CTRL-003, AC-CTRL-004 (async MySQL store, DATA-TASK-007)
// Encrypted profiles and secret overrides, transactional audit, and key rotation.
// Each test gets its own migrated database (tests/helpers/db-client.mjs): the fake, or a real MySQL in CI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createControlStore, redactDetail } from '../../_gg_data/handler/controlStore.js';
import { createKeyring, hashPassword, verifyPassword, parseKey } from '../../control-plane/crypto.mjs';
import { rotateEncryptionKey } from '../../scripts/control-plane/rotate-key.mjs';
import { freshClient, closeClients } from '../helpers/db-client.mjs';

after(closeClients);
const newKey = () => crypto.randomBytes(32).toString('base64');
const EMAIL = 'profile-owner@example.test';
const PASSWORD = 'profile-password-fixture-1';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/store-fixture-token-abcdefgh';
const CONTROL_TABLES = ['config_overrides', 'module_preferences', 'account_profiles', 'audit_events'];

/** Every stored value in the control-plane tables, as one string (what a dump of the database would hold). */
async function dump(db) {
    const parts = [];
    for (const t of CONTROL_TABLES) parts.push(JSON.stringify(await db.query(`SELECT * FROM ${t}`)));
    return parts.join('\n');
}

test('AES-256-GCM keyring: round trip, AAD binding, tamper detection, and key validation', () => {
    const ring = createKeyring(newKey());
    const sealed = ring.seal('secret-value', 'profile:a:email');
    assert.equal(ring.open(sealed, 'profile:a:email'), 'secret-value');
    assert.ok(!sealed.includes('secret-value'));
    assert.notEqual(ring.seal('secret-value', 'x'), ring.seal('secret-value', 'x'), 'random IV per seal');
    assert.throws(() => ring.open(sealed, 'profile:b:email'), /failed authentication/, 'ciphertext cannot move between records');
    const parts = sealed.split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    assert.throws(() => ring.open(parts.join(':'), 'profile:a:email'), /failed authentication/);
    assert.throws(() => createKeyring(newKey()).open(sealed, 'profile:a:email'), /unknown key/);
    assert.throws(() => parseKey('too-short'), /32 random bytes/);
});

test('AC-CTRL-001: scrypt admin hashes verify only the right password and reject malformed input', async () => {
    const hash = hashPassword('correct horse battery staple');
    assert.match(hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong password here', hash), false);
    assert.equal(await verifyPassword('correct horse battery staple', 'plaintext-password'), false);
    assert.equal(await verifyPassword('x', 'scrypt$1$1$1$AAAA$AAAA'), false, 'weak parameters are refused');
    assert.throws(() => hashPassword('short'), /at least 12/);
});

test('AC-CTRL-004: profiles are stored encrypted; the database never holds the plaintext', async () => {
    const db = await freshClient();
    const store = createControlStore(db, createKeyring(newKey()));
    const id = await store.createProfile({ label: 'Main', email: EMAIL, password: PASSWORD }, 'owner');
    await store.setOverride('GG_RELIC_WEBHOOK', WEBHOOK, 'owner');
    await store.setOverride('GG_GUILD_NAME', 'Plain Guild', 'owner');
    assert.deepEqual(await store.getProfileCredentials(id), { label: 'Main', email: EMAIL, password: PASSWORD });
    assert.deepEqual((await store.listProfiles()).map(p => Object.keys(p).sort()), [['active', 'createdAt', 'id', 'label', 'updatedAt']]);
    assert.deepEqual(new Map(await store.loadOverrides()), new Map([['GG_GUILD_NAME', 'Plain Guild'], ['GG_RELIC_WEBHOOK', WEBHOOK]]));
    const stored = await dump(db);
    for (const secret of [EMAIL, PASSWORD, WEBHOOK, 'store-fixture-token']) assert.ok(!stored.includes(secret), `plaintext ${secret} stored`);
    assert.ok(stored.includes('Plain Guild'), 'non-secret overrides stay readable');
});

test('AC-CTRL-003: each change and its audit event commit together; audit details are redacted', async () => {
    const db = await freshClient();
    const store = createControlStore(db, createKeyring(newKey()));
    await store.setOverride('GG_RELIC_WEBHOOK', WEBHOOK, 'owner');
    await store.createProfile({ label: 'Alt', email: EMAIL, password: PASSWORD }, 'owner');
    await assert.rejects(() => store.createProfile({ label: 'Alt', email: EMAIL, password: PASSWORD }, 'owner'),
        e => e.field === 'label' && /already exists/.test(e.message));
    const events = await store.listAudit(10);
    assert.deepEqual(events.map(e => `${e.action}:${e.subject}:${e.outcome}`), ['profile.create:Alt:success', 'config.set:GG_RELIC_WEBHOOK:success']);
    const json = JSON.stringify(events);
    for (const secret of [EMAIL, PASSWORD, WEBHOOK]) assert.ok(!json.includes(secret));
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM account_profiles'))[0].n, 1, 'failed duplicate insert rolled back');
    assert.equal((await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'profile.create'"))[0].n, 1, 'no audit row for the rolled-back insert');
});

test('AC-CTRL-003: a failure inside a mutation rolls back the change with its audit event', async () => {
    const db = await freshClient();
    const failing = {
        query: db.query,
        transaction: fn => db.transaction(tx => fn({
            query: (sql, params) => (/^INSERT INTO audit_events/.test(sql) ? Promise.reject(new Error('audit write failed')) : tx.query(sql, params)),
        })),
    };
    const store = createControlStore(failing, createKeyring(newKey()));
    await assert.rejects(() => store.setModulePreference('Crates', { enabled: false, intervalMs: 60000 }, 'owner'), /audit write failed/);
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM module_preferences'))[0].n, 0, 'the preference is not saved without its audit event');
});

test('redactDetail drops sensitive keys and URL/email-like strings', () => {
    assert.deepEqual(redactDetail({ password: 'x', token: 'y', webhookUrl: 'z', label: 'Main', value: 'https://a/b', who: 'a@b.c', n: 3, list: ['ok', 'http://x'] }),
        { password: '[redacted]', token: '[redacted]', webhookUrl: '[redacted]', label: 'Main', value: '[redacted]', who: '[redacted]', n: 3, list: ['ok'] });
});

test('only one profile can be active, and the active profile cannot be deleted', async () => {
    const store = createControlStore(await freshClient(), createKeyring(newKey()));
    const a = await store.createProfile({ label: 'A', email: EMAIL, password: PASSWORD }, 'owner');
    const b = await store.createProfile({ label: 'B', email: EMAIL, password: PASSWORD }, 'owner');
    await store.setActiveProfile(a);
    await store.setActiveProfile(b);
    assert.deepEqual((await store.listProfiles()).filter(p => p.active).map(p => p.label), ['B']);
    assert.equal(await store.deleteProfile(b, 'owner'), false);
    assert.equal(await store.deleteProfile(a, 'owner'), true);
    await store.setActiveProfile(null);
    assert.equal(await store.getActiveProfile(), null);
});

test('module preferences round-trip as booleans and numbers', async () => {
    const store = createControlStore(await freshClient(), createKeyring(newKey()));
    await store.setModulePreference('Crates', { enabled: false, intervalMs: 90000 }, 'owner');
    await store.setModulePreference('Crates', { enabled: true, intervalMs: 120000 }, 'owner');
    assert.deepEqual([...(await store.listModulePreferences())], [['Crates', { enabled: true, intervalMs: 120000 }]]);
    assert.equal(await store.clearOverride('GG_GUILD_NAME', 'owner'), false);
});

test('CTRL-TASK-002 key rotation: every secret is re-sealed with the new key in one transaction', async () => {
    const db = await freshClient();
    const oldKey = newKey();
    const store = createControlStore(db, createKeyring(oldKey));
    const id = await store.createProfile({ label: 'Main', email: EMAIL, password: PASSWORD }, 'owner');
    await store.setOverride('GG_DISCORD_TOKEN', 'discord-token-fixture', 'owner');
    const before = await dump(db);

    const key2 = newKey();
    const result = await rotateEncryptionKey({ client: db, currentKey: key2, previousKey: oldKey });
    assert.deepEqual(result, { profiles: 1, overrides: 1 });

    const rotated = createControlStore(db, createKeyring(key2));         // new key alone now suffices
    assert.equal((await rotated.getProfileCredentials(id)).password, PASSWORD);
    assert.equal(new Map(await rotated.loadOverrides()).get('GG_DISCORD_TOKEN'), 'discord-token-fixture');
    await assert.rejects(() => createControlStore(db, createKeyring(oldKey)).getProfileCredentials(id), /unknown key/);
    const after = await dump(db);
    for (const secret of [EMAIL, PASSWORD, 'discord-token-fixture']) assert.ok(!after.includes(secret), 'ciphertext only after rotation');
    assert.notEqual(after, before);
    await assert.rejects(() => rotateEncryptionKey({ client: db, currentKey: key2 }), /PREVIOUS/);
});

test('CTRL-TASK-002 key rotation: a wrong previous key changes nothing', async () => {
    const db = await freshClient();
    const store = createControlStore(db, createKeyring(newKey()));
    await store.createProfile({ label: 'Main', email: EMAIL, password: PASSWORD }, 'owner');
    const before = JSON.stringify(await db.query('SELECT * FROM account_profiles'));
    await assert.rejects(() => rotateEncryptionKey({ client: db, currentKey: newKey(), previousKey: newKey() }), /unknown key/);
    assert.equal(JSON.stringify(await db.query('SELECT * FROM account_profiles')), before, 'rolled back');
});
