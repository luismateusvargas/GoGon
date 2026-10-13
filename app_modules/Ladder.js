// app_modules/Ladder.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR, sleep } from './core.js';
import { secureFetch } from '../utils.js';
import { LadderGroup } from '../webhooks.js';
import { extraDiscordPayload } from './discordPayload.js';
import { claimAlerts, appendAlerts, alertFor, processedContent, bindAccount } from './notify.js';
import { apiEndpoints } from '../game_modules/API.js';
import { EMOJIS, DELAYS, EMBED_COLORS } from './constants.js';

// --- CONFIGURATION & STATE ---
const LADDER_NEWS_STORAGE_KEY = 'processed_ladder_news_ids';
const LADDER_HISTORY_LIMIT = 100;

/**
 * Loads the set of processed ladder news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
async function loadProcessedLadderNews(account) {
    try {
        const storedIdsJson = (await processedContent(LADDER_NEWS_STORAGE_KEY, account)) || '[]';
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
 * Each band's result is added to the reset event's outbox rows (parts 1..n) once fetched.
 * @param {{ scope: string|null, epoch: number }} account - The account of the run that claimed the reset.
 * @param {number|string} resetEventId - The claimed ladder reset news ID.
 */
async function fetchAndAnnounceAllPreviousRankings(account, resetEventId) {
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

        // 2. Sequentially enqueue messages to avoid Discord rate-limiting
        LOG('ladder', `Announcing ${allResults.length} band results to Discord...`);
        let part = 1;
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

            await appendAlerts('ladder', account, resetEventId, part++, [alertFor('GG_LADDER_WEBHOOK', extraDiscordPayload(
                message, 
                "Previous PvP Ladder Results", 
                EMBED_COLORS.LADDER_RANKING.toString(), 
                `Top players for Band ${band.id}`, 
                ""
            ))]);

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
        const account = bindAccount(); // this run reads and claims only for the account active now (O4)
        const processedNewsIds = await loadProcessedLadderNews(account);

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

        // 2. Build each reset alert, then claim the ID and enqueue the alert in one transaction
        LOG('ladder', `Found ${newResetEvents.length} new ladder reset event(s). Claiming...`);
        const claimed = await claimAlerts('ladder', { storageKey: LADDER_NEWS_STORAGE_KEY, historyLimit: LADDER_HISTORY_LIMIT, account }, newResetEvents, {
            idOf: news => news.id,
            build: news => {
                const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                const message = `
:crossed_swords: **The PvP Ladder has been reset!**
:calendar_spiral: ${dateTime}
:trophy: Tokens have been allocated. Fetching previous ladder results...`.trim();

                LOG('ladder', `Notifying PvP Ladder Reset (ID: ${news.id})`);
                return [alertFor('GG_LADDER_WEBHOOK', extraDiscordPayload(
                    message, 
                    "PvP Ladder Reset", 
                    EMBED_COLORS.LADDER_RESET.toString(), 
                    "The battle begins anew!", 
                    LadderGroup
                ))];
            },
        });

        // 3. After announcing, fetch and post the results (usually only one reset)
        for (const news of claimed) {
            await fetchAndAnnounceAllPreviousRankings(account, news.id);
        }
    } catch (error) {
        ERR('ladder', 'Error occurred while checking for ladder resets', error);
    }
}