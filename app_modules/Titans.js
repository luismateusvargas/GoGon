// app_modules/Titans.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { titanWebhook, TitanGroup } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent,
    getCreatureById
} from '../_gg_data/handler/gg_database.js';

// --- CONFIGURATION & STATE ---
const TITAN_NEWS_STORAGE_KEY = 'processed_titan_news_ids';
const TITAN_HISTORY_LIMIT = 100; // Standard history limit of 100

/**
 * Loads the set of processed titan news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
async function loadProcessedTitanNews() {
    try {
        const storedIdsJson = (await getContent(TITAN_NEWS_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('titans', `Loaded ${storedIdsArray.length} processed titan news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('titans', 'Failed to load processed titan news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new titan sightings.
 */
export async function checkForTitanNotifications() {
    LOG('titans', 'Checking for new titan notifications...');
    try {
        const processedNewsIds = await loadProcessedTitanNews();

        const response = await secureFetch(apiEndpoints.game.newsArchive);
        if (!response.ok) throw new Error(`Failed to fetch news archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r?.news) {
            WARN('titans', `News archive fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        // 1. Filter to find only the genuinely new titan news items
        const newTitanNews = data.r.news
            .filter(news => 
                news.type === 4 && 
                news.subject === "Titan Spotted!" && 
                !processedNewsIds.has(news.id)
            );

        if (newTitanNews.length === 0) {
            return; // No new titans found
        }

        // 2. IMMEDIATELY claim and save the new IDs to prevent race conditions
        LOG('titans', `Found ${newTitanNews.length} new titan sightings. Claiming them now...`);
        for (const news of newTitanNews) {
            await setContent(TITAN_NEWS_STORAGE_KEY, news.id, TITAN_HISTORY_LIMIT);
        }
        LOG('titans', `Claimed and saved ${newTitanNews.length} new titan news IDs.`);

        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newTitanNews.map(async (news) => {
            try {
                const newsId = news.id;
                const titanId = news.content.attachments?.[0]?.data;
                if (!titanId) {
                    WARN('titans', `Found titan news (ID: ${newsId}) but missing creature ID.`);
                    return;
                }

                const titan = await getCreatureById(titanId);
                if (!titan) {
                    WARN('titans', `Could not find titan with ID ${titanId} in DB. Skipping news ID: ${newsId}.`);
					const locationMatch = news.content.text.match(/in (.*?)\!/);
					const location = locationMatch ? locationMatch[1] : 'an unknown location';
					const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
					const message = `
**NOT IN DATABASE (UNRELEASED)**
:calendar_spiral: ${dateTime}
:map: Spotted at: **${location}**`.trim();

					sendExtraDiscordMessage(
						message, "Titan Spotted!", "1127128", 
						"A new titan has appeared in the realm!",
						TitanGroup, titanWebhook, "", ""
					);
                    return;
                }
                
                const locationMatch = news.content.text.match(/in (.*?)\!/);
                const location = locationMatch ? locationMatch[1] : 'an unknown location';
                const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });

                const message = `
:boar: **${titan.name}**
:calendar_spiral: ${dateTime}
:map: Spotted at: **${location}**`.trim();

                sendExtraDiscordMessage(
                    message, "Titan Spotted!", "1127128", 
                    "A new titan has appeared in the realm!",
                    TitanGroup, titanWebhook, "", titan.imageUrl || ""
                );
                LOG('titans', `Notified: ${titan.name} spotted at ${location}`);
            } catch (e) {
                ERR('titans', `Failed to process titan news ID ${news.id}`, e);
            }
        });

        // 4. Wait for all notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('titans', 'Error occurred while checking for titan notifications', error);
    }
}