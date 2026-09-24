// app_modules/Ladder.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR, sleep } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { ladderWebhook, LadderGroup } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import { EMOJIS, DELAYS, EMBED_COLORS } from './constants.js';
import {
    getContent,
    setContent
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const LADDER_NEWS_STORAGE_KEY = 'processed_ladder_news_ids';
const LADDER_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed ladder news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
async function loadProcessedLadderNews() {
    try {
        const storedIdsJson = (await getContent(LADDER_NEWS_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('ladder', `Loaded ${storedIdsArray.length} processed ladder news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('ladder', 'Failed to load processed ladder news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * Fetches the results of the previous ladder for all bands with controlled concurrency.
 * Processes bands in batches of 3 to avoid overloading the server.
 */
async function fetchAndAnnounceAllPreviousRankings() {
    LOG('ladder', 'Fetching previous ladder rankings for all bands...');
    try {
        const initialResponse = await secureFetch(apiEndpoints.game.ladderResetScoreboard(1));
        const initialData = await initialResponse.json();

        if (!initialData.s || !initialData.r.bands) {
            WARN('ladder', 'Could not fetch the list of PvP bands.');
            return;
        }

        const bands = initialData.r.bands;
        LOG('ladder', `Found ${bands.length} PvP bands to process in batches of 3.`);

        const BATCH_SIZE = 3; // Process 3 bands concurrently
        const allResults = [];

        // Process bands in batches to avoid overwhelming the server
        for (let i = 0; i < bands.length; i += BATCH_SIZE) {
            const batch = bands.slice(i, i + BATCH_SIZE);
            LOG('ladder', `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(bands.length / BATCH_SIZE)} (bands ${i + 1}-${Math.min(i + BATCH_SIZE, bands.length)})`);

            // Fetch current batch concurrently
            const batchPromises = batch.map(async (band) => {
                try {
                    const response = await secureFetch(apiEndpoints.game.ladderResetScoreboard(band.id));
                    const data = await response.json();
                    return { band, data, success: true };
                } catch (error) {
                    WARN('ladder', `Failed to fetch band ${band.id}: ${error.message}`);
                    return { band, data: null, success: false };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            
            // Collect successful results
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value.success) {
                    allResults.push(result.value);
                }
            }

            // Small delay between batches to be respectful to the server
            if (i + BATCH_SIZE < bands.length) {
                await sleep(500);
            }
        }

        // 2. Sequentially send messages to avoid Discord rate-limiting
        LOG('ladder', `Announcing ${allResults.length} band results to Discord...`);
        for (const result of allResults) {
            if (!result.data.s || !result.data.r.previous || result.data.r.previous.length === 0) {
                continue; // Skip bands with no data
            }

            const { band, data } = result;
            const topPlayers = data.r.previous.slice(0, 3);
            const medals = [EMOJIS.FIRST, EMOJIS.SECOND, EMOJIS.THIRD];
            const playerLines = topPlayers.map((p, index) => {
                return `${medals[index]} **${p.player.name}** - Rating: ${p.rating}`;
            }).join('\n');

            const message = `**Band ${band.id} (Levels ${band.level_start}-${band.level_end})**\n${playerLines}`.trim();

            sendExtraDiscordMessage(
                message, 
                "Previous PvP Ladder Results", 
                EMBED_COLORS.LADDER_RANKING.toString(), 
                `Top players for Band ${band.id}`, 
                "", 
                ladderWebhook
            );

            await sleep(DELAYS.LADDER_BETWEEN_BANDS); // Use constant
        }

        LOG('ladder', 'Finished announcing all ladder results.');
    } catch (error) {
        ERR('ladder', 'Failed to fetch or process previous ladder rankings', error);
    }
}

/**
 * The main function to check for and announce PvP ladder resets.
 */
export async function checkLadderReset() {
    LOG('ladder', 'Checking for PvP ladder reset...');
    try {
        const processedNewsIds = await loadProcessedLadderNews();

        const response = await secureFetch(apiEndpoints.game.newsArchive);
        if (!response.ok) throw new Error(`Failed to fetch news archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r?.news) {
            WARN('ladder', `News archive fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        // 1. Filter to find only the new ladder reset events
        const newResetEvents = data.r.news.reverse().filter(news =>
            news.type === 3 &&
            news.subject === "PvP Ladder" &&
            !processedNewsIds.has(news.id)
        );

        if (newResetEvents.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs
        LOG('ladder', `Found ${newResetEvents.length} new ladder reset event(s). Claiming...`);
        for (const news of newResetEvents) {
            await setContent(LADDER_NEWS_STORAGE_KEY, news.id, LADDER_HISTORY_LIMIT);
        }
        LOG('ladder', `Claimed and saved ${newResetEvents.length} new ladder reset news IDs.`);

        // 3. Process each reset event (usually only one)
        for (const news of newResetEvents) {
            try {
                const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                const message = `
:crossed_swords: **The PvP Ladder has been reset!**
:calendar_spiral: ${dateTime}
:trophy: Tokens have been allocated. Fetching previous ladder results...`.trim();

                sendExtraDiscordMessage(
                    message, 
                    "PvP Ladder Reset", 
                    EMBED_COLORS.LADDER_RESET.toString(), 
                    "The battle begins anew!", 
                    LadderGroup, 
                    ladderWebhook
                );
                LOG('ladder', `Notified PvP Ladder Reset (ID: ${news.id})`);

                // After announcing, fetch and post the results
                await fetchAndAnnounceAllPreviousRankings();

            } catch (e) {
                ERR('ladder', `Failed to process ladder reset ID ${news.id}`, e);
            }
        }
    } catch (error) {
        ERR('ladder', 'Error occurred while checking for ladder resets', error);
    }
}