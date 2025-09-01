import { DELAY_BETWEEN_MESSAGES, RETRY_DELAY } from './webhooks.js';
import { FS_BASE, authedFetch } from './session.mjs';
let LAST_GOOD_REFERER = null;

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
  const base = new URL(FS_BASE.endsWith('/') ? FS_BASE : FS_BASE + '/');
const forcedProto = (process.env.SWS_FORCE_PROTOCOL || '').toLowerCase();
if (forcedProto === 'http' || forcedProto === 'https') {
  try { base.protocol = forcedProto + ':'; } catch {}
}
const finalUrl = (() => {
    try { return new URL(url, base).toString(); } catch { return String(url); }
  })();
  const isGameUrl = finalUrl.startsWith(base.toString());

  const canToggleScheme = !(forcedProto === 'http' || forcedProto === 'https');
if (isGameUrl && typeof globalThis.ensureLogin === 'function' && !options.__skipEnsureLogin) {
    try { await globalThis.ensureLogin(); } catch (e) { console.warn('ensureLogin guard falhou:', e?.message || e); }
  }

  const browseryHeaders = {
    'user-agent': process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': process.env.SWS_LANG || 'en-US,en;q=0.9,pt-BR;q=0.8',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };
    function toggleScheme(u) {
    try { const x = new URL(u); x.protocol = (x.protocol === 'https:') ? 'http:' : 'https:'; return x.toString(); }
    catch { return u; }
  }

const merged = {
    method: (options && options.method) || 'GET',
    redirect: 'follow',
    credentials: 'include',
    ...options,
    headers: { ...(browseryHeaders), ...(options && options.headers ? options.headers : {}) }
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(finalUrl, merged);

      try {
        if (isGameUrl && res.ok && (res.headers.get('content-type') || '').includes('text/html') && !options.__retryLandingGuard) {
          const clone = res.clone();
          const html = await clone.text();
          const hasPCC = /id\s*=\s*['"]pCC['"]/.test(html);
          const looksLikeLanding = !hasPCC && /class=["']outer content["']/.test(html);
          if (looksLikeLanding) {
            console.warn('[secureFetch] Landing page detected. Forcing ensureLogin + retry…', finalUrl);
            if (typeof globalThis.ensureLogin === 'function') {
              try { await globalThis.ensureLogin(); } catch (e) { console.warn('ensureLogin (retry) falhou:', e?.message || e); }
            }
            const retryRes = await fetch(finalUrl, { ...merged, __retryLandingGuard: true });
                        // Re-check HTML; if still landing, try scheme toggle once
            try {
              if ((retryRes.headers.get('content-type') || '').includes('text/html')) {
                const retryClone = retryRes.clone();
                const retryHtml = await retryClone.text();
                const retryHasPCC = /id\s*=\s*['"]pCC['"]/.test(retryHtml);
                const retryLooksLikeLanding = !retryHasPCC && /class=["']outer content["']/.test(retryHtml);
                if (retryLooksLikeLanding && canToggleScheme && !options.__schemeSwitched) {
                  const altUrl = toggleScheme(finalUrl);
                  console.warn('[secureFetch] Still landing after retry. Toggling scheme and retrying…', altUrl);
                  const altRes = await fetch(altUrl, { ...merged, __retryLandingGuard: true, __schemeSwitched: true });
                  if (altRes.status === 200 || altRes.status === 204) return altRes;
                  if (altRes.status === 429 || (altRes.status >= 500 && altRes.status < 600)) {
                    if (attempt < retries) { await sleep(RETRY_DELAY); }
                    else { throw new Error(`Server error: ${altRes.status}`); }
                  } else {
                    throw new Error(`Request failed: ${altRes.status}`);
                  }
                }
              }
            } catch {}
if (retryRes.status === 200 || retryRes.status === 204) return retryRes;
            if (retryRes.status === 429 || (retryRes.status >= 500 && retryRes.status < 600)) {
              if (attempt < retries) { await sleep(RETRY_DELAY); continue; }
              throw new Error(`Server error: ${retryRes.status}`);
            }
            throw new Error(`Request failed: ${retryRes.status}`);
          }
        }
      } catch (e) {
        console.warn('secureFetch landing-guard check failed:', e?.message || e);
      }

      if (res.status === 200 || res.status === 204) {
        return res;
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY);
          continue;
        }
        throw new Error(`Server error: ${res.status}`);
      }
      throw new Error(`Request failed: ${res.status}`);
    } catch (err) {
            try {
        const msg = (err && (err.code || err.message || '') || '').toString().toLowerCase();
        const tlsLike = msg.includes('ssl') || msg.includes('tls') || msg.includes('certificate') || msg.includes('und_err_connect') || msg.includes('fetch failed');
        if (canToggleScheme && !options.__schemeSwitched && tlsLike) {
          const altUrl = toggleScheme(finalUrl);
          console.warn('[secureFetch] Network/TLS error. Toggling scheme and retrying once…', altUrl);
          const altRes = await fetch(altUrl, { ...merged, __schemeSwitched: true });
          if (altRes.status === 200 || altRes.status === 204) return altRes;
          if (altRes.status === 429 || (altRes.status >= 500 && altRes.status < 600)) {
            if (attempt < retries) { await sleep(RETRY_DELAY); } else { throw new Error(`Server error: ${altRes.status}`); }
          } else {
            throw new Error(`Request failed: ${altRes.status}`);
          }
        }
      } catch {}
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

export async function getGoldInHand(targetLink) {
  let response = await secureFetch(targetLink);
  let text = await response.text();
  let tempElement = document.createElement('div');
  tempElement.innerHTML = text;
  let goldInHandElement = tempElement.querySelector('#stat-gold');
  if (goldInHandElement) {
    return goldInHandElement.textContent;
  }
  return null;
}

export async function getBuffs(targetLink) {
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
}
