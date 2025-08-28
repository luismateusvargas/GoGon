// ==UserScript==
// @name         News
// @version      6.0.6
// @author       Zucomate
// @description  but I'm not done yet!
// @match        https://www.fallensword.com/index.php?cmd=points&subcmd=redeem
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      https://www.fallensword.com
// @connect      https://discord.com
// ==/UserScript==

const logURL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=log';
const conflictsURL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=conflicts';

const RELIC_WEBHOOK = 'https://discord.com/api/webhooks/1402982809165107230/bzNPsfHFP3_uPNnr8uEp2zcDkbaRuBDNe_sLeVTmyLsFtHTwv5QKMaC55gDOoKLT_LEg';
const CONFLICT_WEBHOOK = 'https://discord.com/api/webhooks/1402983130045878292/DW6WOyX8aUgkfpx2-j01Pjh-ayqw49oUMO8EMsvZxOO9fwArEzRnfcXhaxx37hN9wbfq';
const bountyWebhook = "https://discord.com/api/webhooks/1111675211968950363/xwT5Ju0nkGSRfTkaUwl_AkNTKry5kAuUYyxLuvDmfGbemT5gdjLrdJ49piOA4wluvBO0";
const titanWebhook = "https://discord.com/api/webhooks/1111675919829045289/Y6WgHBE8imPTK8eLuoZNyYxz5JhuNS4uAStV2DiEIWuvfRlDUP6gg_le0CAL-yXVgoeH";
const ladderWebhook = "https://discord.com/api/webhooks/1111676083587260418/d_DD4FuHLW-TXSUiqxmV00zYxrd7JlNO_SlF39YeA_52gRonS58TVC-aoCoduT_3xY2h";
const ladderRankingWebhook = "https://discord.com/api/webhooks/1402422545696821298/vnC00pqrRzdlUZ5IuOzOPMt9_iWuDcHImUsZ-XgkUak5OSYagpWM8ILw5iubOgMy9P3g";
const SuperEliteWebhook = "https://discord.com/api/webhooks/1125465684906868886/RXLdFdW0ZGKH7c9Ku8u7-oiiTRC4RHpUWcAUUs-bMtHoDMzqyKzHXow133ymEXytOwXx";
const cratesWebhook = "https://discord.com/api/webhooks/1142943755259875389/pxspjNuDAWD-xJNJPxX4KhYZMHmC2S_Lxm5koGDQh3wjfpR792BBfBw3eTyGSXxRfYfa";
const newsWebhook = "https://discord.com/api/webhooks/1142972994478686279/16H0SeTON7va5l6REkzpnTs-jpkebT-rqIJbXYEKV1Bt_J-HiQHeSH7KY66DIRAhtB6L";
const shoutboxWebhook = "https://discord.com/api/webhooks/1142973656302092358/qp-pFvUFWp9ErLl9PW8h3sktFREZUn2PvdqHNbluUEVHCPVsXBjhF87Wn_-DWhU54PbP";
const SEgroup = `<@&1142926613009408000>`;
const BountyGroup = `<@&1111676687340548216>`;
const TitanGroup = `<@&1111676811982667776>`;
const LadderGroup = `<@&1111676962067456091>`;

const DELAY_BETWEEN_MESSAGES = 1500; //Define o atraso entre as mensagens em milissegundos

