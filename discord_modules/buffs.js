// discord_modules/buffs.js
import { ensureLogin } from '../session.mjs';
import { secureFetch, getBuffs, getPlayerIdByName } from '../utils.js';
import { getSetting } from '../config/runtime.mjs';
import { apiEndpoints } from '../game_modules/API.js';
import pkg from 'discord.js';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

// --- Setup & Constants (Unchanged) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jsonPath = path.join(__dirname, 'buff_data.json');
const BUFF_DATA = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

const normName = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// buff_data.json keeps display casing ("Blood Thirst"); lookups use normalized names ("blood thirst").
export const NAME_TO_ID = Object.fromEntries(
    Object.entries(BUFF_DATA).map(([name, id]) => [normName(name), id])
);

// Aliases (e.g. "Bloodthirst") are listed before their display name in buff_data.json, so the display name wins here.
export const ID_TO_NAME = Object.fromEntries(
    Object.entries(BUFF_DATA).map(([name, id]) => {
        const capitalizedName = name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        return [id, capitalizedName];
    })
);

export const META_NAMES = ['Extend', 'Reinforce', 'Buff Master', 'Guild Buffer'];
export const META_IDS = [42, 126, 65, 160];
const META_BUFF_BE_MIN_LEVEL = 200;
const META_BUFF_DEFAULT_LEVEL = 175;

export const PVP_IDS = [12,9,13,14,27,28,82,37,57,58,59,44,80,77,97,86,96,119,121,123,110,114,154,136,135,170,171,172,178,183,0,1,4,5,2,7,30,29,32,33,35,47,51,52,73,70,74,118,108,89,105,111,88,106,175,180,23,25,39,66,81,72,124,112,102,103,100,159,161];
export const ALL_IDS = [12,13,10,8,9,11,15,14,27,28,36,82,37,54,55,57,56,58,60,59,44,46,80,71,77,97,117,122,86,96,98,119,121,123,110,114,154,153,136,135,170,181,171,172,145,178,183,0,1,4,5,2,3,6,7,30,29,31,32,34,33,35,47,48,49,50,51,52,53,73,70,74,79,78,118,108,89,105,109,111,113,115,88,106,116,146,130,173,179,174,175,155,180,22,16,61,17,19,18,20,21,23,24,26,25,40,39,41,42,63,62,65,64,66,160,67,68,76,166,81,75,72,126,120,124,101,112,107,102,103,125,100,104,159,137,167,161,168,169,177];
export const TITAN_IDS = [28, 39, 72, 167, 67];
export const EPICS_IDS = [88,89,7,5,2,74,0,37,171,77,9,82,44,28,159,102,169,124];

// --- Utility Functions ---
/**
 * Returns the buff array from a getBuffs() result ({ buffsList, parsedAt }), a bare list, or undefined.
 * @param {object|Array|undefined} result
 * @returns {Array}
 */
export function toBuffsList(result) {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.buffsList) ? result.buffsList : [];
}

export function resolveBuffIds(input) {
    if (!input) return [];
    const raw = input.split(',').map(x => x.trim()).filter(Boolean);
    const normalizedInput = normName(raw[0] || '');
    if (raw.length === 1) {
        if (normalizedInput === 'pvp') return [...new Set(PVP_IDS)];
        if (normalizedInput === 'titan') return [...new Set(TITAN_IDS)];
        if (normalizedInput === 'epics') return [...new Set(EPICS_IDS)];
        if (normalizedInput === 'all') return [...new Set(ALL_IDS)];
    }
    const out = new Set();
    for (const token of raw) {
        if (/^\d+$/.test(token)) {
            out.add(parseInt(token, 10)); continue;
        }
        const normalizedToken = normName(token);
        const directMatchId = NAME_TO_ID[normalizedToken];
        if (directMatchId !== undefined) {
            out.add(directMatchId); continue;
        }
        const partialMatchKey = Object.keys(NAME_TO_ID).find(k => k.startsWith(normalizedToken));
        if (partialMatchKey) {
            out.add(NAME_TO_ID[partialMatchKey]);
        }
    }
    return Array.from(out);
}
/**
 * Formats a total number of seconds into a "Hh Mm Ss" string.
 * @param {number} totalSeconds - The total seconds to format.
 * @returns {string} The formatted time string (e.g., "20h 16m 8s").
 */
