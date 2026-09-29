import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGuideWorker, DEFAULT_GUIDE_USER_AGENT } from '../../catalog/guideWorker.js';
import { GUIDE_POLICY } from '../../catalog/contracts/policy.js';

const itemIndex = readFileSync('tests/catalog-sync/fixtures/guide-item-index.html', 'utf8');
const challenge = readFileSync('tests/catalog-sync/fixtures/cloudflare-challenge.html', 'utf8');
const lease = () => ({
    leaseId: 'server-lease', kind: 'item', work: [{ type: 'index', page: 0 }], minDelayMs: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), maxBodyBytes: 512 * 1024,
});

function fakeRelay() {
    const calls = { scheduled: 0, ensured: 0, leases: 0, submissions: [] };
    return {
        calls,
        async scheduleSeededDetails() { calls.scheduled++; },
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
    assert.equal(relay.calls.scheduled, 1);
});

test('guide worker keeps its clearance when the app installs a game-cookie fetch wrapper', () => {
    const script = `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { CookieJar } from 'tough-cookie';
        import fetchCookie from 'fetch-cookie';

        const observedCookies = [];
        const index = readFileSync('tests/catalog-sync/fixtures/guide-item-index.html', 'utf8');
        globalThis.fetch = async (url, options) => {
            observedCookies.push(new Headers(options.headers).get('cookie'));
            return new Response(index, { status: 200, headers: { 'content-type': 'text/html' } });
        };
        const { createGuideWorker } = await import('./catalog/guideWorker.js');
        const jar = new CookieJar();
        await jar.setCookie('game_session=example; Domain=.fallensword.com; Path=/', 'https://guide.fallensword.com/');
        globalThis.fetch = fetchCookie(globalThis.fetch, jar);
        const relay = {
            async scheduleSeededDetails() {},
            async ensureServerWorker() { return 'worker-id'; },
            async nextLease() { return { status: 'lease', lease: {
                leaseId: 'lease-id', kind: 'item', work: [{ type: 'index', page: 0 }],
                minDelayMs: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxBodyBytes: 524288,
            } }; },
            async submit() { return { sweepComplete: false }; },
        };
        const worker = createGuideWorker({ relay, clearance: 'sample-clearance' });
        assert.equal((await worker.run()).challenge, false);
        assert.deepEqual(observedCookies, ['cf_clearance=sample-clearance']);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
        cwd: process.cwd(), input: script, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
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
    assert.equal(relay.calls.scheduled, 1);
});

test('guide worker retries a challenged clearance after the policy delay', async () => {
    const relay = fakeRelay();
    let currentTime = Date.now();
    let reads = 0;
    const nextLease = relay.nextLease;
    relay.nextLease = async workerId => {
        const next = await nextLease(workerId);
        next.lease.expiresAt = new Date(currentTime + 60_000).toISOString();
        return next;
    };
    const worker = createGuideWorker({ relay, clearance: 'sample-clearance', now: () => currentTime,
        fetchFn: async () => {
            const challenged = reads++ === 0;
            return new Response(challenged ? challenge : itemIndex, {
                status: challenged ? 403 : 200,
                headers: { 'content-type': 'text/html' },
            });
        } });

    assert.equal((await worker.run()).challenge, true);
    currentTime += GUIDE_POLICY.partialRetryMs - 1;
    assert.deepEqual(await worker.run(), { status: 'challenged' });
    assert.equal(reads, 1);
    currentTime++;
    assert.equal((await worker.run()).challenge, false);
    assert.equal(reads, 2);
    assert.equal(relay.calls.submissions[1].results[0].outcome, 'ok');
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
    assert.equal(relay.calls.scheduled, 0);
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
