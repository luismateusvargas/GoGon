// app_modules/Relics.js
import { LOG, WARN, ERR, ensurePCC } from './core.js';
import { secureFetch, queueDiscordMessage } from '../utils.js';
import { RELIC_WEBHOOK } from '../webhooks.js';

const LOG_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=log';

/**
 * Fallen Sword guild log timestamps appear as "HH:MM DD/Mon/YYYY" (no seconds).
 * To avoid missing multiple relic events within the same minute,
 * we combine {minuteBucket, relicName} as the dedup key.
 */
function parseTimestamp(ts) {
  if (!ts || !ts.includes(' ')) return null;
  const [time, date] = ts.split(' ');
  if (!date) return null;
  const [day, monStr, year] = date.split('/');
  if (!day || !monStr || !year) return null;
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04',
    May: '05', Jun: '06', Jul: '07', Aug: '08',
    Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const month = months[monStr];
  if (!month) return null;
  // Build an ISO-like string without seconds for the minute bucket
  const isoMinute = `${year}-${month}-${day}T${time}`; // HH:MM
  const isoFull = `${isoMinute}:00`;
  return { date: new Date(isoFull), minuteKey: isoMinute };
}

function extractRelicName(cell) {
  if (!cell) return null;
  // 1) Prefer link text that likely points to a relic
  const link = cell.querySelector('a[href*="relic"], a[href*="Relic"], a[href*="relics"], a[href*="Relics"]');
  const linkText = link?.textContent?.trim();
  if (linkText) return linkText;

  const text = cell.textContent || '';
  // 2) Try quoted 'relic "Name"' or "relic 'Name'"
  let m = text.match(/relic\s*['"]([^'"]+)['"]/i);
  if (m && m[1]) return m[1].trim();
  // 3) Try ending after 'relic ' until punctuation
  m = text.match(/relic\s+([A-Za-z0-9 _\-:()\[\]{}.,]+?)(?:[.!?]|$)/i);
  if (m && m[1]) return m[1].trim();
  // 4) Nothing reliable
  return null;
}

function getProcessedSet() {
  try {
    const raw = localStorage.getItem('relics_processed_set');
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveProcessedSet(set) {
  try {
    const arr = Array.from(set);
    localStorage.setItem('relics_processed_set', JSON.stringify(arr));
  } catch {}
}

export async function checkRelics() {
  try {
    const resp = await secureFetch(LOG_URL, { credentials: 'include', cache: 'no-cache' });
    if (!resp.ok) { WARN('relics', `Log request failed: ${resp.status}`); return; }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const pCC = ensurePCC(doc, html, 'checkRelics');
    if (!pCC) return;

    const rows = Array.from(pCC.querySelectorAll('table.width_full tbody tr'));

    // State used for dedup across restarts
    const processed = getProcessedSet();
    const lastMinuteKey = localStorage.getItem('relics_last_minute') || null;

    // Track new state as we go
    let newLastMinuteKey = lastMinuteKey;
    const touchedKeys = new Set();

    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 3) continue;

      const timestampRaw = tds[1].textContent.trim();
      const parsed = parseTimestamp(timestampRaw);
      if (!parsed) continue;

      const { date, minuteKey } = parsed;
      const messageCell = tds[2];
      const plainMessage = messageCell.textContent.trim();

      // Only care about relic-related messages
      let label = null;
      let color = null;
      if (plainMessage.includes('has captured the relic')) {
        label = '**RELIC TAKEN**';
        color = 15844367; // yellow
      } else if (plainMessage.includes('has captured your relic')) {
        label = '**RELIC LOST**';
        color = 16711680; // red
      } else {
        continue;
      }

      // Extract relic name and build dedup key
      const relicName = extractRelicName(messageCell) || plainMessage; // fallback: message itself
      const dedupKey = `${minuteKey}|${relicName}`;

      // If minute is older than last processed minute, we can stop (assuming newest-first).
      if (lastMinuteKey && minuteKey < lastMinuteKey) {
        break;
      }

      // Skip if already processed
      if (processed.has(dedupKey)) continue;

      // Send notification
      const payload = {
        content: '',
        embeds: [{
          title: 'Relic Notification',
          description: `${label}\n${plainMessage}`,
          color,
          timestamp: date.toISOString()
        }]
      };
      queueDiscordMessage(RELIC_WEBHOOK, payload);
      LOG('relics', `${label} :: ${relicName} @ ${minuteKey}`);

      // Mark processed
      processed.add(dedupKey);
      touchedKeys.add(minuteKey);

      // Track the newest minute key seen
      if (!newLastMinuteKey || minuteKey > newLastMinuteKey) {
        newLastMinuteKey = minuteKey;
      }
    }

    // Persist dedup state
    if (newLastMinuteKey && newLastMinuteKey !== lastMinuteKey) {
      localStorage.setItem('relics_last_minute', newLastMinuteKey);
    }
    if (touchedKeys.size > 0) {
      saveProcessedSet(processed);
    }
  } catch (err) {
    ERR('relics', 'checkRelics error', err);
  }
}
