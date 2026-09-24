// tests/discord-integration/gvg.test.mjs - DISC-TASK-003 / AC-DISC-004, REC-TASK-004
// /gvgcooldown against a throwaway SQLite file seeded with fixture cooldowns. No Discord access.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';


const db = await import('../../_gg_data/handler/gg_database.js');
const { handleGvgCooldownInteraction } = await import('../../discord_modules/gvg.js');

after(() => db.closeDatabase());

const HOUR = 3_600_000;
const active = n => Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`g${i}`, { guildName: `Guild ${i}`, expires: Date.now() + (i + 2) * HOUR }]));

async function run() {
    const replies = [];
    await handleGvgCooldownInteraction({ deferReply: async () => {}, editReply: async m => { replies.push(m); } });
    assert.equal(replies.length, 1);
    return replies[0];
}

beforeEach(async () => await db.deleteContent('gvg_cooldowns'));

test('AC-DISC-004: no cooldowns replies with the no-active message', async () => {
    assert.equal(await run(), '✅ There are currently no active GvG cooldowns.');
});

test('AC-DISC-004: malformed and expired entries are filtered out', async () => {
    await db.setObject('gvg_cooldowns', {
        good: { guildName: 'Raiders', expires: Date.now() + 26 * HOUR - 30_000 },   // margin: same-millisecond reads format as 1d 2h
        expired: { guildName: 'Old', expires: Date.now() - HOUR },
        nullEntry: null,
        noName: { expires: Date.now() + HOUR },
        blankName: { guildName: '  ', expires: Date.now() + HOUR },
        numericName: { guildName: 7, expires: Date.now() + HOUR },
        stringExpiry: { guildName: 'Strings', expires: String(Date.now() + HOUR) },
        nanExpiry: { guildName: 'NaN', expires: Number.NaN },
    });
    const reply = await run();
    assert.equal(reply.embeds.length, 1);
    assert.deepEqual(reply.embeds[0].fields, [{ name: 'Raiders', value: '1d 1h 59m' }]);
    assert.equal(reply.embeds[0].footer.text, 'Cooldowns are set for 10 days after a conflict ends.');
});

test('AC-DISC-004: only malformed or expired entries means no active cooldowns', async () => {
    await db.setObject('gvg_cooldowns', { a: null, b: { guildName: 'Old', expires: Date.now() - HOUR } });
    assert.equal(await run(), '✅ There are currently no active GvG cooldowns.');
});

test('AC-DISC-004: 25 cooldowns fit in one embed', async () => {
    await db.setObject('gvg_cooldowns', active(25));
    const { embeds } = await run();
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].fields.length, 25);
});

test('AC-DISC-004: more than 25 cooldowns are chunked into 25-field embeds', async () => {
    await db.setObject('gvg_cooldowns', active(56));
    const { embeds } = await run();
    assert.deepEqual(embeds.map(e => e.fields.length), [25, 25, 6]);
    assert.equal(embeds[0].title, '⚔️ GvG Cooldown Status');
    assert.equal(embeds[1].title, undefined);
    assert.deepEqual(embeds.flatMap(e => e.fields).map(f => f.name), Object.values(active(56)).map(c => c.guildName));
});

test('AC-DISC-004: a reply never exceeds 10 embeds', async () => {
    await db.setObject('gvg_cooldowns', active(300));
    const { embeds } = await run();
    assert.equal(embeds.length, 10);
    assert.ok(embeds.every(e => e.fields.length <= 25));
});
