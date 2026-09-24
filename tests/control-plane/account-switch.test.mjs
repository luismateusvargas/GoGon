// tests/control-plane/account-switch.test.mjs - CTRL-TASK-004 / AC-CTRL-004
// The coordinator runs against a real encrypted store and fakes for the engine and game session.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createControlStore } from '../../_gg_data/handler/controlStore.js';
import { createKeyring } from '../../control-plane/crypto.mjs';
import { createAccountSwitcher } from '../../control-plane/accountSwitch.mjs';

let store, steps, provider, loggedInAs, loginResult, profiles, switcher;

async function setup() {
    store = createControlStore(await freshClient(), createKeyring(crypto.randomBytes(32).toString('base64')));
    profiles = {
        main: await store.createProfile({ label: 'Main', email: 'main@example.test', password: 'main-password-fixture' }, 'owner'),
        alt: await store.createProfile({ label: 'Alt', email: 'alt@example.test', password: 'alt-password-fixture' }, 'owner'),
    };
    steps = [];
    provider = undefined;
    loggedInAs = null;
    loginResult = email => email;             // default: every login succeeds
    const engine = {
        pauseAll: async () => { steps.push('pause'); return ['SuperElites', 'Crates']; },
        resumeAll: async (names) => { steps.push(`resume:${names.join(',')}`); return names; },
    };
    const session = {
        setCredentialProvider: (p) => { provider = p; steps.push(p ? 'credentials:profile' : 'credentials:none'); },
        resetSession: async () => { loggedInAs = null; steps.push('reset-cookies'); },
        login: async (email, password, opts) => {
            steps.push(`login:${email}:bootstrap=${opts?.useBootstrap}`);
            const r = await loginResult(email, password);
            if (r instanceof Error) throw r;
            loggedInAs = email;
            return true;
        },
        isLoggedIn: async () => { steps.push('validate'); return Boolean(loggedInAs); },
    };
    switcher = createAccountSwitcher({ store, engine, drainQueue: async () => { steps.push('flush'); return true; }, session });
}
beforeEach(setup);
after(closeClients);

test('AC-CTRL-004: pause -> flush -> invalidate -> authenticate -> validate -> resume the prior modules', async () => {
    const result = await switcher.switchTo(profiles.alt, 'owner');
    assert.deepEqual(steps, [
        'pause', 'flush', 'credentials:none', 'reset-cookies',
        'login:alt@example.test:bootstrap=false', 'validate', 'credentials:profile', 'resume:SuperElites,Crates',
    ]);
    assert.deepEqual(result, { activeLabel: 'Alt', resumed: ['SuperElites', 'Crates'] });
    assert.deepEqual(provider(), { email: 'alt@example.test', password: 'alt-password-fixture' });
    assert.equal((await store.getActiveProfile()).label, 'Alt');
    assert.deepEqual(switcher.status(), { state: 'idle', activeLabel: 'Alt', lastError: null });
});

test('AC-CTRL-004: the audit log records profile labels only', async () => {
    await switcher.switchTo(profiles.main, 'owner');
    await switcher.switchTo(profiles.alt, 'owner');
    const events = (await store.listAudit(5)).filter(e => e.action === 'account.switch');
    assert.deepEqual(events.map(e => [e.subject, e.detail?.from ?? null, e.outcome]), [['Alt', 'Main', 'success'], ['Main', null, 'success']]);
    const json = JSON.stringify(await store.listAudit(50));
    for (const secret of ['alt@example.test', 'main@example.test', 'alt-password-fixture', 'main-password-fixture']) assert.ok(!json.includes(secret));
});

test('AC-CTRL-004 error case: a failed login keeps tasks paused with no active account, then a retry succeeds', async () => {
    await switcher.switchTo(profiles.main, 'owner');
    steps.length = 0;
    loginResult = () => new Error('Authentication failed: fixture');
    await assert.rejects(switcher.switchTo(profiles.alt, 'owner'), (e) => e.status === 502 && /Tasks stay paused/.test(e.message) && !/alt@example/.test(e.message));
    assert.ok(!steps.some(s => s.startsWith('resume')), 'modules are not resumed');
    assert.equal(provider, null, 'no credentials remain installed');
    assert.equal(loggedInAs, null, 'cookie jar cleared');
    assert.equal(await store.getActiveProfile(), null, 'no partial account is active');
    const status = switcher.status();
    assert.equal(status.state, 'failed-closed');
    assert.equal(status.activeLabel, null);
    assert.match(status.lastError, /"Alt"/);
    const failure = (await store.listAudit(1))[0];
    assert.deepEqual([failure.action, failure.subject, failure.outcome, failure.detail.reason], ['account.switch', 'Alt', 'failed', 'authentication']);

    loginResult = email => email;
    const retry = await switcher.switchTo(profiles.main, 'owner');
    assert.equal(retry.activeLabel, 'Main');
    assert.equal(switcher.status().state, 'idle');
});

test('AC-CTRL-004: a profile that cannot be found or decrypted is refused before anything is paused', async () => {
    await assert.rejects(switcher.switchTo('00000000-0000-4000-8000-000000000000', 'owner'), (e) => e.status === 404);
    assert.deepEqual(steps, []);
});

test('AC-CTRL-004: switches are serialized; a concurrent request is refused', async () => {
    let release;
    loginResult = () => new Promise(r => { release = r; }).then(() => undefined);
    const first = switcher.switchTo(profiles.alt, 'owner');
    while (!release) await new Promise(r => setImmediate(r));   // the first switch reached login
    await assert.rejects(switcher.switchTo(profiles.main, 'owner'), (e) => e.status === 409);
    release();
    await first;
    assert.equal(switcher.status().activeLabel, 'Alt');
});

test('boot applies the stored active profile, so GoGon logs in as the selected account', async () => {
    await store.setActiveProfile(profiles.alt);
    const fresh = createAccountSwitcher({ store, engine: {}, drainQueue: async () => true, session: { setCredentialProvider: p => { provider = p; } } });
    assert.equal(await fresh.applyStoredActiveProfile(), 'Alt');
    assert.equal(provider().email, 'alt@example.test');
    assert.equal(fresh.status().activeLabel, 'Alt');
});
