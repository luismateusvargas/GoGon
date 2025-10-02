// app_modules/Relics.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { relicWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const RELIC_LOG_STORAGE_KEY = 'processed_relic_log_ids';
const RELIC_HISTORY_LIMIT = 500;

/**
 * Loads the set of processed relic log IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed log entries.
 */
function loadProcessedRelicLogs() {
    try {
        const storedIdsJson = getContent(RELIC_LOG_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed relic log IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed relic log IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new relic-related guild log events.
 */
export async function checkRelics() {
    console.log('Checking for new relic events...');
    try {
        const processedLogIds = loadProcessedRelicLogs();

        const response = await secureFetch(apiEndpoints.guild.log);
        if (!response.ok) throw new Error(`Failed to fetch guild log data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Guild log fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        const logs = data.r?.logs;
        if (!logs || logs.length === 0) {
            return;
        }

        let newEventsFound = false;

        for (const log of logs.reverse()) {
            const logId = log.id;
            if (processedLogIds.has(logId)) {
                continue;
            }
            
            if (log.type !== 39) {
                continue;
            }
            
            const text = log.msg.text;
            if (!text.toLowerCase().includes('relic')) {
                continue;
            }

            const attachments = log.msg.attachments;
            const attachmentMap = new Map();
            attachments.forEach((att, index) => {
                attachmentMap.set(`a${index}`, att.data);
            });

            const relicMatch = text.match(/relic (.*? \(.+?\))/);
            const relicInfo = relicMatch ? `**${relicMatch[1]}**` : 'an unknown relic';

            let message = '';
            let title = 'Relic Update';
            let color = '8421504';
            
            let eventShouldBeSent = false;

            if (text.includes('has captured the relic')) {
                title = '🏆 Relic Captured!';
                color = '3066993'; // Green
                const player = attachmentMap.get('a0');
                const enemyGuild = attachmentMap.get('a1');
                message = `**${player.name}** from our guild has captured the relic ${relicInfo} from **${enemyGuild.name}**!`;
                eventShouldBeSent = true;

            } else if (text.includes('has captured your relic')) {
                title = '❌ Relic Lost!';
                color = '15158332'; // Red
                const enemyGuild = attachmentMap.get('a0');
                const enemyPlayer = attachmentMap.get('a1');
                message = `**${enemyPlayer.name}** from **${enemyGuild.name}** has captured our relic ${relicInfo}!`;
                eventShouldBeSent = true;

            } else if (text.includes('but your defense held them back')) {
                title = '🛡️ Relic Defended!';
                color = '3447003'; // Blue
                const enemyPlayer = attachments.find(a => a.type === 0)?.data;
                message = `We successfully defended the relic ${relicInfo} from an attack by **${enemyPlayer?.name || 'an enemy'}**!`;
                eventShouldBeSent = true;

            } else if (text.includes('failed to capture the relic')) {
                title = '💨 Attack Failed!';
                color = '16737095'; // Gold/Yellow
                const player = attachments.find(a => a.type === 0)?.data;
                const enemyGuild = attachments.find(a => a.type === 1)?.data;
                message = `**${player.name}** from our guild failed to capture the relic ${relicInfo} from **${enemyGuild.name}**.`;
                eventShouldBeSent = true;
            }
            
            // [FIXED] If the event is not one of the important types, simply skip it.
            // Do not log it, do not add it to the processed list.
            if (!eventShouldBeSent) {
                continue;
            }

            // --- If we reach this point, it is a new, important event ---
            console.log(`New processable relic event found! Log ID: ${logId}`);
            newEventsFound = true;
            processedLogIds.add(logId);

            const dateTime = new Date(log.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
            try {
                sendExtraDiscordMessage(
                    message,
                    title,
                    color,
                    `Event time: ${dateTime}`,
                    "", // No group ping for relic events
                    relicWebhook
                );
                LOG('relics', `Notified: ${title} - ${relicInfo.replace(/\*/g, '')}`);
            } catch (e) {
                ERR('relics', 'Failed to send relic notification to Discord', e);
            }
        }

        if (newEventsFound) {
            let idsToStore = Array.from(processedLogIds);
            if (idsToStore.length > RELIC_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - RELIC_HISTORY_LIMIT);
            }
            setContent(RELIC_LOG_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed relic log IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking for relic events:', error);
    }
}

