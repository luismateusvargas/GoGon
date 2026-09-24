// app_modules/Shoutbox.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { shoutboxWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const SHOUTBOX_STORAGE_KEY = 'processed_shoutbox_ids';
const SHOUTBOX_HISTORY_LIMIT = 100; // Standard history limit

/**
 * Loads the set of processed shoutbox message IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed messages.
 */
async function loadProcessedShouts() {
    try {
        const storedIdsJson = (await getContent(SHOUTBOX_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('shoutbox', `Loaded ${storedIdsArray.length} processed shoutbox message IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('shoutbox', 'Failed to load processed shoutbox message IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new shoutbox messages.
 */
export async function checkForShoutbox() {
    LOG('shoutbox', 'Checking for new shoutbox messages...');
    try {
        const processedShoutIds = await loadProcessedShouts();

        const response = await secureFetch(apiEndpoints.game.shoutbox);
        if (!response.ok) throw new Error(`Failed to fetch shoutbox data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r) {
            WARN('shoutbox', `Shoutbox fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        const messages = Object.values(data.r);
        if (messages.length === 0) {
            return;
        }

        // 1. Filter to find only the new shouts (processing oldest to newest)
        const newShouts = messages.reverse().filter(shout => !processedShoutIds.has(shout.id));

        if (newShouts.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs to prevent race conditions
        LOG('shoutbox', `Found ${newShouts.length} new shoutbox messages. Claiming them now...`);
        for (const shout of newShouts) {
            await setContent(SHOUTBOX_STORAGE_KEY, shout.id, SHOUTBOX_HISTORY_LIMIT);
        }
        LOG('shoutbox', `Claimed and saved ${newShouts.length} new shoutbox message IDs.`);

        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newShouts.map(shout => {
            try {
                const shoutId = shout.id;
                const dateTime = new Date(shout.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                const playerProfileImage = apiEndpoints.player.profileImg(shout.player.id);

                const message = `
:left_speech_bubble: **${shout.player.name}** (Lvl ${shout.player.level}):
> ${shout.msg.text}`.trim();

                sendExtraDiscordMessage(
                    message, "Shoutbox", "10494192", `Posted at ${dateTime}`,
                    "", shoutboxWebhook, "", playerProfileImage
                );
                LOG('shoutbox', `Notified: Message from ${shout.player.name} (ID: ${shoutId})`);
            } catch (e) {
                ERR('shoutbox', `Failed to process shout ID ${shout.id}`, e);
            }
        });

        // 4. Wait for all notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('shoutbox', 'Error occurred while checking the shoutbox', error);
    }
}