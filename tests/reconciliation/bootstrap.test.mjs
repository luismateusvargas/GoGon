// tests/reconciliation/bootstrap.test.mjs - REC-TASK-002 / AC-REC-002
// Static and import-level checks only: app.mjs is never executed, no network, .env is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const { readEnv } = await import('../../session.mjs');

test('app.mjs resolves credentials and Discord settings through the registry, with legacy fallbacks', async () => {
    // CTRL-TASK-001: credentials come from currentCredentials() (active profile, else GG_ > SWS_ > FS_),
    // Discord settings from getSetting() (dashboard override, else GG_ > legacy unprefixed names).
    const app = read('app.mjs');
    assert.match(app, /currentCredentials\(\)/);
    for (const name of ['GG_DISCORD_TOKEN', 'GG_DISCORD_APP_ID', 'GG_DISCORD_GUILD_ID']) {
        assert.ok(app.includes(`getSetting('${name}')`), `${name} read through getSetting`);
    }
    const { getSetting } = await import('../../config/runtime.mjs');
    assert.equal(getSetting('GG_DISCORD_TOKEN', { DISCORD_TOKEN: 'legacy' }), 'legacy');
    assert.equal(getSetting('GG_DISCORD_TOKEN', { GG_DISCORD_TOKEN: 'gg', DISCORD_TOKEN: 'legacy' }), 'gg');
    assert.equal(getSetting('GG_EMAIL', { SWS_EMAIL: 'sws@example.test', FS_EMAIL: 'fs@example.test' }), 'sws@example.test');
    assert.equal(readEnv('GG_DISCORD_TOKEN', undefined, { DISCORD_TOKEN: 'legacy' }), 'legacy');
});

test('AC-REC-002: root-only bootstrap capabilities are retained in app.mjs', () => {
    const app = read('app.mjs');
    assert.match(app, /validateAndExit\(\)/, 'configuration validation');
    assert.match(app, /startHealthCheckServer\(\)/, 'health check server');
    assert.doesNotMatch(app, /^\s*import .*_sws_data/m, 'no live import from the legacy data path');
});

test('AC-REC-002: utils.js keeps its root exports and no longer calls an undefined helper', async () => {
    const utils = await import('../../utils.js');
    for (const name of ['secureFetch', 'secureFetchExternal', 'securePost', 'securePostDiscord', 'flushAllBatches',
        'queueDiscordMessage', 'sendAndGetMessageId', 'editDiscordMessage', 'getBuffs', 'getGoldInHand']) {
        assert.equal(typeof utils[name], 'function', `utils.${name}`);
    }
    const source = read('utils.js');
    assert.doesNotMatch(source, /\bnormalizeFsUrl\s*\(/);
    assert.doesNotMatch(source, /process\.env\.SWS_(UA|LANG)\b/);
});

test('AC-REC-002: webhooks and roles come only from environment variables', () => {
    const webhooks = read('webhooks.js');
    assert.doesNotMatch(webhooks, /discord(app)?\.com\/api\/webhooks\//, 'no hardcoded webhook URL');
});

test('AC-REC-002: /guide stays disabled in discordBot.mjs', () => {
    const bot = read('discordBot.mjs');
    assert.doesNotMatch(bot, /^\s*import\s*\{[^}]*guideCommand[^}]*\}\s*from/m);
});
