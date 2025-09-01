// app_modules/BountyBoard.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch, securePostDiscord, queueDiscordMessage } from '../utils.js';


export async function checkForNewBounty() {
  try {
    // 1) Carrega a página
    const resp = await secureFetch('/index.php?cmd=bounty');
    if (resp.status !== 200) {
      console.error(`HTTP ${resp.status} ao carregar bounties`);
      return;
    }
    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, 'text/html');

  const pCC = ensurePCC(doc, html, 'checkForNewBounty');
  if (!pCC) { return; }


// Detecta explicitamente o estado "sem bounties" (sempre há tabela, mas com esta mensagem)
// CSS fornecido: #pCC > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(10) > td:nth-child(1) > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(1) > i:nth-child(1)
// Como já estamos ancorados em pCC, removemos o prefixo "#pCC >"
{
  const noBountyEl = pCC.querySelector('table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(10) > td:nth-child(1) > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(1) > i:nth-child(1)');
  const msg = (noBountyEl && noBountyEl.textContent) ? noBountyEl.textContent.trim() : '';
  if (msg && /no bounties active/i.test(msg)) {
    LOG('[bounty] Nenhuma bounty ativa no momento');
    return;
  }
}


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