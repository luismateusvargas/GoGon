// app_modules/Ladder.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR, sleep } from './core.js';
import { secureFetch } from '../utils.js';
import { LadderGroup } from '../webhooks.js';
import { extraDiscordPayload } from './discordPayload.js';
import { claimAlerts, appendAlerts, alertFor, processedContent, bindAccount, isCurrentAccount } from './notify.js';
import { getContent, setObject } from '../_gg_data/handler/gg_database.js';
import { apiEndpoints } from '../game_modules/API.js';
import { EMOJIS, DELAYS, EMBED_COLORS } from './constants.js';

// --- CONFIGURATION & STATE ---
const LADDER_NEWS_STORAGE_KEY = 'processed_ladder_news_ids';
const LADDER_HISTORY_LIMIT = 100;
// Resets whose band results are not all queued yet, per account (review-2 counter-plan O5):
// '<key>@<accountScope>' -> [{ id, attempts }]. A later run under that account fetches them again.
const LADDER_FOLLOWUPS_KEY = 'ladder_followups';
const LADDER_FOLLOWUP_MAX_ATTEMPTS = 5; // failed fetches before a reset's band results are given up

const followupsKey = account => `${LADDER_FOLLOWUPS_KEY}@${account.scope}`;

async function loadFollowups(account) {
    try {
        const list = JSON.parse((await getContent(followupsKey(account))) ?? '[]');
        return Array.isArray(list) ? list.filter(f => f && f.id !== undefined) : [];
    } catch (error) {
        WARN('ladder', 'Failed to load unfinished ladder results; starting fresh.', error);
        return [];
    }
}

const saveFollowups = (account, list) => setObject(followupsKey(account), list.length ? list : undefined);

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
 * Each band's result is added to the reset event's outbox rows once fetched; a band's part is its
 * position in the band list (1..n), so a repeated run adds only the parts still missing.
 * @param {{ scope: string|null, epoch: number }} account - The account of the run that claimed the reset.
 * @param {number|string} resetEventId - The claimed ladder reset news ID.
 * @returns {Promise<boolean>} True once every band was fetched and queued under that account.
 */
async function fetchAndAnnounceAllPreviousRankings(account, resetEventId) {
    LOG('ladder', 'Fetching previous ladder rankings for all bands...');
    try {
        const initialResponse = await secureFetch(apiEndpoints.game.ladderResetScoreboard(1));
        const initialData = await initialResponse.json();

        if (!initialData.s || !initialData.r.bands) {
            WARN('ladder', 'Could not fetch the list of PvP bands.');
            return false;
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
            const batchPromises = batch.map(async (band, j) => {
                try {
                    const response = await secureFetch(apiEndpoints.game.ladderResetScoreboard(band.id));
                    const data = await response.json();
                    return { band, part: i + j + 1, data, success: true };
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
        for (const result of allResults) {
            if (!result.data.s || !result.data.r.previous || result.data.r.previous.length === 0) {
                continue; // Skip bands with no data
            }

            const { band, part, data } = result;
            const topPlayers = data.r.previous.slice(0, 3);
            const medals = [EMOJIS.FIRST, EMOJIS.SECOND, EMOJIS.THIRD];
            const playerLines = topPlayers.map((p, index) => {
                return `${medals[index]} **${p.player.name}** - Rating: ${p.rating}`;
            }).join('\n');

            const message = `**Band ${band.id} (Levels ${band.level_start}-${band.level_end})**\n${playerLines}`.trim();

            await appendAlerts('ladder', account, resetEventId, part, [alertFor('GG_LADDER_WEBHOOK', extraDiscordPayload(
                message, 
                "Previous PvP Ladder Results", 
                EMBED_COLORS.LADDER_RANKING.toString(), 
                `Top players for Band ${band.id}`, 
                ""
            ))]);

            await sleep(DELAYS.LADDER_BETWEEN_BANDS); // Use constant
        }

        if (!isCurrentAccount(account)) return false; // parts fetched after the switch were not queued
        LOG('ladder', 'Finished announcing all ladder results.');
        return allResults.length === bands.length;
    } catch (error) {
        ERR('ladder', 'Failed to fetch or process previous ladder rankings', error);
        return false;
    }
}

/**
 * Fetches the band results of every reset this account claimed but has not finished (O5): new
 * claims and resets interrupted by an account switch or a failed fetch. A finished reset is removed;
 * one whose fetch keeps failing is given up after LADDER_FOLLOWUP_MAX_ATTEMPTS runs. An entry whose
 * reset was never claimed is kept only while the reset is still waiting to be claimed.
 */
async function finishFollowups(account, followups, claimedIds, waitingIds) {
    for (const entry of [...followups]) {
        if (!isCurrentAccount(account)) return; // the rest waits for a run under this account
        const id = String(entry.id);
        let done = false;
        if (!claimedIds.has(id)) {
            done = !waitingIds.has(id);
        } else if (await fetchAndAnnounceAllPreviousRankings(account, entry.id)) {
            done = true;
        } else if (isCurrentAccount(account) && ++entry.attempts >= LADDER_FOLLOWUP_MAX_ATTEMPTS) {
            WARN('ladder', `Giving up on the band results of ladder reset ${id} after ${entry.attempts} failed attempts.`);
            done = true;
        }
        if (done) followups.splice(followups.indexOf(entry), 1);
        await saveFollowups(account, followups);
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

        const followups = account.scope ? await loadFollowups(account) : [];
        if (newResetEvents.length === 0 && followups.length === 0) {
            return;
        }

        // Record the new resets before claiming them, so a crash or an account switch between the claim
        // and the band results leaves them to a later run under this account.
        if (newResetEvents.length && isCurrentAccount(account)) {
            for (const news of newResetEvents) {
                if (!followups.some(f => String(f.id) === String(news.id))) followups.push({ id: news.id, attempts: 0 });
            }
            await saveFollowups(account, followups);
        }

        // 2. Build each reset alert, then claim the ID and enqueue the alert in one transaction
        if (newResetEvents.length) LOG('ladder', `Found ${newResetEvents.length} new ladder reset event(s). Claiming...`);
        const claimed = !newResetEvents.length ? [] : await claimAlerts('ladder', { storageKey: LADDER_NEWS_STORAGE_KEY, historyLimit: LADDER_HISTORY_LIMIT, account }, newResetEvents, {
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

        // 3. After announcing, fetch and post the results of new and unfinished resets (usually one)
        const claimedIds = new Set([...processedNewsIds, ...claimed.map(news => news.id)].map(String));
        const waitingIds = new Set(newResetEvents.map(news => String(news.id)));
        await finishFollowups(account, followups, claimedIds, waitingIds);
    } catch (error) {
        ERR('ladder', 'Error occurred while checking for ladder resets', error);
    }
}