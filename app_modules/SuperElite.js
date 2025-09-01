// app_modules/SuperElite.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage, sendExtraDiscordMessageNODROP } from '../utils.js';


export function checkForSuperEliteKills() {
  // Obtém o conteúdo da página da web
  secureFetch('https://www.fallensword.com/index.php?cmd=superelite')
    .then(response => response.text())
    .then(text => {
      // Analisa o conteúdo da página da web
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');

  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForSuperEliteKills');
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
          const killInfo = {
            dateTime: (() => {
                // Obtém o elemento td que contém a data e a hora
                const td = tds[0];

                // Cria uma cópia do elemento td
                const tdCopy = td.cloneNode(true);

                // Substitui a tag br por um caractere de espaço
                const br = tdCopy.querySelector('br');
                br.parentNode.replaceChild(document.createTextNode(' '), br);

                // Extrai o conteúdo de texto do elemento td
                return tdCopy.textContent.trim();
            })(),
            superElite: {
              image: tds[1].querySelector('img').src,
              name: tds[1].querySelector('center').textContent.trim()
            },
            player: {
              name: tds[2].querySelector('a').textContent.trim(),
              location: tds[2].childNodes[2].textContent.trim()
            },
            drop: tds[3].textContent.includes('[no drop]') ? '[no drop]' : tds[3].querySelector('img').src
          };
          let line = `${killInfo.dateTime} ${killInfo.player.location}`
          // Verifica se as informações já foram enviadas anteriormente
          if (!checkInfo(line, "SEdata")) {
            // Armazena as informações em cache usando o GM
            addLine(line, "SEdata");
        // Envia as informações para o Discord
              // Verifica se killInfo.drop é um link válido
if (killInfo.drop.startsWith('http://') || killInfo.drop.startsWith('https://')) {
  // killInfo.drop é um link válido, então pode ser usado como um link para uma imagem
  sendExtraDiscordMessage(`
${killInfo.dateTime}
${killInfo.superElite.name}
${killInfo.player.name}
${killInfo.player.location}
`, "Super Elite", "15466240", "It Dropped!", "", SuperEliteWebhook, killInfo.superElite.image, killInfo.drop);
} else {
  // killInfo.drop não é um link válido, então deve ser omitido ou substituído por um valor padrão
  sendExtraDiscordMessageNODROP(`
${killInfo.dateTime}
${killInfo.superElite.name}
${killInfo.player.name}
${killInfo.player.location}
`, "Super Elite", "15466240", killInfo.drop, "", SuperEliteWebhook, killInfo.superElite.image);
}

          }
        }
      }
    });
}