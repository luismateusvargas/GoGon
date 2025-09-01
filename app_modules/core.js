// app_modules/core.js
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
    WARN(feature, `Snapshot salvo em ${fname} (len=${html?.length||0})`);
  } catch (e) {
    WARN(feature, `Falhou dumpHtml`, e?.message || e);
  }
}
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function waitForPCC(fetchFn, url, { tries = 8, delay = 800, feature = 'page', logHtmlOnFail = true } = {}) {
  let lastHtml = '';
  for (let i = 1; i <= tries; i++) {
    const res  = await fetchFn(url);
    const html = await res.text();
    lastHtml   = html;
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const pCC  = doc.getElementById('pCC');
    if (pCC) { LOG(feature, `#pCC encontrado (tentativa ${i}/${tries})`); return { doc, pCC, html }; }
    WARN(feature, `#pCC não encontrado (tentativa ${i}/${tries}), aguardando ${delay}ms...`, { url, htmlLen: html.length });
    await sleep(delay);
  }
  ERR(feature, `Falha ao localizar #pCC após ${tries} tentativas`, { url, lastHtmlLen: lastHtml.length });
  if (logHtmlOnFail) dumpHtml(feature, 'no_pCC', lastHtml);
  const doc = new DOMParser().parseFromString(lastHtml || '<html></html>', 'text/html');
  return { doc, pCC: null, html: lastHtml };
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
  LOG(feature, `selector C (amplo): ${rows.length} linhas`);
  return rows;
}