function formatSeconds(totalSeconds) {
    if (totalSeconds <= 0) {
        return "";
    }
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    // If less than a minute, show seconds for precision
    if (parts.length === 0 && totalSeconds > 0) {
        parts.push(`${Math.floor(totalSeconds)}s`);
    }

    return parts.join(' ');
}

// --- Core API/Scraping Functions ---
// Add this new function inside discord_modules/buffs.js

/**
 * Filters a list of skill IDs against the caster's available skills.
 * @param {number[]} skillIds - An array of skill IDs the user requested.
 * @returns {Promise<{available: number[], unavailable: number[]}>} An object containing available and unavailable skill IDs.
 */
async function filterUnavailableBuffs(skillIds) {
    try {
        const response = await secureFetch(apiEndpoints.player.availableBuffs);
        const data = await response.json();

        if (!data.s || !data.r?.skills) {
            console.warn('[SWS_WARN] filterUnavailableBuffs: Could not fetch available skills from API. Skipping filter.');
            // On failure, return the original list to attempt casting anyway.
            return { available: skillIds, unavailable: [] };
        }

        // Create a Set of skill IDs that have points > 0 for fast lookups.
        const availableSkillIds = new Set(
            data.r.skills
                .filter(skill => skill.points > 0)
                .map(skill => skill.id)
        );

        const available = [];
        const unavailable = [];

        for (const id of skillIds) {
            if (availableSkillIds.has(id)) {
                available.push(id);
            } else {
                unavailable.push(id);
            }
        }

        return { available, unavailable };

    } catch (error) {
        console.error('[SWS_ERROR] filterUnavailableBuffs:', error);
        // On exception, return the original list.
        return { available: skillIds, unavailable: [] };
    }
}

/**
 * Activates a list of buffs on a target player using the Quick Buff system.
 * This refactored function is correct and remains unchanged.
 */
