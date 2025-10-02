import { DELAY_BETWEEN_MESSAGES, RETRY_DELAY } from './webhooks.js';
import { LOG, WARN, ERR } from './app_modules/core.js';
import { getBuffNameById } from './game_modules/buffParser.js';
import { apiEndpoints } from './game_modules/API.js';
import * as cheerio from 'cheerio';

import { FS_BASE, authedFetch, ensureLogin, isLoggedIn } from './session.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import discordFetch from 'node-fetch';


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

/*function __swsDebugLog(...args) {
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
}*/

const messageQueue = [];
let processingQueue = false;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Adds a message to the queue to be sent to Discord.
 * @param {string} webhook - The webhook URL.
 * @param {object} payload - The message payload.
 */
export function queueDiscordMessage(webhook, payload) {
    messageQueue.push({ webhook, payload });
    if (!processingQueue) {
        processQueue();
    }
}

/**
 * Processes the message queue one by one, sending messages to Discord.
 */
export async function processQueue() {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
        const { webhook, payload } = messageQueue[0];
        try {
            await securePostDiscord(webhook, payload);
            messageQueue.shift(); // Remove message from queue on success
            await sleep(DELAY_BETWEEN_MESSAGES);
        } catch (err) {
            // Handle rate limits by pausing and retrying the same message
            if (err.status === 429 && err.retryAfter) {
                WARN('DiscordQueue', `Rate limited. Pausing queue for ${err.retryAfter}ms...`);
                await sleep(err.retryAfter);
            } else {
                ERR('DiscordQueue', 'Failed to send message, removing from queue', err);
                messageQueue.shift(); // Remove message from queue on other errors
            }
        }
    }
    processingQueue = false;
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

/**
 * A secure fetch wrapper for Fallen Sword game URLs.
 * Handles authentication, retries, and session validation for both HTML and JSON API responses.
 */
