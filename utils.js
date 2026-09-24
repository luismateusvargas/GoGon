// utils.js - GoGon Utility Functions
import { DELAY_BETWEEN_MESSAGES, RETRY_DELAY } from './webhooks.js';
import { LOG, WARN, ERR } from './app_modules/core.js';
import { getBuffNameById } from './game_modules/buffParser.js';
import { apiEndpoints } from './game_modules/API.js';
import * as cheerio from 'cheerio';

// Session management imports
import { FS_BASE, authedFetch, ensureLogin, isLoggedIn, DEFAULT_UA, DEFAULT_LANG } from './session.mjs';
import { getSetting } from './config/runtime.mjs';

import * as fs from 'node:fs';
import * as path from 'node:path';
import discordFetch from 'node-fetch';

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

// v1.8.0: Batch queue for combining multiple messages
const batchQueue = new Map(); // webhook -> { messages: [], timeout: null, totalChars: 0 }
const BATCH_SIZE = 10; // Max 10 embeds per Discord message
const BATCH_IDLE_TIMEOUT = 100; // 100ms idle before sending partial batch
const MAX_DISCORD_CHARS = 5800; // Safety limit (actual is 6000) for title+desc+fields+footer+author
const MAX_EMBED_DESC = 4096;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculates the character count of an embed object to ensure Discord limits are met.
 * @param {object} embed - The embed object to measure.
 * @returns {number} The total character count.
 */
function getEmbedSize(embed) {
    let size = 0;
    if (embed.title) size += embed.title.length;
    if (embed.description) size += embed.description.length;
    if (embed.footer?.text) size += embed.footer.text.length;
    if (embed.author?.name) size += embed.author.name.length;
    if (embed.fields) {
        for (const field of embed.fields) {
            size += (field.name?.length || 0) + (field.value?.length || 0);
        }
    }
    return size;
}

/**
 * Adds a message to the batch queue for efficient Discord sending.
 * Messages are automatically batched (up to 10 embeds) by webhook.
 * Automatically splits batches if size exceeds Discord limits (6000 chars).
 * @param {string} webhook - The webhook URL.
 * @param {object} payload - The message payload with embeds.
 */
export function queueDiscordMessage(webhook, payload) {
    // Get or create batch for this webhook
    if (!batchQueue.has(webhook)) {
        batchQueue.set(webhook, {
            messages: [],
            timeout: null,
            totalChars: 0
        });
    }

    const batch = batchQueue.get(webhook);
    
    // Calculate new message size
    let msgSize = (payload.content || '').length;
    if (payload.embeds) {
        for (const embed of payload.embeds) {
            msgSize += getEmbedSize(embed);
        }
    }

    // Check if adding this message would exceed limits
    // 1. Embed count > 10
    // 2. Total chars > 6000
    const wouldExceedCount = batch.messages.length >= BATCH_SIZE; // Actually checking BEFORE adding, so >= 10 means full
    
    // Calculate current batch size if we merged now (deduplicated content is tricky to estimate perfectly, 
    // but simply summing lengths is a safe upper bound)
    const wouldExceedSize = (batch.totalChars + msgSize) > MAX_DISCORD_CHARS;

    if (batch.messages.length > 0 && (wouldExceedCount || wouldExceedSize)) {
        // Must send current batch first
        if (wouldExceedSize) {
             LOG('BatchQueue', `Batch size limit reached (${batch.totalChars} + ${msgSize} > ${MAX_DISCORD_CHARS}). Sending partial batch.`);
        }
        sendBatch(webhook);
        
        // Re-get new (empty) batch
        return queueDiscordMessage(webhook, payload);
    }
    
    // Add message to batch
    batch.messages.push(payload);
    batch.totalChars += msgSize;

    // Clear existing timeout
    if (batch.timeout) {
        clearTimeout(batch.timeout);
        batch.timeout = null;
    }

    // If batch is full (count limit), send immediately
    if (batch.messages.length >= BATCH_SIZE) {
        sendBatch(webhook);
    } else {
        // Schedule batch send after idle timeout
        batch.timeout = setTimeout(() => {
            sendBatch(webhook);
        }, BATCH_IDLE_TIMEOUT);
    }
}

/**
 * Sends a batch of messages for a specific webhook.
 * Merges multiple payloads into a single Discord message with multiple embeds.
 * @param {string} webhook - The webhook URL to send the batch to.
 */
function sendBatch(webhook) {
    if (!batchQueue.has(webhook)) return;

    const batch = batchQueue.get(webhook);
    
    // Clear timeout
    if (batch.timeout) {
        clearTimeout(batch.timeout);
        batch.timeout = null;
    }

    // Nothing to send
    if (batch.messages.length === 0) {
        batchQueue.delete(webhook);
        return;
    }

    // Merge messages into a single payload
    const mergedPayload = {
        content: batch.messages
            .map(m => m.content)
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i) // Deduplicate @mentions
            .join(' '),
        embeds: batch.messages.flatMap(m => m.embeds || [])
    };

    // Log batch efficiency
    LOG('BatchQueue', `Sending batch: ${batch.messages.length} messages, 1 API call (saved ${(batch.messages.length - 1) * 2}s)`);

    // Add to processing queue
    messageQueue.push({ webhook, payload: mergedPayload });
    
    // Clear this batch
    batchQueue.delete(webhook);

    // Start processing if not already running
    if (!processingQueue) {
        processQueue();
    }
}

/**
 * Flushes all pending batches immediately.
 * Useful for graceful shutdown or manual triggering.
 */
