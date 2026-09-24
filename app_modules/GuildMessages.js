// app_modules/GuildMessages.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { guildMessageWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const GUILD_MSG_STORAGE_KEY = 'processed_guild_message_ids';
const GUILD_MSG_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed guild message IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed messages.
 */
async function loadProcessedGuildMessages() {
    try {
        const storedIdsJson = (await getContent(GUILD_MSG_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('guildmsg', `Loaded ${storedIdsArray.length} processed guild message IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('guildmsg', 'Failed to load processed guild message IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new guild messages.
 */
export async function checkGuildMessages() {
    LOG('guildmsg', 'Checking for new guild messages...');
    try {
        const processedMessageIds = await loadProcessedGuildMessages();

        const response = await secureFetch(apiEndpoints.player.privateMessages);
        if (!response.ok) throw new Error(`Failed to fetch private messages. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r?.private_messages) {
            WARN('guildmsg', `Private message fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        // 1. Filter to find only the new guild messages
        const newGuildMessages = data.r.private_messages.reverse().filter(msg =>
            msg.msg.text.startsWith('[Guild Message]:') &&
            !processedMessageIds.has(msg.id)
        );

        if (newGuildMessages.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs
        LOG('guildmsg', `Found ${newGuildMessages.length} new guild messages. Claiming them now...`);
        for (const msg of newGuildMessages) {
            await setContent(GUILD_MSG_STORAGE_KEY, msg.id, GUILD_MSG_HISTORY_LIMIT);
        }
        LOG('guildmsg', `Claimed and saved ${newGuildMessages.length} new guild message IDs.`);

        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newGuildMessages.map(msg => {
            try {
                const dateTime = new Date(msg.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                const cleanContent = msg.msg.text.replace('[Guild Message]:', '').trim();
                const playerProfileImage = apiEndpoints.player.profileImg(msg.player.id);
                const title = `New Guild Message from ${msg.player.name}`;

                sendExtraDiscordMessage(
                    cleanContent, title, '7506394', `Received at ${dateTime}`,
                    "", guildMessageWebhook, "", playerProfileImage
                );
                LOG('guildmsg', `Replicated guild message from ${msg.player.name} (ID: ${msg.id})`);
            } catch (e) {
                ERR('guildmsg', `Failed to process guild message ID ${msg.id}`, e);
            }
        });

        // 4. Wait for all notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('guildmsg', 'Error occurred while checking guild messages', error);
    }
}