export async function secureFetch(url, options = {}, retries = 3) {
  // Constants and environment setup (assuming these are defined elsewhere)
  const FS_BASE = process.env.FS_BASE || 'https://www.fallensword.com/';
  const RETRY_DELAY = 1000; // 1 second delay for retries
  let LAST_GOOD_REFERER = '';

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Mock functions for environment compatibility if they don't exist
  const __swsDebugLog = typeof globalThis.__swsDebugLog === 'function' ? globalThis.__swsDebugLog : () => {};
  const __swsDumpHtml = typeof globalThis.__swsDumpHtml === 'function' ? globalThis.__swsDumpHtml : () => {};
  const authedFetch = typeof globalThis.authedFetch === 'function' ? globalThis.authedFetch : globalThis.fetch;
  const ensureLogin = typeof globalThis.ensureLogin === 'function' ? globalThis.ensureLogin : async () => { throw new Error('ensureLogin not implemented.'); };
  // Helper to normalize URLs (assuming implementation exists)
  const normalizeFsUrl = (urlToNormalize) => urlToNormalize;


  // --- Main Function Logic ---
  const base = new URL(FS_BASE);
  base.protocol = 'https:';
  base.hostname = 'www.fallensword.com';

  const finalUrl = (() => { try { return new URL(url, base).toString(); } catch { return String(url); } })();
  const isGameUrl = finalUrl.startsWith(base.toString());

  if (isGameUrl) {
    try {
      const norm = normalizeFsUrl(finalUrl, base);
      if (norm !== finalUrl) {
        url = norm;
      }
    } catch {}
  }

  __swsDebugLog('secureFetch:start', { url: finalUrl, isGameUrl, retries });

  const f = isGameUrl ? authedFetch : globalThis.fetch;
  __swsDebugLog('secureFetch:fetchSelected', isGameUrl ? 'authedFetch' : 'global.fetch');

  // Login guard (proactive check)
  if (isGameUrl && !options.__skipEnsureLogin) {
    try { await ensureLogin(); } catch (e) {
      __swsDebugLog('secureFetch:ensureLoginWarn', e?.message || e);
    }
  }

  // --- LOGOUT DETECTION HELPERS ---

  /**
   * Detects a logged-out state by checking for the HTML login page signature.
   */
  async function isLoginHtml(response) {
    const ct = response.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return false;
    try {
      const html = await response.clone().text();
      return /\bid\s*=\s*["']hc-account-link["']\b/i.test(html);
    } catch {
      return false;
    }
  }

  /**
   * [NEW] Detects a logged-out state by checking for the JSON error signature.
   * This handles API responses like: {"s":false,"e":{"message":"...","code":...}}
   */
  async function isLoginJson(response) {
    const ct = response.headers.get('content-type') || '';
    if (!/application\/json/i.test(ct)) return false;
    try {
      const data = await response.clone().json();
      // The signature of a logged-out API call is s:false with an error object 'e'.
      return data && data.s === false && typeof data.e === 'object' && data.e !== null;
    } catch {
      // Failed to parse JSON, so it's not the target signature.
      return false;
    }
  }


  if (typeof globalThis.__didLoginAttempt === 'undefined') {
    globalThis.__didLoginAttempt = false;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const defaultHeaders = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'User-Agent': (process.env.SWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
        'Origin': 'https://www.fallensword.com',
        'Referer': (LAST_GOOD_REFERER || 'https://www.fallensword.com/index.php?'),
      };
      const opts = {
        method: 'POST',
        redirect: 'follow',
        cache: 'no-store',
        ...options,
        headers: { ...defaultHeaders, ...(options?.headers || {}) }
      };

      let res = await f(finalUrl, opts);

      __swsDebugLog('secureFetch:response', { url: finalUrl, status: res?.status, redirected: res?.redirected, final: res?.url });

      if (isGameUrl && res.ok) {
        LAST_GOOD_REFERER = res.url || finalUrl;
      }

      // [MODIFIED] Check for logged-out state using BOTH HTML and JSON detectors.
      if (isGameUrl && res.ok && (await isLoginHtml(res) || await isLoginJson(res))) {
        __swsDebugLog('secureFetch:loginDetected', { url: res.url || finalUrl });
        const dump = await res.clone().text();
        __swsDumpHtml('secureFetch_login_detected', res?.url || finalUrl, dump);

        if (!globalThis.__didLoginAttempt) {
          globalThis.__didLoginAttempt = true;
          try {
            await ensureLogin();
            res = await f(finalUrl, opts); // Retry the fetch after re-authenticating

            // Check again after retry. If it's still a login page, fail hard.
            if (await isLoginHtml(res) || await isLoginJson(res)) {
               throw new Error('Session is still invalid after re-authentication.');
            }
            // Success!
            return res;
          } catch (e) {
            throw (e instanceof Error ? e : new Error('Failed to re-authenticate.'));
          }
        } else {
          // Already tried to log in once, so fail immediately.
          throw new Error('Session invalid/expired (login page detected).');
        }
      }

      if (res.ok) {
        return res;
      }

      // Handle non-OK responses (e.g., 500 server errors)
      const status = res.status || 0;
      if (status >= 500 && attempt < retries) {
        __swsDebugLog('secureFetch:serverErrorRetry', { status, attempt });
        await sleep(RETRY_DELAY);
        continue; // Go to the next iteration of the loop
      }

      throw new Error(`Request failed with status: ${status}`);

    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY);
      } else {
        console.error('secureFetch error after all retries:', err);
        throw err;
      }
    }
  }
}


