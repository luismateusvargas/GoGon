// app_modules/QoL.js - Quality of Life enhancements
// Handles auto group joining and automatic gear swapping based on conflict status.

import { LOG, WARN, ERR } from './core.js';
import { secureFetch } from '../utils.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION ---
const GEAR_STATE_KEY = 'current_gear_state';
const botPlayerID = process.env.SWS_BOT_ID_CHARACTER;

// --- [ACTION REQUIRED] DEFINE YOUR EQUIPMENT SETUPS HERE ---
// Use the INVENTORY ID ('a' value) for each piece of gear.
const PEACE_GEAR_INVENTORY_IDS = new Set([
    529720295, 529878548, 529886771, 546492527, 546492529, 
    566206042, 566206043, 566206044, 569579310
]);
const WAR_GEAR_INVENTORY_IDS = new Set([
    543019687, 543019688, 546671480, 546722123, 546722124, 
    546948627, 546948628, 579943341, 579943342
]);


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
 */
async function equipItem(inventoryId) {
    try {
        LOG('gearSwap', `Equipping item with inventory ID: ${inventoryId}...`);
        await secureFetch(apiEndpoints.player.equipItem(inventoryId));
        await new Promise(resolve => setTimeout(resolve, 500)); // Short delay between actions
    } catch (error) {
        ERR('gearSwap', `Failed to equip item ${inventoryId}`, error);
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
    if (!botPlayerID) {
        WARN('gearSwap', 'FS_BOT_ID is not set in environment variables. Aborting gear swap.');
        return;
    }
    
    LOG('gearSwap', 'Checking conflict status for potential gear swap...');
    const inConflict = await isGuildInConflict();
    const desiredState = inConflict ? 'war' : 'peace';
    
    const lastKnownState = getContent(GEAR_STATE_KEY);
    if (lastKnownState === desiredState) {
        return;
    }
    
    const equippedInventoryIds = await getCurrentEquipment();
    if (!equippedInventoryIds) {
        WARN('gearSwap', 'Aborting gear swap cycle, could not fetch player equipment.');
        return;
    }
    
    LOG('gearSwap', `State change detected! Current: ${lastKnownState || 'unknown'}. Desired: ${desiredState}.`);
    const targetSetupIds = desiredState === 'war' ? WAR_GEAR_INVENTORY_IDS : PEACE_GEAR_INVENTORY_IDS;
    
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
        setContent(GEAR_STATE_KEY, desiredState);
        return;
    }

    LOG('gearSwap', `Gear swap required. Equipping ${desiredState} setup...`);

    try {
        for (const invId of targetSetupIds) {
            await equipItem(invId);
        }
        
        LOG('gearSwap', `Successfully switched to ${desiredState} gear setup!`);
        setContent(GEAR_STATE_KEY, desiredState);

    } catch (error) {
        ERR('gearSwap', 'An error occurred during the gear swap process', error);
    }
}

