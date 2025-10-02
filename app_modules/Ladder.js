// app_modules/Ladder.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { ladderWebhook, LadderGroup } from '../webhooks.js'; // Assuming you have these in webhooks.js
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const LADDER_NEWS_STORAGE_KEY = 'processed_ladder_news_ids';
const LADDER_HISTORY_LIMIT = 100; // Standard history limit

/**
 * Loads the set of processed ladder news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
function loadProcessedLadderNews() {
    try {
        const storedIdsJson = getContent(LADDER_NEWS_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed ladder news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed ladder news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * Fetches the results of the previous ladder for all available PvP bands.
 */
async function fetchAndAnnounceAllPreviousRankings() {
    console.log('Fetching previous ladder rankings for all bands...');
    try {
        // Fetch the first band to get the list of all bands
        const initialResponse = await secureFetch(apiEndpoints.game.ladderResetScoreboard(1));
        const initialData = await initialResponse.json();

        if (!initialData.s || !initialData.r.bands) {
            WARN('ladder', 'Could not fetch the list of PvP bands.');
            return;
        }

        const bands = initialData.r.bands;
        console.log(`Found ${bands.length} PvP bands to process.`);

        for (const band of bands) {
            const response = await secureFetch(apiEndpoints.game.ladderResetScoreboard(band.id));
            const data = await response.json();

            if (!data.s || !data.r.previous || data.r.previous.length === 0) {
                continue; // Skip bands with no previous ladder data
            }

            const topPlayers = data.r.previous.slice(0, 3); // Get the top 3 players

            let playerLines = topPlayers.map((p, index) => {
                const medals = ['🥇', '🥈', '🥉'];
                return `${medals[index]} **${p.player.name}** - Rating: ${p.rating}`;
            }).join('\n');

            const message = `
**Band ${band.id} (Levels ${band.level_start}-${band.level_end})**
${playerLines}
            `.trim();

            sendExtraDiscordMessage(
                message,
                "Previous PvP Ladder Results",
                "16776960", // Bright yellow
                `Top players for Band ${band.id}`,
                "", // No group ping for individual results
                ladderWebhook
            );
            
            // Small delay to avoid rate-limiting on Discord hooks
            await new Promise(resolve => setTimeout(resolve, 500));
        }

    } catch (error) {
        ERR('ladder', 'Failed to fetch or process previous ladder rankings', error);
    }
}

/**
 * The main function to check for and announce PvP ladder resets.
 */
export async function checkLadderReset() {
    console.log('Checking for PvP ladder reset...');
    try {
        const processedNewsIds = loadProcessedLadderNews();

        const response = await secureFetch(apiEndpoints.game.newsArchive);
        if (!response.ok) throw new Error(`Failed to fetch news archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('News archive fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        const newsItems = data.r?.news;
        if (!newsItems || newsItems.length === 0) {
            return;
        }

        let newLadderResetFound = false;

        for (const news of newsItems.reverse()) {
            if (news.type !== 3 || news.subject !== "PvP Ladder") {
                continue;
            }

            const newsId = news.id;
            if (processedNewsIds.has(newsId)) {
                continue;
            }

            newLadderResetFound = true;
            console.log(`New PvP ladder reset found! News ID: ${newsId}`);
            
            const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });

            const message = `
:crossed_swords: **The PvP Ladder has been reset!**
:calendar_spiral: ${dateTime}
:trophy: Tokens have been allocated. Fetching previous ladder results...`
.trim();

            try {
                sendExtraDiscordMessage(
                    message,
                    "PvP Ladder Reset",
                    "16711680", // Orange
                    "The battle begins anew!",
                    LadderGroup,
                    ladderWebhook
                );
                LOG('ladder', `Notified PvP Ladder Reset (ID: ${newsId})`);

                // After announcing the reset, fetch and post the results.
                await fetchAndAnnounceAllPreviousRankings();

            } catch (e) {
                ERR('ladder', 'Failed to send ladder notification to Discord', e);
            }

            processedNewsIds.add(newsId);
        }

        if (newLadderResetFound) {
            let idsToStore = Array.from(processedNewsIds);

            if (idsToStore.length > LADDER_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - LADDER_HISTORY_LIMIT);
            }
            
            setContent(LADDER_NEWS_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed ladder news IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking for ladder resets:', error);
    }
}

