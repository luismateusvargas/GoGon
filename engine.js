// newsFeatures.js (modular orchestrator)

import { LOG, WARN, ERR } from './app_modules/core.js';
import { checkForNewBounty } from './app_modules/BountyBoard.js';
import { checkForSuperEliteKills } from './app_modules/SuperElite.js';
import { monitorIncomingAttacks } from './app_modules/GuildConflicts.js';
import { checkForCratesFound } from './app_modules/Crates.js';
import { checkForShoutbox } from './app_modules/Shoutbox.js';
import { checkForUpdatesArchive } from './app_modules/GameUpdates.js';
import { checkLadderReset } from './app_modules/Ladder.js';
import { checkForTitanNotifications } from './app_modules/Titans.js';
import { checkRelics } from './app_modules/Relics.js';
import { autoJoinAllGroups } from './app_modules/QoL.js';

import { ensureLogin } from './session.mjs';

export function initEngine() {
  console.log('initEngine invoked (modular)');
  if (typeof window !== 'undefined') {
    window.initEngine = initEngine;
    console.log('initEngine attached to window');
  }
  // Kickoff
  try { checkForNewBounty(); } catch (e) { ERR('bounty', 'kickoff', e); }
  try { checkForSuperEliteKills(); } catch (e) { ERR('se', 'kickoff', e); }
  try { checkForCratesFound(); } catch (e) { ERR('crates', 'kickoff', e); }
  try { checkForShoutbox(); } catch (e) { ERR('shoutbox', 'kickoff', e); }
  try { checkForUpdatesArchive(); } catch (e) { ERR('updates', 'kickoff', e); }
  //try { checkGuildLog(); } catch (e) { ERR('guild', 'kickoff', e); }
  try { monitorIncomingAttacks(); } catch (e) { ERR('attacks', 'kickoff', e); }
  try { checkLadderReset(); } catch (e) { ERR('pvp', 'kickoff', e); }
  try { checkForTitanNotifications(); } catch (e) { ERR('titan', 'kickoff', e); }
  try { checkRelics(); } catch (e) { ERR('relics', 'kickoff', e); } 
  try { autoJoinAllGroups(); } catch (e) { ERR('groups', 'kickoff', e); } 

  // Schedules
  const now = new Date();
  const timeToNextHour = (60 - now.getMinutes()) * 60 * 1000;
  setTimeout(() => {
    try { checkForTitanNotifications(); } catch (e) { ERR('titan', 'hourly', e); }
    setInterval(() => { try { checkForTitanNotifications(); } catch (e) { ERR('titan', 'hourly', e); } }, 1000 * 60 * 60);
  }, timeToNextHour);

  setInterval(() => { try { checkLadderReset(); } catch (e) { ERR('pvp', 'interval', e); } }, 1000 * 60 * 2);
  setInterval(() => { try { monitorIncomingAttacks(); } catch (e) { ERR('attacks', 'interval', e); } }, 1000 * 60 * 6);
  //setInterval(() => { try { checkGuildLog(); } catch (e) { ERR('guild', 'interval', e); } }, 60 * 1000); 
  setInterval(() => { try { checkForNewBounty(); } catch (e) { ERR('bounty', 'interval', e); } }, 7000);
  setInterval(() => { try { checkForSuperEliteKills(); } catch (e) { ERR('se', 'interval', e); } }, 15 * 1000);
  setInterval(() => { try { checkForCratesFound(); } catch (e) { ERR('crates', 'interval', e); } }, 60 * 1000);
  setInterval(() => { try { checkForShoutbox(); } catch (e) { ERR('shoutbox', 'interval', e); } }, 300 * 1000);
  setInterval(() => { try { checkForUpdatesArchive(); } catch (e) { ERR('updates', 'interval', e); } }, 300 * 1000);
  setInterval(() => { try { checkRelics(); } catch (e) { ERR('relics', 'interval', e); } }, 60 * 1000);
  setInterval(() => { try { autoJoinAllGroups(); } catch (e) { ERR('groups', 'interval', e); } }, 60 * 1000);
  //setInterval(() => { try { ensureLogin(); } catch (e) { ERR('login', 'interval', e); } }, 60 * 5000);
}
