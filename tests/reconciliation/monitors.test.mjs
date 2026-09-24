// tests/reconciliation/monitors.test.mjs - REC-TASK-003 / AC-REC-002 (MON-TASK-001 AC-MON-001, MON-TASK-003)
// utils.js network helpers are mocked with fixtures; a throwaway SQLite file holds state.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const sent = [];
let seFixture = null;
const record = kind => (...args) => { sent.push({ kind, args }); };

mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        secureFetch: async () => ({ ok: true, status: 200, json: async () => seFixture }),
        sendExtraDiscordMessage: record('drop'),
        sendExtraDiscordMessageNODROP: record('nodrop'),
    },
});

const db = await import('../../_gg_data/handler/gg_database.js');
const { checkSuperElites, UNINDEXED_SE_NAME, UNINDEXED_ITEM_TEXT } = await import('../../app_modules/SuperElite.js');
const { apiEndpoints } = await import('../../game_modules/API.js');

const SERVER_TS = 1_790_000_000;
const kill = (over = {}) => ({
    time: 120, creature: 999_001, item: 0,
    player: { id: 42, name: 'Hunter' }, realm: { realm: 5, x: 3, y: 4 }, ...over,
});
const fixture = (...kills) => ({ s: true, t: `x ${SERVER_TS}`, r: Object.fromEntries(kills.map((k, i) => [i, k])) });

beforeEach(async () => {
    await db.deleteContent('processed_se_kill_ids');
    sent.length = 0;
});

test('AC-MON-001: a kill of an unindexed creature is announced with the fallback name', async () => {
    seFixture = fixture(kill());
    await checkSuperElites();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'nodrop');
    assert.match(sent[0].args[0], /\*\*NEW SE Waiting on database\*\*/);
    assert.equal(UNINDEXED_SE_NAME, '**NEW SE Waiting on database**');
    assert.match(sent[0].args[0], /Killed by: \*\*Hunter\*\*/);
});

test('AC-MON-001: an unknown dropped item is still reported instead of "nothing found"', async () => {
    seFixture = fixture(kill({ item: 888_001 }));
    await checkSuperElites();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args[3], UNINDEXED_ITEM_TEXT);
});

test('AC-MON-001 error case: an already processed kill is not announced twice', async () => {
    seFixture = fixture(kill());
    await checkSuperElites();
    await checkSuperElites();
    assert.equal(sent.length, 1);
});

test('MON-TASK-003: media and world-map endpoints are real URLs', () => {
    assert.equal(apiEndpoints.currency.type('gold'), 'https://cdn2.fallensword.com/currency/gold.png');
    assert.equal(apiEndpoints.items.displayImage(123), 'https://cdn2.fallensword.com/items/123.gif');
    const worldMap = Object.values(apiEndpoints).map(v => v?.fetchWorldMap).find(Boolean);
    assert.ok(worldMap, 'fetchWorldMap endpoint exists');
    assert.doesNotThrow(() => new URL(worldMap));
    assert.ok(worldMap.startsWith('https://www.fallensword.com/fetchdata.php?'));
});

test('AC-REC-002: every monitor keeps its current import paths and entry point', () => {
    const monitors = {
        BountyBoard: 'checkBounties', Crates: 'checkForCratesFound', GameUpdates: 'checkForUpdatesArchive',
        GuildConflicts: 'checkGuildConflicts', GuildMessages: 'checkGuildMessages', Ladder: 'checkLadderReset',
        QoL: 'checkAndSwapGear', Relics: 'checkRelics', Shoutbox: 'checkForShoutbox',
        SuperElite: 'checkSuperElites', Titans: 'checkForTitanNotifications',
    };
    for (const [file, fn] of Object.entries(monitors)) {
        const source = readFileSync(new URL(`../../app_modules/${file}.js`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /_sws_data/, `${file}.js must not import the legacy data layer`);
        assert.match(source, new RegExp(`export async function ${fn}\\(`), `${file}.js exports ${fn}`);
    }
    const core = readFileSync(new URL('../../app_modules/core.js', import.meta.url), 'utf8');
    for (const helper of ['formatGameTime', 'formatRemainingTime', 'formatDuration']) {
        assert.match(core, new RegExp(`export function ${helper}\\(`), `core.js keeps ${helper}`);
    }
});

test('AC-REC-002: no state module writes whole-object state through the list-append setContent', () => {
    for (const file of ['GuildConflicts', 'QoL']) {
        const source = readFileSync(new URL(`../../app_modules/${file}.js`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /\bsetContent\b/, `${file}.js`);
        assert.doesNotMatch(source, /7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, `${file}.js has no 7-day literal`);
    }
});
