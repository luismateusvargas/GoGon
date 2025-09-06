// app_modules/Titans.js (filtro estrito de spawn + correções)
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, sendDiscordMessage, checkInfo, addLine } from '../utils.js';
import { TitanGroup, titanWebhook } from '../webhooks.js';

/**
 * Publica APENAS notícias reais de "Titan Spotted / Spawn" vindas de News/Archive.
 * - Ancorado em .news_head/.news_body e .news_head_tavern/.news_body_tavern
 * - Limpa <script>/<style>, converte <br> em \n
 * - Filtro **estrito** por verbos de aparição (inclui "has been spotted")
 * - Deduplicação persistente (GM_* via utils.js) usando storageKey 'titanData'
 * - Só encerra quando pelo menos UM envio ocorreu; caso contrário, tenta próximas URLs
 *
 * Requer no escopo: TitanGroup, titanWebhook
 */

export async function checkForTitanNotifications() {
  const urls = [
    'https://www.fallensword.com/index.php?cmd=updatearchive&subcmd=view'
  ];

  // Aceita títulos "Titan Spotted/Spawned..." e corpos com "titan ... spotted" (ou invertido)
  const HEAD_SPAWN = /titan\s+(spotted|spawn(?:ed|s)?|sighted|seen|appeared|emerged|roaming)/i;
  const BODY_SPAWN = /(titan[^\\n]{0,80}(?:has\\s+been\\s+)?(spotted|spawn(?:ed|s)?|sighted|seen|appeared|emerged|roaming))|((spotted|spawn(?:ed|s)?|sighted|seen|appeared|emerged|roaming)[^\\n]{0,80}titan)/i;
  // Bloqueios comuns de notícias que NÃO são spawn
  const ANTI_NOISE = /(ladder|reset|patch|update|auction|season|sale|discount|offer|arena|bounty|super\\s*elite|double composing|bug\\s*fix)/i;

  // helpers
  function toDoc(html) {
    try {
      const parser = new DOMParser();
      return parser.parseFromString(html, 'text/html');
    } catch (e) {
      ERR('[Titans] DOMParser indisponível:', e?.message || e);
      return null;
    }
  }

  function cleanToText(node) {
    if (!node) return '';
    node.querySelectorAll('script, style').forEach(n => n.remove());
    node.querySelectorAll('br').forEach(br => br.replaceWith('\\n'));
    return (node.textContent || '')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\u00A0/g, ' ')
      .split('\\n')
      .map(s => s.replace(/\\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\\n');
  }

  function bodyFromHead(head) {
    let sib = head?.nextElementSibling || null;
    while (sib && !sib.classList?.contains('news_body') && !sib.classList?.contains('news_body_tavern')) {
      sib = sib.nextElementSibling;
    }
    return sib || null;
  }

  function extractSpawnLines(text) {
    if (!text) return [];
    const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
    const hits = lines.filter(l => BODY_SPAWN.test(l));
    if (!hits.length) return [];
    // Complementa com a linha seguinte (geralmente localização)
    const idxs = hits.map(h => lines.indexOf(h)).filter(i => i >= 0);
    const out = new Set();
    for (const i of idxs) {
      out.add(lines[i]);
      if (lines[i + 1]) out.add(lines[i + 1]);
    }
    return Array.from(out);
  }

  let sentAny = false;

  for (const url of urls) {
    try {
      const resp = await secureFetch(url);
      if (!resp || resp.status !== 200) {
        WARN(`[Titans] HTTP ${resp?.status} em ${url}`);
        continue;
      }
      const html = await resp.text();
      const doc = toDoc(html);
      if (!doc) continue;

      const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForTitanNotifications');
      if (!pCC) {
        WARN(`[Titans] #pCC não encontrado em ${url}`);
        continue;
      }

      const heads = Array.from(pCC.querySelectorAll('.news_head, .news_head_tavern'));
      if (!heads.length) {
        WARN(`[Titans] Nenhuma .news_head encontrada em ${url}`);
        continue;
      }

      for (const head of heads) {
        const h1 = head.querySelector('h1');
        const titleText = (h1?.textContent || '').trim();
        const headText = cleanToText(head);
        const body = bodyFromHead(head);
        const bodyText = cleanToText(body);

        // Descarta ruído óbvio (mas só se também não combinar com spawn)
        const fullText = [titleText, headText, bodyText].filter(Boolean).join('\\n');
        const looksLikeSpawn = HEAD_SPAWN.test(titleText) || BODY_SPAWN.test(fullText);

        if (!looksLikeSpawn) continue;
        if (ANTI_NOISE.test(fullText) && !HEAD_SPAWN.test(titleText)) continue;

        // Capta linhas fortes do corpo; se vazio, usa o título mesmo
        let spawnLines = extractSpawnLines(bodyText);
        if (!spawnLines.length && HEAD_SPAWN.test(titleText)) {
          // tenta captar a linha do body que contém o nome do Titan ou a frase "has been spotted"
          const nameLine = (bodyText.split('\\n').find(l => /titan/i.test(l) && /spott|spawn|sight|appear|emerg|roam/i.test(l)) || titleText).trim();
          spawnLines = [nameLine];
        }
        if (!spawnLines.length) continue;

        const dateEl = head.querySelector('i, .NEWS_DATE') || body?.querySelector('.NEWS_DATE');
        const when = (dateEl?.textContent || '').trim();

        const titanInfo = spawnLines.join('\\n');
        const key = `${titleText} :: ${when}`;

        let shouldSend = true;
        try {
          shouldSend = !checkInfo(key, 'titanData');
          if (shouldSend) addLine(key, 'titanData');
        } catch (e) {
          // se storage falhar, ainda tentamos enviar uma vez
          WARN('[Titans] Falha ao acessar storage para dedupe:', e?.message || e);
        }

        if (!shouldSend) continue;

        const message = `New Titan Spotted:
${titanInfo}
${when}`.trim();

        sendDiscordMessage(
          message,
          'Titan Spawn',
          '21247',
          "Don't forget TP and TD!",
          TitanGroup,
          titanWebhook
        );
        LOG('[Titans] Notificação de spawn enviada.');
        sentAny = true;
      }

      if (sentAny) return; // encerra se pelo menos uma notificação foi enviada nesta URL
      // senão, tenta a próxima URL
    } catch (e) {
      ERR(`[Titans] Falha ao processar ${url}`, e);
    }
  }

  if (!sentAny) WARN('[Titans] Nenhuma notícia de Titan Spotted encontrada nas URLs testadas.');
}
