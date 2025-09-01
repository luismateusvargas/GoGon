// app_modules/Titans.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, securePost, queueDiscordMessage } from '../utils.js';


export function checkForTitanNotifications() {
        secureFetch('https://www.fallensword.com/index.php?cmd=&subcmd=viewarchive')
            .then(response => response.text())
            .then(text => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');

  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForTitanNotifications');
  if (!pCC) { return; }

            const rows = doc.querySelectorAll('table > tbody > tr:nth-child(5) > td > table > tbody > tr');
            rows.forEach(row => {
                const cell = row.querySelector('td:nth-child(2)');
                if (cell) {
                    const cellData = cell.textContent;
                    if (cellData.includes('Titan Spotted!')) {
                        const titanInfo = row.nextElementSibling.nextElementSibling.querySelector('td').textContent;
                        const titanTime = row.querySelector('.NEWS_DATE').textContent;
                        let line = `${titanInfo} ${titanTime}`
                        if (!checkInfo(line, "titanData")) {
                            addLine(line, "titanData");
                            //console.log(titanInfo,'and', titanTime);
                            sendDiscordMessage(`
New Titan Spotted:
${titanInfo}
${titanTime}
`, "Titan Spawn", "21247", "Don't forget TP and TD!", TitanGroup, titanWebhook);
                        }
                    }
                }
            });
        });
    }