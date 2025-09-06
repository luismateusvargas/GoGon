import { DELAY_BETWEEN_MESSAGES, RETRY_DELAY } from './webhooks.js';

// === GM_* Polyfill for Node.js (Tampermonkey-like storage) ==================
try {
  // Only define if not provided by the runtime (e.g., not running in TM)
  if (typeof globalThis.GM_getValue !== 'function') {
    const { default: fs } = await import('node:fs');
	const { default: path } = await import('node:path');
    const __SWS_GM_STORE = process.env.SWS_GM_STORE || './_sws_data/gm_store.json';

    function __swsReadStore() {
      try {
        return JSON.parse(fs.readFileSync(__SWS_GM_STORE, 'utf8'));
      } catch {
        return {};
      }
    }
    function __swsWriteStore(obj) {
      try {
        fs.mkdirSync(path.dirname(__SWS_GM_STORE), { recursive: true });
        fs.writeFileSync(__SWS_GM_STORE, JSON.stringify(obj, null, 2), 'utf8');
      } catch (e) {
        try { console.warn('[SWS_DEBUG] GM polyfill write failed:', e?.message || e); } catch {}
      }
    }

    globalThis.GM_getValue = function(key, defVal) {
      const store = __swsReadStore();
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defVal;
    };
    globalThis.GM_setValue = function(key, val) {
      const store = __swsReadStore();
      store[key] = val;
      __swsWriteStore(store);
    };
    globalThis.GM_deleteValue = function(key) {
      const store = __swsReadStore();
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        delete store[key];
        __swsWriteStore(store);
      }
    };
    globalThis.GM_listValues = function() {
      const store = __swsReadStore();
      return Object.keys(store);
    };

    console.log('[SWS_DEBUG] GM_* polyfill ativo. Arquivo:', __SWS_GM_STORE);
  }
} catch (e) {
  try { console.warn('[SWS_DEBUG] Falha ao ativar GM polyfill:', e?.message || e); } catch {}
}
// === End GM_* Polyfill =======================================================
import { FS_BASE, authedFetch, ensureLogin, isLoggedIn } from './session.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';


function normalizeFsUrl(u, base) {
  try {
    const url = new URL(u, base);
    if (url.pathname.endsWith('/index.php')) {
      const cmd = url.searchParams.get('cmd');
      const subcmd = url.searchParams.get('subcmd');
      if ((!cmd || cmd === '') && subcmd) {
        url.searchParams.set('cmd', 'news');
      }
    }
    return url.toString();
  } catch {
    return u;
  }
}

let LAST_GOOD_REFERER = (new URL('index.php?cmd=news', new URL(FS_BASE || 'https://www.fallensword.com/'))).toString();

function __swsDebugLog(...args) {
  const dbg = (process.env.SWS_DEBUG || '').toString().trim();
  if (!dbg || dbg === '0' || dbg.toLowerCase() === 'false') return;
  try { console.log('[SWS_DEBUG]', ...args); } catch {}
}

function __swsDumpHtml(tag, url, html) {
  try {
    const dbg = (process.env.SWS_DEBUG || '').toString().trim();
    if (!dbg || dbg === '0' || dbg.toLowerCase() === 'false') return;
    const dumpDir = (process.env.SWS_DEBUG_DUMP_DIR || './_sws_dumps').toString().trim();
    const data = (typeof html === 'string') ? html : (html ? String(html) : '');
    const safeTag = String(tag || 'dump').replace(/[^a-z0-9_\-\.]/gi, '_');
    const safeName = String(url || 'unknown').replace(/[^a-z0-9_\-\.]/gi, '_').slice(0, 120);
    const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
    const file = path.join(dumpDir, `${timestamp}_${safeTag}_${safeName}.html`);
    const latest = path.join(dumpDir, `secureFetch-last.html`);
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(file, data, 'utf8');
    fs.writeFileSync(latest, data, 'utf8');
    console.log('[SWS_DEBUG] HTML dump salvo em:', file, 'URL:', url);
  } catch (e) {
    try { console.log('[SWS_DEBUG] Falha ao salvar dump HTML:', e?.message || e); } catch {}
  }
}

