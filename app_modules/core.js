// app_modules/core.js
import * as cheerio from 'cheerio';
export const SWS_DEBUG = (typeof process !== 'undefined' && process?.env?.SWS_DEBUG) ? process.env.SWS_DEBUG : '1';

export function ts() {
  const d = new Date();
  return d.toISOString().replace('T',' ').replace('Z','');
}
export function LOG(feature, msg, extra)  { if (!SWS_DEBUG) return; const base = `[${ts()}][${feature}] ${msg}`; extra!==undefined ? console.log(base, extra) : console.log(base); }
export function WARN(feature, msg, extra) { const base = `⚠️ [${ts()}][${feature}] ${msg}`; extra!==undefined ? console.warn(base, extra) : console.warn(base); }
export function ERR(feature, msg, extra)  { const base = `❌ [${ts()}][${feature}] ${msg}`; extra!==undefined ? console.error(base, extra) : console.error(base); }

export async function dumpHtml(feature, label, html) {
  try {
    const dir = (typeof process !== 'undefined' && process?.env?.SWS_DEBUG_DIR) ? process.env.SWS_DEBUG_DIR : null;
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
