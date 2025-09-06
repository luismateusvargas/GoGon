// app_modules/Crates.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage, checkInfo, addLine } from '../utils.js';
import { cratesWebhook } from '../webhooks.js';

export function checkForCratesFound() {
  // Carrega a página de Crates de forma autenticada
  secureFetch('https://www.fallensword.com/index.php?cmd=crates')
    .then(response => response.text())
    .then(text => {
      // Parse do HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');

      // Garante #pCC (mesmo padrão dos outros módulos)
      const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkForCratesFound');
      if (!pCC) { return; }

      // Localiza a tabela de Crates de forma robusta (por cabeçalhos/padrões)
      const tables = Array.from(pCC.querySelectorAll('table'));
      function isCratesTable(tbl) {
        // 1) Cabeçalhos com palavras-chave usuais
        const headerRow = tbl.querySelector('tr');
        if (headerRow) {
          const headers = Array.from(headerRow.querySelectorAll('td.header, th.header')).map(td => td.textContent.trim().toLowerCase());
          if (headers.length >= 3) {
            const hasDateTime = headers.some(h => h.includes('date') || h.includes('time'));
            const hasChest    = headers.some(h => h.includes('chest') || h.includes('crate'));
            const hasPlayer   = headers.some(h => h.includes('player'));
            const hasDrop     = headers.some(h => h.includes('drop'));
            if ((hasChest || hasDrop) && hasPlayer) return true;
            if (hasDateTime && (hasChest || hasDrop)) return true;
          }
        }
        // 2) Padrão visual:
        //    - Linha com 4+ colunas
        //    - Coluna 2 contendo <img> e <center> (nome do chest)
        //    - Coluna 3 contendo <a> (jogador) e texto extra (localização)
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

      const crateTable = tables.find(isCratesTable);
      if (!crateTable) {
        console.error('⚠️ Tabela de Crates não encontrada (DOM mudou?)');
        return;
      }

      // Coleta linhas úteis (ignora cabeçalhos e mensagens "no entries")
      const rawRows = Array.from(crateTable.querySelectorAll('tr'));
      const trs = rawRows.filter(tr => {
        const tds = tr.querySelectorAll(':scope > td');
        if (tds.length < 4) return false;
        if ([...tds].some(td => td.classList.contains('header'))) return false;
        const txt = tr.textContent.trim().toLowerCase();
        if (!txt) return false;
        if (txt.includes('no') && (txt.includes('entries') || txt.includes('chests'))) return false;
        return true;
      });

      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i];
        const tds = tr.querySelectorAll('td');

        // date/time
        const dateTime = (tds[0]?.textContent || '').trim();

        // chest info (coluna 2): imagem + nome centralizado
        const chestImg = tds[1]?.querySelector('img')?.src || '';
        const chestName = (tds[1]?.querySelector('center')?.textContent || '').trim();

        // player (coluna 3): <a> com nome + texto solto com localização
        const playerName = (tds[2]?.querySelector('a')?.textContent || '').trim();
        // tentativa de pegar o segundo nó de texto (após <a>)
        let playerLoc = '';
        const c2nodes = Array.from(tds[2]?.childNodes || []);
        for (const n of c2nodes) {
          if (n.nodeType === 3) {
            const t = (n.textContent || '').trim();
            if (t) { playerLoc = t; break; }
          }
        }

        // drop (coluna 4): pode ser "[no drop]" ou img
        let drop;
        const td4 = tds[3];
        const dropImg = td4?.querySelector('img')?.src || '';
        if (td4?.textContent?.includes('[no drop]')) drop = '[no drop]';
        else drop = dropImg || '';

        // Linha única para cache/deduplicação (como no SE)
        const line = `${dateTime} ${playerLoc}`;

        // Publica somente se novo
        try {
          if (typeof checkInfo !== 'function' || typeof addLine !== 'function') {
            console.warn('checkInfo/addLine não disponíveis no escopo; pulando cache local.');
          }
          const isNew = (typeof checkInfo === 'function') ? !checkInfo(line, 'crateData') : true;
          if (isNew) {
            if (typeof addLine === 'function') addLine(line, 'crateData');

            const crateInfo = {
              dateTime,
              crateName: { name: chestName, image: chestImg },
              player: { name: playerName, location: playerLoc },
              drop,
            };

            // Envia para o Discord (mantendo sua assinatura atual)
            sendExtraDiscordMessage(
`\
${crateInfo.dateTime}
${crateInfo.crateName.name}
${crateInfo.player.name}
${crateInfo.player.location}
`,
              'New Chest',
              '15466240',
              'Chest Found!',
              '',
              cratesWebhook,
              '',
              crateInfo.drop
            );
          }
        } catch (e) {
          console.error('checkForCratesFound error ao processar linha:', e);
        }
      }
    })
    .catch(err => console.error('checkForCratesFound falhou:', err));
}