// session.mjs — SSO robusto + cookie bootstrap + logs opcionais
// Node 20/22 ESM
import { LOG } from './app_modules/core.js';
import { ENV_ALIASES } from './app_modules/constants.js';
import { getSetting, getBooleanSetting } from './config/runtime.mjs';
import { CookieJar } from 'tough-cookie';
import * as fetchCookieNS from 'fetch-cookie';
const fetchCookie = fetchCookieNS.default ?? fetchCookieNS;

import { parseHTML } from 'linkedom';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------- Config ----------
/**
 * Reads a GG_ setting, falling back to its legacy SWS_/FS_ names (ENV_ALIASES). AUTH-TASK-001
 * Empty or whitespace-only values are treated as unset.
 */
export function readEnv(name, defaultValue = undefined, env = process.env) {
  for (const key of ENV_ALIASES[name] || [name]) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return defaultValue;
}

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
export const DEFAULT_LANG = 'en-US,en;q=0.9,pt-BR;q=0.8';

const BASE = readEnv('GG_BASE', 'https://www.fallensword.com');
export const GG_BASE = BASE;
export const FS_BASE = BASE;
export const SSO_ENTRY = readEnv('GG_SSO_URL', 'https://account.huntedcow.com/auth?game=6');

// AC-AUTH-001 / constraints: each SSO step is bounded so a network partition cannot hang boot.
export const LOGIN_STEP_TIMEOUT_MS = 15000;

// Hot registry settings (CTRL-TASK-001): read per request so dashboard changes apply immediately.
const isLoginDebug = () => getBooleanSetting('GG_LOGIN_DEBUG');
const userAgent = () => getSetting('GG_UA') || DEFAULT_UA;
const acceptLanguage = () => getSetting('GG_LANG') || DEFAULT_LANG;
const DEBUG_DIR = readEnv('GG_DEBUG_DIR', path.resolve(process.cwd(), 'DEBUG'));

// ---------- Credentials (CTRL-TASK-004) ----------
// The active account's credentials come from a provider: .env by default, or the selected
// encrypted account profile once the control plane switches accounts. A null provider fails
// closed: every login attempt reports missing credentials until a switch succeeds.
const envCredentials = () => ({ email: readEnv('GG_EMAIL'), password: readEnv('GG_PASSWORD') });
let credentialProvider = envCredentials;

export function setCredentialProvider(provider) {
  credentialProvider = provider === undefined ? envCredentials : provider;
}

export function currentCredentials() {
  return credentialProvider ? (credentialProvider() || {}) : {};
}

// ---------- Cookie jar ----------
const jar = new CookieJar();
export const authedFetch = fetchCookie(globalThis.fetch, jar);

/** Drops every game cookie, so the next request is anonymous (account switch, AC-CTRL-004). */
export async function resetSession() {
  await jar.removeAllCookies();
}

// ---------- Utils ----------
function abs(u, base = BASE) {
  try { return new URL(u, base).toString(); } catch { return String(u); }
}

function nowTag() {
  const d = new Date();
  const t = d.getTime();
  return `${t}`;
}

