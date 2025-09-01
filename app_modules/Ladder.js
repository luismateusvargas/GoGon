// app_modules/Ladder.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendDiscordMessage } from '../utils.js';


export async function fetchPreviousPvPLadder(bandId) {
  const url = `https://www.fallensword.com/index.php?cmd=pvpladder&viewing_band_id=${bandId}`;
  try {
    const response = await secureFetch(url, {
      credentials: 'include',
      cache: 'no-cache'
    });
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

	  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'fetchPreviousPvPLadder');
	  if (!pCC) { return; }


    // Select the second <td> containing "Previous PvP Ladder"
    const previousLadderTable = doc.querySelector('td[valign="top"]:nth-of-type(2) table');

    if (!previousLadderTable) {
      console.warn(`[PvP Ladder] No previous ladder found for band ${bandId}`);
      return [];
    }

    const rows = previousLadderTable.querySelectorAll('tbody tr');
    const ladderData = [];

    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length === 3 && !cols[0].classList.contains('header')) {
        const ranking = cols[0].textContent.trim();
        const player = cols[1].textContent.trim();
        const rating = cols[2].textContent.trim();
        ladderData.push({ ranking, player, rating });
      }
    });

    console.log(`[PvP Ladder Band ${bandId}]`, ladderData);
    return ladderData;
  } catch (error) {
    console.error(`[PvP Ladder] Error fetching band ${bandId}:`, error);
    return [];
  }
}

export async function fetchAllPreviousPvPLadders() {
  const allBands = {};
  for (let bandId = 1; bandId <= 19; bandId++) {
    allBands[bandId] = await fetchPreviousPvPLadder(bandId);
  }
  return allBands;
}

export async function handleLadderNotification() {
  const allBands = await fetchAllPreviousPvPLadders();

  for (let bandId = 1; bandId <= 19; bandId++) {
    const bandData = allBands[bandId];
    if (!bandData || bandData.length === 0) continue;

    const formatted = bandData
      .map(item => `${item.ranking} - ${item.player} (${item.rating})`)
      .join('\n');

    const message = `**Previous PvP Ladder (Band ${bandId}):**\n${formatted}`;

    sendDiscordMessage(
      message,
      'PvP Ladder Report',
      '15466240',
      'Ladder Stats',
      LadderGroup,
      ladderRankingWebhook
    );

    // Delay between messages to avoid flooding Discord (e.g., 2 seconds)
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

export function checkForPvPNotifications() {
    secureFetch('https://www.fallensword.com/index.php?cmd=&subcmd=viewarchive', {
      credentials: 'include',
      cache: 'no-cache'
    })
      .then(response => response.text())
      .then(text => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForPvPNotifications');
  if (!pCC) { return; }

        const rows = doc.querySelectorAll(
          'table > tbody > tr:nth-child(5) > td > table > tbody > tr'
        );

        rows.forEach(row => {
          const cell = row.querySelector('td:nth-child(2)');
          if (cell) {
            const cellData = cell.textContent;
            if (cellData.includes('PvP Ladder')) {
              const ladderInfo = row.nextElementSibling?.nextElementSibling?.querySelector('td')?.textContent?.trim() || '';
              const ladderTime = row.querySelector('.NEWS_DATE')?.textContent?.trim() || '';
              const line = `${ladderInfo} ${ladderTime}`;

              if (!checkInfo(line, 'ladderData')) {
                addLine(line, 'ladderData');

                sendDiscordMessage(
                  `**${ladderInfo}**\n${ladderTime}`,
                  'Ladder Reset',
                  '15466240', // Icon ID
                  'Dominating!',
                  LadderGroup,
                  ladderWebhook
                );
                handleLadderNotification();
              }
            }
          }
        });
      })
      .catch(err => console.error('[PvP Notification] Fetch error:', err));
  }