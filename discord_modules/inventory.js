import { secureFetch, getBuffs } from '../utils.js';
import { getSetting } from '../config/runtime.mjs';
import { LOG, WARN, ERR } from '../app_modules/core.js';
import { apiEndpoints } from '../game_modules/API.js';
import { quickBuff, NAME_TO_ID, ID_TO_NAME, toBuffsList } from './buffs.js';

// --- CONFIGURATION ---
// /bebuff is not role-gated (owner decision 2026-09-24).
const FOLDER_NAME = 'Main';

// --- POTION & SKILL DEFINITIONS ---
const ITEM_IDS = {
    ZOMBIE_BREW: '11503',
    BREWERS_ART: '10252',
    PONTIUS_EGG: '14059'
};

const BUFF_IDS = {
    PRIDE: 133,
    BUFF_ENHANCER: 129
};

// --- Dynamically find the skill ID for Brewing Master ---
const BREWING_MASTER_SKILL_ID = NAME_TO_ID['brewing master'];

const POTION_TO_BUFF_MAP = {
    'Zombie Brew': 'distil',
    'Pride Potion': 'pride',
    'Brewing Master Potion': 'brewing master',
    'Buff Enhancer Potion': 'buff enhancer'
};

// (getPotionsFromInventory and useItem functions remain unchanged)
async function getPotionsFromInventory() {
    try {
        const response = await secureFetch(apiEndpoints.player.inventory);
        const data = await response.json();
        if (!data.s || !Array.isArray(data.r?.inventories)) {
            WARN('BE-Sequence', 'Inventory data format was unexpected.');
            return [];
        }
        const potFolder = data.r.inventories.find(inv => inv.name === FOLDER_NAME);
        if (!potFolder || !Array.isArray(potFolder.items)) {
            WARN('BE-Sequence', `Could not find an inventory folder named "${FOLDER_NAME}".`);
            return [];
        }
        return potFolder.items;
    } catch (e) {
        ERR('BE-Sequence', 'Failed while fetching or parsing inventory data.', e);
        return [];
    }
}

async function useItem(inventoryId) {
    const response = await secureFetch(apiEndpoints.player.useItem(inventoryId));
    return response.ok;
}

// In discord_modules/inventory.js

export async function useBESequence(interaction) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const normName = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    await interaction.deferReply();

    // 1. CHECK ACTIVE BUFFS
    await interaction.editReply('⌛ Checking for active potion buffs...');
    const activeBuffs = new Set();
    const selfID = getSetting('GG_BOT_ID_CHARACTER'); // GG_ wins over legacy SWS_/FS_
    try {
        const buffs = toBuffsList(await getBuffs(apiEndpoints.player.activeBuffs(selfID)));
        const selfBuffNames = buffs.map(b => ID_TO_NAME[b.id] || '');
        selfBuffNames.forEach(name => activeBuffs.add(normName(name)));
    } catch (e) {
        ERR('BE-Sequence', 'Could not fetch active buffs.', e);
        await interaction.editReply('❌ Failed to check active buffs. Aborting.');
        return { ok: false, message: 'Failed to fetch buffs' };
    }

    if (activeBuffs.has('buff enhancer')) {
        return { ok: true, alreadyActive: true, used: [], message: 'Buff Enhancer is already active.' };
    }

    const neededPotions = Object.entries(POTION_TO_BUFF_MAP)
        .filter(([potName, buffName]) => !activeBuffs.has(normName(buffName)))
        .map(([potName]) => potName);

    if (neededPotions.length === 0) {
        return { ok: true, alreadyActive: true, used: [], message: 'All required potion buffs are already active.' };
    }

    // 2. FIND AVAILABLE POTIONS
    await interaction.editReply(`⌛ Searching for required potions in the "${FOLDER_NAME}" folder...`);
    const inventoryItems = await getPotionsFromInventory();
    const foundPotions = {};

    for (const item of inventoryItems) {
        // Find simple potions (stop after finding one of each)
        if (!foundPotions['Zombie Brew'] && item.b == ITEM_IDS.ZOMBIE_BREW) {
            foundPotions['Zombie Brew'] = item.a;
        }
        if (!foundPotions['Brewing Master Potion'] && (item.b == ITEM_IDS.BREWERS_ART || item.b == ITEM_IDS.PONTIUS_EGG)) {
            foundPotions['Brewing Master Potion'] = item.a;
        }

        // --- FIX: Check item.x.bu for composed potions ---
        if (item.x && Array.isArray(item.x.bu)) {
            for (const buff of item.x.bu) {
                if (!foundPotions['Pride Potion'] && buff.id === BUFF_IDS.PRIDE) {
                    foundPotions['Pride Potion'] = item.a;
                }
                if (!foundPotions['Buff Enhancer Potion'] && buff.id === BUFF_IDS.BUFF_ENHANCER) {
                    foundPotions['Buff Enhancer Potion'] = item.a;
                }
            }
        }
        // ---------------------------------------------
    }

    // 3. --- BUILD ORDERED ACTION PLAN ---
    const plannedActions = [];
    const missingItems = [];
    const activationOrder = ['Zombie Brew', 'Pride Potion', 'Brewing Master Potion', 'Buff Enhancer Potion'];

    for (const potName of activationOrder) {
        if (neededPotions.includes(potName)) {
            if (foundPotions[potName]) {
                plannedActions.push({ type: 'potion', name: potName, payload: foundPotions[potName] });
            } else if (potName === 'Brewing Master Potion') {
                plannedActions.push({ type: 'skill', name: 'Brewing Master', payload: BREWING_MASTER_SKILL_ID });
            } else {
                missingItems.push(potName);
            }
        }
    }

    if (missingItems.length > 0) {
        const message = `❌ **Failed:** Could not find all required items. Missing: ${missingItems.map(p => `**${p}**`).join(', ')}`;
        await interaction.editReply(message);
        return { ok: false, message };
    }

    // 4. --- EXECUTE PLANNED ACTIONS IN SEQUENCE ---
    const usedItems = [];
    const selfName = getSetting('GG_BOT_CHARACTER');

    for (const action of plannedActions) {
        if (action.type === 'potion') {
            await interaction.editReply(`⌛ Using **${action.name}**...`);
            const ok = await useItem(action.payload);
            if (!ok) {
                const message = `❌ **Failed:** An error occurred while using **${action.name}**.`;
                await interaction.editReply(message);
                return { ok: false, used: usedItems, message };
            }
            usedItems.push(action.name);
        } else if (action.type === 'skill') {
            await interaction.editReply(`⌛ No potion found. Casting **${action.name}** from skill book...`);
            await quickBuff(selfName, [action.payload]);
            usedItems.push(action.name);
        }
        await sleep(1200);
    }

    return { ok: true, alreadyActive: false, used: usedItems, message: 'Potions and skills applied successfully.' };
}