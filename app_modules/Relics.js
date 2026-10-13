// app_modules/Relics.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch } from '../utils.js';
import { extraDiscordPayload } from './discordPayload.js';
import { claimAlerts, alertFor, processedContent } from './notify.js';
import { apiEndpoints } from '../game_modules/API.js';

// --- CONFIGURATION & STATE ---
const RELIC_LOG_STORAGE_KEY = 'processed_relic_log_ids';
const RELIC_HISTORY_LIMIT = 500;

/**
 * Loads the set of processed relic log IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed log entries.
 */
async function loadProcessedRelicLogs() {
    try {
        const storedIdsJson = (await processedContent(RELIC_LOG_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('relics', `Loaded ${storedIdsArray.length} processed relic log IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('relics', 'Failed to load processed relic log IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new relic-related guild log events.
 */
export async function checkRelics() {
    LOG('relics', 'Checking for new relic events...');
    try {
        const processedLogIds = await loadProcessedRelicLogs();

        const response = await secureFetch(apiEndpoints.guild.log);
        if (!response.ok) throw new Error(`Failed to fetch guild log data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r?.logs) {
            WARN('relics', `Guild log fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        // 1. Filter to find only the new, important relic log events
        const newRelicEvents = data.r.logs.reverse().filter(log => {
            if (processedLogIds.has(log.id) || log.type !== 39) {
                return false;
            }
            const text = log.msg.text.toLowerCase();
            return text.includes('has captured the relic') ||
                   text.includes('has captured your relic') ||
                   text.includes('but your defense held them back') ||
                   text.includes('failed to capture the relic');
        });

        if (newRelicEvents.length === 0) {
            return;
        }

        // 2. Build each alert, then claim the ID and enqueue the alert in one transaction
        LOG('relics', `Found ${newRelicEvents.length} new relic events. Claiming them now...`);
        await claimAlerts('relics', { storageKey: RELIC_LOG_STORAGE_KEY, historyLimit: RELIC_HISTORY_LIMIT }, newRelicEvents, {
            idOf: log => log.id,
            build: log => {
                const text = log.msg.text;
                const attachments = log.msg.attachments;
                const relicMatch = text.match(/relic (.*? \(.+?\))/);
                const relicInfo = relicMatch ? `**${relicMatch[1]}**` : 'an unknown relic';

                let message = '';
                let title = 'Relic Update';
                let color = '8421504';

                if (text.includes('has captured the relic')) {
                    title = '🏆 Relic Captured!';
                    color = '3066993'; // Green
                    const player = attachments[0]?.data;
                    const enemyGuild = attachments[1]?.data;
                    message = `**${player.name}** from our guild has captured the relic ${relicInfo} from **${enemyGuild.name}**!`;
                } else if (text.includes('has captured your relic')) {
                    title = '❌ Relic Lost!';
                    color = '15158332'; // Red
                    const enemyGuild = attachments[0]?.data;
                    const enemyPlayer = attachments[1]?.data;
                    message = `**${enemyPlayer.name}** from **${enemyGuild.name}** has captured our relic ${relicInfo}!`;
                } else if (text.includes('but your defense held them back')) {
                    title = '🛡️ Relic Defended!';
                    color = '3447003'; // Blue
                    const enemyPlayer = attachments.find(a => a.type === 0)?.data;
                    message = `We successfully defended the relic ${relicInfo} from an attack by **${enemyPlayer?.name || 'an enemy'}**!`;
                } else if (text.includes('failed to capture the relic')) {
                    title = '💨 Attack Failed!';
                    color = '16737095'; // Gold/Yellow
                    const player = attachments.find(a => a.type === 0)?.data;
                    const enemyGuild = attachments.find(a => a.type === 1)?.data;
                    message = `**${player.name}** from our guild failed to capture the relic ${relicInfo} from **${enemyGuild.name}**.`;
                }

                const dateTime = new Date(log.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                LOG('relics', `Notifying: ${title} - ${relicInfo.replace(/\*/g, '')}`);
                return [alertFor('GG_RELIC_WEBHOOK', extraDiscordPayload(
                    message, title, color, `Event time: ${dateTime}`, ""
                ))];
            },
        });

    } catch (error) {
        ERR('relics', 'Error occurred while checking for relic events', error);
    }
}