export async function quickBuff(target, skillIds) {
    const uniqIds = [...new Set((skillIds || []).filter(id => Number.isInteger(id)))];
    if (!uniqIds.length) {
        return { ok: true, success: [], failed: [], blocked: [] };
    }
    const params = new URLSearchParams({
        cmd: 'quickbuff', subcmd: 'activate', targetPlayers: target,
    });
    uniqIds.forEach(id => params.append('skills[]', String(id)));
    const resp = await secureFetch('index.php', { method: 'POST', body: params });
    const html = await resp.text();
    const results = { ok: resp.ok, status: resp.status, success: [], failed: [], blocked: [], details: [] };
    if (!resp.ok) return results;
    const $ = cheerio.load(html);
    const $report = $('#quickbuff-report');
    if (!$report.length) {
        const looksLikeLogin = /name=["']?username["']?|id=["']?login["']?/i.test(html);
        results.details.push({ status: 'no-report-found', hint: looksLikeLogin ? 'Session expired' : 'Markup changed' });
        
        // --- ADDED FOR DEBUGGING ---
        console.log('[SWS_DEBUG] quickBuff: Could not find #quickbuff-report. Full HTML response:');
        console.log(html);
        // -------------------------

        return results;
    }
    const messages = $report.find('p:not(.back)').map((_, el) => $(el).text().trim()).get();
    const patterns = {
        success: /Skill\s+'?(.+?)'?\s+level\s+\d+\s+was activated on/i,
        failed: /The skill\s+'?(.+?)'?\s+of current or higher level is currently active on/i,
        blocked: /has set their preferences to block the skill\s+'?(.+?)'?\s+from being cast on them/i,
    };
    for (const msg of messages) {
        let match;
        if ((match = msg.match(patterns.success))) {
            results.success.push(match[1].replace(/\(.*?\)/g, '').trim());
        } else if ((match = msg.match(patterns.failed))) {
            results.failed.push(match[1].trim());
        } else if ((match = msg.match(patterns.blocked))) {
            results.blocked.push(match[1].trim());
        }
    }

    // --- ADDED FOR DEBUGGING ---
    if (results.success.length === 0 && results.failed.length === 0 && results.blocked.length === 0) {
        console.log('[SWS_DEBUG] quickBuff: Parsed report but found no known messages. Full HTML response:');
        console.log(html);
    }
    // -------------------------

    results.success = [...new Set(results.success)];
    results.failed = [...new Set(results.failed)];
    results.blocked = [...new Set(results.blocked)];
    return results;
}

/**
 * Ensures meta buffs (Extend, Reinforce, etc.) are active on the caster.
 */
// In discord_modules/buffs.js (replace the old version)

export async function ensureMetaBuffs() {
    // GG_ names win over legacy SWS_/FS_ (registry settings, hot)
    const selfName = getSetting('GG_BOT_CHARACTER');
    const selfId = getSetting('GG_BOT_ID_CHARACTER');
    
    // 1. Get all active buffs and their levels
    const activeBuffsList = toBuffsList(await getBuffs(apiEndpoints.player.activeBuffs(selfId)));
    const activeLevels = new Map();
    for (const buff of activeBuffsList) {
        const name = ID_TO_NAME[buff.id];
        if (name) activeLevels.set(normName(name), Number(buff.level) || 0);
    }

    // 2. Determine the minimum required level for meta buffs
    const hasEnhancer = (activeLevels.get(normName('buff enhancer')) || 0) > 0;
    const minLevel = hasEnhancer ? META_BUFF_BE_MIN_LEVEL : META_BUFF_DEFAULT_LEVEL;

    // 3. Find all meta buffs that are below the required minimum level
    const idsToCast = META_NAMES
        .map((name, idx) => ({ name: normName(name), id: META_IDS[idx] }))
        .filter(({ name }) => (activeLevels.get(name) || 0) < minLevel)
        .map(({ id }) => id);

    // 4. If any buffs need to be cast or refreshed, cast them all
    if (idsToCast.length > 0) {
        console.log(`[SWS] Ensuring meta buffs are at min level ${minLevel}. Casting: ${idsToCast.join(', ')}`);
        const res = await quickBuff(selfName, idsToCast);
        return { applied: idsToCast, selfName, minLevel, hasEnhancer, res };
    }

    // If we reach here, all meta buffs were already sufficient.
    return { applied: [], selfName, minLevel, hasEnhancer };
}

// --- Discord Interaction Handlers ---
/**
 * Handles the /checkbuffs command.
 */
export async function handleCheckBuffsInteraction(interaction) {
    await interaction.deferReply();
    try {
        await ensureLogin();
        const targetUsername = interaction.options.getString('username', true).trim();
        const playerID = await getPlayerIdByName(targetUsername);

        if (!playerID || playerID <= 0) {
            await interaction.editReply(`❌ Could not find a player with the username "**${targetUsername}**". Please check spelling and capitalization.`);
            return;
        }

        // getBuffs() returns { buffsList, parsedAt }, or undefined when the request fails.
        const buffsResult = await getBuffs(apiEndpoints.player.activeBuffs(playerID));
        const buffsList = toBuffsList(buffsResult);
        const parsedAt = buffsResult?.parsedAt;

        if (buffsList.length === 0) {
            await interaction.editReply(`**${targetUsername}** has no active buffs.`);
            return;
        }

        // --- PAGINATION LOGIC (No changes here) ---
        const BUFFS_PER_PAGE = 20;
        const totalPages = Math.ceil(buffsList.length / BUFFS_PER_PAGE);
        let currentPage = 0;

        const generatePage = (page) => {
            const start = page * BUFFS_PER_PAGE;
            const end = start + BUFFS_PER_PAGE;
            const buffsForPage = buffsList.slice(start, end);

            const buffLines = buffsForPage.map(buff => {
                const buffName = ID_TO_NAME[buff.id] || `Unknown (ID: ${buff.id})`;
                const level = buff.level ? ` (Lvl ${buff.level})` : '';

                // --- CHANGE #2: Calculate remaining seconds using expire_time and the server timestamp ---
                const remainingSeconds = buff.expire_time - parsedAt;
                const formattedDuration = formatSeconds(remainingSeconds);
                // --- END CHANGE #2 ---

                const duration = formattedDuration ? `- *${formattedDuration} remaining*` : '';
                return `• **${buffName}**${level} ${duration}`;
            }).join('\n');

            const embed = {
                title: `Active Buffs for ${targetUsername} (${buffsList.length} total)`,
                description: buffLines,
                color: 0x4E98D8,
                timestamp: new Date().toISOString(),
                footer: { text: `Page ${page + 1} of ${totalPages} • Player ID: ${playerID}` }
            };

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('previous_page')
                    .setLabel('◀️ Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Next ▶️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page + 1 >= totalPages)
            );

            return { embeds: [embed], components: [row] };
        };

        // Send the initial page
        const replyMessage = await interaction.editReply(generatePage(currentPage));

        if (totalPages <= 1) return;

        // Collector logic remains the same
        const collector = replyMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 120000
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                await i.reply({ content: "You can't use these buttons.", ephemeral: true });
                return;
            }
            if (i.customId === 'next_page') {
                currentPage++;
            } else if (i.customId === 'previous_page') {
                currentPage--;
            }
            await i.update(generatePage(currentPage));
        });

        collector.on('end', async () => {
            const finalState = generatePage(currentPage);
            finalState.components[0].components.forEach(button => button.setDisabled(true));
            await interaction.editReply(finalState).catch(() => {});
        });

    } catch (e) {
        console.error('slash /checkbuffs error:', e);
        await interaction.editReply('❌ Command failed. Please check the console logs.');
    }
}