const messageQueue = [];
let processingQueue = false;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function queueDiscordMessage(webhook, payload) {
  messageQueue.push({ webhook, payload });
  processQueue();
}

export async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (messageQueue.length) {
    const { webhook, payload } = messageQueue[0];
    try {
      await securePostDiscord(webhook, payload);
      messageQueue.shift();
      await sleep(DELAY_BETWEEN_MESSAGES);
    } catch (err) {
      if (err.status === 429) {
        await sleep(err.retryAfter || DELAY_BETWEEN_MESSAGES);
      } else {
        console.error('queueDiscordMessage error:', err);
        messageQueue.shift();
      }
    }
  }
  processingQueue = false;
}

export function getContent(where) {
  return GM_getValue(where, '');
}

export function setContent(where, content) {
  GM_setValue(where, content);
}

export function addLine(newLine, where) {
  let conteudo = getContent(where);
  let linhas = conteudo.split('\n');
  linhas.push(newLine);
  if (linhas.length > 20) {
    linhas.shift();
  }
  conteudo = linhas.join('\n');
  setContent(where, conteudo);
}

export function checkInfo(line, where) {
  let conteudo = getContent(where);
  let linhas = conteudo.split('\n');
  return linhas.includes(line);
}



async function setRefererIfPCC(response, usedUrl) {
  try {
    const ct = (response.headers.get('content-type') || '');
    if (!ct.includes('text/html')) return;
    const clone = response.clone();
    const html = await clone.text();
    if (/id\s*=\s*['"]pCC['"]/.test(html)) {
      LAST_GOOD_REFERER = usedUrl;
    }
  } catch {}
} 

export async function secureFetch(url, options = {}, retries = 3) {
  // Node/headless. Fallen Sword SEMPRE em https://www.fallensword.com/ (host com www)
  const base = new URL(FS_BASE || 'https://www.fallensword.com/');
  base.protocol = 'https:';
  base.hostname = 'www.fallensword.com';

  const finalUrl = (() => { try { return new URL(url, base).toString(); } catch { return String(url); } })();
  const isGameUrl = finalUrl.startsWith(base.toString());

  // Normaliza a URL do FS sem tentar login aqui (evita dupla chamada)
  if (isGameUrl) {
    try {
      const norm = normalizeFsUrl(finalUrl, base);
      if (norm !== finalUrl) {
        url = norm; // atualiza origem da requisição
      }
    } catch {}
  }

  if (typeof __swsDebugLog === 'function') {
    __swsDebugLog('secureFetch:start', { url: finalUrl, isGameUrl, retries });
  }

  // Usar SEMPRE authedFetch para URLs do jogo
  const f = isGameUrl && typeof authedFetch === 'function' ? authedFetch : globalThis.fetch;
  if (typeof __swsDebugLog === 'function') {
    __swsDebugLog('secureFetch:fetchSelected', isGameUrl ? (typeof authedFetch === 'function' ? 'authedFetch' : 'global.fetch') : 'global.fetch');
  }

  // Warm-up de stickiness (cookie LB) se ausente
  if (isGameUrl) {
    try {
      const sess = await import('./session.mjs');
      if (typeof sess.dumpDomainCookies === 'function' && typeof authedFetch === 'function') {
        const cookies = await sess.dumpDomainCookies('fallensword.com');
        const hasLB = Array.isArray(cookies) && cookies.some(c => (c.key || c.name) === 'LB' && String(c.domain||'').includes('www.fallensword.com'));
        if (!hasLB) {
          if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:warmupLB', { action: 'GET /', reason: 'LB ausente' });
          try { await authedFetch(base.toString(), { redirect: 'follow' }); } catch {}
        }
      }
    } catch (e) {
      if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:warmupLB:error', e?.message || e);
    }
  }

  const defaultHeaders = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': (process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
    'Origin': 'https://www.fallensword.com',
    'Referer': (LAST_GOOD_REFERER || 'https://www.fallensword.com/index.php?'),
  };
  const optsTemplate = { method: 'GET', redirect: 'follow', cache: 'no-store' };

  // Guard de login (único ponto pró-ativo)
  if (isGameUrl && typeof globalThis.ensureLogin === 'function' && !options.__skipEnsureLogin) {
    try { await globalThis.ensureLogin(); } catch (e) {
      if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:ensureLoginWarn', e?.message || e);
    }
  }

  // Helper: detecta página de login por #hc-account-link (determinístico)
  async function isLoginHtml(response) {
    try {
      const ct = response.headers.get('content-type') || '';
      if (!/text\/html/i.test(ct)) return false;
      const html = await response.clone().text();
      // Checagem robusta ao id e opcionalmente ao href esperado
      const hasId = /\bid\s*=\s*["']hc-account-link["']\b/i.test(html);
      if (!hasId) return false;
      // Endurece se quiser: exigir também o href do HuntedCow
      return /href\s*=\s*["']https:\/\/account\.huntedcow\.com\/auth\?game=6["']/i.test(html) || hasId;
    } catch {
      return false;
    }
  }

  // Garante flag global para evitar loop de reautenticação
  if (typeof globalThis.__didLoginAttempt === 'undefined') {
    globalThis.__didLoginAttempt = false;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const opts = { ...optsTemplate, ...options, headers: { ...defaultHeaders, ...(options?.headers || {}) } };
      let res = await f(finalUrl, opts);

      if (typeof __swsDebugLog === 'function') {
        __swsDebugLog('secureFetch:response', { url: finalUrl, status: res?.status, redirected: res?.redirected, final: res?.url });
      }

      if (isGameUrl && res.ok) { try { LAST_GOOD_REFERER = res.url || finalUrl; } catch {} }

      // Detecta página de login (200 sem redirect) pelo marcador #hc-account-link
      if (isGameUrl && res.ok && await isLoginHtml(res)) {
        if (typeof __swsDebugLog === 'function') {
          __swsDebugLog('secureFetch:loginDetected', { url: res.url || finalUrl });
        }
        if (typeof __swsDumpHtml === 'function') {
          try {
            const dump = await res.clone().text();
            __swsDumpHtml('secureFetch_login_detected', res?.url || finalUrl, dump);
          } catch {}
        }

        if (typeof ensureLogin === 'function' && !globalThis.__didLoginAttempt) {
          globalThis.__didLoginAttempt = true;
          try {
            await ensureLogin();
            const optsRetry = {
              ...opts,
              headers: { ...defaultHeaders, ...(options?.headers || {}) }, // mesma ordem (caller tem precedência)
            };
            res = await f(finalUrl, optsRetry);

            if (res.ok && !(await isLoginHtml(res))) {
              // OK após reautenticar
              if (typeof __swsDumpHtml === 'function') {
                try {
                  const tOk = await res.clone().text();
                  __swsDumpHtml('secureFetch_ok', res?.url || finalUrl, tOk);
                } catch {}
              }
              return res;
            }

            // Ainda em login após tentar reautenticar
            throw new Error('Sessão inválida após reautenticação.');
          } catch (e) {
            // Propaga com mensagem clara
            throw (e instanceof Error ? e : new Error('Falha na reautenticação.'));
          }
        } else {
          // Sem ensureLogin ou já tentado: falha imediata
          throw new Error('Sessão inválida/expirada (página de login detectada).');
        }
      }

      if (res.ok) {
        try {
          const tOk = await res.clone().text();
          if (typeof __swsDumpHtml === 'function') __swsDumpHtml('secureFetch_ok', res?.url || finalUrl, tOk);
          if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:okBodyPreview', tOk ? tOk.slice(0, 300) : '(sem corpo)');
        } catch (e) {
          if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:okBodyReadError', e?.message || e);
        }
        return res;
      }

      // Dump do corpo em erro (debug)
      try {
        const t = await res.clone().text();
        if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:notOkBodyPreview', t ? t.slice(0, 300) : '(sem corpo)');
        if (typeof __swsDumpHtml === 'function') __swsDumpHtml('secureFetch_not_ok', res?.url || finalUrl, t);
      } catch (e) {
        if (typeof __swsDebugLog === 'function') __swsDebugLog('secureFetch:notOkBodyReadError', e?.message || e);
      }

      const status = res.status || 0;
      if (status >= 500 && attempt < retries) {
        await sleep(RETRY_DELAY);
        continue;
      }
      // ⚠️ Corrigido template string
      throw new Error(`Request failed: ${status}`);

    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY);
      } else {
        console.error('secureFetch error:', err);
        throw err;
      }
    }
  }
}

