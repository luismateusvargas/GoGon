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
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const CRATES_STORAGE_KEY = 'processed_crate_ids';
const CRATES_HISTORY_LIMIT = 100; // Standard history limit of 100

/**
 * Loads the set of processed crate IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed crates.
 */
function loadProcessedCrates() {
    try {
        const storedIdsJson = getContent(CRATES_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed crate IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed crate IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new crates found.
 */
export async function checkForCratesFound() {
    console.log('Checking for new crates...');
    try {
        const processedCrateIds = loadProcessedCrates();

        const response = await secureFetch(apiEndpoints.game.cratesArchive);
        if (!response.ok) throw new Error(`Failed to fetch crate data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Crate fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }

        const serverTimestamp = parseInt(data.t.split(' ')[1], 10);
        const crates = data.r;

        if (!crates || crates.length === 0) {
            console.log('No recent crates found.');
            return;
        }

        let newCratesFound = false;

        for (const crate of crates.reverse()) {
            const crateId = crate.id;
            if (processedCrateIds.has(crateId)) {
                continue;
            }

            newCratesFound = true;
            console.log(`New crate found! ID: ${crateId}`);

            const actualTimestamp = serverTimestamp - crate.time;
            const dateTime = new Date(actualTimestamp * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });

            const realm = getRealmById(crate.realm.realm);
            const realmName = realm ? realm.name : `Realm #${crate.realm.realm}`;
            
            let itemDrops = [];
            let firstItemImage = '';

            if (crate.items && crate.items.length > 0) {
                for (const itemId of crate.items) {
                    const item = getItemById(itemId);
                    if (item) {
                        itemDrops.push(item.name);
                        // Save the image of the first item to use as a thumbnail
                        if (!firstItemImage) {
                            firstItemImage = item.imageUrl;
                        }
                    } else {
                        itemDrops.push(`Unknown Item (ID: ${itemId})`);
                        console.warn(`Crate log contained item ID ${itemId}, but it was not found in the database.`);
                    }
                }
            }

            const message = `
<:chest:1421205506206203914> **${crate.name}**
:calendar_spiral: ${dateTime}
:person_running: Found by: **${crate.player.name}**
:map: at **${realmName}** (${crate.realm.x}, ${crate.realm.y})
:gift: Contains: ${itemDrops.length > 0 ? itemDrops.join(', ') : 'Nothing of value'}`
.trim();

            try {
                sendExtraDiscordMessage(
                    message,
                    "Chest Found!",
                    "15466240", // A golden/yellow color
                    "A new chest has been discovered!",
                    "",
                    cratesWebhook,
                    "", // No primary image for crates
                    firstItemImage // Use the first item's image as the thumbnail
                );
                LOG('crates', `Notified: ${crate.name} found by ${crate.player.name}`);
            } catch (e) {
                ERR('crates', 'Failed to send crate notification to Discord', e);
            }

            processedCrateIds.add(crateId);
        }

        if (newCratesFound) {
            let idsToStore = Array.from(processedCrateIds);

            if (idsToStore.length > CRATES_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - CRATES_HISTORY_LIMIT);
            }
            
            setContent(CRATES_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed crate IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking for crates:', error);
    }
}
