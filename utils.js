// utils.js - GoGon Utility Functions
import {
    DELAY_BETWEEN_MESSAGES, RETRY_DELAY, DISCORD_REQUEST_TIMEOUT, DISCORD_MAX_ATTEMPTS,
    DISCORD_MAX_RATE_LIMITS, DISCORD_RATE_LIMIT_FALLBACK, DISCORD_MAX_RETRY_AFTER,
} from './webhooks.js';
import { LOG, WARN, ERR } from './app_modules/core.js';
import { incrementMetric } from './app_modules/metricsStore.js';
import { getBuffNameById } from './game_modules/buffParser.js';
import { apiEndpoints } from './game_modules/API.js';
import * as cheerio from 'cheerio';

// Session management imports
import { FS_BASE, authedFetch, ensureLogin, isLoggedIn, DEFAULT_UA, DEFAULT_LANG } from './session.mjs';
import { getSetting } from './config/runtime.mjs';
import { getAccountScope } from './config/accountScope.mjs';
import { extraDiscordPayload, noDropDiscordPayload, basicDiscordPayload } from './app_modules/discordPayload.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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

const messageQueue = []; // { webhook, payload, attempts, rateLimits, notBefore, queuedAt, accountScope, settle[] }
let processingQueue = false;
let lastPostAt = -Infinity; // start of the latest webhook POST; enforces DELAY_BETWEEN_MESSAGES
let globalBlockedUntil = 0; // set by a 429 with global: true
let wakeDispatcher = null;  // resolves the dispatcher's current wait when new work arrives
// Delivery progress (specs/tasks/2026-10-notification-progress-health.md): times in ms, failure as a category only.
const progress = { attemptStartedAt: null, lastAttemptAt: null, lastSuccessAt: null, lastFailure: null };

// v1.8.0: Batch queue for combining multiple messages
const batchQueue = new Map(); // batch key -> { webhook, accountScope, messages: [], settle: [], timeout: null, totalChars: 0 }
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
 * @param {object} [meta] - Outbox delivery (specs/tasks/2026-10-notification-outbox.md):
 * @param {string} [meta.accountScope] - Only sent while this account is active; otherwise released unsent.
 * @param {(outcome: { ok: boolean, held?: boolean, error?: Error, batchSize?: number }) => void} [meta.onSettled]
 *   Called once with the final outcome: Discord accepted it, it was dropped after bounded retries, or it was held.
 * @param {boolean} [meta.solo] - Send as its own Discord message, never merged into a batch.
 */
export function queueDiscordMessage(webhook, payload, meta = {}) {
    const { accountScope, onSettled, solo = false } = meta;
    if (solo) {
        enqueueSend({ webhook, payload, accountScope, settle: onSettled ? [onSettled] : [] });
        return;
    }
    const key = batchKey(webhook, accountScope);
    // Get or create batch for this webhook and account
    if (!batchQueue.has(key)) {
        batchQueue.set(key, {
            webhook,
            accountScope,
            messages: [],
            settle: [],
            timeout: null,
            totalChars: 0
        });
    }

    const batch = batchQueue.get(key);
    
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
        sendBatch(key);
        
        // Re-get new (empty) batch
        return queueDiscordMessage(webhook, payload, meta);
    }
    
    // Add message to batch
    batch.messages.push(payload);
    if (onSettled) batch.settle.push(onSettled);
    batch.totalChars += msgSize;

    // Clear existing timeout
    if (batch.timeout) {
        clearTimeout(batch.timeout);
        batch.timeout = null;
    }

    // If batch is full (count limit), send immediately
    if (batch.messages.length >= BATCH_SIZE) {
        sendBatch(key);
    } else {
        // Schedule batch send after idle timeout
        batch.timeout = setTimeout(() => {
            sendBatch(key);
        }, BATCH_IDLE_TIMEOUT);
    }
}

/** Batches never mix accounts, so a batch is released or sent as a whole. */
function batchKey(webhook, accountScope) {
    return accountScope === undefined ? webhook : `${accountScope}\u0000${webhook}`;
}

