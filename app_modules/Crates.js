// app_modules/Crates.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { cratesWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent,
    getItemById,
    getRealmById
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const CRATES_STORAGE_KEY = 'processed_crate_ids';
const CRATES_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed crate IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed crates.
 */
async function loadProcessedCrates() {
    try {
        const storedIdsJson = (await getContent(CRATES_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('crates', `Loaded ${storedIdsArray.length} processed crate IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('crates', 'Failed to load processed crate IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new crates found.
 */
export async function checkForCratesFound() {
LOG('crates', 'Checking for new crates...');
    try {
        const processedCrateIds = await loadProcessedCrates();

        const response = await secureFetch(apiEndpoints.game.cratesArchive);
        if (!response.ok) throw new Error(`Failed to fetch crate data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r) {
            WARN('crates', `Crate fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }

        const serverTimestamp = parseInt(data.t.split(' ')[1], 10);
        
        // 1. Filter to find only the new crates
        const newCrates = data.r.reverse().filter(crate => !processedCrateIds.has(crate.id));

        if (newCrates.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs
        LOG('crates', `Found ${newCrates.length} new crates. Claiming them now...`);
        for (const crate of newCrates) {
            await setContent(CRATES_STORAGE_KEY, crate.id, CRATES_HISTORY_LIMIT);
        }
        LOG('crates', `Claimed and saved ${newCrates.length} new crate IDs.`);

        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newCrates.map(async crate => {
            try {
                const actualTimestamp = serverTimestamp - crate.time;
                const dateTime = new Date(actualTimestamp * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });

                const realm = await getRealmById(crate.realm.realm);
                const realmName = realm ? realm.name : `Realm #${crate.realm.realm}`;
                
                let itemDrops = [];
                let firstItemImage = '';

                if (crate.items && crate.items.length > 0) {
                    for (const itemId of crate.items) {
                        const item = await getItemById(itemId);
                        if (item) {
                            itemDrops.push(item.name);
                            if (!firstItemImage) firstItemImage = item.imageUrl;
                        } else {
                            itemDrops.push(`Unknown Item (ID: ${itemId})`);
                            WARN('crates', `Crate log contained unknown item ID ${itemId}.`);
                        }
                    }
                }

                const message = `
<:chest:1421205506206203914> **${crate.name}**
:calendar_spiral: ${dateTime}
:person_running: Found by: **${crate.player.name}**
:map: at **${realmName}** (${crate.realm.x}, ${crate.realm.y})
:gift: Contains: ${itemDrops.length > 0 ? itemDrops.join(', ') : 'Nothing of value'}`.trim();

                sendExtraDiscordMessage(
                    message, "Chest Found!", "15466240", "A new chest has been discovered!",
                    "", cratesWebhook, "", firstItemImage
                );
                LOG('crates', `Notified: ${crate.name} found by ${crate.player.name}`);
            } catch (e) {
                ERR('crates', `Failed to process crate ID ${crate.id}`, e);
            }
        });

        // 4. Wait for all notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('crates', 'Error occurred while checking for crates', error);
    }
}