(function() {
    'use strict';

    // Função para adicionar uma nova linha ao "arquivo"
    function getContent(where) {
        return GM_getValue(where, "");
    }

    function setContent(where, content){
        GM_setValue(where, content);
    }

    function showContent(where){
        console.log(getContent(where))
    }

    function addLine(newLine, where) {
        // Recupera o conteúdo atual do "arquivo"
        let conteudo = getContent(where);
        let linhas = conteudo.split("\n");
        linhas.push(newLine);
        if (linhas.length > 20) {
            linhas.shift();
        }
        conteudo = linhas.join("\n");
        setContent(where, conteudo);
    }

    // Função para ler o conteúdo do "arquivo"

    function checkInfo(line, where) {
    // Recupera o conteúdo atual do "arquivo"
        let conteudo = getContent(where);
        let linhas = conteudo.split("\n");
        return linhas.includes(line);
    }
    // Exemplo de uso:
    //addLine("Linha 2");

    async function secureFetch(url, options = {}) {
        try {
            const response = await fetch(url, options);
            if (response.status === 200) {
                return response;
            }
            if (response.status === 502 || response.status === 504) {
                throw new Error(`Server error: ${response.status}`);
            }
            throw new Error(`Request failed: ${response.status}`);
        } catch (err) {
            console.error('secureFetch error:', err);
            throw err;
        }
    }

    function securePost(url, payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response);
                    } else if (response.status === 502 || response.status === 504) {
                        reject(new Error(`Server unavailable: ${response.status}`));
                    } else {
                        reject(new Error(`HTTP error: ${response.status}`));
                    }
                },
                onerror: function() {
                    reject(new Error('Network error'));
                }
            });
        });
    }

    function sendDiscordMessage(message, wTitle, colorCode, footerText, group, webhook) {
        const embed = {
            title: wTitle,
            description: message,
            color: colorCode,
            footer: {
                text: footerText
            }
        };
        securePost(webhook, { content: group, embeds: [embed] })
            .catch(err => console.error('sendDiscordMessage error:', err));
    }

    function sendSimpleMessage(message, webhook){
        securePost(webhook, { content: message })
            .catch(err => console.error('sendSimpleMessage error:', err));
    }
    function sendExtraDiscordMessage(message, wTitle, colorCode, footerText, group, webhook, thumbUrl, thumb) {
        const embed = {
            title: wTitle,
            description: message,
            image: {
                url: thumbUrl
            },
            thumbnail: {
                url: thumb
            },
            color: colorCode,
            footer: {
                text: footerText
            }
        };
        securePost(webhook, { content: group, embeds: [embed] })
            .catch(err => console.error('sendExtraDiscordMessage error:', err));
    }

    function sendExtraDiscordMessageNODROP(message, wTitle, colorCode, footerText, group, webhook, thumbUrl) {
        const embed = {
            title: wTitle,
            description: message,
            image: {
                url: thumbUrl
            },
            color: colorCode,
            footer: {
                text: footerText
            }
        };
        securePost(webhook, { content: group, embeds: [embed] })
            .catch(err => console.error('sendExtraDiscordMessageNODROP error:', err));
    }

// Modifica a função sendExtraDiscordMessage para adicionar um atraso entre as chamadas
function sendExtraDiscordMessageWithDelay(message, wTitle, colorCode, footerText, group, webhook, thumbUrl, thumb) {
  // Agenda a chamada para a função sendExtraDiscordMessage com um atraso
  setTimeout(() => {
    sendExtraDiscordMessage(message, wTitle, colorCode, footerText, group, webhook, thumbUrl, thumb);
  }, DELAY_BETWEEN_MESSAGES);

}

