// app_modules/GuildConflicts.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
// We need sendAndGetMessageId and editDiscordMessage from your utils for the live counter
import { secureFetch, sendAndGetMessageId, editDiscordMessage } from '../utils.js'; 
import { conflictWebhook } from '../webhooks.js'; // Assuming you have these
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const CONFLICT_STATE_KEY = 'active_guild_conflicts';
const COOLDOWN_STATE_KEY = 'gvg_cooldowns';
const SWS_GUILD_NAME = process.env.SWS_GUILD_NAME || 'My Guild'; // Your guild's name for score display

/**
 * Calculates the remaining time from seconds and formats it.
 * @param {number} totalSeconds - The total seconds remaining.
 * @returns {string} A formatted string e.g., "1d 2h 30m".
 */
function formatTime(totalSeconds) {
    if (totalSeconds <= 0) return "Expired";
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    
    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ');
}

/**
 * Composes the Discord message payload (embed) for a conflict.
 * @param {object} conflict - The conflict data object from the API.
 * @param {boolean} isUpdate - True if this is an update to an existing message.
 * @param {boolean} isFinished - True if the conflict has ended.
 * @returns {object} The payload for the Discord webhook.
 */
function composeConflictMessage(conflict, isUpdate = false, isFinished = false) {
    const isIncomingAttack = conflict.incoming < conflict.max_attacks;
    let title = '⚔️ New Guild Conflict!';
    let color = '15158332'; // Red for new conflict

    if (isFinished) {
        title = '✅ Guild Conflict Ended!';
        color = '3066993'; // Green
    } else if (isUpdate) {
        title = '⚔️ Guild Conflict Update';
        color = isIncomingAttack ? '15105570' : '16737095'; // Grey for our turn, Gold for their turn
    }

    const description = `
:busts_in_silhouette: **Members:** ${conflict.members.length} / ${conflict.max_members}
:arrow_down: **Incoming:** ${conflict.incoming} / ${conflict.max_attacks}
:arrow_up: **Outgoing:** ${conflict.outgoing} / ${conflict.max_attacks}
:alarm_clock: **Expires:** ${formatTime(conflict.expires)}
    `.trim();
    
    const scoreTitle = `${SWS_GUILD_NAME} vs ${conflict.guild.name}`;
    const scoreValue = `**${conflict.score_a}** - **${conflict.score_b}**`;
    
    const memberNames = conflict.members.map(m => m.name).join(', ');

    const embed = {
        title: title,
        color: color,
        description: description,
        fields: [
            { name: scoreTitle, value: scoreValue, inline: false },
            { name: 'Our Participants', value: memberNames || 'None', inline: false }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (isFinished) {
       embed.description = `The conflict with **${conflict.guild.name}** has concluded.`;
       embed.fields = [{ name: scoreTitle, value: scoreValue, inline: false }];
    }

    return { embeds: [embed] };
}


/**
 * The main function to check for and update guild conflicts.
 */
export async function checkGuildConflicts() {
    console.log('Checking for guild conflicts...');
    try {
        const response = await secureFetch(apiEndpoints.guild.conflicts);
        if (!response.ok) throw new Error(`Failed to fetch guild conflicts. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Guild conflicts fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        const activeConflicts = data.r?.conflicts || [];
        const activeConflictIds = new Set(activeConflicts.map(c => c.id));

        // Load current state from DB
        const storedStatesJson = getContent(CONFLICT_STATE_KEY) || '{}';
        const conflictStates = JSON.parse(storedStatesJson);
        const cooldownsJson = getContent(COOLDOWN_STATE_KEY) || '{}';
        const cooldowns = JSON.parse(cooldownsJson);

        let statesChanged = false;

        // --- Process active conflicts ---
        for (const conflict of activeConflicts) {
            const conflictId = conflict.id;
            const currentStateKey = `${conflict.score_a}-${conflict.score_b}|${conflict.incoming}-${conflict.outgoing}`;
            const storedState = conflictStates[conflictId];

            if (!storedState) { // New conflict
                console.log(`New conflict detected with ${conflict.guild.name} (ID: ${conflictId})`);
                const payload = composeConflictMessage(conflict, false);
                const messageId = await sendAndGetMessageId(conflictWebhook, payload);
                if (messageId) {
                    conflictStates[conflictId] = {
                        messageId: messageId,
                        stateKey: currentStateKey,
                        guildName: conflict.guild.name
                    };
                    statesChanged = true;
                }
            } else if (storedState.stateKey !== currentStateKey) { // Updated conflict
                console.log(`Conflict with ${conflict.guild.name} (ID: ${conflictId}) has been updated.`);
                const payload = composeConflictMessage(conflict, true);
                await editDiscordMessage(conflictWebhook, storedState.messageId, payload);
                conflictStates[conflictId].stateKey = currentStateKey;
                statesChanged = true;
            }
        }
        
        // --- Process ended conflicts ---
        for (const conflictId in conflictStates) {
            if (!activeConflictIds.has(parseInt(conflictId))) {
                console.log(`Conflict with ${conflictStates[conflictId].guildName} (ID: ${conflictId}) has ended.`);
                
                // We need the final state of the conflict, which is not in the current API call.
                // We'll use the last known state to announce the end. A more advanced version could fetch final results.
                const finalPayload = {
                    embeds: [{
                        title: '✅ Guild Conflict Ended!',
                        description: `The conflict with **${conflictStates[conflictId].guildName}** is now over.`,
                        color: '3066993', // Green
                        timestamp: new Date().toISOString()
                    }]
                };

                await editDiscordMessage(conflictWebhook, conflictStates[conflictId].messageId, finalPayload);
                
                // Set a 7-day cooldown
                const cooldownEnd = Date.now() + 7 * 24 * 60 * 60 * 1000;
                cooldowns[conflictId] = {
                    guildName: conflictStates[conflictId].guildName,
                    expires: cooldownEnd
                };
                
                delete conflictStates[conflictId];
                statesChanged = true;
            }
        }

        // Save updated states if anything changed
        if (statesChanged) {
            setContent(CONFLICT_STATE_KEY, JSON.stringify(conflictStates));
            setContent(COOLDOWN_STATE_KEY, JSON.stringify(cooldowns));
            console.log('[SWS_DB] Saved updated conflict and cooldown states to database.');
        }

    } catch (error) {
        console.error('An error occurred while checking guild conflicts:', error);
    }
}