async function dbgDump(name, html) {
  if (!isLoginDebug()) return;
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${nowTag()}-${name}.html`);
    await fs.writeFile(file, html, 'utf8');
    console.warn(`[login-debug] Snapshot salvo em ${file} (len=${html.length})`);
  } catch {}
}

/**
 * Runs one login HTTP step. Network failures, timeouts, and 5xx answers become a connection
 * error that names only the step and URL, never the submitted form. AC-AUTH-001
 */
async function loginStep(url, init, tag) {
  let res;
  try {
    res = await authedFetch(url, { signal: AbortSignal.timeout(LOGIN_STEP_TIMEOUT_MS), ...init });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? `timed out after ${LOGIN_STEP_TIMEOUT_MS}ms` : (e?.cause?.code || e?.message || 'network error');
    throw new Error(`Connection failure during ${tag} (${new URL(url).host}): ${reason}`);
  }
  if (res.status >= 500) {
    throw new Error(`Connection failure during ${tag} (${new URL(url).host}): HTTP ${res.status}`);
  }
  return res;
}

function pickLoginForm(document) {
  // Form com password + (email|user|login)
  const forms = [...document.querySelectorAll('form')];
  for (const f of forms) {
    const hasPwd = !!f.querySelector('input[type="password"], input[name*="pass"]');
    if (!hasPwd) continue;
    const hasUser = !!f.querySelector('input[name*="email"], input[type="email"], input[name*="user"], input[name*="login"]');
    if (hasUser) return f;
  }
  return null;
}

function pickHiddenRelayForm(document) {
  // Form intermediário pós-login (só hidden/submit, method=post)
  const forms = [...document.querySelectorAll('form')];
  for (const f of forms) {
    const method = (f.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'post') continue;
    const inputs = [...f.querySelectorAll('input')];
    if (inputs.length === 0) continue;
    const hasPwd = inputs.some(i => (i.getAttribute('type') || '').toLowerCase() === 'password');
    if (hasPwd) continue;
    const allHiddenOrButton = inputs.every(i => {
      const t = (i.getAttribute('type') || '').toLowerCase();
      return t === 'hidden' || t === 'submit' || t === '';
    });
    if (allHiddenOrButton) return f;
  }
  return null;
}

async function getHtml(url, options = {}, tag = 'step') {
  const headers = {
    'user-agent': userAgent(),
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': acceptLanguage(),
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    ...(options.headers || {}),
  };
  const res = await loginStep(url, { redirect: 'follow', credentials: 'include', ...options, headers }, tag);
  const html = await res.text();
  if (isLoginDebug()) console.warn(`[login-debug] GET ${url} -> ${res.status}`);
  await dbgDump(tag, html);
  return { res, html };
}

async function postForm(url, body, options = {}, tag = 'post') {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': userAgent(),
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': acceptLanguage(),
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    ...(options.headers || {}),
  };
  const res = await loginStep(url, { method: 'POST', body, redirect: 'follow', credentials: 'include', ...options, headers }, tag);
  const html = await res.text();
  if (isLoginDebug()) console.warn(`[login-debug] POST ${url} -> ${res.status}`);
  await dbgDump(tag, html);
  return { res, html };
}

// ---------- Cookie bootstrap (opcional) ----------
export async function loadCookieBootstrap(file = path.resolve(process.cwd(), 'cookies.bootstrap.json')) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    let set = 0;
    for (const c of arr) {
      if (!c || !c.name) continue;
      const cookieStr = `${c.name}=${c.value}; Domain=${c.domain || 'www.fallensword.com'}; Path=${c.path || '/'}${c.secure ? '; Secure' : ''}`;
      await jar.setCookie(cookieStr, BASE);
      set++;
    }
    if (set > 0 && isLoginDebug()) console.warn(`[login-debug] Bootstrap de ${set} cookies aplicado do arquivo ${file}`);
    return set > 0;
  } catch (e) {
    return false;
  }
}

export async function dumpDomainCookies(domainLike = 'fallensword.com') {
  const all = await jar.getCookies(BASE);
  return all.filter(c => (c.domain || '').includes(domainLike)).map(c => ({
    key: c.key, value: c.value, domain: c.domain, path: c.path, expires: c.expires
  }));
}

// ---------- API ----------
export async function isLoggedIn() {
  const { html } = await getHtml(abs('/index.php'), {}, 'isLoggedIn');
  return /id\s*=\s*['"]pCC['"]/.test(html);
}

/**
 * @param {object} [opts] - useBootstrap: false skips cookies.bootstrap.json (an account switch
 *   must never resume the previous account from that file).
 */
export async function login(email = currentCredentials().email,
                            password = currentCredentials().password,
                            { useBootstrap = true } = {}) {
  if (!email || !password) throw new Error('Credentials missing: define GG_EMAIL and GG_PASSWORD in .env or activate an account profile');

  // 0) Tenta bootstrap de cookies (se existir)
  if (useBootstrap) await loadCookieBootstrap().catch(() => {});
  if (await isLoggedIn()) {
    console.log('Account logged in');
    return true; // ✅ ADD THIS RETURN
  }

  // 1) Abre a home
  let curUrl = abs('/index.php');
  let got = await getHtml(curUrl, {}, 'home');
  if (/id\s*=\s*['"]pCC['"]/.test(got.html)) return true;

  let doc = parseHTML(got.html).document;

  // 1a) Tenta formulário local
  let form = pickLoginForm(doc);
  if (form) {
    const action = abs(form.getAttribute('action') || curUrl, curUrl);
    const method = (form.getAttribute('method') || 'post').toLowerCase();
    const data = new URLSearchParams();
    const userInput = form.querySelector('input[name*="email"], input[type="email"], input[name*="user"], input[name*="login"]');
    const passInput = form.querySelector('input[type="password"], input[name*="pass"]');
    if (userInput && passInput) {
      data.set(userInput.getAttribute('name') || 'email', email);
      data.set(passInput.getAttribute('name') || 'password', password);
      [...form.querySelectorAll('input[type="hidden"]')].forEach(i => {
        const n = i.getAttribute('name'); if (n) data.set(n, i.getAttribute('value') || '');
      });
      const posted = await postForm(action, data, {}, 'post-local');
      if (/id\s*=\s*['"]pCC['"]/.test(posted.html)) return true;
      doc = parseHTML(posted.html).document;
      const relay = pickHiddenRelayForm(doc);
      if (relay) {
        const relayAct = abs(relay.getAttribute('action') || curUrl, curUrl);
        const relayData = new URLSearchParams();
        [...relay.querySelectorAll('input')].forEach(i => {
          const n = i.getAttribute('name'); if (n) relayData.set(n, i.getAttribute('value') || '');
        });
        const fin = await postForm(relayAct, relayData, {}, 'relay-local');
        if (/id\s*=\s*['"]pCC['"]/.test(fin.html)) return true;
      }
    }
  }

  // 1b) Segue link para o provedor SSO (HuntedCow)
  const ssoUrl = SSO_ENTRY;
  // Referer aponta para a home do jogo, como faria um navegador
  let sso = await getHtml(ssoUrl, { headers: { referer: abs('/index.php') } }, 'sso-entry');
  let d2 = parseHTML(sso.html).document;

  // form de login no provedor
  let f2 = pickLoginForm(d2);
  if (f2) {
    const action = abs(f2.getAttribute('action') || ssoUrl, ssoUrl);
    const method = (f2.getAttribute('method') || 'post').toLowerCase();
    const data = new URLSearchParams();
    const userInput = f2.querySelector('input[name*="email"], input[type="email"], input[name*="user"], input[name*="login"]');
    const passInput = f2.querySelector('input[type="password"], input[name*="pass"]');
    if (userInput) data.set(userInput.getAttribute('name') || 'email', email);
    if (passInput) data.set(passInput.getAttribute('name') || 'password', password);
    [...f2.querySelectorAll('input[type="hidden"]')].forEach(i => {
      const n = i.getAttribute('name'); if (n) data.set(n, i.getAttribute('value') || '');
    });

    const posted = await postForm(action, data, {
      headers: { referer: ssoUrl, origin: 'https://account.huntedcow.com' }
    }, 'sso-post');

    let d3 = parseHTML(posted.html).document;
    // relay de volta ao jogo
    let relay = pickHiddenRelayForm(d3);
    if (relay) {
      const relayAct = abs(relay.getAttribute('action') || ssoUrl, ssoUrl);
      const relayData = new URLSearchParams();
      [...relay.querySelectorAll('input')].forEach(i => {
        const n = i.getAttribute('name'); if (n) relayData.set(n, i.getAttribute('value') || '');
      });
      const fin = await postForm(relayAct, relayData, {
        headers: { referer: ssoUrl }
      }, 'sso-relay');
      if (/id\s*=\s*['"]pCC['"]/.test(fin.html)) return true;
    }
    if (await isLoggedIn()) {
      console.log('login successful');
      return true; // ✅ ADD THIS RETURN
    }
  }
  // AC-AUTH-001: a completed SSO sequence without #pCC means the credentials were rejected.
  throw new Error('Authentication failed: the game did not accept the configured GG_EMAIL/GG_PASSWORD (no #pCC after SSO).');
}

export async function ensureLogin(
  email = currentCredentials().email,
  password = currentCredentials().password
) {
  const ok = await isLoggedIn();
  if (ok) return LOG('login', `Account logged in`);
  LOG('login', 'Session expired or invalid; re-authenticating'); // AC-AUTH-002
  return await login(email, password);
}
