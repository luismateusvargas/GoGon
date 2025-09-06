// app_modules/QoL.js (robust)
// Reforço de qualidade de vida: join em grupos + troca automática de set em conflitos.
import { LOG, WARN, ERR, ensurePCC, dumpHtml } from './core.js';
import { secureFetch, getContent, setContent } from '../utils.js';

/**
 * Faz JOIN em todos os grupos de uma vez.
 * Mantém logs e opcionalmente grava o HTML para debug.
 */
export async function autoJoinAllGroups() {
  const url = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=groups&subcmd2=joinall';
  try {
    const response = await secureFetch(url, { credentials: 'include', cache: 'no-cache' });
    const ok = response && (response.status === 200);
    LOG('QoL', `JoinAll status ${response?.status ?? '??'}`);
    try {
      const html = await response.text();
      if (html && /success|joined|added/i.test(html)) {
        LOG('QoL', 'All groups joined.');
      } else {
        WARN('QoL', 'JoinAll sem confirmação evidente; verifique se já estava em todos os grupos.');
      }
      //if (dumpHtml) dumpHtml('guild_joinall', url, html);
    } catch {}
    return ok;
  } catch (error) {
    ERR('QoL', 'JoinAll fetch error', error);
    return false;
  }
}

/**
 * Lê estado de conflito da guilda a partir da página de Conflicts.
 * Retorna { inConflict: boolean, incoming: number }.
 */
export async function isGuildInConflict() {
  const url = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=conflicts';
  try {
    const resp = await secureFetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!resp || resp.status !== 200) {
      WARN('QoL', `Conflicts HTTP ${resp?.status ?? '??'}`);
      return { inConflict: false, incoming: 0 };
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pCC = ensurePCC(doc, html, 'isGuildInConflict');
    if (!pCC) return { inConflict: false, incoming: 0 };
    // Limpa scripts/estilos
    pCC.querySelectorAll('script, style').forEach(n => n.remove());

    // Heurística 1: procurar linhas com "Incoming Attacks: N"
    let incoming = 0;
    const rows = Array.from(pCC.querySelectorAll('tr'));
    for (const tr of rows) {
      const text = (tr.textContent || '').toLowerCase();
      const m = /incoming attacks[:\s]*([0-9]+)/i.exec(text);
      if (m) {
        const val = parseInt(m[1], 10);
        if (!Number.isNaN(val)) incoming = Math.max(incoming, val);
      }
    }

    // Heurística 2: detectar frases de conflito
    const raw = (pCC.textContent || '').toLowerCase();
    const conflictHints = [
      /has just initiated a conflict with/i,
      /your conflict with/i,
      /defend/i,
      /attack/i,
      /incoming attacks/i,
      /conflict/i,
    ];
    const inConflict = incoming > 0 || conflictHints.some(re => re.test(raw));

    //if (dumpHtml) dumpHtml('guild_conflicts', url, html);
    return { inConflict, incoming };
  } catch (e) {
    ERR('QoL', 'isGuildInConflict error', e);
    return { inConflict: false, incoming: 0 };
  }
}

/**
 * Troca automaticamente o Combat Set conforme status de conflito.
 * - conflictSetId: ID do set para guerra
 * - peaceSetId:    ID do set para paz
 * Para evitar "ping-pong", mantém última troca em storage e só muda quando necessário.
 */
export async function gearSwapOnConflict(conflictSetId, peaceSetId) {
  if (!conflictSetId || !peaceSetId) {
    WARN('QoL', 'gearSwapOnConflict requer conflictSetId e peaceSetId.');
    return false;
  }

  try {
    const { inConflict } = await isGuildInConflict();
    const desiredSet = inConflict ? conflictSetId : peaceSetId;

    // Consulta último set aplicado (persistente)
    let lastSet = null;
    try { lastSet = getContent('qol_last_combat_set') || null; } catch {}
    if (lastSet && String(lastSet) === String(desiredSet)) {
      LOG('QoL', `[GearSwap] Já está no set ${desiredSet}; nada a fazer.`);
      return true;
    }

    // Endpoint oficial para trocar set:
    //   index.php?cmd=profile&subcmd=managecombatset&combatSetId=<ID>&submit=Use
    const url = `https://www.fallensword.com/index.php?cmd=profile&subcmd=managecombatset&combatSetId=${encodeURIComponent(desiredSet)}&submit=Use`;
    const resp = await secureFetch(url, { credentials: 'include', cache: 'no-cache' });
    const ok = resp && resp.status === 200;

    // Verificação leve pelo HTML (opcional)
    try {
      const html = await resp.text();
      if (dumpHtml) dumpHtml('gear_swap', url, html);
      // Em alguns temas, o set selecionado aparece como "Using" ou marcado no select.
      if (!/using|current|selected|combat set/i.test(html)) {
        WARN('QoL', 'Swap de set sem confirmação explícita no HTML (pode ser normal).');
      }
    } catch {}

    if (ok) {
      setContent('qol_last_combat_set', String(desiredSet));
      LOG('QoL', `[GearSwap] Troquei para o set ${desiredSet} pois estamos em ${inConflict ? 'conflito' : 'paz'}.`);
    } else {
      WARN('QoL', `[GearSwap] HTTP ${resp?.status ?? '??'} ao trocar para set ${desiredSet}.`);
    }
    return ok;
  } catch (error) {
    ERR('QoL', 'Erro no gearSwapOnConflict', error);
    return false;
  }
}
