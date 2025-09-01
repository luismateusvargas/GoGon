// app_modules/Crates.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';


export function checkForCratesFound() {
  // Obtém o conteúdo da página da web
  secureFetch('https://www.fallensword.com/index.php?cmd=crates')
    .then(response => response.text())
    .then(text => {
      // Analisa o conteúdo da página da web
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');

	  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForCratesFound');
	  if (!pCC) { return; }

      // Obtém todos os elementos tr dentro do div
      const trs = pCC.querySelectorAll('table > tbody > tr:nth-child(6) > td > table > tbody > tr');

      // Percorre os elementos tr de 2 em 2
      for (let i = 1; i < trs.length; i += 2) {
        const tr = trs[i];

        // Obtém os elementos td dentro do tr
        const tds = tr.querySelectorAll('td');

        // Verifica se existem elementos td suficientes
        if (tds.length >= 4) {
          // Extrai as informações dos elementos td
          const crateInfo = {
            dateTime: tds[0].textContent.trim(),
            crateName: {
              name: tds[1].querySelector('center').textContent.trim()
            },
            player: {
              name: tds[2].querySelector('a').textContent.trim(),
              location: tds[2].childNodes[2].textContent.trim()
            },
            drop: tds[3].querySelector('img').src
          };
            let line = `${crateInfo.dateTime} ${crateInfo.player.location}`
          // Verifica se as informações já foram enviadas anteriormente
          if (!checkInfo(line, "crateData")) {
            // Armazena as informações em cache usando o GM
            addLine(line, "crateData");
  sendExtraDiscordMessage(`
${crateInfo.dateTime}
${crateInfo.crateName.name}
${crateInfo.player.name}
${crateInfo.player.location}
`, "New Chest", "15466240", "Chest Found!", "", cratesWebhook, "", crateInfo.drop);

          }
        }
      }
    });
}