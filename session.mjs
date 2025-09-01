// session.mjs — SSO robusto + cookie bootstrap + logs opcionais
// Node 20/22 ESM

import { CookieJar } from 'tough-cookie';
import * as fetchCookieNS from 'fetch-cookie';
const fetchCookie = fetchCookieNS.default ?? fetchCookieNS;

import { parseHTML } from 'linkedom';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------- Config ----------
const BASE = process.env.SWS_BASE || process.env.FS_BASE || 'https://www.fallensword.com';
export const SWS_BASE = BASE;
export const FS_BASE = BASE;
export const SSO_ENTRY = process.env.SWS_SSO_URL || 'https://account.huntedcow.com/auth?game=6';


const DEBUG_LOGIN = String(process.env.SWS_LOGIN_DEBUG || '').toLowerCase() === '1' || String(process.env.SWS_LOGIN_DEBUG || '').toLowerCase() === 'true';
const DEBUG_DIR = process.env.SWS_DEBUG_DIR || path.resolve(process.cwd(), 'DEBUG');

// ---------- Cookie jar ----------
const jar = new CookieJar();
export const authedFetch = fetchCookie(globalThis.fetch, jar);

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
  if (!DEBUG_LOGIN) return;
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${nowTag()}-${name}.html`);
    await fs.writeFile(file, html, 'utf8');
    console.warn(`[login-debug] Snapshot salvo em ${file} (len=${html.length})`);
  } catch {}
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
    'user-agent': process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': process.env.SWS_LANG || 'en-US,en;q=0.9,pt-BR;q=0.8',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    ...(options.headers || {}),
  };
  const res = await authedFetch(url, { redirect: 'follow', credentials: 'include', ...options, headers });
  const html = await res.text();
  if (DEBUG_LOGIN) console.warn(`[login-debug] GET ${url} -> ${res.status}`);
  await dbgDump(tag, html);
  return { res, html };
}

async function postForm(url, body, options = {}, tag = 'post') {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': process.env.SWS_LANG || 'en-US,en;q=0.9,pt-BR;q=0.8',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    ...(options.headers || {}),
  };
  const res = await authedFetch(url, { method: 'POST', body, redirect: 'follow', credentials: 'include', ...options, headers });
  const html = await res.text();
  if (DEBUG_LOGIN) console.warn(`[login-debug] POST ${url} -> ${res.status}`);
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
    if (set > 0 && DEBUG_LOGIN) console.warn(`[login-debug] Bootstrap de ${set} cookies aplicado do arquivo ${file}`);
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

export async function login(email = process.env.SWS_EMAIL || process.env.FS_EMAIL,
                            password = process.env.SWS_PASSWORD || process.env.FS_PASSWORD) {
  if (!email || !password) throw new Error('Credenciais ausentes: defina SWS_EMAIL/FS_EMAIL e SWS_PASSWORD/FS_PASSWORD');

  // 0) Tenta bootstrap de cookies (se existir)
  await loadCookieBootstrap().catch(() => {});
  if (await isLoggedIn()) return true;

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
    if (await isLoggedIn()) return true;
  }
  return false;
}

export async function ensureLogin(
  email = process.env.SWS_EMAIL || process.env.FS_EMAIL,
  password = process.env.SWS_PASSWORD || process.env.FS_PASSWORD
) {
  const ok = await isLoggedIn();
  if (ok) return false;
  return await login(email, password);
}