export async function securePost(url, form, options = {}, retries = 3) {
  const base = new URL(FS_BASE.endsWith('/') ? FS_BASE : FS_BASE + '/');
  const finalUrl = (() => { try { return new URL(url, base).toString(); } catch { return String(url); } })();
  const body = new URLSearchParams(form || {});
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': process.env.SWS_LANG || 'en-US,en;q=0.9,pt-BR;q=0.8',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    ...(options.headers || {})
  };
  return secureFetch(finalUrl, { ...options, method: 'POST', body, headers }, retries);
}

export async function securePostDiscord(url, payload, opts = {}) {
  const { retries = 5, authorization } = opts;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'User-Agent': 'SWS-Bot/1.0 (+https://www.fallensword.com)'
  };
  if (authorization) headers['Authorization'] = authorization;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (res.status === 200 || res.status === 204) {
        return res;
      }

      if (res.status === 429) {
        let retryAfterMs = 0;
        try {
          const data = await res.json().catch(() => ({}));
          if (typeof data.retry_after !== 'undefined') {
            retryAfterMs = Number(data.retry_after);
            if (retryAfterMs && retryAfterMs < 50) retryAfterMs = Math.round(retryAfterMs * 1000);
          }
        } catch {}
        if (!retryAfterMs) {
          const h = (name) => res.headers.get(name) || res.headers.get(name.toLowerCase()) || '';
          const ra = h('Retry-After') || h('X-RateLimit-Reset-After');
          if (ra) {
            const num = Number(ra);
            if (!Number.isNaN(num)) retryAfterMs = num > 50 ? Math.round(num) : Math.round(num * 1000);
          }
        }
        const err = new Error('Rate limited');
        err.status = 429;
        err.retryAfter = retryAfterMs || undefined;
        throw err;
      }

      if ((res.status === 502 || res.status === 504 || res.status === 503) && attempt < retries) {
        await sleep(RETRY_DELAY);
        continue;
      }
      if (res.status >= 500) {
        throw new Error(`Server error: ${res.status}`);
      }

      throw new Error(`Request failed: ${res.status}`);
    } catch (err) {
      if (err && err.status === 429) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(RETRY_DELAY);
        continue;
      }
      throw err;
    }
  }
}

