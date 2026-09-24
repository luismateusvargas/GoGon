// tests/discord-integration/commands.test.mjs - DISC-TASK-001/002/004/005, REC-TASK-004
// Slash-command handlers against fixtures only: utils.js and session.mjs are mocked, so nothing
// reaches FallenSword or Discord and .env is never read.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SWS_BOT_CHARACTER = 'FixtureBot';
process.env.SWS_BOT_ID_CHARACTER = '1';

const { apiEndpoints } = await import('../../game_modules/API.js');

let buffsResult;          // what getBuffs() resolves to
let availableSkills = []; // skill ids the caster can cast
let inventoryItems = [];  // items in the "Main" inventory folder
const casts = [];         // quickbuff POSTs: { target, ids }
const usedItems = [];     // inventory ids passed to useitem

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
mock.module(new URL('../../utils.js', import.meta.url).href, {
    namedExports: {
        getBuffs: async () => (typeof buffsResult === 'function' ? buffsResult() : buffsResult),
        getPlayerIdByName: async name => (name === 'Ghost' || name === 'Target' ? 42 : 0),
        secureFetch: async (url, options = {}) => {
            if (url === 'index.php') {
                const ids = options.body.getAll('skills[]').map(Number);
                casts.push({ target: options.body.get('targetPlayers'), ids });
                const lines = ids.map(id => `<p>Skill '${id}' level 1 was activated on 'x'.</p>`).join('');
                return { ok: true, status: 200, text: async () => `<div id="quickbuff-report">${lines}</div>` };
            }
            if (url === apiEndpoints.player.availableBuffs) {
                return json({ s: true, r: { skills: availableSkills.map(id => ({ id, points: 1 })) } });
            }
            if (url === apiEndpoints.player.inventory) {
                return json({ s: true, r: { inventories: [{ name: 'Main', items: inventoryItems }] } });
            }
            const used = /inventory_id=(\d+)/.exec(url);
            if (used) { usedItems.push(Number(used[1])); return json({ s: true }); }
            throw new Error(`unexpected fixture URL ${url}`);
        },
    },
});
mock.module(new URL('../../session.mjs', import.meta.url).href, {
    namedExports: { ensureLogin: async () => true },
});

const buffs = await import('../../discord_modules/buffs.js');
const { useBESequence } = await import('../../discord_modules/inventory.js');
const { getBuffNameById } = await import('../../game_modules/buffParser.js');
const { toBuffsList, resolveBuffIds, ensureMetaBuffs, EPICS_IDS, ID_TO_NAME, NAME_TO_ID, META_IDS } = buffs;

const PARSED_AT = 1_758_700_000;
const buffsAt = list => ({ buffsList: list, parsedAt: PARSED_AT });
const fullMeta = [...META_IDS.map(id => ({ id, level: 200 })), { id: 129, level: 1 }];

function fakeInteraction(options = {}) {
    const replies = [];
    return {
        replies,
        user: { id: 'user-1' },
        options: { getString: name => options[name] },
        deferReply: async () => {},
        editReply: async msg => { replies.push(msg); return { createMessageComponentCollector: () => ({ on() {} }) }; },
    };
}

beforeEach(() => {
    buffsResult = undefined;
    availableSkills = [];
    inventoryItems = [];
    casts.length = usedItems.length = 0;
});

// --- getBuffs() return shape (DISC-TASK-001/002) --------------------------------------------------
test('toBuffsList reads { buffsList, parsedAt }, a bare list, and a failed (undefined) result', () => {
    const list = [{ id: 13 }];
    assert.equal(toBuffsList({ buffsList: list, parsedAt: 1 }), list);
    assert.equal(toBuffsList(list), list);
    assert.deepEqual(toBuffsList(undefined), []);
    assert.deepEqual(toBuffsList({ buffsList: null, parsedAt: 1 }), []);
});

test('DISC-TASK-001: ensureMetaBuffs iterates buffsList and skips casting when meta buffs meet the BE minimum', async () => {
    buffsResult = buffsAt(fullMeta);
    const meta = await ensureMetaBuffs();
    assert.deepEqual(meta.applied, []);
    assert.equal(meta.hasEnhancer, true);
    assert.equal(meta.minLevel, 200);
    assert.equal(casts.length, 0);
});

test('DISC-TASK-001: ensureMetaBuffs casts only the meta buffs below the level floor', async () => {
    buffsResult = buffsAt([{ id: 42, level: 180 }]); // Extend at 180, no Buff Enhancer -> floor 175
    const meta = await ensureMetaBuffs();
    assert.equal(meta.minLevel, 175);
    assert.deepEqual(meta.applied, [126, 65, 160]);
    assert.deepEqual(casts, [{ target: 'FixtureBot', ids: [126, 65, 160] }]);
});

