// app_modules/GuildConflicts.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendDiscordMessage } from '../utils.js';
const LOG_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=log';
const CONFLICTS_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=conflicts';

export async function monitorIncomingAttacks() {
    try {
      const resp = await secureFetch(CONFLICTS_URL);
      if (!resp.ok) return console.warn(`Conflict page failed: ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

	  const pCC = ensurePCC(doc, html, 'monitorIncomingAttacks');
	  if (!pCC) { return; }


      const conflictTable = doc.querySelector("#pCC > table:nth-child(1) > tbody:nth-child(1)");
      if (!conflictTable) return;

      const conflictRows = conflictTable.querySelectorAll("tr");
      for (let i = 2; i < conflictRows.length; i++) {
        const cells = conflictRows[i].querySelectorAll("td");
        if (cells.length < 7) continue;

        const targetGuild = cells[0].textContent.replace(/\s+/g, ' ').trim();
        const incomingAtks = cells[3].textContent.replace(/\s+/g, ' ').trim();

        if (!incomingAtks || incomingAtks === 'Incoming Atks' || !/^\d+\s*\/\s*\d+$/.test(incomingAtks)) continue;

        const conflictKey = `incomingAtk_${targetGuild}`;
        const lastSeenValue = localStorage.getItem(conflictKey);

        if (incomingAtks !== lastSeenValue) {
          localStorage.setItem(conflictKey, incomingAtks);
          const timestamp = new Date().toLocaleString();
          const msg = `Incoming Attacks changed for conflict '${targetGuild}': ${incomingAtks}`;
          sendDiscordMessage(
            msg,
            'Incoming Attack Update',
            16776960,
            timestamp,
            '**CONFLICT UPDATE**',
            CONFLICT_WEBHOOK
          );
        }
      }
    } catch (err) {
      console.error("Conflict Incoming Attack Monitor Error:", err);
    }
  }

export async function checkGuildLog() {
    try {
      const resp = await secureFetch(LOG_URL);
      if (!resp.ok) return console.warn(`Log request failed: ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

	  const pCC = ensurePCC(doc, html, 'checkGuildLog');
	  if (!pCC) { return; }


      const rows = pCC.querySelectorAll("table.width_full tbody tr");
      const lastSeenRaw = localStorage.getItem("guild_log_last_timestamp");
      const lastSeen = lastSeenRaw ? new Date(lastSeenRaw) : new Date(0);
      let latestTimestamp = lastSeen;

      for (const row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) continue;

        const timestampRaw = tds[1].textContent.trim();
        const timestamp = parseTimestamp(timestampRaw);
          if (!timestamp) continue;
        const plainMessage = tds[2].textContent.trim();

        if (timestamp <= lastSeen) break;

        let message = "";
        let webhook = null;
        let who = "";

        if (plainMessage.includes("has just initiated a conflict with")) {
          message = plainMessage.split("This cost")[0].trim();
          webhook = CONFLICT_WEBHOOK;
        } else if (plainMessage.includes("Your conflict with")) {
          message = plainMessage;
          webhook = CONFLICT_WEBHOOK;
        } else if (plainMessage.startsWith("To arms!")) {
          message = plainMessage;
          webhook = CONFLICT_WEBHOOK;
        }

        if (webhook && message) {
          const embedTimestamp = `${timestampRaw}`;
          
            sendDiscordMessage(
              `${embedTimestamp} - ${message}`,
              'Guild Conflict Update',
              3447003, // azul
              embedTimestamp,
              '**CONFLICT UPDATE**',
              webhook
            );
          

          if (timestamp > latestTimestamp) latestTimestamp = timestamp;
        }
      }

      if (latestTimestamp > lastSeen) {
        localStorage.setItem("guild_log_last_timestamp", latestTimestamp.toISOString());
      }
    } catch (err) {
      console.error("Guild Log Check Error:", err);
    }
  }