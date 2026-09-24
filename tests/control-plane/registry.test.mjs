// tests/control-plane/registry.test.mjs - CTRL-TASK-001 / AC-CTRL-002, AC-CTRL-003
// The registry is the only door to configuration: every setting the code reads is registered,
// validators reject unsafe input, and secrets never appear in the browser description.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    CONFIG_DEFINITIONS, CONFIG_BY_KEY, VALIDATORS, RELOAD_MODES, SENSITIVITIES, SECTIONS, validateSetting,
} from '../../config/registry.mjs';
import { getSetting, resolveSetting, describeSettings, applyOverride, loadOverrides, onSettingChange } from '../../config/runtime.mjs';
import { ENV_ALIASES } from '../../app_modules/constants.js';
import { renderEnvExample } from '../../scripts/control-plane/write-env-example.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
afterEach(() => loadOverrides([]));

const APP_SOURCES = ['app.mjs', 'session.mjs', 'utils.js', 'engine.js', 'webhooks.js', 'discordBot.mjs', 'healthCheck.mjs', 'configValidator.mjs', 'metrics.mjs']
    .concat(fs.readdirSync(path.join(ROOT, 'app_modules')).map(f => `app_modules/${f}`))
    .concat(fs.readdirSync(path.join(ROOT, 'discord_modules')).filter(f => f.endsWith('.js')).map(f => `discord_modules/${f}`))
    .concat(['_gg_data/handler/gg_database.js', 'control-plane/server.mjs', 'control-plane/index.mjs']);

test('CTRL-TASK-001: every definition is complete and uses known reload modes, sensitivities, sections, validators', () => {
    const keys = new Set();
    for (const d of CONFIG_DEFINITIONS) {
        assert.ok(!keys.has(d.key), `duplicate ${d.key}`);
        keys.add(d.key);
        assert.match(d.key, /^GG_[A-Z0-9_]+$/);
        assert.ok(RELOAD_MODES.includes(d.reloadMode), `${d.key} reloadMode`);
        assert.ok(SENSITIVITIES.includes(d.sensitivity), `${d.key} sensitivity`);
        assert.ok(SECTIONS[d.section], `${d.key} section`);
        assert.equal(typeof VALIDATORS[d.validator], 'function', `${d.key} validator`);
        assert.ok(d.label && d.description && d.type && Array.isArray(d.owners) && d.owners.length, `${d.key} metadata`);
        assert.equal(d.aliases[0], d.key);
        if (d.type === 'secret') assert.equal(d.sensitivity, 'secret', d.key);
        if (d.reloadMode === 'subsystem-rebind') assert.ok(d.subsystem, `${d.key} names its subsystem`);
        if (d.default) assert.equal(VALIDATORS[d.validator](d.default), null, `${d.key} default passes its validator`);
    }
});

test('CTRL-TASK-001: every GG_/SWS_/FS_ setting read by application code is registered and read through the registry', () => {
    const aliasNames = new Set(CONFIG_DEFINITIONS.flatMap(d => d.aliases));
    const unregistered = new Set();
    const directReads = new Set();
    for (const file of APP_SOURCES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/process\.env(?:\?\.|\.)((?:GG|SWS|FS)_[A-Z0-9_]+)|process\.env\[['"]((?:GG|SWS|FS)_[A-Z0-9_]+)['"]\]|(?:readEnv|getSetting|getBooleanSetting|getIdListSetting)\(['"]([A-Z0-9_]+)['"]/g)) {
            const name = m[1] || m[2] || m[3];
            if (!aliasNames.has(name)) unregistered.add(`${file}: ${name}`);
        }
        for (const m of src.matchAll(/process\.env(?:\?\.|\.)((?:GG|SWS|FS)_[A-Z0-9_]+)|(?<![.\w])env(?:\?\.|\.)((?:GG|SWS|FS)_[A-Z0-9_]+)/g)) {
            directReads.add(`${file}: ${m[1] || m[2]}`);
        }
    }
    assert.deepEqual([...unregistered], []);
    assert.deepEqual([...directReads], []);
});

test('CTRL-TASK-001: registry aliases agree with ENV_ALIASES precedence (GG_ > SWS_ > FS_)', () => {
    for (const [name, aliases] of Object.entries(ENV_ALIASES)) {
        assert.deepEqual(CONFIG_BY_KEY.get(name)?.aliases, aliases, name);
    }
});

test('CTRL-TASK-001: .env.example lists every registry key, is current, and holds placeholders only', () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert.equal(example, renderEnvExample(), 'regenerate with node scripts/control-plane/write-env-example.mjs');
    for (const d of CONFIG_DEFINITIONS) assert.match(example, new RegExp(`^#? ?${d.key}=`, 'm'), d.key);
    assert.doesNotMatch(example, /discord(app)?\.com\/api\/webhooks\/\d/);
    assert.doesNotMatch(example, /^GG_(ADMIN_PASSWORD_HASH|CONTROL_SESSION_SECRET|CONTROL_ENCRYPTION_KEY)=\S/m);
});

