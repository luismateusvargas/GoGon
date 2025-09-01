// app_modules/QoL.js
import { LOG, WARN, ERR, waitForPCC, ensurePCC, selectRowsResilient, dumpHtml } from './core.js';
import { secureFetch } from '../utils.js';

export async function autoJoinAllGroups() {
  try {
    const response = await secureFetch('https://www.fallensword.com/index.php?cmd=guild&subcmd=groups&subcmd2=joinall', {
      credentials: 'include',
      cache: 'no-cache'
    });
    LOG('QoL', `JoinAll status ${response.status}`);
  } catch (error) {
    ERR('QoL', 'JoinAll fetch error', error);
  }
}

export async function checkConflictsAndSwapGear() {
  try {
    const resp = await secureFetch(CONFLICTS_URL, {
      credentials: 'include',
      cache: 'no-cache'
    });

    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

  const pCC = ensurePCC(doc, (typeof html !== 'undefined' ? html : (doc?.documentElement?.outerHTML ?? null)), 'checkConflictsAndSwapGear');
  if (!pCC) { return; }


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