/** Adds one Discord message to the send queue and starts or wakes the dispatcher. */
function enqueueSend({ webhook, payload, accountScope, settle }) {
    messageQueue.push({ webhook, payload, attempts: 0, rateLimits: 0, notBefore: 0, queuedAt: Date.now(), accountScope, settle });

    // Start processing, or wake a dispatcher that is waiting on a retry delay
    if (!processingQueue) {
        processQueue();
    } else if (wakeDispatcher) {
        wakeDispatcher();
    }
}

/**
 * Sends a batch of messages for a specific webhook.
 * Merges multiple payloads into a single Discord message with multiple embeds.
 * @param {string} key - The batch key (see batchKey).
 */
function sendBatch(key) {
    if (!batchQueue.has(key)) return;

    const batch = batchQueue.get(key);
    
    // Clear timeout
    if (batch.timeout) {
        clearTimeout(batch.timeout);
        batch.timeout = null;
    }

    // Nothing to send
    if (batch.messages.length === 0) {
        batchQueue.delete(key);
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

    // Clear this batch
    batchQueue.delete(key);
    if (batch.messages.length > 1) {
        incrementMetric('discordBatches');
        incrementMetric('discordMessagesSaved', batch.messages.length - 1);
    }

    // Add to processing queue
    enqueueSend({ webhook: batch.webhook, payload: mergedPayload, accountScope: batch.accountScope, settle: batch.settle });
}

/**
 * Flushes all pending batches immediately.
 * Useful for graceful shutdown or manual triggering.
 */
export function flushAllBatches() {
    LOG('BatchQueue', `Flushing ${batchQueue.size} pending batches...`);
    for (const key of Array.from(batchQueue.keys())) {
        sendBatch(key);
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



/** A non-secret label for a webhook URL, safe to log. */
function destinationKey(url) {
    return `hook#${createHash('sha256').update(String(url)).digest('hex').slice(0, 8)}`;
}

/** Waits up to ms, returning early when new work is queued. */
function dispatcherWait(ms) {
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); wakeDispatcher = null; resolve(); };
        const timer = setTimeout(done, ms);
        wakeDispatcher = done;
    });
}

/**
 * The eligible item that was queued first. Only the oldest pending item of each webhook is a candidate,
 * so a delayed item keeps later items for the same webhook behind it. notBefore is only an eligibility
 * gate: a retried item keeps its queue position, so fresh traffic for other webhooks cannot starve it.
 */
function nextEligibleItem(now) {
    const seen = new Set();
    for (const item of messageQueue) {
        if (seen.has(item.webhook)) continue;
        seen.add(item.webhook);
        if (item.notBefore <= now) return item;
    }
    return null;
}

function removeItem(item) {
    const i = messageQueue.indexOf(item);
    if (i !== -1) messageQueue.splice(i, 1);
}

/** Reports an item's final outcome to its outbox callbacks; a callback error never stops the queue. */
function settleItem(item, outcome) {
    for (const fn of item.settle || []) {
        try {
            Promise.resolve(fn({ ...outcome, batchSize: item.settle.length })).catch(err => ERR('DiscordQueue', 'Delivery outcome handler failed', err));
        } catch (err) {
            ERR('DiscordQueue', 'Delivery outcome handler failed', err);
        }
    }
}

/**
 * Releases queued items that belong to an account other than the active one, unsent: an alert is
 * never posted while a different account (or none) is active. Their outbox rows stay pending.
 */
function releaseForeignItems() {
    const active = getAccountScope();
    for (const item of messageQueue.filter(i => i.accountScope !== undefined && i.accountScope !== active)) {
        removeItem(item);
        settleItem(item, { ok: false, held: true });
    }
}

