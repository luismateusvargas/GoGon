// tests/catalog-sync/contracts.test.mjs - CAT-TASK-001 / AC-CAT-003, AC-CAT-011, AC-CAT-012, AC-CAT-015
// Source contracts, response classification, and the guide page parsers against the synthetic
// fixtures in tests/catalog-sync/fixtures (see its README). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from 'linkedom';
import { classifyResponse } from '../../catalog/contracts/classify.js';
import { GUIDE_URLS, GUIDE_ORDERING, guideUrl } from '../../catalog/contracts/guide.js';
import { GAME_LOCATION_CONTRACT, GAME_DETAIL_CONTRACTS, isContractUsable, pick } from '../../catalog/contracts/gameLocation.js';
import { GAME_POLICY, GUIDE_POLICY, fullSweepEstimate } from '../../catalog/contracts/policy.js';
import { isGuidePage, parseIndexPage, parseItemDetail, parseCreatureDetail, parseRealmDetail, parseMasterRealmDetail } from '../../catalog/guideParsers.js';
import { apiEndpoints } from '../../game_modules/API.js';

const FIXTURES = path.resolve('tests/catalog-sync/fixtures');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const doc = name => new DOMParser().parseFromString(fixture(name), 'text/html');

test('CAT-TASK-001: guide URLs match the supplied scrapers and accept only bounded integers', () => {
    const scrapers = ['fallen_sword_item_scraper.js', 'fallen_sword_creature_scraper.js', 'fallen_sword_realm_scraper.js']
        .map(f => fs.readFileSync(path.resolve('reconciliation/scrappers', f), 'utf8')).join('\n');
    for (const [kind, spec] of Object.entries(GUIDE_URLS)) {
        for (const phase of ['index', 'detail']) {
            const shape = spec[phase].split('{')[0];
            assert.ok(scrapers.includes(shape), `${kind} ${phase} URL shape comes from a supplied scraper`);
        }
    }
    assert.equal(guideUrl('item', 'index', 0), 'https://guide.fallensword.com/index.php?cmd=items&index=0');
    assert.equal(guideUrl('master_realm', 'detail', 5), 'https://guide.fallensword.com/index.php?cmd=masterrealms&subcmd=view&masterrealm_id=5');
    for (const bad of [-1, 1.5, '3', NaN, 10_001]) assert.throws(() => guideUrl('item', 'index', bad));
    for (const bad of [0, -2, '7', 2 ** 53]) assert.throws(() => guideUrl('creature', 'detail', bad));
    assert.throws(() => guideUrl('shop', 'index', 0));
    assert.throws(() => guideUrl('item', 'search', 0));
});

test('CAT-TASK-013 / AC-CAT-012: every kind needs complete index coverage', () => {
    assert.equal(GUIDE_ORDERING.indexCoverage, 'all_pages');
    assert.equal(GUIDE_ORDERING.firstIndex, 0);
});

test('CAT-TASK-013 / AC-CAT-015: guide and game policies are separate and guide usage is uncapped', () => {
    assert.notEqual(GUIDE_POLICY, GAME_POLICY);
    assert.equal(GAME_POLICY.minDelayMs, 3000);
    assert.equal(GAME_POLICY.maxRequestsPerExecution, 50);
    assert.equal(GAME_POLICY.maxInFlight, 1);
    assert.equal(GUIDE_POLICY.maxInFlight, 1);
    const est = fullSweepEstimate();
    assert.equal(est.indexPages, 661 + 330 + 289 + 15);
    assert.equal(GUIDE_POLICY.dailyRequestCap, null);
    assert.equal(est.leases, Math.ceil(est.indexPages / GUIDE_POLICY.maxRequestsPerExecution));
    assert.ok(est.minDurationMs >= est.indexPages * 3000);
});

test('CAT-TASK-001 / AC-CAT-003: the current-location read is passive but unverified, so it cannot drive requests', () => {
    const url = apiEndpoints.world.fetchLocation;
    assert.match(url, /fetchdata\.php\?a=-1&d=1409&passback=kta$/);
    assert.equal(GAME_LOCATION_CONTRACT.endpoint, 'world.fetchLocation');
    assert.equal(isContractUsable(GAME_LOCATION_CONTRACT), false);
    assert.equal(GAME_DETAIL_CONTRACTS.creature, null);
    assert.equal(GAME_DETAIL_CONTRACTS.item, null);
    assert.equal(isContractUsable({ verified: true, verifiedOn: '2026-10-01', fixture: 'x.json', mapping: {} }), true);
    assert.equal(pick({ a: { b: [{ c: 5 }] } }, 'a.b.0.c'), 5);
    assert.equal(pick({ a: 1 }, 'a.constructor'), undefined);
    assert.equal(pick({ a: 1 }, 'x.y'), undefined);
});

