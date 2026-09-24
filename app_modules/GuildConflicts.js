// app_modules/GuildConflicts.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
// We need sendAndGetMessageId and editDiscordMessage from your utils for the live counter
import { secureFetch, sendAndGetMessageId, editDiscordMessage } from '../utils.js';
import { conflictWebhook } from '../webhooks.js'; // Assuming you have these
import { apiEndpoints } from '../game_modules/API.js';
import { getSetting } from '../config/runtime.mjs';
import {
    getObject,
    setObject
} from '../_gg_data/handler/gg_database.js';
import { STORAGE_KEYS, COOLDOWNS, CONFLICT_PING } from './constants.js';

// --- CONFIGURATION & STATE ---
const CONFLICT_STATE_KEY = STORAGE_KEYS.GUILD_CONFLICTS;
const COOLDOWN_STATE_KEY = STORAGE_KEYS.GVG_COOLDOWNS;
// Your guild's name for score display: a hot registry setting read on every run (CTRL-TASK-001)
const guildName = () => getSetting('GG_GUILD_NAME');

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

    return parts.length > 0 ? parts.join(' ') : "Less than a minute";
}

/**
 * Reads the last known incoming-attack count, including legacy states that only kept stateKey
 * ("scoreA-scoreB|incoming-outgoing").
 * @param {object} storedState - The stored conflict state.
 * @returns {number} The previous incoming count (0 when unknown).
 */
