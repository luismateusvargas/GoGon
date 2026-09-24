// tests/auth-session/env-precedence.test.mjs - AUTH-TASK-001
// GG_ settings win over legacy SWS_ then FS_ names. Uses fake values only; .env is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, DEFAULT_UA } from '../../session.mjs';
import { validateConfig } from '../../configValidator.mjs';
import { ENV_ALIASES } from '../../app_modules/constants.js';

test('GG_ value wins over SWS_ and FS_', () => {
    const env = { GG_EMAIL: 'gg@example.test', SWS_EMAIL: 'sws@example.test', FS_EMAIL: 'fs@example.test' };
    assert.equal(readEnv('GG_EMAIL', undefined, env), 'gg@example.test');
});

test('SWS_ is used when GG_ is unset or blank, before FS_', () => {
    assert.equal(readEnv('GG_PASSWORD', undefined, { GG_PASSWORD: '  ', SWS_PASSWORD: 'sws', FS_PASSWORD: 'fs' }), 'sws');
    assert.equal(readEnv('GG_BASE', undefined, { SWS_BASE: 'https://sws.example.test', FS_BASE: 'https://fs.example.test' }), 'https://sws.example.test');
});

test('FS_ is the last legacy fallback', () => {
    assert.equal(readEnv('GG_EMAIL', undefined, { FS_EMAIL: 'fs@example.test' }), 'fs@example.test');
    assert.equal(readEnv('GG_BASE', undefined, { FS_BASE: 'https://fs.example.test' }), 'https://fs.example.test');
});

test('UA and language fall back to SWS_ names, then to defaults', () => {
    assert.equal(readEnv('GG_UA', DEFAULT_UA, { SWS_UA: 'legacy-ua' }), 'legacy-ua');
    assert.equal(readEnv('GG_UA', DEFAULT_UA, {}), DEFAULT_UA);
    assert.equal(readEnv('GG_LANG', 'en', { GG_LANG: 'pt-BR', SWS_LANG: 'en-GB' }), 'pt-BR');
});

test('unaliased names are read directly', () => {
    assert.equal(readEnv('GG_GUILD_NAME', 'none', { GG_GUILD_NAME: 'Guild' }), 'Guild');
    assert.equal(readEnv('GG_GUILD_NAME', 'none', {}), 'none');
});

test('every alias list starts with its GG_ name', () => {
    for (const [name, keys] of Object.entries(ENV_ALIASES)) assert.equal(keys[0], name);
});

test('configValidator accepts SWS_ credentials the same way session.mjs does', (t) => {
    const keys = ['GG_EMAIL', 'SWS_EMAIL', 'FS_EMAIL', 'GG_PASSWORD', 'SWS_PASSWORD', 'FS_PASSWORD', 'GG_BOT_CHARACTER', 'GG_BOT_ID_CHARACTER'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, { SWS_EMAIL: 'sws@example.test', SWS_PASSWORD: 'not-a-secret', GG_BOT_CHARACTER: 'Bot', GG_BOT_ID_CHARACTER: '123' });

    const result = validateConfig();
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
    assert.ok(result.info.some(line => line.includes('SWS_EMAIL')));
    assert.ok(!JSON.stringify(result).includes('not-a-secret'), 'password must never appear in validation output');
});
