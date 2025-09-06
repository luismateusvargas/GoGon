// app_modules/Shoutbox.js (fix: busca em .news_shoutbox, 1 mensagem por shout, dedupe persistente)
import { LOG, WARN, ERR } from './core.js';
import { secureFetch, checkInfo, addLine, sendDiscordMessage } from '../utils.js';
import { shoutboxWebhook } from '../webhooks.js';

const SHOUT_SOURCE_URL = 'https://www.fallensword.com/index.php?cmd=news&subcmd=view';
const TIME_RE = /\b\d{1,2}:\d{2}\s+\d{2}\/[A-Za-z]{3}\/\d{4}\b/;

function toDoc(html) {
  // Usa DOMParser quando disponível; fallback usando createHTMLDocument.
  if (typeof DOMParser !== 'undefined') {
    try { return new DOMParser().parseFromString(html, 'text/html'); } catch {}
  }
  if (typeof document !== 'undefined' && document.implementation?.createHTMLDocument) {
    const doc = document.implementation.createHTMLDocument('');
    doc.documentElement.innerHTML = html;
    return doc;
  }
  throw new Error('Ambiente sem DOMParser/document para parsear HTML.');
}

function normTxt(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function getTxt(el) {
  if (!el) return '';
  el.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return normTxt(el.textContent || '');
}

function findShoutboxRoot(doc) {
  // 1) alvo principal (coluna direita do News)
  let root = doc.querySelector('.news_shoutbox');
  if (root) return root;
  // 2) fallbacks
  root = doc.querySelector('#pCR .news_shoutbox, .news_right_column .news_shoutbox');
  if (root) return root;
  // 3) fallback por heading "Shoutbox"
  const h1 = Array.from(doc.querySelectorAll('h1, h2, .news-heading')).find(h => /shoutbox/i.test(h.textContent || ''));
  if (h1) {
    const cand = h1.closest('div');
    if (cand && cand.querySelector('.shout')) return cand;
  }
  return null;
}

function parseShout(shoutEl) {
  // Estrutura típica:
  // <div class="shout">
  //   <div class="shout_head">
  //     <div class="shout_head_left"><a>WHO</a></div>
  //     <div class="shout_head_right">13:31 04/Sep/2025</div>
  //   </div>
  //   <div class="shout_body">MSG...</div>
  // </div>
  const head = shoutEl.querySelector('.shout_head');
  const who = getTxt(head?.querySelector('.shout_head_left a, .shout_head_left'));
  const when = getTxt(head?.querySelector('.shout_head_right'));
  const msg = getTxt(shoutEl.querySelector('.shout_body'));
  if (!when || !TIME_RE.test(when) || !msg) return null;
  const key = `${when} :: ${who} :: ${msg.slice(0,120)}`.trim();
  return { who, when, msg, key };
}

export async function checkForShoutbox() {
  try {
    const resp = await secureFetch(SHOUT_SOURCE_URL);
    if (!resp || resp.status !== 200) { WARN('shout', `HTTP ${resp?.status ?? '??'}`); return; }
    const html = await resp.text();
    const doc = toDoc(html);

    const root = findShoutboxRoot(doc);
    if (!root) { WARN('shout', 'Shoutbox not found in news page.'); return; }

    const shouts = Array.from(root.querySelectorAll('.shout'));
    if (!shouts.length) { WARN('shout', 'No .shout found.'); return; }

    const seenRun = new Set();
    for (const el of shouts.slice(0, 20)) { // limita às 20 mais recentes
      const item = parseShout(el);
      if (!item) continue;
      const { who, when, msg, key } = item;

      if (seenRun.has(key)) continue;
      seenRun.add(key);

      let isNew = true;
      try {
        isNew = !checkInfo(key, 'shoutboxData');
        if (isNew) addLine(key, 'shoutboxData');
      } catch {}

      if (!isNew) continue;

      const content = `**Shoutbox**\n${when ? `[${when}] ` : ''}${who ? `${who}: ` : ''}${msg}`.trim();
      sendDiscordMessage(content, 'Shoutbox', '10494192', 'Report it!', '', shoutboxWebhook);
      LOG('shout', `Sent: ${key}`);
    }
  } catch (e) {
    ERR('shout', 'checkForShoutbox failed', e);
  }
}
