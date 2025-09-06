// app_modules/GuildConflicts.js (robust)
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, sendDiscordMessage, checkInfo, addLine, getContent, setContent } from '../utils.js';
import { CONFLICT_WEBHOOK } from '../webhooks.js';

const CONFLICTS_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=conflicts';

/**
 * Monitor de conflitos/ataques de guilda.
 * - Robusto a mudanças de layout: sem nth-child, tudo por conteúdo.
 * - Deduplicação persistente (GM_* via utils): evita mensagens repetidas.
 * - Notifica mudanças em "Incoming Attacks" por conflito.
 */
export async function monitorIncomingAttacks() {
  try {
    const resp = await secureFetch(CONFLICTS_URL);
    if (!resp || !resp.ok) {
      WARN(`[GuildConflicts] Falha ao carregar página de conflitos: HTTP ${resp ? resp.status : '??'}`);
      return;
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const pCC = ensurePCC(doc, html, 'monitorIncomingAttacks');
    if (!pCC) return;

    // Remover <script>/<style> para evitar lixo textual
    pCC.querySelectorAll('script, style').forEach(n => n.remove());

    // 1) Detectar mudanças de "Incoming Attacks" por linha (quando a página lista por guilda)
    // Estratégia: procurar TRs com "Incoming Attacks" no texto e extrair guild e contagem.
    const conflictRows = Array.from(pCC.querySelectorAll('tr')).filter(tr => {
      const txt = (tr.textContent || '').toLowerCase();
      return txt.includes('incoming attacks');
    });

    // Carrega estado persistido (JSON) de contagens por guilda
    const INCOMING_KEY = 'guildIncomingCounts';
    let incomingState = {};
    try { incomingState = JSON.parse(getContent(INCOMING_KEY) || '{}') || {}; } catch {}

    for (const tr of conflictRows) {
      const txt = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;

      // Extrai o nome da guilda (primeiro link da linha, fallback para início do texto)
      let targetGuild = '';
      const a = tr.querySelector('a');
      if (a && a.textContent) targetGuild = a.textContent.trim();
      if (!targetGuild) {
        // fallback: tenta até os 40 primeiros chars antes de "Incoming Attacks"
        const i = txt.toLowerCase().indexOf('incoming attacks');
        targetGuild = i > 0 ? txt.slice(0, Math.min(i, 40)).trim() : 'Unknown Guild';
      }

      // Extrai a contagem "Incoming Attacks: N"
      let incomingAtks = null;
      const m = /incoming attacks[:\s]*([0-9]+)/i.exec(txt);
      if (m) incomingAtks = parseInt(m[1], 10);
      if (incomingAtks == null || Number.isNaN(incomingAtks)) continue;

      const prev = (incomingState[targetGuild] ?? null);
      if (prev === null || prev !== incomingAtks) {
        // Notificar mudança
        const msg = `Incoming Attacks changed for conflict '${targetGuild}': ${incomingAtks}`;
        try {
          sendDiscordMessage(
            msg,
            'Incoming Attack Update',
            16776960,           // amarelo
            new Date().toISOString(),
            '**CONFLICT UPDATE**',
            CONFLICT_WEBHOOK    // variável já existente no seu projeto
          );
        } catch (e) {
          ERR('[GuildConflicts] Falha ao enviar Incoming Attacks', e);
        }
        incomingState[targetGuild] = incomingAtks;
      }
    }

    // Persiste o estado de incoming
    try { setContent(INCOMING_KEY, JSON.stringify(incomingState)); } catch {}

    // 2) Ler feed de mensagens/textos de conflito dentro do #pCC (robusto: qualquer TR com 3+ TDs)
    const allRows = Array.from(pCC.querySelectorAll('tr'));
    const rows = allRows.filter(tr => tr.querySelectorAll(':scope > td').length >= 3);

    // Padrões relevantes (case-insensitive)
    const patt = [
      /has just initiated a conflict with/i,
      /your conflict with/i,
      /^to arms!/i,
      /incoming attacks/i,
      /defend/i,
      /attack/i,
      /conflict/i,
    ];

    function looksRelevant(msg) {
      const low = (msg || '').toLowerCase();
      return patt.some(re => re.test(low));
    }

    // Função de parse de timestamp tolerante
    function parseGuildTimestamp(raw) {
      const s = (raw || '').trim();
      if (!s) return null;
      // Tenta padrões comuns:
      // 1) DD/MM/YYYY HH:MM
      let m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})[ ,T](\d{1,2}):(\d{2})(?::(\d{2}))?$/i.exec(s);
      if (m) {
        const [_, d, mo, y, h, mi, se] = m;
        const yy = (+y < 100) ? 2000 + (+y) : +y;
        return new Date(yy, (+mo - 1), +d, +h, +mi, se ? +se : 0);
      }
      // 2) YYYY-MM-DD HH:MM:SS
      m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ ,T](\d{1,2}):(\d{2})(?::(\d{2}))?$/i.exec(s);
      if (m) {
        const [_, yy, mo, d, h, mi, se] = m;
        return new Date(+yy, (+mo - 1), +d, +h, +mi, se ? +se : 0);
      }
      // 3) Padrões com mês textual: "Sep 1 2025, 14:05"
      m = /^([A-Za-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?[ ,]+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/i.exec(s);
      if (m) {
        const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
        const [_, mon, d, yy, h, mi, se] = m;
        const mm = months[mon.toLowerCase().slice(0,3)];
        if (mm != null) return new Date(+yy, mm, +d, +h, +mi, se ? +se : 0);
      }
      // 4) Fallback Date.parse
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return new Date(t);
      return null;
    }

    // Deduplicação de mensagens de conflito
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll(':scope > td'));
      if (tds.length < 3) continue;

      const timestampRaw = (tds[1].textContent || '').trim();
      const messageRaw   = (tds[2].textContent || '').trim();
      if (!messageRaw) continue;

      const relevant = looksRelevant(messageRaw);
      if (!relevant) continue;

      const ts = parseGuildTimestamp(timestampRaw) || new Date();
      const key = `${ts.toISOString()} :: ${messageRaw.slice(0, 120)}`;

      let shouldSend = true;
      try {
        shouldSend = !checkInfo(key, 'guildConflictData');
        if (shouldSend) addLine(key, 'guildConflictData');
      } catch {}

      if (!shouldSend) continue;

      try {
        sendDiscordMessage(
          `${timestampRaw} - ${messageRaw}`,
          'Guild Conflict Update',
          3447003, // azul
          timestampRaw,
          '**CONFLICT UPDATE**',
          CONFLICT_WEBHOOK
        );
      } catch (e) {
        ERR('[GuildConflicts] Falha ao enviar mensagem de conflito', e);
      }
    }
  } catch (err) {
    console.error('Guild Log Check Error:', err);
  }
}
