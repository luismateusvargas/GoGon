// app_modules/core.js - GoGon Edition
import * as cheerio from 'cheerio';
import { getBooleanSetting, getSetting } from '../config/runtime.mjs';

// GG_DEBUG is a hot registry setting (CTRL-TASK-001): '0' silences LOG() on the next call.
export const isDebugEnabled = () => getBooleanSetting('GG_DEBUG');

export function ts() {
  const d = new Date();
  return d.toISOString().replace('T',' ').replace('Z','');
}
export function LOG(feature, msg, extra)  { if (!isDebugEnabled()) return; const base = `[${ts()}][${feature}] ${msg}`; extra!==undefined ? console.log(base, extra) : console.log(base); }
export function WARN(feature, msg, extra) { const base = `⚠️ [${ts()}][${feature}] ${msg}`; extra!==undefined ? console.warn(base, extra) : console.warn(base); }
export function ERR(feature, msg, extra)  { const base = `❌ [${ts()}][${feature}] ${msg}`; extra!==undefined ? console.error(base, extra) : console.error(base); }

export async function dumpHtml(feature, label, html) {
  try {
    const dir = getSetting('GG_DEBUG_DIR') || null;
    if (!dir) return;
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const fname = path.join(dir, `${Date.now()}-${feature}-${label}.html`);
    fs.writeFileSync(fname, html);
    WARN(feature, `Snapshot saved at ${fname} (len=${html?.length||0})`);
  } catch (e) {
    WARN(feature, `Failed dumpHtml`, e?.message || e);
  }
}
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Formats a Unix timestamp to a localized date string
 * Uses Brazilian Portuguese locale with London timezone (game standard)
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
export function formatGameTime(timestamp) {
    return new Date(timestamp * 1000).toLocaleString('pt-BR', { 
        timeZone: 'Europe/London' 
    });
}

/**
 * Formats remaining time from a future timestamp
 * @param {number} futureTimestamp - Future timestamp in milliseconds
 * @returns {string} Formatted time remaining (e.g., "6d 23h 59m")
 */
export function formatRemainingTime(futureTimestamp) {
    const now = Date.now();
    const remainingMs = futureTimestamp - now;

    if (remainingMs <= 0) {
        return "Expired";
    }

    let totalSeconds = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.length > 0 ? parts.join(' ') : "< 1m";
}

/**
 * Formats a duration in seconds to human-readable format
 * @param {number} totalSeconds - Duration in seconds
 * @returns {string} Formatted duration (e.g., "20h 16m 8s")
 */
export function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) {
        return "0s";
    }
    
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}


export async function waitForPCC(fetchFn, retries = 8) {
    if (retries <= 0) {
        WARN('page', '#pCC not found after multiple retries');
        return null;
    }

    try {
        const response = await fetchFn();
        if (!response || !response.ok) {
            await new Promise(res => setTimeout(res, 500));
            return waitForPCC(fetchFn, retries - 1);
        }

        const html = await response.text();
        const $ = cheerio.load(html); // Create the Cheerio object

        if ($('#pCC').length > 0) {
            LOG('page', `#pCC found (attempt ${9 - retries}/8)`);
            return $; // <<< FIX: Return the main Cheerio object
        }

        // If pCC is not found, wait and retry
        await new Promise(res => setTimeout(res, 400));
        return waitForPCC(fetchFn, retries - 1);

    } catch (e) {
        // Handle fetch errors and retry
        await new Promise(res => setTimeout(res, 500));
        return waitForPCC(fetchFn, retries - 1);
    }
}

export function ensurePCC(doc, html, feature = 'page') {
  try {
    const pCC = (doc && typeof doc.getElementById === 'function') ? doc.getElementById('pCC')
               : (doc && typeof doc.querySelector === 'function') ? doc.querySelector('#pCC')
               : null;
    if (!pCC) {
      WARN(feature, '#pCC ausente; abortando parse');
      if (html) dumpHtml(feature, 'no_pCC', html);
      return null;
    }
    return pCC;
  } catch (e) {
    ERR(feature, 'ensurePCC exception', e && (e.stack || e));
    if (html) dumpHtml(feature, 'ensurePCC_exc', html);
    return null;
  }
}

export function selectRowsResilient(pCC, feature = 'table-scan') {
  if (!pCC) return [];
  let rows = pCC.querySelectorAll('table > tbody > tr:nth-child(6) > td > table > tbody > tr');
  if (rows && rows.length) { LOG(feature, `selector A ok: ${rows.length} linhas`); return rows; }
  rows = pCC.querySelectorAll('table table table tr');
  if (rows && rows.length) { LOG(feature, `selector B ok: ${rows.length} linhas`); return rows; }
  rows = pCC.querySelectorAll('tr');
  LOG(feature, `selector C (wide): ${rows.length} linhas`);
  return rows;
}