export function sendDiscordMessage(message, wTitle, colorCode, footerText, group, webhook) {
  const embed = {
    title: wTitle,
    description: message,
    color: colorCode,
    footer: {
      text: footerText
    }
  };

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  /* securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendDiscordMessage error:', err)
  ); */
}

export function sendSimpleMessage(message, webhook) {
	queueDiscordMessage(webhook, message);
  /* securePost(webhook, { content: message }).catch(err =>
    console.error('sendSimpleMessage error:', err)
  ); */
}

export function sendExtraDiscordMessage(
  message,
  wTitle,
  colorCode,
  footerText,
  group,
  webhook,
  thumbUrl,
  thumb
) {
  const embed = {
    title: wTitle,
    description: message,
    image: {
      url: thumbUrl
    },
    thumbnail: {
      url: thumb
    },
    color: colorCode,
    footer: {
      text: footerText
    }
  };

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  /* securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendExtraDiscordMessage error:', err)
  ); */
}

export function sendExtraDiscordMessageNODROP(
  message,
  wTitle,
  colorCode,
  footerText,
  group,
  webhook,
  thumbUrl
) {
  const embed = {
    title: wTitle,
    description: message,
    image: {
      url: thumbUrl
    },
    color: colorCode,
    footer: {
      text: footerText
    }
  };

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  /* securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendExtraDiscordMessageNODROP error:', err)
  ); */
}