test('DISC-TASK-001: ensureMetaBuffs treats a failed getBuffs as no active buffs', async () => {
    buffsResult = undefined;
    const meta = await ensureMetaBuffs();
    assert.deepEqual(meta.applied, META_IDS);
});

test('AC-DISC-002: /checkbuffs computes remaining time as expire_time - parsedAt', async () => {
    buffsResult = buffsAt([{ id: 13, level: 150, expire_time: PARSED_AT + 3_720 }]);
    const interaction = fakeInteraction({ username: 'Ghost' });
    await buffs.handleCheckBuffsInteraction(interaction);
    const [reply] = interaction.replies;
    assert.equal(reply.embeds[0].title, 'Active Buffs for Ghost (1 total)');
    assert.match(reply.embeds[0].description, /\*\*Absorb\*\* \(Lvl 150\) - \*1h 2m remaining\*/);
});

test('AC-DISC-002: /checkbuffs replies politely when getBuffs fails or the list is empty', async () => {
    for (const result of [undefined, buffsAt([])]) {
        buffsResult = result;
        const interaction = fakeInteraction({ username: 'Ghost' });
        await buffs.handleCheckBuffsInteraction(interaction);
        assert.deepEqual(interaction.replies, ['**Ghost** has no active buffs.']);
    }
});

test('DISC-TASK-002: useBESequence reads buffsList and stops when Buff Enhancer is already active', async () => {
    buffsResult = buffsAt([{ id: 129, level: 1 }]);
    const result = await useBESequence(fakeInteraction());
    assert.equal(result.ok, true);
    assert.equal(result.alreadyActive, true);
    assert.equal(casts.length + usedItems.length, 0);
});

test('DISC-TASK-002: useBESequence casts Brewing Master from the skill book when no potion is found', async () => {
    buffsResult = buffsAt([{ id: 84 }, { id: 133 }]); // Distil and Pride already active
    inventoryItems = [{ a: 777, b: '99999', x: { bu: [{ id: 129 }] } }]; // composed Buff Enhancer potion
    const result = await useBESequence(fakeInteraction());
    assert.equal(result.ok, true);
    assert.deepEqual(result.used, ['Brewing Master', 'Buff Enhancer Potion']);
    assert.deepEqual(casts, [{ target: 'FixtureBot', ids: [NAME_TO_ID['brewing master']] }]);
    assert.equal(NAME_TO_ID['brewing master'], 40);
    assert.deepEqual(usedItems, [777]);
});

// --- "epics" keyword (DISC-TASK-004) --------------------------------------------------------------
test('DISC-TASK-004: the "epics" keyword resolves to the production EPICS_IDS set', () => {
    const expected = [88, 89, 7, 5, 2, 74, 0, 37, 171, 77, 9, 82, 44, 28, 159, 102, 169, 124];
    assert.deepEqual(EPICS_IDS, expected);
    assert.deepEqual(resolveBuffIds('epics'), expected);
    assert.deepEqual(resolveBuffIds('  EPICS '), expected);
    for (const id of expected) assert.ok(ID_TO_NAME[id], `buff ${id} has a display name`);
});

test('DISC-TASK-004: /buff epics casts the available epics and reports the rest as skipped', async () => {
    buffsResult = buffsAt(fullMeta);
    availableSkills = EPICS_IDS.filter(id => id !== 169);
    const interaction = fakeInteraction({ target: 'Target', buffs: 'epics' });
    await buffs.handleBuffInteraction(interaction);
    assert.deepEqual(casts, [{ target: 'Target', ids: availableSkills }]);
    const summary = interaction.replies.at(-1);
    assert.match(summary, /Skipped:\*\* Invigorate/);
    assert.match(summary, /✅ \*\*Applied:\*\*/);
});

// --- buff_data.json reconciliation (REC-TASK-004) -------------------------------------------------
test('REC-TASK-004: buff names resolve case-insensitively against the Title Case buff_data.json', () => {
    assert.deepEqual(resolveBuffIds('absorb, Death Wish, 97'), [13, 34, 97]);
    assert.deepEqual(resolveBuffIds('shield w'), [135]); // prefix match
    assert.deepEqual(resolveBuffIds('pvp prestige'), [69]);
});

test('REC-TASK-004: the backup "bloodthirst" and "deathwish" names resolve without renaming the buffs', () => {
    assert.deepEqual(resolveBuffIds('bloodthirst'), [4]);
    assert.deepEqual(resolveBuffIds('deathwish'), [34]);
    assert.deepEqual(resolveBuffIds('Blood Thirst'), [4]);
    assert.equal(ID_TO_NAME[4], 'Blood Thirst');
    assert.equal(ID_TO_NAME[34], 'Death Wish');
    assert.equal(getBuffNameById(4), 'Blood Thirst');
    assert.equal(getBuffNameById(34), 'Death Wish');
});
