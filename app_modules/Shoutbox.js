// app_modules/Shoutbox.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { shoutboxWebhook } from '../webhooks.js'; 
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const SHOUTBOX_STORAGE_KEY = 'processed_shoutbox_ids';
const SHOUTBOX_HISTORY_LIMIT = 100; // Standard history limit

/**
 * Loads the set of processed shoutbox message IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed messages.
 */
function loadProcessedShouts() {
    try {
        const storedIdsJson = getContent(SHOUTBOX_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed shoutbox message IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed shoutbox message IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new shoutbox messages.
 */
export async function checkForShoutbox() {
    console.log('Checking for new shoutbox messages...');
    try {
        const processedShoutIds = loadProcessedShouts();

        const response = await secureFetch(apiEndpoints.game.shoutbox);
        if (!response.ok) throw new Error(`Failed to fetch shoutbox data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Shoutbox fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        // The API returns an object of messages, we need the values.
        const messages = Object.values(data.r);
        if (!messages || messages.length === 0) {
            return;
        }

        let newShoutsFound = false;

        for (const shout of messages.reverse()) {
            const shoutId = shout.id;
            if (processedShoutIds.has(shoutId)) {
                continue;
            }

            newShoutsFound = true;
            console.log(`New shoutbox message found! ID: ${shoutId}`);
            
            const dateTime = new Date(shout.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
            
            // Construct the player's profile image URL
            const playerProfileImage = apiEndpoints.player.profileImg(shout.player.id);

            const message = `
:left_speech_bubble: **${shout.player.name}** (Lvl ${shout.player.level}):
> ${shout.msg.text}`
.trim();

            try {
                sendExtraDiscordMessage(
                    message,
                    "Shoutbox",
                    "10494192", // A light blue color
                    `Posted at ${dateTime}`,
                    "",
                    shoutboxWebhook,
                    "", // No primary image
                    playerProfileImage // Use the player's profile image as the thumbnail
                );
                LOG('shoutbox', `Notified: Message from ${shout.player.name} (ID: ${shoutId})`);
            } catch (e) {
                ERR('shoutbox', 'Failed to send shoutbox notification to Discord', e);
            }

            processedShoutIds.add(shoutId);
        }

        if (newShoutsFound) {
            let idsToStore = Array.from(processedShoutIds);

            if (idsToStore.length > SHOUTBOX_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - SHOUTBOX_HISTORY_LIMIT);
            }
            
            setContent(SHOUTBOX_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed shoutbox message IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking the shoutbox:', error);
    }
}
