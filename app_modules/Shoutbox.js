// app_modules/Shoutbox.js (corrigido)
import { LOG, WARN, ERR, ensurePCC, dumpHtml } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { parseHTML } from 'linkedom';
import { shoutboxWebhook } from '../webhooks.js';

/**
 * Lê a shoutbox da página de news em /index.php?cmd=news
 * e envia cada shout como mensagem no Discord.
 * 
 * Robustez:
 * - Usa parseHTML do linkedom; não usa document.createElement.
 * - Garante #pCC via ensurePCC antes de querySelector.
 * - Protege todos os querySelector encadeados com checagem nula.
 */
export async function checkForShoutbox() {
  try {
    const res = await secureFetch('index.php?cmd=news');
    const html = await res.text();

    const { document } = parseHTML(html);
    const pCC = ensurePCC(document, html, 'checkForShoutbox');
    if (!pCC) return;

    const shoutboxDiv = pCC.querySelector('div.float_right div.news_shoutbox');
    if (!shoutboxDiv) {
      WARN('[Shoutbox] Container da shoutbox não encontrado');
      await dumpHtml('Shoutbox_noContainer', html);
      return;
    }

    const shouts = shoutboxDiv.querySelectorAll('div.shout');
    if (!shouts || shouts.length === 0) {
      WARN('[Shoutbox] Nenhum shout encontrado');
      return;
    }

    for (const shout of shouts) {
      const headLeft = shout.querySelector('div.shout_head_left');
      const headRight = shout.querySelector('div.shout_head_right');
      const body = shout.querySelector('div.shout_body');

      const playerName = headLeft?.textContent?.trim() || 'Unknown';
      const messageDate = headRight?.textContent?.trim() || '';
      const messageContent = body?.textContent?.trim() || '';

      if (!messageContent) continue;

      let discordMessage = `
:loudspeaker: Player: ${playerName}
:calendar: Date: ${messageDate}
:page_facing_up: Message: ${messageContent}
`;
      sendExtraDiscordMessage(discordMessage, "Shoutbox", "16711680", "We should just report it!", "", shoutboxWebhook, "", "");
      //queueDiscordMessage(shoutboxWebhook, { content });
    }

    LOG(`[Shoutbox] ${shouts.length} mensagem(ens) processada(s)`);
  } catch (e) {
    ERR('Shoutbox error', e);
  }
}
