// app_modules/GameUpdates.js (corrigido)
import { LOG, WARN, ERR, ensurePCC, dumpHtml } from './core.js';
import { secureFetch, queueDiscordMessage } from '../utils.js';
import { parseHTML } from 'linkedom';
import { newsWebhook } from '../webhooks.js';

/**
 * Lê o arquivo de "Game Updates" (arquivo de notícias/patch notes) em
 * /index.php?cmd=&subcmd=viewupdatearchive e envia resumo ao Discord.
 * 
 * Robustez:
 * - Usa parseHTML do linkedom (nada de document.createElement).
 * - Garante #pCC via ensurePCC antes de querySelector.
 * - Envolve tudo em try/catch e loga snapshots quando #pCC faltar.
 */
export async function checkForUpdatesArchive() {
  try {
    const res = await secureFetch('index.php?cmd=&subcmd=viewupdatearchive');
    const html = await res.text();

    const { document } = parseHTML(html);
    const pCC = ensurePCC(document, html, 'checkForUpdatesArchive');
    if (!pCC) return;

    // Seleção original ancorada em #pCC (ajuste fino pode ser necessário conforme HTML real)
    const tbody = pCC.querySelector('table tbody tr:nth-of-type(5) td table tbody');
    if (!tbody) {
      WARN('[GameUpdates] Tabela principal não encontrada');
      await dumpHtml('GameUpdates_noTable', html);
      return;
    }

    // Pega as primeiras linhas (título e conteúdo do update mais recente)
    const firstTr = tbody.querySelector('tr:first-of-type');
    const thirdTr = tbody.querySelector('tr:nth-of-type(3)');
    if (!firstTr || !thirdTr) {
      WARN('[GameUpdates] Linhas esperadas (1 e 3) não encontradas');
      await dumpHtml('GameUpdates_badRows', html);
      return;
    }

    const titleTd = firstTr.querySelector('td b');
    const messageTd = thirdTr.querySelector('td');
    const title = titleTd ? titleTd.textContent.trim() : 'Game Update';
    const message = messageTd ? messageTd.textContent.trim() : '';

    if (!message) {
      WARN('[GameUpdates] Conteúdo vazio, nada a enviar');
      return;
    }

    const content = `🛠️ **${title}**\n${message}`;
    sendDiscordMessage(newsWebhook, { content });
    LOG('[GameUpdates] Update enviado ao Discord');
  } catch (e) {
    ERR('GameUpdates error', e);
  }
}