function sendExtraDiscordMessageWithDelayNODROP(message, wTitle, colorCode, footerText, group, webhook, thumbUrl) {
  // Agenda a chamada para a função sendExtraDiscordMessage com um atraso
  setTimeout(() => {
    sendExtraDiscordMessageNODROP(message, wTitle, colorCode, footerText, group, webhook, thumbUrl);
  }, DELAY_BETWEEN_MESSAGES);
}
    async function getGoldInHand(targetLink) {
        let completeLink = targetLink;
        let response = await secureFetch(completeLink);
        let text = await response.text();
        let tempElement = document.createElement('div');
        tempElement.innerHTML = text;
        let goldInHandElement = tempElement.querySelector('#stat-gold');
        if (goldInHandElement) {
            return goldInHandElement.textContent;
        } else {
            // O elemento goldInHandElement não foi encontrado
            // Aqui você pode adicionar código para lidar com esse caso
            return null;
        }
    }

      async function getBuffs(targetLink) {
        let completeLink = targetLink;
        let response = await secureFetch(completeLink);
        let text = await response.text();
        let tempElement = document.createElement('div');
        tempElement.innerHTML = text;
        let isCloaked = false;
        let hasDeflect = false;
        let buffs = tempElement.querySelector('#profileRightColumn > div:nth-child(14) > table > tbody > tr:nth-child(1)');
        let buffAmount = buffs.length;

        let buffNameAndLevel = [];
        let trs = tempElement.querySelectorAll('#profileRightColumn > div:nth-child(14) > table > tbody > tr');
        trs.forEach(tr => {
            let tds = tr.querySelectorAll('td');
            tds.forEach(td => {
                let img = td.querySelector('img');
                if (img) {
                    let tipped = img.getAttribute('data-tipped');
                    let span = document.createElement('div');
                    span.innerHTML = tipped;
                    let buffName = span.querySelector('span > b').textContent;
                    let level = span.querySelector('span').textContent.split('Level: ')[1].split(')')[0];
                    buffNameAndLevel.push({name: buffName, level: level});
                }
            });
        });

        buffNameAndLevel.forEach(buff => {
            if (buff.name === 'Deflect') {
                hasDeflect = true;
            }
            if (buff.name === 'Cloak') {
                isCloaked = true;
            }
        });

        return {hasDeflect: hasDeflect, isCloaked: isCloaked, numberOfBuffs: buffNameAndLevel.length};
    }

