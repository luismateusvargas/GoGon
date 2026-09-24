// --- MODULE IMPORTS ---
import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage, sendExtraDiscordMessageNODROP } from '../utils.js';
import { SuperEliteWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent,
    getCreatureById,
    getItemById,
    getRealmById
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const SE_KILLS_STORAGE_KEY = 'processed_se_kill_ids';
const SE_KILL_HISTORY_LIMIT = 200;
export const UNINDEXED_SE_NAME = '**NEW SE Waiting on database**';
export const UNINDEXED_ITEM_TEXT = 'New Item';

/**
 * Loads the set of processed SE kill IDs from the SQLite key-value store.
 * @returns {Set<string>} A Set containing unique IDs of processed kills.
 */
async function loadProcessedSeKills() {
    try {
        const storedIdsJson = (await getContent(SE_KILLS_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('superelites', `Loaded ${storedIdsArray.length} processed SE kill IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('superelites', 'Failed to load processed SE kill IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new Super Elite kills.
 */
export async function checkSuperElites() {
    LOG('superelites', 'Checking for new Super Elite kills...');
    try {
        const processedSeKills = await loadProcessedSeKills();

        const response = await secureFetch(apiEndpoints.game.superEliteArchive);
        if (!response.ok) throw new Error(`Failed to fetch SE data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r) {
            WARN('superelites', `SE fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }

        const serverTimestamp = parseInt(data.t.split(' ')[1], 10);
        
        // 1. Augment kills with a unique ID, then filter for new ones
        const newKills = Object.values(data.r)
            .map(kill => {
                const actualKillTimestamp = serverTimestamp - kill.time;
                const minuteRoundedTimestamp = Math.floor(actualKillTimestamp / 60) * 60;
                const uniqueKillId = `${minuteRoundedTimestamp}-${kill.player.id}-${kill.creature}`;
                return { ...kill, uniqueKillId, actualKillTimestamp };
            })
            .reverse()
            .filter(kill => !processedSeKills.has(kill.uniqueKillId));

        if (newKills.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs
        console.log(`Found ${newKills.length} new SE kills. Claiming them now...`);
        for (const kill of newKills) {
            await setContent(SE_KILLS_STORAGE_KEY, kill.uniqueKillId, SE_KILL_HISTORY_LIMIT);
        }
        LOG('superelites', `Claimed and saved ${newKills.length} new SE kill IDs.`);
        
        
        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newKills.map(async kill => {
            try {
                // AC-MON-001: an unindexed creature is still announced with a fallback name (MON-TASK-001)
                const creature = await getCreatureById(kill.creature);
                if (!creature) {
                    WARN('superelites', `Could not find creature with ID ${kill.creature}. Announcing with fallback name.`);
                }

                const realm = await getRealmById(kill.realm.realm);
                const realmName = realm ? realm.name : `Realm #${kill.realm.realm}`;

                const killInfo = {
                    dateTime: new Date(kill.actualKillTimestamp * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' }),
                    superElite: creature
                        ? { name: `**${creature.name}**`, image: creature.imageUrl }
                        : { name: UNINDEXED_SE_NAME, image: '' },
                    player: {
                        name: `Killed by: **${kill.player.name}**`,
                        location: `at **${realmName}** (${kill.realm.x}, ${kill.realm.y})`
                    },
                    drop: "Nothing of value was found."
                };

                if (kill.item) {
                    const item = await getItemById(kill.item);
                    if (item) {
                        killInfo.drop = item.imageUrl || '';
                        killInfo.textInfo = item.name;
                        LOG('superelites', `Item dropped: ${item.name} (ID: ${item.id})`);
                    } else {
                        // An unknown item is still a drop worth announcing
                        WARN('superelites', `Kill log had unknown item ID ${kill.item}.`);
                        killInfo.drop = '';
                        killInfo.textInfo = UNINDEXED_ITEM_TEXT;
                    }
                }

                const messageBody = `${killInfo.dateTime}\n${killInfo.superElite.name}\n${killInfo.player.name}\n${killInfo.player.location}`;
                if (killInfo.drop.startsWith('http')) {
                    sendExtraDiscordMessage(messageBody, "Super Elite", "15466240", killInfo.textInfo || "It Dropped!", "", SuperEliteWebhook, killInfo.superElite.image, killInfo.drop);
                } else {
                    sendExtraDiscordMessageNODROP(messageBody, "Super Elite", "15466240", killInfo.textInfo || killInfo.drop, "", SuperEliteWebhook, killInfo.superElite.image);
                }
            } catch (e) {
                ERR('superelites', `Failed to process SE kill ${kill.uniqueKillId}`, e);
            }
        });

        // 4. Wait for all notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('superelites', 'Error occurred while checking Super Elites', error);
    }
}