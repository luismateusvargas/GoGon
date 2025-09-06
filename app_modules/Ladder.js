// app_modules/Ladder.js (detecção de reset da PvP Ladder via News Archive)
// - Procura por entradas com <span class="NEWS_SUBJECT"><b>PvP Ladder</b></span>
// - Extrai a data de <span class="NEWS_DATE">Posted: ...</span> do mesmo <tr>
// - Dedupe persistente (GM_): evita repetição entre execuções
// - Envia uma única notificação formatada ao Discord
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, checkInfo, addLine, sendDiscordMessage } from '../utils.js';
import { ladderWebhook, LadderGroup } from '../webhooks.js';

const NEWS_URLS = [
  'https://www.fallensword.com/index.php?cmd=news&subcmd=viewarchive',
  'https://www.fallensword.com/index.php?cmd=news&subcmd=view',
  'https://www.fallensword.com/index.php?cmd=news',
];

function toDoc(html) {
  if (typeof DOMParser !== 'undefined') {
    try { return new DOMParser().parseFromString(html, 'text/html'); } catch {}
  }
  if (typeof document !== 'undefined' && document.implementation?.createHTMLDocument) {
    const doc = document.implementation.createHTMLDocument('');
    doc.documentElement.innerHTML = html;
    return doc;
  }
  throw new Error('Ambiente sem DOMParser/document.');
}

function normTxt(s) {
  return (s || '').replace(/\r/g,'').replace(/\u00A0/g,' ').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').trim();
}
function getTxt(el) {
  if (!el) return '';
  el.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return normTxt(el.textContent || '');
}

function findPvPLadderRows(pCC) {
  // Procura todos os SUBJECTs e filtra os que tenham "PvP Ladder" (case-insensitive)
  const subjects = Array.from(pCC.querySelectorAll('span.NEWS_SUBJECT b'));
  const hits = [];
  for (const b of subjects) {
    const title = getTxt(b);
    if (!/pvp\s*ladder/i.test(title)) continue;
    const row = b.closest('tr');
    if (!row) continue;
    const dateEl = row.querySelector('.NEWS_DATE');
    const posted = getTxt(dateEl);
    // Conteúdo (body) geralmente no próximo <tr> com td[colspan="2"]
    let body = '';
    let sib = row.nextElementSibling;
    if (sib && sib.querySelector('td[colspan="2"]')) {
      body = getTxt(sib.querySelector('td[colspan="2"]'));
    }
    hits.push({ row, title, posted, body });
  }
  return hits;
}

function trimFirstSentence(s) {
  if (!s) return '';
  const idx = s.indexOf('.');
  return idx >= 0 ? s.slice(0, idx + 1).trim() : s.trim();
}

export async function checkLadderReset() {
  for (const url of NEWS_URLS) {
    try {
      const resp = await secureFetch(url);
      if (!resp || resp.status !== 200) { WARN('ladder', `HTTP ${resp?.status ?? '??'} em ${url}`); continue; }
      const html = await resp.text();
      const doc = toDoc(html);
      const pCC = ensurePCC(doc, html, 'checkLadderReset');
      if (!pCC) { WARN('ladder', 'pCC não encontrado.'); continue; }

      // Varre a página e pega o(s) blocos "PvP Ladder"
      const items = findPvPLadderRows(pCC);
      if (!items.length) { LOG('ladder', `Nenhum bloco "PvP Ladder" em ${url}`); continue; }

      // Processa o mais recente primeiro
      for (const item of items.slice(0, 3)) {
        const title = item.title || 'PvP Ladder';
        const dateTxt = item.posted || '';
        const messageBody = trimFirstSentence(item.body);

        // chave de dedupe: data + título normalizado
        const normTitle = title.replace(/^\s*\d+\s+/,'').trim();
        const key = `${dateTxt} ${normTitle}`.trim();

        let isNew = true;
        try {
          isNew = !checkInfo(key, 'ladderResets');
          if (isNew) addLine(key, 'ladderResets');
        } catch {}

        if (!isNew) { LOG('ladder', `Duplicado ignorado: ${key}`); continue; }

        let content = `
:crossed_swords: **PvP Ladder Reset**
:calendar: ${dateTxt || '-'}
`;
        if (messageBody) {
          content += `\n:page_facing_up: ${messageBody}`;
        }

        // Envia
        sendDiscordMessage(
          content.trim(),
          'PvP Ladder',
          '16711680',
          'Dominating!',
          LadderGroup,
          ladderWebhook
        );
        LOG('ladder', `Notificado: ${key}`);
        return; // apenas um por execução
      }
    } catch (e) {
      ERR('ladder', 'Falha ao processar Ladder', e);
    }
  }
}
