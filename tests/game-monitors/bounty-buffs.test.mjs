// tests/game-monitors/bounty-buffs.test.mjs - AC-MON-002 regression: BountyBoard must detect Deflect and Cloak.
// buff_data.json names are Title Case ("Deflect"); getBuffs(isBounty) used to compare against 'deflect'/'cloak'.
// Runs the real utils.getBuffs against a fake fetch; no network, no .env.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeFetch } from '../helpers/fake-fetch.mjs';

process.env.GG_EMAIL = 'owner@example.test';
process.env.GG_PASSWORD = 'fixture';
let buffs = [];
const fake = installFakeFetch((req) => {
    const u = new URL(req.url);
    if (u.pathname === '/index.php') return { body: '<div id="pCC"></div>' };
    return { json: { s: true, t: 'x 1', r: buffs } };
});
after(() => fake.restore());

const { getBuffs } = await import('../../utils.js');
const buffData = (await import('../../discord_modules/buff_data.json', { with: { type: 'json' } })).default;
const URL_ = 'https://www.fallensword.com/fetchdata/api.php?a=buffs&id=1';

test('getBuffs(isBounty) flags Deflect and Cloak by their buff_data.json IDs', async () => {
    buffs = [{ id: buffData.Deflect }, { id: buffData.Cloak }, { id: buffData['Blood Thirst'] }];
    assert.deepEqual(await getBuffs(URL_, true), { hasDeflect: true, isCloaked: true, numberOfBuffs: 3 });
});

test('getBuffs(isBounty) does not mistake Anti Deflect for Deflect', async () => {
    buffs = [{ id: buffData['Anti Deflect'] }];
    assert.deepEqual(await getBuffs(URL_, true), { hasDeflect: false, isCloaked: false, numberOfBuffs: 1 });
});

test('getBuffs(isBounty) with no buffs reports none', async () => {
    buffs = [];
    assert.deepEqual(await getBuffs(URL_, true), { hasDeflect: false, isCloaked: false, numberOfBuffs: 0 });
});