/** Applies a failed attempt to a queued item: schedules a bounded retry or drops it with an explicit outcome. */
function handleQueueFailure(item, err, now) {
    const dest = destinationKey(item.webhook);
    const category = err?.category || 'unexpected';
    const status = err?.status ? ` (HTTP ${err.status})` : '';
    progress.lastFailure = { category, ...(err?.status ? { status: err.status } : {}), at: now };
    incrementMetric('discordErrors');
    if (category === 'timeout') incrementMetric('discordTimeouts');
    if (category === 'rate_limit') {
        incrementMetric('discordRateLimits');
        item.rateLimits++;
        if (item.rateLimits <= DISCORD_MAX_RATE_LIMITS) {
            item.notBefore = now + err.retryAfter;
            if (err.global) globalBlockedUntil = item.notBefore;
            WARN('DiscordQueue', `Rate limited on ${dest} (${item.rateLimits}/${DISCORD_MAX_RATE_LIMITS}). Retrying in ${err.retryAfter}ms.`);
            return;
        }
    } else {
        item.attempts++;
        if (err?.retryable && item.attempts < DISCORD_MAX_ATTEMPTS) {
            incrementMetric('discordRetries');
            item.notBefore = now + RETRY_DELAY;
            WARN('DiscordQueue', `Send to ${dest} failed: ${category}${status}, attempt ${item.attempts}/${DISCORD_MAX_ATTEMPTS}. Retrying in ${RETRY_DELAY}ms.`);
            return;
        }
    }
    removeItem(item);
    incrementMetric('discordDropped');
    ERR('DiscordQueue', `Dropped message for ${dest}: ${category}${status} after ${item.attempts + item.rateLimits} attempt(s), ${item.rateLimits} rate limited.`);
    settleItem(item, { ok: false, error: err });
}

/**
 * Processes the message queue, sending messages to Discord one at a time.
 * Every POST starts at least DELAY_BETWEEN_MESSAGES after the previous one. A rate-limited or failed
 * item waits for its own retry time while items for other webhooks keep moving.
 */
export async function processQueue() {
    if (processingQueue) return;
    processingQueue = true;
    try {
        while (messageQueue.length > 0) {
            releaseForeignItems();
            if (messageQueue.length === 0) break;
            const now = Date.now();
            const item = now >= globalBlockedUntil ? nextEligibleItem(now) : null;
            if (!item) {
                const readyAt = Math.max(globalBlockedUntil, Math.min(...messageQueue.map(i => i.notBefore)));
                await dispatcherWait(Math.min(Math.max(readyAt - now, 1), DISCORD_MAX_RETRY_AFTER));
                continue;
            }
            const gapWait = Math.min(lastPostAt + DELAY_BETWEEN_MESSAGES - now, DELAY_BETWEEN_MESSAGES);
            if (gapWait > 0) {
                await dispatcherWait(gapWait);
                continue;
            }
            lastPostAt = now;
            progress.attemptStartedAt = now;
            try {
                await securePostDiscord(item.webhook, item.payload, { retries: 1 });
                progress.lastAttemptAt = progress.lastSuccessAt = Date.now();
                incrementMetric('discordSent');
                removeItem(item);
                settleItem(item, { ok: true });
            } catch (err) {
                progress.lastAttemptAt = Date.now();
                handleQueueFailure(item, err, progress.lastAttemptAt);
            } finally {
                progress.attemptStartedAt = null;
            }
        }
    } finally {
        processingQueue = false;
    }
}


/**
 * Read-only view of the send queue for delivery health. Contains counts, times (ms since epoch) and a
 * failure category; never a webhook URL or payload.
 * dueSince is the earliest time a queued message became eligible to send (ignoring the two-second
 * spacing); messages still waiting for a 429 or retry delay, or still in a batch window, are not due.
 */