export async function handleBuffInteraction(interaction) {
    await interaction.deferReply({ ephemeral: false });
    try {
        await ensureLogin();
        const target = interaction.options.getString('target', true).trim();
        const buffsArg = interaction.options.getString('buffs', true).trim();

        const meta = await ensureMetaBuffs();
        const initialSkillIds = resolveBuffIds(buffsArg);
        if (!initialSkillIds.length) {
            await interaction.editReply(`❌ No valid buffs found for: \`${buffsArg}\`.`);
            return;
        }

        // --- NEW: Filter buffs before casting ---
        const { available: skillIds, unavailable: unavailableIds } = await filterUnavailableBuffs(initialSkillIds);

        const summary = [`**Target(s):** \`${target}\``];
        if (meta.applied.length > 0) {
            const metaNames = meta.applied.map(id => ID_TO_NAME[id] || `#${id}`);
            summary.push(`**Caster Prep:** Activated ${metaNames.join(', ')} (min Lvl ${meta.minLevel}).`);
        } else {
            summary.push(`**Caster Prep:** Meta buffs already active (min Lvl ${meta.minLevel}).`);
        }

        // --- NEW: Notify user about unavailable buffs ---
        if (unavailableIds.length > 0) {
            const unavailableNames = unavailableIds.map(id => ID_TO_NAME[id] || `ID #${id}`);
            summary.push(`ℹ️ **Skipped:** ${unavailableNames.join(', ')} (Caster cannot cast).`);
        }

        if (skillIds.length === 0) {
            summary.push('❌ No buffs in your request could be cast.');
            await interaction.editReply(summary.join('\n'));
            return;
        }
        
        const res = await quickBuff(target, skillIds);

        if (res.success.length > 0) summary.push(`✅ **Applied:** ${res.success.join(', ')}`);
        if (res.failed.length > 0) summary.push(`⚠️ **Already Active:** ${res.failed.join(', ')}`);
        if (res.blocked.length > 0) summary.push(`🚫 **Blocked by Player:** ${res.blocked.join(', ')}`);
        if (res.success.length === 0 && res.failed.length === 0 && res.blocked.length === 0) {
            const hint = res.details?.find(d => d.status === 'no-report-found')?.hint || 'Check target name or stamina.';
            summary.push(`ℹ️ No buffs were applied. ${hint}`);
        }
        if (!res.ok) summary.push(`❗ **Network Error:** Server returned status ${res.status}.`);
        await interaction.editReply(summary.join('\n'));
    } catch (e) {
        console.error('slash /buff error:', e);
        await interaction.editReply('❌ Command failed. Please check the console logs.');
    }
}