// Fetch simplificado para domínios externos (ex.: guide.fallensword.com)
export async function secureFetchExternal(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await globalThis.fetch(url, { redirect: 'follow', ...options });
      if (res.ok) return res;
      if (res.status >= 500 && attempt < retries) {
        await sleep(RETRY_DELAY);
        continue;
      }
      throw new Error(`External request failed: ${res.status}`);
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY);
      } else {
        console.error('secureFetchExternal error:', err);
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
    const { retries = 3, method = 'POST' } = opts;
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'SWS-Bot/1.0 (+https://www.fallensword.com)'
    };

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // [FIXED] Use the clean, dedicated 'discordFetch' for all Discord communication.
            const res = await discordFetch(url, {
                method: method,
                headers,
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                return res;
            }

            if (res.status === 429) { // Rate limited
                const responseData = await res.json();
                const retryAfterMs = Math.round(responseData.retry_after * 1000) + 500; // Add buffer
                const error = new Error('Rate limited by Discord');
                error.status = 429;
                error.retryAfter = retryAfterMs;
                throw error; // Throw to be handled by the caller (e.g., processQueue)
            }

            if (res.status >= 500 && attempt < retries - 1) { // Server error
                WARN('Discord', `Server error (${res.status}). Retrying in ${RETRY_DELAY}ms...`);
                await sleep(RETRY_DELAY);
                continue;
            }
            
            const errorText = await res.text();
            throw new Error(`Request failed: ${res.status} - ${errorText}`);

        } catch (err) {
            if (err.status === 429) throw err; // Re-throw rate limit errors immediately
            if (attempt >= retries - 1) {
                throw err; // Throw the final error after all retries
            }
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

// --- HELPER FUNCTIONS FOR PARSING (MOVED FROM BountyBoard.js) ---

// Helper to parse HTML string into a document
export function toDoc(html) { 
  return new DOMParser().parseFromString(html, 'text/html'); 
}

// Helper to clean up text content from HTML elements
export function txt(n) {
  return (n?.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g,' ').trim();
}

// --- DUPLICATED FUNCTIONS (NOW CENTRALIZED) ---

/**Extracts Gold in hand from a target's profile */
export async function getGoldInHand(targetLink) {
  try {
    // [FIXED] Added 'await' to wait for the promise to resolve.
    const response = await secureFetch(targetLink);

    if (!response.ok) {
      WARN('goldFetch', `Failed HTTP request: ${response.status}`);
      return; // Return undefined on failure
    }

    const data = await response.json();
    if (!data || !data.s) {
      LOG('goldFetch', `API call not successful: ${data.e?.message || 'Unknown error'}`);
      return; // Return undefined on failure
    }

    // Safely access the gold value and return it.
    return data.r?.gold; // Assuming the property is named 'gold_in_hand' based on context

  } catch (error) {
    console.error('An error occurred in getGoldInHand:', error);
    // Return undefined if any part of the process fails.
    return;
  }
}

/**
 * Extracts active buffs and their levels from a target's profile.
 */
export async function getBuffs(targetLink, isBounty) {
  try {
    const response = await secureFetch(targetLink);
    if (!response.ok) {
      WARN('getBuffs', `Failed HTTP request: ${response.status}`);
      return;
    }

    const data = await response.json();
    if (!data || !data.s) {
      LOG('getBuffs', `API call not successful: ${data.e?.message || 'Unknown error'}`);
      return;
    }

    // The raw list of buffs from the API.
    const buffsList = data.r;

    // If we're processing for a bounty, we transform the data.
    if (isBounty) {
      // Establish default values.
      let hasDeflect = false;
      let isCloaked = false;
      const numberOfBuffs = Array.isArray(buffsList) ? buffsList.length : 0;

      if (numberOfBuffs > 0) {
        for (const buff of buffsList) {
          const buffName = getBuffNameById(buff.id);
          if (buffName === 'deflect') {
            hasDeflect = true;
          } else if (buffName === 'cloak') {
            isCloaked = true;
          }
        }
      }
      return { hasDeflect, isCloaked, numberOfBuffs };
    }

    // If not for a bounty, return the raw buff list.
    return buffsList;

  } catch (e) {
    WARN('getBuffs', `Error fetching buffs: ${e}`);
    return; // Return undefined on failure
  }
}

/**
 * Fetches a player's ID based on their username.
 * @param {string} username - The username of the player to find.
 * @returns {Promise<number|null>} The player's ID, or null if not found.
 */
export async function getPlayerIdByName(username) {
    try {
        const response = await secureFetch(apiEndpoints.player.returnPlayerID(username));
        const data = await response.json();
        // The API returns a flat object, so we check for the 'id' property directly.
        if (data && data.id) {
            return data.id;
        }
        // It's possible for the API to return a success=false for not found players.
        if (data && data.s === false) {
             LOG('getPlayerId', `Could not find player ID for username: ${username}. Player does not exist.`);
             return null;
        }
        LOG('getPlayerId', `Could not find player ID for username: ${username}. Unexpected API response.`);
        return null;
    } catch (error) {
        ERR('getPlayerId', `An error occurred while fetching player ID for ${username}`, error);
        return null;
    }
}

/**
 * Sends a Discord message and returns the created message's ID.
 * @returns {Promise<string|null>} The ID of the created message, or null on failure.
 */
export async function sendAndGetMessageId(webhookUrl, payload) {
    const url = `${webhookUrl}?wait=true`;
    try {
        const response = await securePostDiscord(url, payload, { method: 'POST' });
        const data = await response.json();
        return data.id || null;
    } catch (err) {
        ERR('Discord', 'sendAndGetMessageId failed after all retries', err);
        return null;
    }
}

/**
 * Edits an existing Discord message using its ID.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function editDiscordMessage(webhookUrl, messageId, payload) {
    const editUrl = `${webhookUrl}/messages/${messageId}`;
    try {
        const response = await securePostDiscord(editUrl, payload, { method: 'PATCH' });
        LOG('Discord', `Successfully edited message ID: ${messageId}`);
        return response.ok;
    } catch (err) {
        ERR('Discord', `editDiscordMessage failed for messageId ${messageId}`, err);
        return false;
    }
}