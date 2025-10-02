// --- MODULE IMPORTS ---
// Core and utility imports (assuming these are correct)
import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage, sendExtraDiscordMessageNODROP } from '../utils.js';
import { SuperEliteWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';

// All database functions now come from the single, new SQLite module.
// Make sure the path '../_sws_data/handler/sws_database.js' is correct for your project.
import {
    getContent,
    setContent,
    getCreatureById,
    getItemById,
    getRealmById // Import the new function
} from '../_sws_data/handler/sws_database.js';


// --- CONFIGURATION & STATE ---
const SE_KILLS_STORAGE_KEY = 'processed_se_kill_ids';
const SE_KILL_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed SE kill IDs from the SQLite key-value store.
 * @returns {Set<string>} A Set containing unique IDs of processed kills.
 */
function loadProcessedSeKills() {
  try {
    const storedIdsJson = getContent(SE_KILLS_STORAGE_KEY) || '[]';
    const storedIdsArray = JSON.parse(storedIdsJson);
    console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed SE kill IDs from database.`);
    return new Set(storedIdsArray);
  } catch (error) {
    console.error('Failed to load processed SE kill IDs from database, starting fresh.', error);
    return new Set();
  }
}

/**
 * The main function to check for and announce new Super Elite kills.
 */
export async function checkSuperElites() {
    console.log('Checking for new Super Elite kills...');
    try {
        const processedSeKills = loadProcessedSeKills();

        const response = await secureFetch(apiEndpoints.game.superEliteArchive);
        if (!response.ok) throw new Error(`Failed to fetch SE data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('SE fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }

        const serverTimestamp = parseInt(data.t.split(' ')[1], 10);

        const kills = Object.values(data.r);
        if (kills.length === 0) {
            console.log('No recent SE kills found.');
            return;
        }

        let newKillsFound = false;

        for (const kill of kills.reverse()) {
            const actualKillTimestamp = serverTimestamp - kill.time;
            
            // FIX APPLIED HERE: Round timestamp down to the nearest minute to prevent 
            // duplicates from logs that are only seconds apart.
            const minuteRoundedTimestamp = Math.floor(actualKillTimestamp / 60) * 60;
            const uniqueKillId = `${minuteRoundedTimestamp}-${kill.player.id}-${kill.creature}`;

            if (processedSeKills.has(uniqueKillId)) {
                continue;
            }
            
            newKillsFound = true;
            console.log(`New SE kill found: ${uniqueKillId}`);

            const creature = getCreatureById(kill.creature);
            if (!creature) {
                console.warn(`Could not find creature with ID ${kill.creature} in the database. Skipping.`);
                continue;
            }

            const realmId = kill.realm.realm;
            const realm = getRealmById(realmId);
            const realmName = realm ? realm.name : `Realm #${realmId}`;
            
            const killInfo = {
                // Use the original actualKillTimestamp for display purposes to maintain precision
                dateTime: new Date(actualKillTimestamp * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' }),
                superElite: {
                    name: `**${creature.name}**`,
                    image: creature.imageUrl
                },
                player: {
                    name: `Killed by: **${kill.player.name}**`,
                    location: `at **${realmName}** (${kill.realm.x}, ${kill.realm.y})`
                },
                drop: "Nothing of value was found."
            };

            if (kill.item) {
                const item = getItemById(kill.item);
                if (item) {
                    killInfo.drop = item.imageUrl;
                    console.log(`Item dropped: ${item.name} (ID: ${item.id})`);
                } else {
                    console.warn(`Kill log contained item ID ${kill.item}, but it was not found in the database.`);
                }
            }

            if (killInfo.drop.startsWith('http')) {
                sendExtraDiscordMessage(
                    `${killInfo.dateTime}\n${killInfo.superElite.name}\n${killInfo.player.name}\n${killInfo.player.location}`,
                    "Super Elite", "15466240", "It Dropped!", "", SuperEliteWebhook, killInfo.superElite.image, killInfo.drop
                );
            } else {
                sendExtraDiscordMessageNODROP(
                    `${killInfo.dateTime}\n${killInfo.superElite.name}\n${killInfo.player.name}\n${killInfo.player.location}`,
                    "Super Elite", "15466240", killInfo.drop, "", SuperEliteWebhook, killInfo.superElite.image
                );
            }

            processedSeKills.add(uniqueKillId);
        }

        if (newKillsFound) {
            let idsToStore = Array.from(processedSeKills);
            
            if (idsToStore.length > SE_KILL_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - SE_KILL_HISTORY_LIMIT);
            }

            setContent(SE_KILLS_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed SE kill IDs to database.`);
        }

    } catch (error) {
        console.error('An error occurred while checking Super Elites:', error);
    }
}