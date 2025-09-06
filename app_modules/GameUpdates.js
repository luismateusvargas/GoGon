// app_modules/GameUpdates.js (fix: dedupe por título normalizado + formatação emoji + links/imagens)
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, checkInfo, addLine, sendDiscordMessage } from '../utils.js';
import { newsWebhook } from '../webhooks.js';

function toDoc(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}
function cleanNode(node) {
  if (!node) return node;
  node.querySelectorAll('script, style').forEach(n => n.remove());
  return node;
}
function textify(node) {
  if (!node) return '';
  node.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return (node.textContent || '')
    .replace(/\u00A0/g,' ')
    .replace(/\s+\n/g,'\n')
    .replace(/[ \t]+/g,' ')
    .trim();
}
function normalizeTitle(title) {
  // remove contadores/prefixos numéricos do início, ex: "13 Rise of ..." -> "Rise of ..."
  return (title || '').replace(/^\s*\d+\s+/, '').trim();
}
function extractDateFromHead(head) {
  const dateEl = head.querySelector('.NEWS_DATE, i, .date, .news-date');
  const t = dateEl ? dateEl.textContent.trim() : '';
  if (t) return t;
  const htxt = (head.textContent || '').trim();
  const m = /(\d{1,2}:\d{2}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/.exec(htxt);
  return m ? m[1] : '';
}
function pickBody(head) {
  let sib = head?.nextElementSibling || null;
  while (sib && !sib.classList?.contains('news_body') && !sib.classList?.contains('news_body_tavern')) {
    sib = sib.nextElementSibling;
  }
  return sib || null;
}

export async function checkForUpdatesArchive() {
  const urls = [
    'https://www.fallensword.com/index.php?cmd=updatearchive&subcmd=view',
    'https://www.fallensword.com/index.php?cmd=updatearchive',
    'https://www.fallensword.com/index.php?cmd=news&subcmd=view',
    'https://www.fallensword.com/index.php?cmd=news',
  ];
  for (const url of urls) {
    try {
      const resp = await secureFetch(url);
      if (!resp || resp.status !== 200) continue;
      const html = await resp.text();
      const doc = toDoc(html);
      const pCC = ensurePCC(doc, html, 'checkForUpdatesArchive');
      if (!pCC) continue;
      cleanNode(pCC);

      const heads = Array.from(pCC.querySelectorAll('.news_head, .news_head_tavern'));
      if (!heads.length) continue;
      const head = heads[0];
      const body = pickBody(head);
      cleanNode(head);
      cleanNode(body);

      const h1 = head.querySelector('.news-heading');
      const h2 = head.querySelector('.news-subheading');
      const titleRaw = [h1?.textContent?.trim(), h2?.textContent?.trim()].filter(Boolean).join(' ') || textify(head);
      const title = titleRaw || 'Game Updates';
      const normTitle = normalizeTitle(title);
      const date = extractDateFromHead(head);
      const message = textify(body) || '';

      const imgElements = Array.from((body || head).querySelectorAll('img'));
      const aElements = Array.from((body || head).querySelectorAll('a'));
      const imgSrcs = imgElements.map(img => img.getAttribute('src') || img.src).filter(Boolean);
      const aHrefs = aElements.map(a => a.getAttribute('href') || a.href).filter(Boolean);

      // chave de dedupe: usa data + título *normalizado*
      const line = `${date} ${normTitle}`.trim();
      let shouldSend = true;
      try {
        shouldSend = !checkInfo(line, 'updatesData');
        if (shouldSend) addLine(line, 'updatesData');
      } catch {}

      if (!shouldSend) { LOG('news', `Duplicado ignorado: ${line}`); return; }

      // formatação solicitada
      let discordMessage = `
:envelope_with_arrow: Title: ${title}
:calendar: Date: ${date || '-'}
:page_facing_up: Message: ${message}
`.trim();

      if (imgSrcs.length > 0) {
        discordMessage += `\n\n:camera_with_flash: Images Links:\n` + imgSrcs.join('\n');
      }
      if (aHrefs.length > 0) {
        discordMessage += `\n\n:link: External Links:\n` + aHrefs.join('\n');
      }

      sendDiscordMessage(discordMessage, "Update Archive", "16711680", "New Content ?", "", newsWebhook);
      LOG('news', `Enviado: ${line}`);
      return;
    } catch (e) {
      ERR('news', 'Falha ao processar Updates', e);
    }
  }
}
