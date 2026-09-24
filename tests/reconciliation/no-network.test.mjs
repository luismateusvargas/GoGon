// tests/reconciliation/no-network.test.mjs - REC-TASK-006 / AC-REC-004
// Proves the preloaded guard (tests/helpers/no-network.mjs) is active and blocks every live path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';

const guard = globalThis.__GG_NO_LIVE_NETWORK__;

test('AC-REC-004: the no-live-network guard is preloaded by the npm test script', () => {
    assert.ok(guard, 'run tests with: node --import ./tests/helpers/no-network.mjs --test (npm test does this)');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.scripts.test, /--import \.\/tests\/helpers\/no-network\.mjs/);
});

const live = [
    'https://www.fallensword.com/index.php',
    'https://account.huntedcow.com/auth?game=6',
    'https://discord.com/api/v10/webhooks/1/x',
    'https://cdn2.fallensword.com/currency/0.png',
];

for (const url of live) {
    test(`AC-REC-004: fetch to ${new URL(url).host} is blocked`, async () => {
        await assert.rejects(fetch(url), (e) => e.cause?.code === 'GG_NO_LIVE_NETWORK');
    });
}

test('AC-REC-004: node http/https, raw sockets, and DNS are blocked for non-loopback hosts', async () => {
    assert.throws(() => net.connect(443, 'discord.com'), { code: 'GG_NO_LIVE_NETWORK' });
    assert.throws(() => https.get('https://www.fallensword.com/'), { code: 'GG_NO_LIVE_NETWORK' });
    assert.throws(() => http.get('http://example.com/'), { code: 'GG_NO_LIVE_NETWORK' });
    await assert.rejects(dns.lookup('account.huntedcow.com'), { code: 'GG_NO_LIVE_NETWORK' });
});

test('AC-REC-004: node-fetch (used for Discord webhooks) is blocked', async () => {
    const { default: nodeFetch } = await import('node-fetch');
    await assert.rejects(nodeFetch('https://discord.com/api/webhooks/1/x'), /blocked|GG_NO_LIVE_NETWORK/);
});

test('loopback stays available for in-process test servers', async (t) => {
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await res.text(), 'ok');
});
