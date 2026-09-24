// tests/discord-integration/bot.test.mjs - DISC-TASK-006 / AC-DISC-001
// Slash command registration and routing in discordBot.mjs. discord.js Client and REST are replaced
// with fakes (no gateway login, no REST call) and the command handlers are stubbed.
// app.mjs is never executed; its credential gate is checked statically. .env is never read.
// Requires --experimental-test-module-mocks (set in the npm test script).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const realDiscord = await import('discord.js');

const rest = { token: null, puts: [], fail: null };
const logins = [];
let lastClient = null;

class FakeREST {
    constructor(options) { this.options = options; }
    setToken(token) { rest.token = token; return this; }
    async put(route, { body }) {
        if (rest.fail) throw rest.fail;
        rest.puts.push({ route, body });
    }
}
class FakeClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.user = { tag: 'GoGon#0001' }; lastClient = this; }
    async login(token) { logins.push(token); return token; }
}
mock.module('discord.js', {
    namedExports: { ...realDiscord, Client: FakeClient, REST: FakeREST },
});

const calls = [];
const handler = name => async interaction => {
    calls.push({ name, interaction });
    if (interaction.fail) throw new Error('handler failed');
};
mock.module(new URL('../../discord_modules/buffs.js', import.meta.url).href, {
    namedExports: {
        handleBuffInteraction: handler('buff'),
        handleBeBuffInteraction: handler('bebuff'),
        handleCheckBuffsInteraction: handler('checkbuffs'),
    },
});
mock.module(new URL('../../discord_modules/gvg.js', import.meta.url).href, {
    namedExports: { handleGvgCooldownInteraction: handler('gvgcooldown') },
});

const { setupDiscord } = await import('../../discordBot.mjs');
const { Events, Routes } = realDiscord;

const TOKEN = 'fixture-token';
const APP_ID = '100000000000000001';
const GUILD_ID = '200000000000000002';

function chatInput(commandName, extra = {}) {
    const replies = [];
    return {
        commandName, replies, deferred: false, replied: false,
        isChatInputCommand: () => true,
        reply: async msg => { replies.push({ reply: msg }); },
        editReply: async msg => { replies.push({ editReply: msg }); },
        ...extra,
    };
}
// Emits an interaction and waits for the async listener to finish.
async function dispatch(interaction) {
    const [listener] = lastClient.listeners(Events.InteractionCreate);
    await listener(interaction);
}

beforeEach(() => {
    rest.token = null; rest.puts.length = 0; rest.fail = null;
    logins.length = calls.length = 0;
    lastClient = null;
});

test('AC-DISC-001: registers /buff, /bebuff, /checkbuffs, /gvgcooldown on the guild route and logs in', async () => {
    const client = await setupDiscord(TOKEN, APP_ID, GUILD_ID);
    assert.equal(client, lastClient);
    assert.equal(rest.token, TOKEN);
    assert.deepEqual(logins, [TOKEN]);
    assert.equal(rest.puts.length, 1);

    const [{ route, body }] = rest.puts;
    assert.equal(route, Routes.applicationGuildCommands(APP_ID, GUILD_ID));
    assert.deepEqual(body.map(c => c.name), ['buff', 'bebuff', 'checkbuffs', 'gvgcooldown']);
    const options = Object.fromEntries(body.map(c => [c.name, (c.options ?? []).map(o => [o.name, o.required])]));
    assert.deepEqual(options, {
        buff: [['target', true], ['buffs', true]],
        bebuff: [['target', true], ['buffs', true]],
        checkbuffs: [['username', true]],
        gvgcooldown: [],
    });
});

test('AC-DISC-001: /guide stays unregistered and the client binds the interaction listener', async () => {
    await setupDiscord(TOKEN, APP_ID, GUILD_ID);
    assert.ok(!rest.puts[0].body.some(c => c.name === 'guide'));
    assert.equal(lastClient.listenerCount(Events.InteractionCreate), 1);
    assert.equal(lastClient.listenerCount(Events.Error), 1);
});

test('AC-DISC-001: each slash command routes to its own handler', async () => {
    await setupDiscord(TOKEN, APP_ID, GUILD_ID);
    for (const name of ['buff', 'bebuff', 'checkbuffs', 'gvgcooldown']) {
        const interaction = chatInput(name);
        await dispatch(interaction);
        assert.equal(calls.at(-1).name, name);
        assert.equal(calls.at(-1).interaction, interaction);
    }
    assert.equal(calls.length, 4);
});

test('AC-DISC-001: component interactions and unknown commands reach no handler', async () => {
    await setupDiscord(TOKEN, APP_ID, GUILD_ID);
    await dispatch({ isChatInputCommand: () => false, customId: 'guide:next' });
    await dispatch(chatInput('guide'));
    assert.equal(calls.length, 0);
});

test('AC-DISC-001: a failing handler gets an ephemeral reply, or an edited reply once deferred', async () => {
    await setupDiscord(TOKEN, APP_ID, GUILD_ID);
    const message = '❌ An error occurred while processing your command. Please try again.';

    const fresh = chatInput('buff', { fail: true });
    await dispatch(fresh);
    assert.deepEqual(fresh.replies, [{ reply: { content: message, ephemeral: true } }]);

    const deferred = chatInput('gvgcooldown', { fail: true, deferred: true });
    await dispatch(deferred);
    assert.deepEqual(deferred.replies, [{ editReply: message }]);
});

test('AC-DISC-001: a failed registration rejects setupDiscord before logging in', async () => {
    rest.fail = Object.assign(new Error('401: Unauthorized'), { status: 401 });
    await assert.rejects(setupDiscord(TOKEN, APP_ID, GUILD_ID), /401/);
    assert.equal(logins.length, 0);
});

test('AC-DISC-001: app.mjs skips the bot without credentials and starts the engine first', () => {
    const app = readFileSync(new URL('../../app.mjs', import.meta.url), 'utf8');
    const gate = app.match(/if \(token && appId && guildId\) \{([\s\S]*?)\} else \{([\s\S]*?)\}/);
    assert.ok(gate, 'setupDiscord is gated on all three Discord settings');
    assert.match(gate[1], /await setupDiscord\(token, appId, guildId\)/);
    assert.match(gate[2], /console\.warn\([^)]*Discord credentials not found/);
    assert.equal(app.match(/setupDiscord\(/g).length, 1, 'no ungated setupDiscord call');
    assert.ok(app.indexOf('initEngine();') < app.indexOf('await setupDiscord('), 'engine starts before the bot');
});