export function flushAllBatches() {
    LOG('BatchQueue', `Flushing ${batchQueue.size} pending batches...`);
    const webhooks = Array.from(batchQueue.keys());
    for (const webhook of webhooks) {
        sendBatch(webhook);
    }
}

/**
 * Flushes pending batches and waits until the Discord send queue is empty (bounded).
 * Used before an account switch so no notification from the old account is left queued. AC-CTRL-004
 * @returns {Promise<boolean>} True when the queue drained within timeoutMs.
 */
export async function drainDiscordQueue(timeoutMs = 15_000) {
    flushAllBatches();
    const deadline = Date.now() + timeoutMs;
    while (messageQueue.length > 0 || processingQueue) {
        if (Date.now() >= deadline) return false;
        await sleep(100);
    }
    return true;
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


/** An authentication failure: retrying the same request cannot fix it. */
function sessionError(message) {
  const err = new Error(message);
  err.sessionInvalid = true;
  return err;
}

/**
 * A secure fetch wrapper for Fallen Sword game URLs.
 * Handles authentication, retries, and session validation for both HTML and JSON API responses.
 */
export async function secureFetch(url, options = {}, retries = 3) {
  // Use the imported/global versions instead of redefining
  const base = new URL(FS_BASE || 'https://www.fallensword.com/');
  base.protocol = 'https:';
  base.hostname = 'www.fallensword.com';

  const finalUrl = (() => { 
    try { 
      return new URL(url, base).toString(); 
    } catch { 
      return String(url); 
    } 
  })();
  
  const isGameUrl = finalUrl.startsWith(base.toString());

  // REC-TASK-002: the legacy normalizeFsUrl call was removed. It was never defined in this
  // module (a swallowed ReferenceError) and its result was never used for the request.

  const f = isGameUrl ? authedFetch : globalThis.fetch;

  // Login guard (proactive check)
  if (isGameUrl && !options.__skipEnsureLogin) {
    try { 
      await ensureLogin(); 
    } catch (e) {
      console.warn('[GoGon] secureFetch: ensureLogin warning:', e?.message || e);
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
      // No trailing \b: the closing quote is followed by a space or '>', which is not a word boundary.
      return /\bid\s*=\s*["']hc-account-link["']/i.test(html);
    } catch {
      return false;
    }
  }

  /**
   * Detects a logged-out state by checking for the JSON error signature.
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

  // AC-AUTH-003: re-authenticate at most once per request. (A process-wide flag used to make
  // every logout after the first one fail permanently.)
  let didLoginAttempt = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const defaultHeaders = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'User-Agent': (getSetting('GG_UA') || DEFAULT_UA),
      };
      // AC-AUTH-005: game Origin/Referer headers (like the cookie jar) are sent to the game only.
      if (isGameUrl) {
        defaultHeaders['Origin'] = 'https://www.fallensword.com';
        defaultHeaders['Referer'] = LAST_GOOD_REFERER || 'https://www.fallensword.com/index.php?';
      }
      const opts = {
        method: 'POST',
        redirect: 'follow',
        cache: 'no-store',
        ...options,
        headers: { ...defaultHeaders, ...(options?.headers || {}) }
      };

      let res = await f(finalUrl, opts);

      if (isGameUrl && res.ok) {
        LAST_GOOD_REFERER = res.url || finalUrl;
      }

      // Check for logged-out state using BOTH HTML and JSON detectors.
      if (isGameUrl && res.ok && (await isLoginHtml(res) || await isLoginJson(res))) {
        console.warn('[GoGon] secureFetch: Login page detected at', res.url || finalUrl);

        if (!didLoginAttempt) {
          didLoginAttempt = true;
          try {
            await ensureLogin();
            res = await f(finalUrl, opts); // Retry the fetch after re-authenticating

            // Check again after retry. If it's still a login page, fail hard.
            if (await isLoginHtml(res) || await isLoginJson(res)) {
               throw sessionError('Session is still invalid after re-authentication.');
            }
            // Success!
            return res;
          } catch (e) {
            throw sessionError(e instanceof Error ? e.message : 'Failed to re-authenticate.');
          }
        } else {
          // Already tried to log in once, so fail immediately.
          throw sessionError('Session invalid/expired (login page detected).');
        }
      }

      if (res.ok) {
        return res;
      }

      // Handle non-OK responses (e.g., 500 server errors)
      const status = res.status || 0;
      if (status >= 500 && attempt < retries) {
        console.warn(`[GoGon] secureFetch: Server error ${status}, retry ${attempt + 1}/${retries}`);
        await sleep(RETRY_DELAY);
        continue;
      }

      return res;

    } catch (err) {
      if (attempt >= retries || err?.sessionInvalid) {
        throw err;
      }
      console.warn(`[GoGon] secureFetch: Error on attempt ${attempt + 1}, retrying...`, err?.message);
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error('secureFetch: Max retries exceeded');
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
    'user-agent': (getSetting('GG_UA') || DEFAULT_UA),
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': (getSetting('GG_LANG') || DEFAULT_LANG),
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
	const parsedAt = data.t;

    // If we're processing for a bounty, we transform the data.
    if (isBounty) {
      // Establish default values.
      let hasDeflect = false;
      let isCloaked = false;
      const numberOfBuffs = Array.isArray(buffsList) ? buffsList.length : 0;

      if (numberOfBuffs > 0) {
        for (const buff of buffsList) {
          const buffName = getBuffNameById(buff.id);
          if (buffName === 'Deflect') {
            hasDeflect = true;
          } else if (buffName === 'Cloak') {
            isCloaked = true;
          }
        }
      }
      return { hasDeflect, isCloaked, numberOfBuffs };
    }

    // If not for a bounty, return the raw buff list.
    return { buffsList, parsedAt };

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