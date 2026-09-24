// scripts/control-plane/firefox-acceptance.mjs - CTRL-TASK-007 browser acceptance (AC-CTRL-001/002/003/004/006).
// Drives headless Firefox over WebDriver BiDi (no extension, no extra dependency) against the demo harness:
//   node scripts/control-plane/demo-server.mjs 8799        (prints the demo password)
//   node scripts/control-plane/firefox-acceptance.mjs http://127.0.0.1:8799 <password> <screenshot-dir>
// Not part of npm test: it needs a local Firefox (C:\Program Files\Mozilla Firefox).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [, , base, password, outDir] = process.argv;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ff-'));
fs.writeFileSync(path.join(profile, 'user.js'), [
    'user_pref("app.update.enabled", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);', 'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("signon.rememberSignons", false);',
].join('\n'));
const ff = spawn('C:\\Program Files\\Mozilla Firefox\\firefox.exe', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '9333', '--width', '1280', '--height', '900'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws;
for (let i = 0; i < 40 && !ws; i++) {
    await sleep(500);
    try { ws = await new Promise((res, rej) => { const s = new WebSocket('ws://127.0.0.1:9333/session'); s.onopen = () => res(s); s.onerror = rej; }); } catch { ws = null; }
}
if (!ws) { ff.kill(); throw new Error('Firefox remote protocol did not start'); }

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.type === 'error' ? rej(new Error(`${msg.error}: ${msg.message}`)) : res(msg.result); }
    else if (msg.method === 'log.entryAdded') logs.push(`${msg.params.level}: ${msg.params.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

try {
    await send('session.new', { capabilities: {} });
    await send('session.subscribe', { events: ['log.entryAdded'] });
    const ctx = (await send('browsingContext.getTree', {})).contexts[0].context;
    const nav = url => send('browsingContext.navigate', { context: ctx, url, wait: 'complete' });
    const js = async (expr) => {
        const r = await send('script.evaluate', { expression: expr, target: { context: ctx }, awaitPromise: true });
        if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
        return r.result?.value;
    };
    const shot = async name => {
        const { data } = await send('browsingContext.captureScreenshot', { context: ctx, origin: 'document' });
        fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    };
    const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(200); } return false; };

    await nav(`${base}/`);
    check('unauthenticated / redirects to /login', (await js('location.pathname')) === '/login');
    await shot('1-login');

    await js(`document.getElementById('username').value='owner'; document.getElementById('password').value='wrong-password'; document.querySelector('#login-form button').click(); 1`);
    check('wrong password shows an error', await waitFor(`!document.getElementById('login-error').hidden`), await js(`document.getElementById('login-error').textContent`));

    await js(`document.getElementById('password').value=${JSON.stringify(password)}; document.querySelector('#login-form button').click(); 1`);
    check('login lands on dashboard', await waitFor(`location.pathname === '/' && !!document.getElementById('modules-body')`));
    check('live stream connects', await waitFor(`document.getElementById('live-indicator').textContent === 'live'`));
    check('12 module rows rendered', await waitFor(`document.querySelectorAll('#modules-body tr').length === 12`), String(await js(`document.querySelectorAll('#modules-body tr').length`)));
    await sleep(2500);
    check('module results update live', await js(`[...document.querySelectorAll('#modules-body td:last-child')].some(td => /ok in|error/.test(td.textContent))`));
    await shot('2-modules');

    // Settings tab: save an HTML payload into the guild name.
    await js(`document.querySelector('[data-tab=settings]').click(); 1`);
    const payload = '<img src=x onerror="window.__xss=1">';
    await js(`(() => { const i = [...document.querySelectorAll('#all-settings .setting')].find(f => f.querySelector('.setting-desc').textContent.startsWith('GG_GUILD_NAME ')).querySelector('input'); i.value = ${JSON.stringify(payload)}; i.dispatchEvent(new Event('input')); i.form.requestSubmit(); return 1; })()`);
    check('setting save confirmed', await waitFor(`/Guild name saved/.test(document.getElementById('banner').textContent)`), await js(`document.getElementById('banner').textContent`));
    await sleep(800);
    check('HTML input shown as text, never executed', (await js(`window.__xss === undefined && document.querySelectorAll('#all-settings img').length === 0`)) === true);
    check('secret fields show set/unset only', await js(`[...document.querySelectorAll('#all-settings input[type=password]')].every(i => i.value === '')`));
    await js(`(() => { const i = [...document.querySelectorAll('#all-settings .setting')].find(f => f.querySelector('.setting-desc').textContent.startsWith('GG_GUILD_NAME ')).querySelector('.revert').click(); return 1; })()`);
    await shot('3-settings');

    // Invalid webhook: field error, nothing saved.
    await js(`document.querySelector('[data-tab=notifications]').click(); 1`);
    await js(`(() => { const f = [...document.querySelectorAll('#notifications-settings .setting')].find(f => f.querySelector('.setting-desc').textContent.startsWith('GG_RELIC_WEBHOOK ')); const i = f.querySelector('input'); i.value = 'http://169.254.169.254/'; i.form.requestSubmit(); return 1; })()`);
    check('unsafe webhook URL rejected with field error', await waitFor(`[...document.querySelectorAll('#notifications-settings .field-error')].some(e => !e.hidden && /discord\\.com\\/api\\/webhooks/.test(e.textContent))`));
    check('conflict ping mention is first in Notifications', await js(`document.querySelector('#notifications-settings .setting .setting-desc').textContent.startsWith('GG_CONFLICT_PING_MENTION')`));
    await shot('4-notifications');

    // Accounts: add a profile, then a failing switch (confirm auto-accepted).
    await js(`document.querySelector('[data-tab=accounts]').click(); window.confirm = () => true; const f = document.getElementById('profile-form'); f.label.value = 'Broken'; f.email.value = 'b@example.test'; f.password.value = 'fail'; f.requestSubmit(); 1`);
    check('profile added', await waitFor(`[...document.querySelectorAll('#profiles-body td:first-child')].some(td => td.textContent === 'Broken')`));
    await js(`[...document.querySelectorAll('#profiles-body tr')].find(tr => tr.firstChild.textContent === 'Broken').querySelector('button').click(); 1`);
    check('failed switch shows paused / no active account', await waitFor(`/no active account/.test(document.getElementById('account-indicator').textContent) && /paused/.test(document.getElementById('engine-indicator').textContent)`, 10000));
    check('profile password never rendered', await js(`!document.body.textContent.includes('b@example.test')`));
    await shot('5-accounts');

    await js(`document.querySelector('[data-tab=activity]').click(); 1`);
    await sleep(500);
    check('audit log lists the failed switch', await js(`[...document.querySelectorAll('#audit-body tr')].some(tr => /account.switch/.test(tr.textContent) && /failed/.test(tr.textContent))`));
    await shot('6-activity');

    await js(`document.getElementById('logout').click(); 1`);
    check('sign out returns to login', await waitFor(`location.pathname === '/login'`));

    const bad = logs.filter(l => /^error|Content-Security-Policy|CSP/i.test(l));
    check('no console errors or CSP violations', bad.length === 0, bad.join(' | '));
} finally {
    console.log(results.join('\n'));
    try { await send('session.end'); } catch { /* closing */ }
    ws.close();
    ff.kill();
}
