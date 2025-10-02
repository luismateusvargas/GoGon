// app_modules/GuildMessages.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { guildMessageWebhook } from '../webhooks.js'; // Assuming you have these
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const GUILD_MSG_STORAGE_KEY = 'processed_guild_message_ids';
const GUILD_MSG_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed guild message IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed messages.
 */
function loadProcessedGuildMessages() {
    try {
        const storedIdsJson = getContent(GUILD_MSG_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed guild message IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed guild message IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new guild messages.
 */
export async function checkGuildMessages() {
    console.log('Checking for new guild messages...');
    try {
        const processedMessageIds = loadProcessedGuildMessages();

        const response = await secureFetch(apiEndpoints.player.privateMessages);
        if (!response.ok) throw new Error(`Failed to fetch private messages. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Private message fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        const messages = data.r?.private_messages;
        if (!messages || messages.length === 0) {
            return;
        }

        let newMessagesFound = false;

        for (const msg of messages.reverse()) {
            const messageId = msg.id;
            if (processedMessageIds.has(messageId)) {
                continue;
            }

            const messageText = msg.msg.text;
            if (!messageText.startsWith('[Guild Message]:')) {
                continue;
            }

            newMessagesFound = true;
            console.log(`New guild message found! ID: ${messageId}`);
            
            const dateTime = new Date(msg.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
            
            const cleanContent = messageText.replace('[Guild Message]:', '').trim();
            const playerProfileImage = apiEndpoints.player.profileImg(msg.player.id);

            // [FIXED] Converted to use the multi-argument helper function
            const title = `New Guild Message from ${msg.player.name}`;
            const message = cleanContent;

            try {
                sendExtraDiscordMessage(
                    message,
                    title,
                    '7506394', // Discord Blurple
                    `Received at ${dateTime}`,
                    "", // Group to ping, or "" for none
                    guildMessageWebhook,
                    "", // No main image
                    playerProfileImage // Use player profile image as thumbnail
                );
                LOG('guildmsg', `Replicated guild message from ${msg.player.name} (ID: ${messageId})`);
            } catch (e) {
                ERR('guildmsg', 'Failed to send guild message notification to Discord', e);
            }

            processedMessageIds.add(messageId);
        }

        if (newMessagesFound) {
            let idsToStore = Array.from(processedMessageIds);

            if (idsToStore.length > GUILD_MSG_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - GUILD_MSG_HISTORY_LIMIT);
            }
            
            setContent(GUILD_MSG_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed guild message IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking guild messages:', error);
    }
}