function previousIncoming(storedState) {
    if (Number.isFinite(storedState?.lastIncoming)) return storedState.lastIncoming;
    const parsed = parseInt(String(storedState?.stateKey ?? '').split('|')[1]?.split('-')[0], 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Decides whether new incoming attacks (the enemy guild hitting us) should ping members.
 * Rule (owner decision, MON-TASK-005 / AC-MON-007):
 *  - the first incoming attack of a conflict pings;
 *  - after a ping, no further ping for 15 minutes;
 *  - after that, ping only if the enemy had stopped (no incoming attack for over BURST_GAP_MS)
 *    and starts again; an uninterrupted attack run never pings twice.
 * @param {object|undefined} storedState - Stored conflict state (lastIncoming, lastIncomingAt, lastPingAt).
 * @param {number} incoming - Current incoming-attack count from the API.
 * @param {number} now - Current time in ms.
 * @returns {{ attacked: boolean, ping: boolean }}
 */
export function evaluateIncomingPing(storedState, incoming, now) {
    const attacked = incoming > previousIncoming(storedState);
    if (!attacked) return { attacked: false, ping: false };

    const lastPingAt = storedState?.lastPingAt;
    if (!lastPingAt) return { attacked: true, ping: true };

    const quietWindowOver = now - lastPingAt >= CONFLICT_PING.QUIET_WINDOW_MS;
    const enemyHadStopped = !storedState.lastIncomingAt || now - storedState.lastIncomingAt > CONFLICT_PING.BURST_GAP_MS;
    return { attacked: true, ping: quietWindowOver && enemyHadStopped };
}

/**
 * The mention for the incoming-attack ping, from the GG_CONFLICT_PING_MENTION registry setting
 * (dashboard notifications panel, CTRL-TASK-008): '' for none, '@everyone', or a role mention.
 * No role ID is hardcoded; an invalid stored value falls back to the registry default.
 */
export function conflictPingMention() {
    const value = getSetting('GG_CONFLICT_PING_MENTION').trim();
    if (value === 'none') return '';
    if (/^\d{17,20}$/.test(value)) return `<@&${value}>`;
    return value === '@everyone' ? '@everyone' : CONFLICT_PING.DEFAULT_MENTION;
}

/**
 * Sends the attack ping as its own message: Discord does not notify mentions added by an edit.
 * @returns {Promise<boolean>} True when the ping was delivered.
 */
async function sendIncomingPing(conflict) {
    const mention = conflictPingMention();
    if (!mention) {
        LOG('conflicts', `Incoming attack from ${conflict.guild.name}; ping mention is set to none.`);
        return false;
    }
    const payload = {
        content: `${mention} 🚨 **INCOMING ATTACK!** **${conflict.guild.name}** is hitting us ` +
            `(incoming ${conflict.incoming}/${conflict.max_attacks}).`
    };
    LOG('conflicts', `🚨 Pinging ${mention} for incoming attack from ${conflict.guild.name}!`);
    return Boolean(await sendAndGetMessageId(conflictWebhook, payload));
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
        title = `⚔️ ${conflict.guild.name}`;
        color = isIncomingAttack ? '15105570' : '16737095'; // Grey for our turn, Gold for their turn
    }

    const description = `
:busts_in_silhouette: **Members:** ${conflict.members.length} / ${conflict.max_members}
:arrow_down: **Incoming:** ${conflict.incoming} / ${conflict.max_attacks}
:arrow_up: **Outgoing:** ${conflict.outgoing} / ${conflict.max_attacks}
:alarm_clock: **Expires:** ${formatTime(conflict.expires)}
    `.trim();

    const scoreTitle = `${guildName()} vs ${conflict.guild.name}`;
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

    // content: null clears a ping that older versions put on the live message
    return { content: null, embeds: [embed] };
}


/**
 * The main function to check for and update guild conflicts.
 */
export async function checkGuildConflicts() {
    LOG('conflicts', 'Checking for guild conflicts...');
    try {
        const response = await secureFetch(apiEndpoints.guild.conflicts);
        if (!response.ok) throw new Error(`Failed to fetch guild conflicts. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            WARN('conflicts', `Guild conflicts fetch failed: ${data?.e?.message || 'Unknown error'}`);
            return;
        }

        const activeConflicts = data.r?.conflicts || [];
        const activeConflictIds = new Set(activeConflicts.map(c => c.id));

        // Load current state from DB (tolerates legacy list-wrapped or multiply-stringified values)
        const conflictStates = await getObject(CONFLICT_STATE_KEY, {});
        const cooldowns = await getObject(COOLDOWN_STATE_KEY, {});

        let statesChanged = false;

        // --- Process active conflicts ---
        for (const conflict of activeConflicts) {
            const conflictId = conflict.id;
            const currentStateKey = `${conflict.score_a}-${conflict.score_b}|${conflict.incoming}-${conflict.outgoing}`;
            const storedState = conflictStates[conflictId];

            if (!storedState) { // New conflict
                LOG('conflicts', `New conflict detected with ${conflict.guild.name} (ID: ${conflictId})`);
                const payload = composeConflictMessage(conflict, false, false);
                const messageId = await sendAndGetMessageId(conflictWebhook, payload);
                if (messageId) {
                    const now = Date.now();
                    const newState = {
                        messageId: messageId,
                        stateKey: currentStateKey,
                        guildName: conflict.guild.name,
                        lastIncoming: conflict.incoming, // Enemy attacks on us so far
                        lastIncomingAt: null,            // When we last saw the enemy hit us
                        lastPingAt: null                 // When we last pinged members
                    };
                    // Enemy hits made before we first saw the conflict count as an increase from 0
                    const { attacked, ping } = evaluateIncomingPing({ lastIncoming: 0 }, conflict.incoming, now);
                    if (attacked) newState.lastIncomingAt = now;
                    if (ping && await sendIncomingPing(conflict)) newState.lastPingAt = now;
                    conflictStates[conflictId] = newState;
                    statesChanged = true;
                } else {
                    WARN('conflicts', `Failed to send Discord message for new conflict ${conflictId}. State will not be saved.`);
                }
            } else if (storedState.stateKey !== currentStateKey) { // Updated conflict
                LOG('conflicts', `Conflict with ${conflict.guild.name} (ID: ${conflictId}) has been updated.`);

                // Incoming attacks are the enemy guild hitting us; the count goes up with each hit
                const now = Date.now();
                const { attacked, ping } = evaluateIncomingPing(storedState, conflict.incoming, now);
                if (attacked) {
                    LOG('conflicts', `🚨 INCOMING ATTACK from ${conflict.guild.name}! Incoming: ${previousIncoming(storedState)} → ${conflict.incoming}`);
                    if (ping && await sendIncomingPing(conflict)) storedState.lastPingAt = now;
                    storedState.lastIncomingAt = now;
                }

                const payload = composeConflictMessage(conflict, true, false);
                if (storedState.messageId) {
                    await editDiscordMessage(conflictWebhook, storedState.messageId, payload);
                } else {
                    WARN('conflicts', `Cannot update conflict ${conflictId}, stored messageId is missing.`);
                }
                storedState.stateKey = currentStateKey;
                storedState.lastIncoming = conflict.incoming; // Update tracked incoming count
                statesChanged = true;
            }
        }

        // --- Process ended conflicts ---
        for (const conflictId in conflictStates) {
            if (!activeConflictIds.has(parseInt(conflictId))) {
                const storedState = conflictStates[conflictId];

                if (storedState && storedState.messageId && storedState.guildName) {
                    LOG('conflicts', `Conflict with ${storedState.guildName} (ID: ${conflictId}) has ended.`);

                    // We need the final state of the conflict, which is not in the current API call.
                    // We'll use the last known state to announce the end. A more advanced version could fetch final results.
                    const finalPayload = {
                        content: null,
                        embeds: [{
                            title: '✅ Guild Conflict Ended!',
                            description: `The conflict with **${storedState.guildName}** is now over.`,
                            color: '3066993', // Green
                            timestamp: new Date().toISOString()
                        }]
                    };

                    await editDiscordMessage(conflictWebhook, storedState.messageId, finalPayload);

                    // Owner-locked 10-day cooldown (MON-TASK-002)
                    cooldowns[conflictId] = {
                        guildName: storedState.guildName,
                        expires: Date.now() + COOLDOWNS.GVG
                    };
                } else {
                    WARN('conflicts', `Found invalid/incomplete state for ended conflict ID ${conflictId}. Cleaning it up.`);
                }

                delete conflictStates[conflictId];
                statesChanged = true;
            }
        }

        // Save updated states as whole objects, never as list entries (AC-MON-005)
        if (statesChanged) {
            await setObject(CONFLICT_STATE_KEY, conflictStates);
            await setObject(COOLDOWN_STATE_KEY, cooldowns);
            LOG('conflicts', 'Saved updated conflict and cooldown states to database.');
        }

    } catch (error) {
        ERR('conflicts', 'Error occurred while checking guild conflicts', error);
    }
}
