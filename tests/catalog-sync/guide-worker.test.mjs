import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuideWorker, DEFAULT_GUIDE_USER_AGENT } from '../../catalog/guideWorker.js';

const itemIndex = readFileSync('tests/catalog-sync/fixtures/guide-item-index.html', 'utf8');
const challenge = readFileSync('tests/catalog-sync/fixtures/cloudflare-challenge.html', 'utf8');
const lease = () => ({
    leaseId: 'server-lease', kind: 'item', work: [{ type: 'index', page: 0 }], minDelayMs: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), maxBodyBytes: 512 * 1024,
});

function fakeRelay() {
    const calls = { ensured: 0, leases: 0, submissions: [] };
    return {
        calls,
        async ensureServerWorker() { calls.ensured++; return 'worker-id'; },
        async nextLease(workerId) {
            assert.equal(workerId, 'worker-id');
            calls.leases++;
            return { status: 'lease', lease: lease() };
        },
        async submit(workerId, leaseId, body) {
            assert.equal(workerId, 'worker-id');
            assert.equal(leaseId, 'server-lease');
            calls.submissions.push(body);
            return { sweepComplete: false };
        },
    };
}

test('guide worker reads and stages a leased index with clearance and matching User-Agent', async () => {
    const relay = fakeRelay();
    let requests = 0;
    const worker = createGuideWorker({ relay, clearance: 'sample-clearance', fetchFn: async (url, options) => {
        requests++;
        assert.equal(url, 'https://guide.fallensword.com/index.php?cmd=items&index=0');
        assert.deepEqual(options.headers, { cookie: 'cf_clearance=sample-clearance', 'user-agent': DEFAULT_GUIDE_USER_AGENT });
        return new Response(itemIndex, { status: 200, headers: { 'content-type': 'text/html' } });
    } });

    assert.deepEqual(await worker.run(), {
        status: 'sent', kind: 'item', requests: 1, results: 1, challenge: false, sweepComplete: false,
    });
    assert.equal(requests, 1);
    assert.equal(relay.calls.submissions[0].results[0].outcome, 'ok');
    assert.equal(relay.calls.submissions[0].results[0].entries.length, 3);
    assert.equal(relay.calls.submissions[0].requests, 1);
});

test('guide worker reports a challenge without staging guide data', async () => {
    const relay = fakeRelay();
    let clearance = 'sample-clearance';
    let reads = 0;
    const worker = createGuideWorker({ relay, getClearance: () => clearance, fetchFn: async () => {
        reads++;
        return new Response(challenge, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } });
    } });

    assert.equal((await worker.run()).challenge, true);
    assert.deepEqual(relay.calls.submissions[0].results, [{ type: 'index', page: 0, outcome: 'challenge' }]);
    assert.deepEqual(await worker.run(), { status: 'challenged' });
    assert.equal(reads, 1);
    clearance = 'renewed-clearance';
    assert.equal((await worker.run()).challenge, true);
    assert.equal(reads, 2);
});

test('guide worker retries a failed submission without reading the page again', async () => {
    const relay = fakeRelay();
    let attempts = 0;
    const submit = relay.submit;
    relay.submit = async (...args) => {
        if (++attempts === 1) throw new Error('database unavailable');
        return submit(...args);
    };
    let reads = 0;
    const worker = createGuideWorker({ relay, clearance: 'sample-clearance', fetchFn: async () => {
        reads++;
        return new Response(itemIndex, { status: 200, headers: { 'content-type': 'text/html' } });
    } });

    await assert.rejects(worker.run(), /database unavailable/);
    assert.equal((await worker.run()).status, 'sent');
    assert.equal(reads, 1);
    assert.equal(relay.calls.leases, 1);
});

test('guide worker stops on an oversized guide response', async () => {
    const relay = fakeRelay();
    const worker = createGuideWorker({ relay, clearance: 'sample-clearance', fetchFn: async () =>
        new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/html' } }) });

    assert.equal((await worker.run()).status, 'sent');
    assert.deepEqual(relay.calls.submissions[0].results, [{ type: 'index', page: 0, outcome: 'error' }]);
});

test('guide worker skips missing or malformed clearance without contacting the relay', async () => {
    const relay = fakeRelay();
    assert.deepEqual(await createGuideWorker({ relay, clearance: '' }).run(), { status: 'unconfigured' });
    assert.deepEqual(await createGuideWorker({ relay, clearance: 'bad\r\ncookie' }).run(), { status: 'invalid_configuration' });
    assert.equal(relay.calls.ensured, 0);
});

test('guide worker picks up clearance saved after startup on its next run', async () => {
    const relay = fakeRelay();
    let clearance = '';
    const worker = createGuideWorker({ relay, getClearance: () => clearance, fetchFn: async () =>
        new Response(itemIndex, { status: 200, headers: { 'content-type': 'text/html' } }) });
    assert.deepEqual(await worker.run(), { status: 'unconfigured' });
    clearance = 'new-clearance';
    assert.equal((await worker.run()).status, 'sent');
    assert.equal(relay.calls.submissions.length, 1);
});