// Replace the existing handleBeBuffInteraction in discord_modules/buffs.js

export async function handleBeBuffInteraction(interaction) {
	const { useBESequence } = await import('./inventory.js');
    try {
        await ensureLogin();
        const target = interaction.options.getString('target', true).trim();
        const buffsArg = interaction.options.getString('buffs', true).trim();

        const be = await useBESequence(interaction);
        if (!be?.ok) {
            await interaction.editReply(be?.message || '❌ Buff Enhancer / potions step aborted.');
            return;
        }
        await interaction.editReply(
            be.alreadyActive ?
            `✅ Potion buffs active. Casting on **${target}**...` :
            `✅ Potions used. Now casting on **${target}**...`
        );

        const meta = await ensureMetaBuffs();
        const initialSkillIds = resolveBuffIds(buffsArg);
        if (!initialSkillIds.length) {
            await interaction.editReply(`❌ No valid buffs found for: \`${buffsArg}\`.`);
            return;
        }

        // --- NEW: Filter buffs before casting ---
        const { available: skillIds, unavailable: unavailableIds } = await filterUnavailableBuffs(initialSkillIds);

        const summary = [`**Target(s):** \`${target}\``];
        if (meta.applied.length > 0) {
            const metaNames = meta.applied.map(id => ID_TO_NAME[id] || `#${id}`);
            summary.push(`**Caster Prep:** Activated ${metaNames.join(', ')} (min Lvl ${meta.minLevel}).`);
        } else {
            summary.push(`**Caster Prep:** Meta buffs already active (min Lvl ${meta.minLevel}).`);
        }

        // --- NEW: Notify user about unavailable buffs ---
        if (unavailableIds.length > 0) {
            const unavailableNames = unavailableIds.map(id => ID_TO_NAME[id] || `ID #${id}`);
            summary.push(`ℹ️ **Skipped:** ${unavailableNames.join(', ')} (Caster cannot cast).`);
        }

        if (skillIds.length === 0) {
            summary.push('❌ No buffs in your request could be cast.');
            await interaction.editReply(summary.join('\n'));
            return;
        }

        const res = await quickBuff(target, skillIds);
        
        if (res.success.length > 0) summary.push(`✅ **Applied:** ${res.success.join(', ')}`);
        if (res.failed.length > 0) summary.push(`⚠️ **Already Active:** ${res.failed.join(', ')}`);
        if (res.blocked.length > 0) summary.push(`🚫 **Blocked by Player:** ${res.blocked.join(', ')}`);
        if (res.success.length === 0 && res.failed.length === 0 && res.blocked.length === 0) {
            summary.push('ℹ️ No buffs were applied. Check target name or stamina.');
        }
        if (!res.ok) summary.push(`❗ **Network Error:** Server returned status ${res.status}.`);

        await interaction.editReply(summary.join('\n'));
    } catch (e) {
        console.error('slash /bebuff error:', e);
        await interaction.editReply('❌ Command failed. Please check the console logs.');
    }
}