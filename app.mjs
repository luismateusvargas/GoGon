import 'dotenv/config';
import { parseHTML, DOMParser } from 'linkedom';
import { authedFetch, login, ensureLogin } from './session.mjs';

// ---------- Polyfills & globals (must come BEFORE importing engine) ----------
const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
global.window = window;
global.document = window.document;
global.DOMParser = DOMParser;

// fetch with cookie jar (session.mjs)
global.fetch = authedFetch;

// make ensureLogin available to any module (utils.js secureFetch guard, engine helpers)
global.ensureLogin = ensureLogin;

// Provide a minimal localStorage backed by storage.js (if your engine uses it)
import { getValue as storageGet, setValue as storageSet } from './storage.js';
global.localStorage = {
  getItem: (k) => {
    const v = storageGet(`ls:${k}`, null);
    return (v === undefined || v === null) ? null : String(v);
  },
  setItem: (k, v) => storageSet(`ls:${k}`, String(v)),
  removeItem: (k) => storageSet(`ls:${k}`, null),
  clear: () => storageSet('__ls_clear__', Date.now())
};
// -------------------------------------------------------------------------------

// Import engine AFTER globals are prepared
const { initEngine } = await import('./engine.js');

// Credentials
const email = process.env.SWS_EMAIL || process.env.FS_EMAIL;
const pass  = process.env.SWS_PASSWORD || process.env.FS_PASSWORD;

if (!email || !pass) {
  console.error('Defina SWS_EMAIL/SWS_PASSWORD (ou FS_EMAIL/FS_PASSWORD) antes de rodar.');
  process.exit(1);
}

// Boot sequence: login -> ensureLogin -> start news -> start bot
try {
  // 1) initial login
  try { console.log(await login(email, pass)); } 
  catch (e) { console.error('login failure:', e?.stack || e); }

  // 2) sanity check / refresh session if needed
  try { console.log(await ensureLogin()); } 
  catch (e) { console.error('login check failure:', e?.stack || e); }

  // 3) start news once
  if (typeof window.initEngine !== 'function') {
    window.initEngine = initEngine;
  }
  try {
    window.initEngine();
    console.log('initEngine invoked');
  } catch (e) {
    console.error('Falha ao invocar initEngine:', e?.stack || e);
  }

  // 4) start Discord bot (keeps process alive)
  const { startDiscordBot } = await import('./discordBot.mjs');
  await startDiscordBot();

} catch (err) {
  console.error('Erro fatal no boot:', err?.stack || err);
  process.exit(1);
}

// Extra: log unhandled rejections to avoid silent crashes
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});
