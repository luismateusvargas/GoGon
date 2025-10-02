// discord_modules/gvg.js

import { getContent } from '../_sws_data/handler/sws_database.js';

const COOLDOWN_STATE_KEY = 'gvg_cooldowns';

/**
 * Calculates remaining time from a future timestamp and formats it.
 * Note: This is a helper function. For larger projects, move it to a shared utils file.
 * @param {number} futureTimestamp - The timestamp in milliseconds when the event ends.
 * @returns {string} A formatted string e.g., "6d 23h 59m" or "Expired".
 */
function formatRemainingTime(futureTimestamp) {
    const now = Date.now();
    const remainingMs = futureTimestamp - now;

    if (remainingMs <= 0) {
        return "Expired";
    }

    let totalSeconds = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.length > 0 ? parts.join(' ') : "< 1m";
}


/**
 * Handles the /gvgcooldown slash command interaction.
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleGvgCooldownInteraction(interaction) {
    await interaction.deferReply();

    try {
        const cooldownsJson = getContent(COOLDOWN_STATE_KEY);
        const cooldowns = JSON.parse(cooldownsJson || '{}');

        const activeCooldowns = Object.values(cooldowns)
            .map(cd => ({
                name: cd.guildName,
                value: formatRemainingTime(cd.expires)
            }))
            .filter(cd => cd.value !== "Expired");

        if (activeCooldowns.length === 0) {
            await interaction.editReply('✅ There are currently no active GvG cooldowns.');
            return;
        }
        
        const embed = {
            title: '⚔️ GvG Cooldown Status',
            description: 'Time remaining before a new conflict can be initiated against these guilds:',
            color: 0x2ECC71, // A nice green
            fields: activeCooldowns,
            timestamp: new Date().toISOString(),
            footer: { text: 'Cooldowns are set for 7 days after a conflict ends.' }
        };

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('Error handling /gvgcooldown interaction:', error);
        await interaction.editReply('❌ An error occurred while fetching GvG cooldowns.');
    }
}