test('CAT-TASK-001: responses are classified before anything reads them', () => {
    const html = 'text/html; charset=utf-8';
    assert.equal(classifyResponse({ status: 503, contentType: html, body: fixture('cloudflare-challenge.html') }, 'html').class, 'challenge');
    assert.equal(classifyResponse({ status: 200, contentType: html, body: fixture('cloudflare-challenge.html') }, 'json').class, 'challenge');
    assert.equal(classifyResponse({ status: 403, contentType: html, cfMitigated: 'challenge', body: '<html></html>' }, 'html').class, 'challenge');
    assert.equal(classifyResponse({ status: 200, contentType: html, body: fixture('game-login.html') }, 'json').class, 'login');
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', body: fixture('game-logged-out.json') }, 'json').class, 'unauthenticated');
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', body: '{"s":true' }, 'json').class, 'malformed');
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', body: '[1,2]' }, 'json').class, 'malformed');
    assert.equal(classifyResponse({ status: 429, body: '' }, 'json').class, 'rate_limited');
    assert.equal(classifyResponse({ status: 502, body: '' }, 'json').class, 'server_error');
    assert.equal(classifyResponse({ status: 404, body: '' }, 'html').class, 'not_found');
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', body: 'x'.repeat(3 * 1024 * 1024) }, 'json').class, 'too_large');
    const ok = classifyResponse({ status: 200, contentType: 'application/json', body: '{"s":true,"r":{}}' }, 'json');
    assert.equal(ok.class, 'ok');
    assert.deepEqual(ok.json, { s: true, r: {} });
    assert.equal(classifyResponse({ status: 200, contentType: html, body: fixture('guide-item-index.html') }, 'html').class, 'ok');
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', body: '{}' }, 'html').class, 'malformed');
});

test('CAT-TASK-001 / AC-CAT-011: index parsers keep document order, drop duplicates, and name each ID', () => {
    const items = parseIndexPage(doc('guide-item-index.html'), GUIDE_URLS.item.idParam);
    assert.deepEqual(items.entries, [
        { id: 17050, name: 'Shard of Dawn' }, { id: 17049, name: 'Dusk Gauntlets' }, { id: 17048, name: 'Montmarr Helm' },
    ]);
    const creatures = parseIndexPage(doc('guide-creature-index.html'), GUIDE_URLS.creature.idParam);
    assert.deepEqual(creatures.entries.map(e => e.id), [7002, 7001]);
    const empty = doc('guide-item-index-empty.html');
    assert.equal(isGuidePage(empty), true, 'an empty last page is still a guide page');
    assert.deepEqual(parseIndexPage(empty, 'item_id').entries, []);
    assert.equal(isGuidePage(doc('cloudflare-challenge.html')), false);
});

test('CAT-TASK-001: detail parsers read the scraper fields', () => {
    const item = parseItemDetail(doc('guide-item-detail.html'), 17048);
    assert.equal(item.name, 'Montmarr Helm');
    assert.equal(item.rarity, 'Rare');
    assert.equal(item.imageUrl, 'https://cdn2.fallensword.com/items/17048.gif');
    assert.deepEqual(item.stats, { type: 'Helmet', level: 1250, attack: 120, defense: 340, armor: 90, hp: 55 });
    assert.deepEqual(item.enhancements, [{ name: 'Piercing Strike', value: 30 }, { name: 'Fury Caster', value: 12 }]);
    assert.deepEqual(item.droppedBy, [{ creatureName: 'Montmarr the Dragon Golem (Dragon LE)', dropRate: 0.5 }, { creatureName: 'Unknown Wisp', dropRate: 2 }]);
    assert.equal(item.setId, 412);
    assert.equal(item.setName, 'Montmarr Set');
    assert.deepEqual(item.setBonuses, { attack: 50, defense: 60, enhancements: [{ name: 'Nightmare Visage', value: 5 }] });

    const creature = parseCreatureDetail(doc('guide-creature-detail.html'), 7001);
    assert.equal(creature.name, 'Montmarr the Dragon Golem');
    assert.equal(creature.description, 'An ancient golem of dragon bone.');
    assert.equal(creature.imageUrl, 'https://cdn2.fallensword.com/creatures/7001.jpg', 'http is upgraded to https');
    assert.deepEqual(creature.stats, { class: 'Dragon', level: 1250, attack: { min: 900, max: 1100 }, hp: { min: 20000, max: 25000 } });
    assert.deepEqual(creature.droppedItems, [{ itemId: 17048, itemName: 'Montmarr Helm' }, { itemId: 99999, itemName: 'Unlisted Relic Blade' }]);
    assert.deepEqual(creature.realms, [{ realmId: 1200, realmName: 'Mountain Path' }]);
    assert.deepEqual(creature.enhancements, ['Crushing Blow 20%']);

    const realm = parseRealmDetail(doc('guide-realm-detail.html'), 1200);
    assert.equal(realm.name, 'MOUNTAIN PATH');
    assert.equal(realm.minLevel, 1);
    assert.deepEqual(realm.shops, [{ shopId: 33, shopName: 'Pathside Trader' }]);
    assert.deepEqual(realm.relics, ['Stone of Echoes']);
    assert.deepEqual(realm.quests, [{ questId: 501, questName: "The Golem's Heart" }]);
    assert.deepEqual(realm.creatures, [{ creatureId: 7001, creatureName: 'Montmarr the Dragon Golem' }, { creatureId: 7003, creatureName: 'Ridge Hawk' }]);
    assert.deepEqual(realm.stairways, [{ targetRealmId: 1201, targetRealmName: 'Summit' }]);

    const master = parseMasterRealmDetail(doc('guide-masterrealm-detail.html'), 5);
    assert.deepEqual(master, {
        id: 5, name: 'Elya Desert', minLevel: 5, imageUrl: 'https://cdn2.fallensword.com/masterrealms/5.jpg',
        realms: [{ realmId: 1200, realmName: 'Mountain Path', minLevel: 1 }],
    });

    assert.equal(parseItemDetail(doc('guide-item-index-empty.html'), 1), null, 'a page without a record name is not a record');
    assert.equal(parseCreatureDetail(doc('cloudflare-challenge.html'), 1), null);
});

test('CAT-TASK-001: hostile markup in guide text stays inert text; unsafe URLs and bad IDs are dropped', () => {
    const c = parseCreatureDetail(doc('guide-hostile-creature.html'), 7);
    assert.equal(c.name, '<img src=x onerror=alert(1)>Evil', 'decoded text, never markup');
    assert.equal(c.description, '<script>steal()</script> description');
    assert.equal(c.imageUrl, null, 'javascript: image URL is refused');
    assert.deepEqual(c.droppedItems, [], 'a non-numeric ID is ignored');
});
