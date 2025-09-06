// app_modules/Relics.js (robust + LOST/OUR CAPTURE diferenciados + trim de frase)
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, queueDiscordMessage, getContent, setContent } from '../utils.js';
import { RELIC_WEBHOOK } from '../webhooks.js';

const LOG_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=log';

/** Util: parse "14:37 03/Sep/2025" -> { date, minuteKey } */
function parseTimestamp(ts) {
  try {
    if (!ts) return null;
    const parts = ts.trim().split(/\s+/); // ["HH:MM", "DD/Mon/YYYY"]
    if (parts.length < 2) return null;
    const [hm, dmy] = parts;
    const [hh, mm] = hm.split(':').map(n => parseInt(n, 10));
    const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/.exec(dmy);
    if (!m) return null;
    const d = parseInt(m[1], 10);
    const mon = m[2].toLowerCase().slice(0,3);
    const y = parseInt(m[3], 10);
    const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const monthIdx = months[mon];
    if (monthIdx == null || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    const date = new Date(y, monthIdx, d, hh, mm, 0);
    const pad = (n) => String(n).padStart(2,'0');
    const minuteKey = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return { date, minuteKey };
  } catch {
    return null;
  }
}

/** Util: pega só a 1ª frase (até o primeiro ponto final). */
function firstSentence(text) {
  const s = (text || '').trim();
  if (!s) return '';
  const idx = s.indexOf('.');
  return idx >= 0 ? s.slice(0, idx + 1).trim() : s;
}

/**
 * Detecta tipo de evento e extrai a Relic nomeando:
 * - CAPTURED (NOSSA guild) => "has captured the relic ... from [ <Guild> ]"
 * - LOST (OUTRA guild)     => "has captured your relic ..."  OU  "Your guild members have lost the bonuses"
 * - DEFENDED               => "defend/repel/held off/held the relic"
 * Retorna { kind: 'CAPTURED'|'LOST'|'DEFENDED'|'OTHER', relicName, label, color, shortText }
 */
function parseRelicMessage(msg) {
  const text = (msg || '').trim();
  if (!/relic/i.test(text)) return null;

  // padrões
  const OUR_CAPTURE = /has\s+captured\s+the\s+relic\b/i; // nossa guild capturou DE alguém
  const LOST_YOUR   = /has\s+captured\s+your\s+relic\b/i; // outra guild capturou DA gente
  const LOST_BONUS  = /your\s+guild\s+members\s+have\s+lost\s+the\s+bonuses/i;
  const DEFEND      = /(defend|defended|repel|repelled|held\s+off|held\s+the\s+relic)/i;

  let kind = 'OTHER', label = 'Relic Update', color = 15105570;
  if (LOST_YOUR.test(text) || LOST_BONUS.test(text)) {
    kind = 'LOST'; label = 'Relic Lost'; color = 15158332; // vermelho
  } else if (DEFEND.test(text)) {
    kind = 'DEFENDED'; label = 'Relic Defended'; color = 3447003; // azul
  } else if (OUR_CAPTURE.test(text)) {
    kind = 'CAPTURED'; label = 'Relic Captured'; color = 3066993; // verde
  }

  // Extrair nome da relic
  let relicName = '';
  let m = /relic\s*[:\-]\s*([^,.;\n]+)/i.exec(text);
  if (m) relicName = m[1].trim();
  if (!relicName) {
    m = /the\s+([^,.;\n]+?)\s+relic/i.exec(text);
    if (m) relicName = m[1].trim();
  }
  if (!relicName) {
    m = /["“”'`](.+?)["“”'`]/.exec(text);
    if (m) relicName = m[1].trim();
  }
  if (!relicName) {
    m = /([A-Z][A-Za-z0-9 '()\-]+)\s+relic/i.exec(text);
    if (m) relicName = m[1].trim();
  }
  relicName = relicName.replace(/\s+/g,' ').trim();

  // 1ª frase apenas
  const shortText = firstSentence(text);

  return { kind, relicName, label, color, shortText };
}

/** Storage */
function getProcessedSet() {
  try {
    const raw = getContent('relics_processed') || '[]';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch {}
  return new Set();
}
function saveProcessedSet(set) {
  try {
    const arr = Array.from(set);
    if (arr.length > 400) arr.splice(0, arr.length - 400);
    setContent('relics_processed', JSON.stringify(arr));
  } catch {}
}

/** Principal */
export async function checkRelics() {
  try {
    const resp = await secureFetch(LOG_URL);
    if (!resp || !resp.ok) {
      WARN('relics', `Log request failed: ${resp ? resp.status : '??'}`);
      return;
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pCC = ensurePCC(doc, html, 'checkRelics');
    if (!pCC) return;

    pCC.querySelectorAll('script, style').forEach(n => n.remove());

    let rows = Array.from(pCC.querySelectorAll('table.width_full tbody tr'));
    if (!rows.length) rows = Array.from(pCC.querySelectorAll('tr')).filter(tr => tr.querySelectorAll(':scope > td').length >= 3);

    const processed = getProcessedSet();
    const lastMinuteKey = getContent('relics_last_minute') || null;
    let newLastMinuteKey = lastMinuteKey;
    const touchedKeys = new Set();

    for (const row of rows) {
      const tds = row.querySelectorAll(':scope > td');
      if (tds.length < 3) continue;

      const timestampRaw = (tds[1].textContent || '').trim();
      const parsed = parseTimestamp(timestampRaw);
      if (!parsed) continue;
      const { date, minuteKey } = parsed;

      const plainMessage = (tds[2].textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g,' ').trim();
      if (!plainMessage) continue;

      const info = parseRelicMessage(plainMessage);
      if (!info) continue;

      const { kind, relicName, label, color, shortText } = info;
      const nameKey = relicName || plainMessage.slice(0,60);
      const dedupKey = `${minuteKey} :: ${kind} :: ${nameKey}`;

      if (processed.has(dedupKey)) continue;

      // Embed curto (apenas 1ª frase)
      const payload = {
        content: '',
        embeds: [{
          title: 'Relic Notification',
          description: `${label}\n${shortText}`,
          color,
          timestamp: date.toISOString()
        }]
      };
      try {
        queueDiscordMessage(RELIC_WEBHOOK, payload);
        LOG('relics', `${label} :: ${relicName || '(unknown)'} @ ${minuteKey}`);
      } catch (e) {
        ERR('relics', 'Falha ao enviar relic notification', e);
      }

      processed.add(dedupKey);
      touchedKeys.add(minuteKey);
      if (!newLastMinuteKey || minuteKey > newLastMinuteKey) newLastMinuteKey = minuteKey;
    }

    if (newLastMinuteKey && newLastMinuteKey !== lastMinuteKey) {
      setContent('relics_last_minute', newLastMinuteKey);
    }
    if (touchedKeys.size > 0) {
      saveProcessedSet(processed);
    }
  } catch (err) {
    ERR('relics', 'checkRelics error', err);
  }
}
