// app_modules/QoL.js - Quality of Life enhancements
// Handles auto group joining and automatic gear swapping based on conflict status.
// Project: GoGon (GG)

import { LOG, WARN, ERR } from './core.js';
import { secureFetch } from '../utils.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getObject,
    setObject
} from '../_gg_data/handler/gg_database.js';
import { STORAGE_KEYS, DELAYS } from './constants.js';
import { getSetting } from '../config/runtime.mjs';

// --- CONFIGURATION ---
const GEAR_STATE_KEY = STORAGE_KEYS.GEAR_STATE;
// --- GEAR CONFIGURATION ---
// Hot registry settings (CTRL-TASK-001): read on every run, so dashboard changes apply next cycle.
const getBotPlayerId = () => getSetting('GG_BOT_ID_CHARACTER');
const parseGearIds = key => new Set(
    getSetting(key)
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id))
);

// Validate configuration on module load
const botPlayerID = getBotPlayerId();
const PEACE_GEAR_INVENTORY_IDS = parseGearIds('GG_PEACE_GEAR_IDS');
const WAR_GEAR_INVENTORY_IDS = parseGearIds('GG_WAR_GEAR_IDS');
if (!botPlayerID) {
    WARN('gearSwap', 'GG_BOT_ID_CHARACTER not configured in .env. Gear swapping will be disabled.');
}
if (PEACE_GEAR_INVENTORY_IDS.size === 0) {
    WARN('gearSwap', 'GG_PEACE_GEAR_IDS not configured in .env. Gear swapping will not work for peace mode.');
}
if (WAR_GEAR_INVENTORY_IDS.size === 0) {
    WARN('gearSwap', 'GG_WAR_GEAR_IDS not configured in .env. Gear swapping will not work for war mode.');
}

// --- Helper Functions for Gear Swapping ---

/**
 * Fetches the currently equipped items' INVENTORY IDs.
 * @returns {Promise<Set<number>|null>} A Set of inventory IDs ('a' values).
 */
async function getCurrentEquipment() {
    try {
        const response = await secureFetch(apiEndpoints.player.ownDetails);
        const data = await response.json();
        if (!data.s) {
            WARN('gearSwap', 'Could not retrieve player details from API.');
            return null;
        }
        // [FIXED] Access the correct path for equipped items
        const equippedItems = new Set(data.r.equipped_items.map(item => item.a));
        return equippedItems;
    } catch (error) {
        ERR('gearSwap', 'Failed to get current equipment, likely due to an invalid session.', error.message);
        return null;
    }
}

/**
 * Equips a single item by its inventory ID.
 * @param {number} inventoryId - The 'a' value of the item in the inventory.
 * @returns {Promise<boolean>} True when the equip request succeeded.
 */
async function equipItem(inventoryId) {
    try {
        LOG('gearSwap', `Equipping item with inventory ID: ${inventoryId}...`);
        const response = await secureFetch(apiEndpoints.player.equipItem(inventoryId));
        await new Promise(resolve => setTimeout(resolve, DELAYS.BETWEEN_EQUIPS)); // Short delay between actions
        if (!response.ok) {
            ERR('gearSwap', `Failed to equip item ${inventoryId}: status ${response.status}`);
            return false;
        }
        return true;
    } catch (error) {
        ERR('gearSwap', `Failed to equip item ${inventoryId}`, error);
        return false;
    }
}

/**
 * Checks if the player's guild is currently in a conflict.
 * @returns {Promise<boolean>}
 */
async function isGuildInConflict() {
    try {
        const response = await secureFetch(apiEndpoints.guild.conflicts);
        const data = await response.json();
        return data.s && data.r?.conflicts && data.r.conflicts.length > 0;
    } catch (error) {
        ERR('gearSwap', 'Could not determine conflict status', error);
        return false;
    }
}


// --- Main Public Functions ---

export async function autoJoinAllGroups() {
  const url = 'https://www.fallensword.com/index.php?cmd=guild&subcmd=groups&subcmd2=joinall';
  try {
    const response = await secureFetch(url);
    if (response.ok) {
        LOG('QoL', 'Successfully sent request to join all groups.');
    } else {
        WARN('QoL', `JoinAll request failed with status: ${response.status}`);
    }
  } catch (error) {
    ERR('QoL', 'JoinAll fetch error', error);
  }
}


export async function checkAndSwapGear() {
    if (!getBotPlayerId()) {
        WARN('gearSwap', 'GG_BOT_ID_CHARACTER is not set in environment variables. Aborting gear swap.');
        return;
    }
    
    LOG('gearSwap', 'Checking conflict status for potential gear swap...');
    const inConflict = await isGuildInConflict();
    const desiredState = inConflict ? 'war' : 'peace';
    
    // Scalar state saved with setObject; legacy list-wrapped values are unwrapped. MON-TASK-002 / AC-MON-003
    const lastKnownState = await getObject(GEAR_STATE_KEY, '');
    if (lastKnownState === desiredState) {
        return;
    }
    
    const equippedInventoryIds = await getCurrentEquipment();
    if (!equippedInventoryIds) {
        WARN('gearSwap', 'Aborting gear swap cycle, could not fetch player equipment.');
        return;
    }
    
    LOG('gearSwap', `State change detected! Current: ${lastKnownState || 'unknown'}. Desired: ${desiredState}.`);
    const targetSetupIds = parseGearIds(desiredState === 'war' ? 'GG_WAR_GEAR_IDS' : 'GG_PEACE_GEAR_IDS');
    
    let needsSwap = false;
    if (equippedInventoryIds.size !== targetSetupIds.size) {
        needsSwap = true;
    } else {
        for (const invId of targetSetupIds) {
            if (!equippedInventoryIds.has(invId)) {
                needsSwap = true;
                break;
            }
        }
    }

    if (!needsSwap) {
        LOG('gearSwap', `Current gear already matches the desired ${desiredState} setup. Updating state.`);
        await setObject(GEAR_STATE_KEY, desiredState);
        return;
    }

    LOG('gearSwap', `Gear swap required. Equipping ${desiredState} setup...`);

    try {
        let failed = 0;
        for (const invId of targetSetupIds) {
            if (!(await equipItem(invId))) failed++;
        }

        // AC-MON-003: leave the stored state unchanged so the next cycle retries
        if (failed > 0) {
            ERR('gearSwap', `${failed} of ${targetSetupIds.size} equip requests failed; ${desiredState} setup incomplete, will retry next cycle.`);
            return;
        }

        LOG('gearSwap', `Successfully switched to ${desiredState} gear setup!`);
        await setObject(GEAR_STATE_KEY, desiredState);

    } catch (error) {
        ERR('gearSwap', 'An error occurred during the gear swap process', error);
    }
}