/** (NOVO) Extrai Gold em mão do alvo */
export async function getGoldInHand(targetLink) {
  try {
    const resp = await secureFetch(targetLink);
    const html = await resp.text();
    const doc = toDoc(html);
    // Tenta #stat-gold primeiro; cai para qualquer id que contenha 'stat-gold'
    const goldEl = doc.querySelector('#stat-gold') || doc.querySelector('[id*="stat-gold"]') || null;
    if (goldEl) return txt(goldEl);
    // Fallback: procurar label "Gold" na coluna esquerda do perfil
    const maybe = Array.from(doc.querySelectorAll('#profileLeftColumn td, #profileLeftColumn div, #profileRightColumn td, #profileRightColumn div'))
      .map(el => txt(el)).find(t => /^gold[:\s]/i.test(t));
    if (maybe) return maybe.replace(/^gold[:\s]*/i, '').trim();
  } catch (e) {
    WARN('bounty', 'getGoldInHand falhou: ' + (e?.message || e));
  }
  return null;
}

/* export async function getGoldInHand(targetLink) {
  let response = await secureFetch(targetLink);
  let text = await response.text();
  let tempElement = document.createElement('div');
  tempElement.innerHTML = text;
  let goldInHandElement = tempElement.querySelector('#stat-gold');
  if (goldInHandElement) {
    return goldInHandElement.textContent;
  }
  return null;
} */

/** (NOVO) Extrai buffs ativos do alvo (Deflect / Cloak + contagem) */
export async function getBuffs(targetLink) {
  try {
    const resp = await secureFetch(targetLink);
    const html = await resp.text();
    const doc = toDoc(html);

    const imgs = Array.from(doc.querySelectorAll('img[data-tipped]'));
    const buffNameAndLevel = [];
    for (const img of imgs) {
      const tipped = img.getAttribute('data-tipped') || '';
      if (!tipped || !/Level:\s*\d+/i.test(tipped)) continue;
      // data-tipped é HTML; parseamos para extrair <span><b>NAME</b> ... Level: N</span>
      try {
        const tipDoc = toDoc(tipped);
        const name = txt(tipDoc.querySelector('span > b')) || '';
        const levelSpan = txt(tipDoc.querySelector('span')) || '';
        const m = /Level:\s*(\d+)/i.exec(levelSpan);
        const level = m ? m[1] : '';
        if (name) buffNameAndLevel.push({ name, level });
      } catch {}
    }

    let hasDeflect = false, isCloaked = false;
    for (const b of buffNameAndLevel) {
      const n = (b.name || '').toLowerCase();
      if (n === 'deflect') hasDeflect = true;
      if (n === 'cloak') isCloaked = true;
    }
    return { hasDeflect, isCloaked, numberOfBuffs: buffNameAndLevel.length };
  } catch (e) {
    WARN('bounty', 'getBuffs falhou: ' + (e?.message || e));
    return { hasDeflect: false, isCloaked: false, numberOfBuffs: 0 };
  }
}

/* export async function getBuffs(targetLink) {
  let response = await secureFetch(targetLink);
  let text = await response.text();
  let tempElement = document.createElement('div');
  tempElement.innerHTML = text;
  let isCloaked = false;
  let hasDeflect = false;
  let buffNameAndLevel = [];
  let trs = tempElement.querySelectorAll('#profileRightColumn > div:nth-child(14) > table > tbody > tr');
  trs.forEach(tr => {
    let tds = tr.querySelectorAll('td');
    tds.forEach(td => {
      let img = td.querySelector('img');
      if (img) {
        let tipped = img.getAttribute('data-tipped');
        let span = document.createElement('div');
        span.innerHTML = tipped;
        let buffName = span.querySelector('span > b').textContent;
        let level = span
          .querySelector('span')
          .textContent.split('Level: ')[1]
          .split(')')[0];
        buffNameAndLevel.push({ name: buffName, level: level });
      }
    });
  });
  buffNameAndLevel.forEach(buff => {
    if (buff.name === 'Deflect') {
      hasDeflect = true;
    }
    if (buff.name === 'Cloak') {
      isCloaked = true;
    }
  });
  return { hasDeflect: hasDeflect, isCloaked: isCloaked, numberOfBuffs: buffNameAndLevel.length };
} */
