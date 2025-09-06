// app_modules/BountyBoard.js (robusto + Gold/Buffs + formatação original + sendExtraDiscordMessage)
import { LOG, WARN, ERR, ensurePCC, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage, getContent, setContent } from '../utils.js';
import { bountyWebhook, BountyGroup } from '../webhooks.js';

/** Texto limpo */
function txt(n) {
  return (n?.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g,' ').trim();
}
/** Parser HTML */
function toDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }
/** Storage */
function getPostedSet() {
  try { const raw = getContent('bounty_posted_ids') || '[]'; const arr = JSON.parse(raw); if (Array.isArray(arr)) return new Set(arr); } catch {}
  return new Set();
}
function savePostedSet(s) {
  try { const arr = Array.from(s); if (arr.length > 500) arr.splice(0, arr.length - 500); setContent('bounty_posted_ids', JSON.stringify(arr)); } catch {}
}

/** Gold em mão do alvo */
export async function getGoldInHand(targetLink) {
  try {
    const resp = await secureFetch(targetLink);
    const html = await resp.text();
    const doc = toDoc(html);
    const goldEl = doc.querySelector('#stat-gold') || doc.querySelector('[id*="stat-gold"]');
    if (goldEl) return txt(goldEl);
    const maybe = Array.from(doc.querySelectorAll('#profileLeftColumn td, #profileLeftColumn div, #profileRightColumn td, #profileRightColumn div'))
      .map(el => txt(el)).find(t => /^gold[:\s]/i.test(t));
    if (maybe) return maybe.replace(/^gold[:\s]*/i, '').trim();
  } catch (e) { WARN('bounty', 'getGoldInHand falhou: ' + (e?.message || e)); }
  return null;
}

/** Buffs do alvo */
export async function getBuffs(targetLink) {
  try {
    const resp = await secureFetch(targetLink);
    const html = await resp.text();
    const doc = toDoc(html);

    const imgs = Array.from(doc.querySelectorAll('img[data-tipped]'));
    const buffNameAndLevel = [];
    for (const img of imgs) {
      const tipped = img.getAttribute('data-tipped') || '';
      if (!tipped || !/Level:\s*\d+/i.test(tipped)) continue;
      try {
        const tipDoc = toDoc(tipped);
        const name = txt(tipDoc.querySelector('span > b')) || '';
        const levelSpan = txt(tipDoc.querySelector('span')) || '';
        const m = /Level:\s*(\d+)/i.exec(levelSpan);
        const level = m ? m[1] : '';
        if (name) buffNameAndLevel.push({ name, level });
      } catch {}
    }
    let hasDeflect = false, isCloaked = false;
    for (const b of buffNameAndLevel) {
      const n = (b.name || '').toLowerCase();
      if (n === 'deflect') hasDeflect = true;
      if (n === 'cloak') isCloaked = true;
    }
    return { hasDeflect, isCloaked, numberOfBuffs: buffNameAndLevel.length };
  } catch (e) {
    WARN('bounty', 'getBuffs falhou: ' + (e?.message || e));
    return { hasDeflect: false, isCloaked: false, numberOfBuffs: 0 };
  }
}

/** Procura linhas com botão "Accept" */
function parseBountyRows(pCC) {
  const rows = Array.from(pCC.querySelectorAll('tr'));
  const out = [];
  for (const tr of rows) {
    const acceptBtn = tr.querySelector('input[type="button"][value="Accept"]');
    if (!acceptBtn) continue;
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 7) continue;

    const targetCell  = tds[0];
    const offererCell = tds[1];
    const rewardCell  = tds[2];
    const xpCell      = tds[3];
    const timeCell    = tds[4];
    const ticketsCell = tds[5];

    const onclick = acceptBtn.getAttribute('onclick') || '';
    const idMatch = /bounty_id=(\d+)/.exec(onclick);
    const bountyId = idMatch ? idMatch[1] : null;

    const targetLink = targetCell.querySelector('a[href*="cmd=profile"]');
    const targetName = txt(targetLink);
    const levelMatch = txt(targetCell).match(/\[([\d,]+)\]/); /* /\[([\d,]+)\]/.exec(txt(targetCell));*/
    const targetLevel = levelMatch ? levelMatch[0] : '';

    const offerer = txt(offererCell.querySelector('a[href*="cmd=profile"]') || offererCell);
    const reward  = txt(rewardCell);
    const xpLossRemaining = txt(xpCell);
    const timeLeft  = txt(timeCell);
    const ticketsReq = txt(ticketsCell);

    // tentativa de imagem para o embed (primeira imagem da linha: alvo/recompensa)
    const img = (targetCell.querySelector('img') || rewardCell.querySelector('img') || tr.querySelector('img'));
    const imgSrc = img ? (img.getAttribute('src') || img.src || '') : '';

    out.push({
      bountyId, targetName, targetLevel, offerer, reward,
      xpLossRemaining, timeLeft, ticketsReq, targetProfileUrl: targetLink?.href || null, imgSrc
    });
  }
  return out;
}

export async function checkForNewBounty() {
  try {
    const url = 'https://www.fallensword.com/index.php?cmd=bounty';
    const resp = await secureFetch(url);
    if (!resp || !resp.ok) { WARN('bounty', `Falha HTTP: ${resp ? resp.status : '??'}`); return; }
    const html = await resp.text();
    const doc = toDoc(html);
    const pCC = ensurePCC(doc, html, 'checkForNewBounty');
    if (!pCC) return;

    //dumpHtml && dumpHtml('bounty_board', url, html);
    pCC.querySelectorAll('script, style').forEach(n => n.remove());

    const rows = parseBountyRows(pCC);
    if (!rows.length) { LOG('bounty', 'Nenhuma bounty disponível.'); return; }

    const posted = getPostedSet();
    let touched = false;

    for (const b of rows) {
      const key = b.bountyId || `${b.targetName}|${b.offerer}|${b.reward}|${b.xpLossRemaining}`;
      if (posted.has(key)) continue;

      let goldInHand = null;
      let buffs = { hasDeflect: false, isCloaked: false, numberOfBuffs: 0 };
      if (b.targetProfileUrl) {
        try {
          [goldInHand, buffs] = await Promise.all([ getGoldInHand(b.targetProfileUrl), getBuffs(b.targetProfileUrl) ]);
        } catch {}
      }

      const message = `
:hammer: Target: ${b.targetName} ${b.targetLevel}
:scales: Offerer: ${b.offerer}
:moneybag: Reward: ${b.reward}
:money_with_wings: Gold in hand: ${goldInHand ?? '-'}
:shield: Deflect ? ${buffs.hasDeflect}
:mage: Cloaked ? ${buffs.isCloaked}
:crystal_ball: Buffs Number: ${buffs.numberOfBuffs}
      `.trim();

      // Assinatura EXATA solicitada
      try {
        sendExtraDiscordMessage(
          message,
          "Bounty Board",
          "16711680",
          "Gotta Smash'em all!",
          BountyGroup,
          bountyWebhook,
          "",
          b.imgSrc || ""
        );
        LOG('bounty', `Notificado: ${b.targetName} (id=${b.bountyId || 'n/a'})`);
        posted.add(key);
        touched = true;
      } catch (e) {
        ERR('bounty', 'Falha ao enviar bounty para Discord', e);
      }
    }

    if (touched) savePostedSet(posted);
  } catch (err) {
    console.error('checkForNewBounty falhou:', err);
  }
}