test('AC-CTRL-003: validators reject unsafe or malformed values', () => {
    const bad = {
        GG_RELIC_WEBHOOK: ['http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv', 'https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv',
            'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv', 'https://user:pw@discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv',
            'https://discord.com:8443/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv', 'https://discord.com/api/users/@me', 'javascript:alert(1)'],
        GG_CONFLICT_PING_MENTION: ['@here', '<@&123456789012345678>', 'everyone', '12345'],
        GG_BOT_ID_CHARACTER: ['12a', '-1', '0', ''],
        GG_PEACE_GEAR_IDS: ['1,2,x', '1;2'],
        GG_GUILD_NAME: ['a'.repeat(101), 'line\nbreak'],
        GG_DEBUG: ['yes', '2'],
        GG_DISCORD_APP_ID: ['123', 'abc'],
    };
    for (const [key, values] of Object.entries(bad)) {
        for (const v of values) assert.equal(validateSetting(key, v).ok, false, `${key}=${JSON.stringify(v)} must be rejected`);
    }
    const good = {
        GG_RELIC_WEBHOOK: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-0123',
        GG_CONFLICT_PING_MENTION: '123456789012345678',
        GG_PEACE_GEAR_IDS: '11, 22,33',
        GG_GUILD_NAME: 'Crazy West <b>',
    };
    for (const [key, v] of Object.entries(good)) assert.equal(validateSetting(key, v).ok, true, `${key}=${v}`);
    assert.equal(validateSetting('GG_CONFLICT_PING_MENTION', 'none').ok, true);
    assert.equal(validateSetting('GG_CONFLICT_PING_MENTION', '@everyone').ok, true);
});

test('AC-CTRL-003: unknown keys, non-string values, and non-editable settings are refused', () => {
    assert.deepEqual(validateSetting('PATH', '/tmp'), { ok: false, error: 'Unknown setting.' });
    assert.deepEqual(validateSetting('NODE_OPTIONS', '--require x'), { ok: false, error: 'Unknown setting.' });
    assert.equal(validateSetting('GG_GUILD_NAME', 5).ok, false);
    for (const key of ['GG_MYSQL_HOST', 'GG_MYSQL_PASSWORD', 'GG_CONTROL_PORT', 'GG_ADMIN_PASSWORD_HASH', 'GG_CONTROL_ENCRYPTION_KEY', 'GG_BASE']) {
        assert.match(validateSetting(key, 'x').error, /\.env-only/, key);
    }
    for (const key of ['GG_EMAIL', 'GG_PASSWORD']) assert.match(validateSetting(key, 'x').error, /Account profiles/, key);
    assert.throws(() => applyOverride('PATH', 'x'), /Unregistered/);
    assert.throws(() => getSetting('HOME'), /Unregistered/);
});

test('CTRL-TASK-001: effective value = override, then GG_ > SWS_ > FS_ env, then default', () => {
    const env = { SWS_GUILD_NAME: 'Legacy Guild' };
    assert.deepEqual(resolveSetting('GG_GUILD_NAME', {}), { value: 'My Guild', source: 'default' });
    assert.deepEqual(resolveSetting('GG_GUILD_NAME', env), { value: 'Legacy Guild', source: 'env:SWS_GUILD_NAME' });
    applyOverride('GG_GUILD_NAME', 'Dashboard Guild');
    assert.deepEqual(resolveSetting('GG_GUILD_NAME', env), { value: 'Dashboard Guild', source: 'override' });
    applyOverride('GG_GUILD_NAME', null);
    assert.equal(getSetting('GG_GUILD_NAME', env), 'Legacy Guild');
});

test('CTRL-TASK-003: hot values reach live consumers without a restart', async () => {
    const seen = [];
    const off = onSettingChange(k => seen.push(k));
    const webhooks = await import('../../webhooks.js');
    const url = 'https://discord.com/api/webhooks/123456789012345678/hot-reload-fixture-token-000';
    applyOverride('GG_CRATES_WEBHOOK', url);
    applyOverride('GG_TITAN_GROUP_ROLE_ID', '123456789012345678');
    assert.equal(webhooks.cratesWebhook, url, 'live ES binding updated');
    assert.equal(webhooks.TitanGroup, '<@&123456789012345678>');
    applyOverride('GG_CRATES_WEBHOOK', null);
    applyOverride('GG_TITAN_GROUP_ROLE_ID', null);
    assert.notEqual(webhooks.cratesWebhook, url);
    assert.deepEqual(seen, ['GG_CRATES_WEBHOOK', 'GG_TITAN_GROUP_ROLE_ID', 'GG_CRATES_WEBHOOK', 'GG_TITAN_GROUP_ROLE_ID']);
    off();
});

test('AC-CTRL-002: describeSettings covers every entry and reduces secrets to set/unset', () => {
    const secretValue = 'https://discord.com/api/webhooks/123456789012345678/never-shown-secret-token-000';
    applyOverride('GG_RELIC_WEBHOOK', secretValue);
    const env = { GG_PASSWORD: 'env-password-fixture', GG_DISCORD_TOKEN: 'env-token-fixture', GG_GUILD_NAME: 'Visible Guild' };
    const described = describeSettings(env);
    assert.equal(described.length, CONFIG_DEFINITIONS.length);
    const json = JSON.stringify(described);
    for (const secret of [secretValue, 'env-password-fixture', 'env-token-fixture']) assert.ok(!json.includes(secret), 'secret leaked');
    const relic = described.find(d => d.key === 'GG_RELIC_WEBHOOK');
    assert.equal(relic.isSet, true);
    assert.equal('value' in relic, false);
    assert.equal(relic.source, 'override');
    assert.equal(described.find(d => d.key === 'GG_GUILD_NAME').value, 'Visible Guild');
    for (const d of described.filter(x => x.sensitivity === 'secret')) assert.equal('value' in d, false, d.key);
});