export function getDiscordQueueProgress(now = Date.now()) {
    let dueSince = null;
    for (const item of messageQueue) {
        if (item.notBefore > now) continue;
        const since = Math.max(item.queuedAt, item.notBefore);
        if (dueSince === null || since < dueSince) dueSince = since;
    }
    let batched = 0;
    for (const batch of batchQueue.values()) batched += batch.messages.length;
    return {
        queued: messageQueue.length,
        batched,
        dueSince,
        attemptStartedAt: progress.attemptStartedAt,
        lastAttemptAt: progress.lastAttemptAt,
        lastSuccessAt: progress.lastSuccessAt,
        lastFailure: progress.lastFailure ? { ...progress.lastFailure } : null,
    };
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

/** Error from a Discord webhook request. Messages carry no URL, payload, or response body. */
class DiscordDeliveryError extends Error {
    constructor(category, { status, retryAfter, global, code, method } = {}) {
        super(`Discord ${method || 'request'} failed: ${category}${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'DiscordDeliveryError';
        this.category = category; // timeout | network | server | rate_limit | client
        this.retryable = category === 'timeout' || category === 'network' || category === 'server';
        if (status) this.status = status;
        if (retryAfter !== undefined) this.retryAfter = retryAfter;
        if (global) this.global = true;
        if (code) this.code = code;
    }
}

/** Converts a 429 body/header into a bounded pause in ms; malformed values use the fallback. */
function rateLimitDelay(body, headerValue) {
    const raw = body?.retry_after ?? headerValue;
    const seconds = (raw == null || raw === '' || typeof raw === 'object') ? NaN : Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return DISCORD_RATE_LIMIT_FALLBACK;
    return Math.min(Math.round(seconds * 1000) + 500, DISCORD_MAX_RETRY_AFTER); // Add buffer
}

/** One request with a deadline covering both the response headers and the body read. */
async function discordRequestOnce(url, init) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new DiscordDeliveryError('timeout', { method: init.method }));
        }, DISCORD_REQUEST_TIMEOUT);
    });
    const request = (async () => {
        const res = await discordFetch(url, { ...init, signal: controller.signal });
        const text = await res.text();
        return { res, text };
    })();
    request.catch(() => {}); // a late rejection after the deadline must not go unhandled
    try {
        return await Promise.race([request, deadline]);
    } catch (err) {
        if (err instanceof DiscordDeliveryError) throw err;
        throw new DiscordDeliveryError('network', { method: init.method, code: /^[A-Z_]+$/.test(err?.code || '') ? err.code : undefined });
    } finally {
        clearTimeout(timer);
    }
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Sends one Discord webhook request with a deadline and bounded retries for timeouts, network errors and 5xx.
 * 429 and other 4xx are thrown immediately. Resolves to a response-like { ok, status, headers, text(), json() }.
 */
export async function securePostDiscord(url, payload, opts = {}) {
    const { retries = DISCORD_MAX_ATTEMPTS, method = 'POST' } = opts;
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'SWS-Bot/1.0 (+https://www.fallensword.com)'
    };
    const attempts = Math.max(1, retries);

    for (let attempt = 1; ; attempt++) {
        let error;
        try {
            const { res, text } = await discordRequestOnce(url, { method, headers, body: JSON.stringify(payload) });
            if (res.ok) {
                return { ok: true, status: res.status, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) };
            }
            if (res.status === 429) { // Rate limited: the caller decides when to retry
                const body = parseJson(text);
                throw new DiscordDeliveryError('rate_limit', {
                    method, status: 429, global: body?.global === true,
                    retryAfter: rateLimitDelay(body, res.headers?.get?.('retry-after')),
                });
            }
            const code = parseJson(text)?.code;
            error = new DiscordDeliveryError(res.status >= 500 ? 'server' : 'client', {
                method, status: res.status, code: Number.isInteger(code) ? code : undefined,
            });
        } catch (err) {
            error = err;
        }
        if (!error.retryable || attempt >= attempts) throw error;
        WARN('Discord', `${error.message}. Retrying in ${RETRY_DELAY}ms (attempt ${attempt}/${attempts})...`);
        await sleep(RETRY_DELAY);
    }
}

export function sendDiscordMessage(message, wTitle, colorCode, footerText, group, webhook) {
  queueDiscordMessage(webhook, basicDiscordPayload(message, wTitle, colorCode, footerText, group));
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
  queueDiscordMessage(webhook, extraDiscordPayload(message, wTitle, colorCode, footerText, group, thumbUrl, thumb));
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
  queueDiscordMessage(webhook, noDropDiscordPayload(message, wTitle, colorCode, footerText, group, thumbUrl));
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