async function checkForNewBounty() {
  try {
    // 1) Carrega a página
    const resp = await secureFetch('/index.php?cmd=bounty');
    if (resp.status !== 200) {
      console.error(`HTTP ${resp.status} ao carregar bounties`);
      return;
    }
    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, 'text/html');

    // 2) Seletor exato da sua tabela interna
    const table = doc.querySelector(
      '#pCC > table:nth-child(3) > tbody > tr:nth-child(12) td[colspan="3"] table'
    );
    if (!table) {
      console.error('⚠️ Tabela de bounties não encontrada');
      return;
    }

    // 3) Filtra só linhas-reais (7 <td> diretos, sem classe "header")
    const allTRs = Array.from(table.querySelectorAll('tbody > tr'));
    const rows   = allTRs.filter(tr => {
      const tds = tr.querySelectorAll(':scope > td');
      return tds.length === 7 && ![...tds].some(td => td.classList.contains('header'));
    });

    // 4) Percorre cada linha com índice
    for (let i = 0; i < rows.length; i++) {
      const tr    = rows[i];
      const cells = tr.querySelectorAll(':scope > td');

      // 4a) Extrai ID real do botão “Accept”, se existir
      const btn = cells[6].querySelector('input[type="button"][value="Accept"]');
      if (!btn) {
        // Ignora linhas sem botão (ex: [n/a])
        continue;
      }
      const on = btn.getAttribute('onclick') || '';
      const m  = /bounty_id=(\d+)/.exec(on);
      if (!m) {
        console.warn('Accept sem bounty_id, pulando');
        continue;
      }
      const id = m[1];
      const cacheId = `bounty|${id}`;

      // 5) Checa cache
      if (checkInfo(cacheId, 'bountyData')) {
        continue;
      }
      addLine(cacheId, 'bountyData');

      // 6) Extrai dados restantes
      const a0     = cells[0].querySelector('a');
      const target = a0?.textContent.trim() || '[no target]';
      const level  = cells[0].textContent.replace(target, '').trim();
      const offerer= cells[1].querySelector('a')?.textContent.trim() || '[no offerer]';
      const reward = cells[2].querySelector('table tr td font')?.textContent.trim() || '[no reward]';
      const imgSrc = cells[2]
        .querySelector('table tr td:nth-of-type(2) img')
        ?.getAttribute('src')
        .replace('/curreny/', '/currency/') || '';

      const hrefPath   = a0?.getAttribute('href') || '';
      const goldInHand = await getGoldInHand(hrefPath);
      let buffs;
      try { buffs = await getBuffs(hrefPath) || {}; }
      catch { buffs = {}; }
      const { hasDeflect = false, isCloaked = false, numberOfBuffs = 0 } = buffs;

      // 7) Envia para o Discord
      sendExtraDiscordMessage(
        `
:hammer: Target: ${target} ${level}
:scales: Offerer: ${offerer}
:moneybag: Reward: ${reward}
:money_with_wings: Gold in hand: ${goldInHand}
:shield: Deflect ? ${hasDeflect}
:mage: Cloaked ? ${isCloaked}
:crystal_ball: Buffs Number: ${numberOfBuffs}
        `,
        "Bounty Board",
        "16711680",
        "Gotta Smash'em all!",
        BountyGroup,
        bountyWebhook,
        "",
        imgSrc
      );
    }

  } catch (err) {
    console.error("checkForNewBounty falhou:", err);
  }
}


    // Function to check for Titan notifications
    function checkForTitanNotifications() {
        secureFetch('https://www.fallensword.com/index.php?cmd=&subcmd=viewarchive')
            .then(response => response.text())
            .then(text => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
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
// === PvP Ladder Notifications ===
  function checkForPvPNotifications() {
    secureFetch('https://www.fallensword.com/index.php?cmd=&subcmd=viewarchive', {
      credentials: 'include',
      cache: 'no-cache'
    })
      .then(response => response.text())
      .then(text => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');
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

function checkForSuperEliteKills() {
  // Obtém o conteúdo da página da web
  secureFetch('https://www.fallensword.com/index.php?cmd=superelite')
    .then(response => response.text())
    .then(text => {
      // Analisa o conteúdo da página da web
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');

      // Obtém o elemento div com id "pCC"
      const pCC = doc.querySelector('#pCC');

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
  sendExtraDiscordMessageWithDelay(`
${killInfo.dateTime}
${killInfo.superElite.name}
${killInfo.player.name}
${killInfo.player.location}
`, "Super Elite", "15466240", "It Dropped!", "", SuperEliteWebhook, killInfo.superElite.image, killInfo.drop);
} else {
  // killInfo.drop não é um link válido, então deve ser omitido ou substituído por um valor padrão
  sendExtraDiscordMessageWithDelayNODROP(`
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
    function checkForCratesFound() {
  // Obtém o conteúdo da página da web
  secureFetch('https://www.fallensword.com/index.php?cmd=crates')
    .then(response => response.text())
    .then(text => {
      // Analisa o conteúdo da página da web
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');

      // Obtém o elemento div com id "pCC"
      const pCC = doc.querySelector('#pCC');

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
  sendExtraDiscordMessageWithDelay(`
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
    function checkForUpdatesArchive(){
        secureFetch('https://www.fallensword.com/index.php?cmd=&subcmd=viewupdatearchive')
            .then(response => response.text())
            .then(text => {
            let tempElement = document.createElement('div');
            tempElement.innerHTML = text;
            let messageTable = tempElement.querySelector('#pCC table tbody tr:nth-of-type(5) td table tbody');
            if (messageTable) {
                let firstTr = messageTable.querySelector('tr:first-of-type');
                let thirdTr = messageTable.querySelector('tr:nth-of-type(3)');
                if (firstTr && thirdTr) {
                    let titleTd = firstTr.querySelector('td:nth-of-type(2)');
                    let title = titleTd.querySelector('span.NEWS_SUBJECT nobr').textContent;
                    let date = titleTd.querySelector('span.NEWS_DATE').textContent;
                    let messageTd = thirdTr.querySelector('td');
                    let message = messageTd.innerHTML
                    .replace(/<br>/g, '\n')
                    .replace(/<[^>]+>/g, '');
                    let imgElements = messageTd.querySelectorAll('img');
                    let aElements = messageTd.querySelectorAll('a');

                    // Armazena as informações nas variáveis ​​separadas
                    let messageTitle = title;
                    let messageDate = date;
                    let messageContent = message;
                    let imgSrcs = Array.from(imgElements).map(img => img.getAttribute('src'));
                    let aHrefs = Array.from(aElements).map(a => a.getAttribute('href'));

                    // Verifica se a data e o título da mensagem já estão armazenados em cache
                    let line = `${messageDate} ${messageTitle}`
                    if (!checkInfo(line, 'updatesData')) {
                        // Adiciona a data e o título da mensagem ao cache
                        addLine(line, 'updatesData');

                        // Formata a mensagem e envia ao Discord
                        let discordMessage = `
:envelope_with_arrow: Title: ${messageTitle}
:calendar: Date: ${messageDate}
:page_facing_up: Message: ${messageContent}
`;

                        if (imgSrcs.length > 0) {
                            discordMessage += '\n:camera_with_flash: Images Links:\n';
                            for (let src of imgSrcs) {
                                discordMessage += `${src}\n`;
                            }
                        }

                        if (aHrefs.length > 0) {
                            discordMessage += '\n:link: External Links:\n';
                            for (let href of aHrefs) {
                                discordMessage += `${href}\n`;
                            }
                        }

                        sendDiscordMessage(discordMessage, "Update Archive", "16711680", "New Content ?", "", newsWebhook);

                    }
                }
            }
        });
    }

    function checkForShoutbox(){
        secureFetch('https://www.fallensword.com/index.php?cmd=news')
            .then(response => response.text())
            .then(text => {
            let tempElement = document.createElement('div');
            tempElement.innerHTML = text;
            let shoutboxDiv = tempElement.querySelector('#pCC div.float_right div.news_shoutbox');
            if (shoutboxDiv) {
                let shouts = shoutboxDiv.querySelectorAll('div.shout');
                for (let shout of shouts) {
                    let shoutHeadLeft = shout.querySelector('div.shout_head_left');
                    let playerName = shoutHeadLeft.querySelector('a').textContent;
                    let shoutHeadRight = shout.querySelector('div.shout_head_right');
                    let messageDate = shoutHeadRight.textContent;
                    let shoutBody = shout.querySelector('div.shout_body');
                    let messageContent = shoutBody.textContent;

                    // Verifica se a data e o nome do jogador já estão armazenados em cache
                    let line = `${messageDate} ${playerName}`;
                    if (!checkInfo(line, 'shoutboxData')) {
                        // Adiciona a data e o nome do jogador ao cache
                        addLine(line, 'shoutboxData');

                        // Formata a mensagem e envia ao Discord
                        let discordMessage = `
:loudspeaker: Player: ${playerName}
:calendar: Date: ${messageDate}
:page_facing_up: Message: ${messageContent}
`;
                        sendExtraDiscordMessageWithDelay(discordMessage, "Shoutbox", "16711680", "Report it now!", "", shoutboxWebhook, "", "");
                    }
                }
            }
        });
    }

   async function autoJoinAllGroups() {
    try {
      const response = await secureFetch('https://www.fallensword.com/index.php?cmd=guild&subcmd=groups&subcmd2=joinall', {
        credentials: 'include', // ensures cookies/session are sent
        cache: 'no-cache'       // force fresh request
      });
      console.log(`[JoinAll] Status: ${response.status} @ ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.error('[JoinAll] Fetch error:', error);
    }
  }
// === CONFIGURATION ===
  const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const CONFLICTS_URL = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=conflicts';
  const GEAR_ON_CONFLICT = '396755';
  const GEAR_NO_CONFLICT = '365299';

  // Track last gear set to avoid redundant swaps
  let lastCombatSetId = null;

async function checkConflictsAndSwapGear() {
  try {
    const resp = await secureFetch(CONFLICTS_URL, {
      credentials: 'include',
      cache: 'no-cache'
    });

    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const tbody = doc.querySelector(
      '#pCC > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(12) > td:nth-child(1) > table:nth-child(1) > tbody:nth-child(1)'
    );

    if (!tbody) {
      console.warn('[ConflictCheck] Could not find the conflicts table.');
      return;
    }

    // Verifica se há algum link com "cmd=guild" — indicando uma guilda em conflito
    const guildLinks = tbody.querySelectorAll('a[href*="cmd=guild"]');
    const inConflict = guildLinks.length > 0;

    const desiredSet = inConflict ? GEAR_ON_CONFLICT : GEAR_NO_CONFLICT;

    if (desiredSet !== lastCombatSetId) {
      const gearUrl = `https://www.fallensword.com/index.php?cmd=profile&subcmd=managecombatset&combatSetId=${desiredSet}&submit=Use`;
      await secureFetch(gearUrl, {
        credentials: 'include',
        cache: 'no-cache'
      });
      lastCombatSetId = desiredSet;
      console.log(`[GearSwap] Switched to set ${desiredSet} due to ${inConflict ? 'conflict' : 'peace'}.`);
    } else {
      console.log('[GearSwap] No gear change needed.');
    }

  } catch (error) {
    console.error('[GearSwap] Error during conflict check or gear switch:', error);
  }
}

async function fetchPreviousPvPLadder(bandId) {
  const url = `https://www.fallensword.com/index.php?cmd=pvpladder&viewing_band_id=${bandId}`;
  try {
    const response = await secureFetch(url, {
      credentials: 'include',
      cache: 'no-cache'
    });
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

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

async function fetchAllPreviousPvPLadders() {
  const allBands = {};
  for (let bandId = 1; bandId <= 19; bandId++) {
    allBands[bandId] = await fetchPreviousPvPLadder(bandId);
  }
  return allBands;
}

async function handleLadderNotification() {
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
    return new Date(`${year}-${month}-${day}T${time}:00`);
  }

  async function checkGuildLog() {
    try {
      const resp = await secureFetch(logURL);
      if (!resp.ok) return console.warn(`Log request failed: ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const rows = doc.querySelectorAll("#pCC table.width_full tbody tr");
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

        if (plainMessage.includes("has captured the relic")) {
          message = plainMessage.split("Be sure to defend")[0].trim();
          webhook = RELIC_WEBHOOK;
          who = "us";
        } else if (plainMessage.includes("has captured your relic")) {
          message = plainMessage.split("Your guild members")[0].trim();
          webhook = RELIC_WEBHOOK;
          who = "them";
        } else if (plainMessage.includes("has just initiated a conflict with")) {
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
          if (webhook === RELIC_WEBHOOK && who === "us") {
            sendDiscordMessage(
              message,
              'Relic Notification',
              15844367, // AMARELO
              embedTimestamp,
              '**RELIC TAKEN**',
              webhook
            );
          } else if (webhook === RELIC_WEBHOOK && who === "them") {
            sendDiscordMessage(
              message,
              'Relic Notification',
              16711680, // vermelho
              embedTimestamp,
              '**RELIC LOST**',
              webhook
            );
          } else {
            sendDiscordMessage(
              `${embedTimestamp} - ${message}`,
              'Guild Conflict Update',
              3447003, // azul
              embedTimestamp,
              '**CONFLICT UPDATE**',
              webhook
            );
          }

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

 async function monitorIncomingAttacks() {
    try {
      const resp = await secureFetch(conflictsURL);
      if (!resp.ok) return console.warn(`Conflict page failed: ${resp.status}`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

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

  //============================= CALLS AND INITIAL RUNS ======================================//
  // Initial run
  //checkConflictsAndSwapGear();
  checkGuildLog();
  monitorIncomingAttacks();

  // Set interval for every 10 minutes
  //setInterval(checkConflictsAndSwapGear, CHECK_INTERVAL_MS);
    // Run the checkForTitanNotifications function every hour (3600000 milliseconds)3600000
    const now = new Date();
    const timeToNextHour = (60 - now.getMinutes()) * 60 * 1000;
    //console.log('remaining time:', timeToNextHour);
    setTimeout(() => {
        checkForTitanNotifications();
        setInterval(checkForTitanNotifications, 1000 * 60 * 60);
    }, timeToNextHour);
    setInterval(checkForPvPNotifications, 1000 * 60 * 2);
    setInterval(monitorIncomingAttacks, 1000 * 60 * 6);
    setInterval(checkGuildLog, 60 * 1000);
    setInterval(checkForNewBounty, 7000);
    setInterval(checkForSuperEliteKills, 15 * 1000);
    setInterval(checkForCratesFound, 60 * 1000);
    setInterval(checkForShoutbox, 300 * 1000);
    setInterval(checkForUpdatesArchive, 300 * 1000);
    setInterval(autoJoinAllGroups, 5*60000);
})();