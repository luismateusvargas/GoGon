// ==UserScript==
// @name         Coletar ID e Nome das Guilds
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Coleta ID e Nome de cada guild em https://www.fallensword.com/index.php?cmd=guild&subcmd=atoz
// @author       Você
// @match        https://www.fallensword.com/index.php?cmd=points&subcmd=redeem
// @grant        GM_xmlhttpRequest
// ==/UserScript==

const guildsWebhook = "https://discord.com/api/webhooks/1199898926925488209/A5dkxqq2_9rtE2MqPRMQ3Tom-twIjMyHSfEPy8mKFa5qfh8IseBpL8PG54juny_fDc60";

(async function() {
    'use strict';

    // Função para enviar mensagem para o Discord de forma assíncrona
async function sendDiscordMessageAsync(message, wTitle, colorCode, footerText, group, webhook) {
    return new Promise((resolve) => {
        const embed = {
            title: wTitle,
            description: message,
            color: colorCode,
            footer: {
                text: footerText
            }
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: webhook,
            headers: {
                "Content-Type": "application/json"
            },
            data: JSON.stringify({
                content: group,
                embeds: [embed]
            }),
            onload: function () {
                resolve();
            }
        });
    });
}

    // Função para extrair ID e Nome de uma guild
    function extractGuildInfo(guildElement) {
        const guildLinkElement = guildElement.querySelector('a');
        if (!guildLinkElement) {
            // O link da guild não foi encontrado, retorne um objeto vazio
            return { id: null, name: null };
        }

        const guildId = guildLinkElement.href.match(/guild_id=(\d+)/)[1];
        const guildName = guildLinkElement.textContent.trim();
        return { id: guildId, name: guildName };
    }

    // Função para coletar informações de uma página de guild
async function collectGuildInfoPage(url) {
    const response = await fetch(url);
    const htmlString = await response.text();
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');

    const guilds = [];

    const guildTable = doc.querySelector('#pCC > table > tbody > tr:nth-child(4) > td > table:nth-child(2) > tbody > tr:nth-child(6) > td > table');
    if (guildTable) {
        const guildRows = guildTable.querySelectorAll('tbody > tr');

        for (let i = 3; i < guildRows.length; i += 4) {
            const guildLinkElement = guildRows[i].querySelector('td:nth-child(2) a');
            const guildMembersElement = guildRows[i].nextElementSibling.querySelector('td');

            if (guildLinkElement && guildMembersElement) {
                const guildIdMatch = guildLinkElement.getAttribute('href').match(/guild_id=(\d+)/);
                const guildName = guildLinkElement.textContent.trim();
                const guildId = guildIdMatch ? parseInt(guildIdMatch[1], 10) : null;
                const memberCount = parseInt(guildMembersElement.textContent, 10);

                if (guildId && guildName && memberCount >= 4) {
                    guilds.push({ id: guildId, name: guildName });
                }
            }
        }
    }

    return { guilds, doc };
}

    // Função para verificar se há mais páginas
    function hasMorePages(doc) {
        return doc.querySelector('.pagenumber.current + .pagenumber a') !== null;
    }

    // Função para coletar informações de todas as páginas e letras
   async function collectAllGuilds() {
    const allGuilds = [];

    const letters = [...Array(10).keys()].map(num => num.toString()).concat([...Array(26)].map((val, index) => String.fromCharCode(index + 65)));

    for (const letter of letters) {
        const url = `https://www.fallensword.com/index.php?cmd=guild&subcmd=atoz&letter=${letter}`;
        console.log('Visitando:', url);

        const { guilds: currentPageGuilds } = await collectGuildInfoPage(url);

        if (currentPageGuilds.length === 0) {
            // Não há guilds nesta letra
            continue;
        }

        allGuilds.push(...currentPageGuilds);
    }

    return allGuilds;
}

    // Função para coletar informações detalhadas de uma guild, incluindo membros
async function collectGuildDetails(guildId) {
    const guildDetailsUrl = `https://www.fallensword.com/index.php?cmd=guild&subcmd=view&guild_id=${guildId}`;
    const response = await fetch(guildDetailsUrl);
    const htmlString = await response.text();
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');

    const guildDetails = {
        guildId,
        // Outras informações da guild podem ser adicionadas aqui
        // Exemplo: guildName: doc.querySelector('.guildNameClass').textContent.trim(),
        // ...

        // Coletar lista de membros
        members: [],
    };

    const memberTable = doc.querySelector('#pCC > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(1) > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(2) > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(7) > td:nth-child(1) > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(3)');

    if (memberTable) {
        const memberRows = memberTable.querySelectorAll('tr');

        for (let i = 1; i < memberRows.length; i += 3) {
            const playerName = memberRows[i].querySelector('td:nth-child(1)').textContent.trim();
            const playerInfo = memberRows[i].querySelector('td:nth-child(2)').getAttribute('data-tipped');

            // Extrair informações específicas de data-tipped
            const matchVL = /VL:<\/td><td>(\d+)<\/td>/.exec(playerInfo);
            const matchLastActivity = /Last Activity:<\/td><td>([\s\S]+?)<\/td>/.exec(playerInfo);

            const VL = matchVL ? parseInt(matchVL[1], 10) : null;
            const lastActivity = matchLastActivity ? matchLastActivity[1].trim() : null;

            // Checar condições
            if (VL !== null && lastActivity !== null && VL >= 5499 && lastActivity < '7d') {
                guildDetails.members.push({ name: playerName, VL, lastActivity });
            }
        }
    }

    return guildDetails;
}


// Função para dividir o array em grupos de tamanho especificado
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Coleta informações de todas as páginas e letras
const allGuilds = await collectAllGuilds();
console.log('Todas as Guilds:', allGuilds);

// Coleta detalhes de cada guild
for (const guild of allGuilds) {
    const guildDetails = await collectGuildDetails(guild.id);
    console.log('Detalhes da Guild:', guildDetails);
}
// Dividir as guilds em grupos de 77
const guildChunks = chunkArray(allGuilds, 77);

// Enviar para o Discord via webhook em grupos de 77 de forma sequencial
for (let index = 0; index < guildChunks.length; index++) {
    const guildChunk = guildChunks[index];
    const messageTitle = `Guilds List (Part ${index + 1})`;
    const messageContent = guildChunk.map(guild => `ID: ${guild.id}, Guild Name: ${guild.name}`).join('\n');

    // Aguardar o envio da mensagem antes de passar para a próxima parte
    await sendDiscordMessageAsync(messageContent, messageTitle, 16711680, 'Last 30 Days Active Guilds', '', guildsWebhook);

    console.log(`Parte ${index + 1} enviada para o Discord.`);
}

console.log('Coleta de guilds concluída.');


})();
