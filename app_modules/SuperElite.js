// app_modules/SuperElite.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage, sendExtraDiscordMessageNODROP, checkInfo, addLine } from '../utils.js';
import { SuperEliteWebhook } from '../webhooks.js';


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

      // Localiza a tabela de Super Elite de forma robusta (por cabeçalhos/padrões visuais)
      const pcc = pCC;
      const tables = Array.from(pcc.querySelectorAll('table'));
      function isSETable(tbl) {
        // 1) Se tiver cabeçalhos, use palavras-chave
        const headerRow = tbl.querySelector('tr');
        if (headerRow) {
          const headers = Array.from(headerRow.querySelectorAll('td.header, th.header')).map(td => td.textContent.trim().toLowerCase());
          if (headers.length >= 3) {
            const hasCreature = headers.some(h => h.includes('creature') || h.includes('super elite'));
            const hasPlayer   = headers.some(h => h.includes('player'));
            const hasDrop     = headers.some(h => h.includes('drop'));
            const hasDateTime = headers.some(h => h.includes('date') || h.includes('time'));
            if ((hasCreature || hasDrop) && hasPlayer) return true;
            if (hasDateTime && (hasCreature || hasDrop)) return true;
          }
        }
        // 2) Caso não tenha cabeçalho claro, procure linhas com padrão visual típico:
        //    - 4+ colunas, a segunda coluna contém <img> e <center> (nome do SE)
        //    - a terceira contém <a> (jogador) e texto extra (localização)
        const probe = tbl.querySelectorAll('tr');
        for (const tr of probe) {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 4) {
            const hasImgIn2 = !!tds[1]?.querySelector('img');
            const hasCenterName = !!tds[1]?.querySelector('center');
            const hasPlayerLink = !!tds[2]?.querySelector('a');
            if (hasImgIn2 && hasCenterName && hasPlayerLink) return true;
          }
        }
        return false;
      }
      const seTable = tables.find(isSETable);
      if (!seTable) {
        console.error('⚠️ Tabela de Super Elite não encontrada (DOM mudou?)');
        return;
      }

      // Coleta as linhas úteis (ignora cabeçalhos e separadores)
      const rawRows = Array.from(seTable.querySelectorAll('tr'));
      // Alguns layouts intercalam linhas; aqui filtramos por linhas com pelo menos 4 <td> relevantes.
      const trs = rawRows.filter(tr => {
        const tds = tr.querySelectorAll(':scope > td');
        if (tds.length < 4) return false;
        if ([...tds].some(td => td.classList.contains('header'))) return false;
        const txt = tr.textContent.trim().toLowerCase();
        if (!txt) return false;
        // Evita mensagens genéricas tipo "no entries"
        if (txt.includes('no') && txt.includes('entries')) return false;
        return true;
      });

      // Percorre as linhas diretamente (sem pular de 2 em 2)
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i];
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