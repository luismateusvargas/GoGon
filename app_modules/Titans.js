// app_modules/Titans.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { titanWebhook, TitanGroup } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent,
    getCreatureById
} from '../_sws_data/handler/sws_database.js';

// --- CONFIGURATION & STATE ---
const TITAN_NEWS_STORAGE_KEY = 'processed_titan_news_ids';
const TITAN_HISTORY_LIMIT = 100; // Standard history limit of 100

/**
 * Loads the set of processed titan news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
function loadProcessedTitanNews() {
    try {
        const storedIdsJson = getContent(TITAN_NEWS_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed titan news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed titan news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new titan sightings.
 */
export async function checkForTitanNotifications() {
    console.log('Checking for new titan notifications...');
    try {
        const processedNewsIds = loadProcessedTitanNews();

        const response = await secureFetch(apiEndpoints.game.newsArchive);
        if (!response.ok) throw new Error(`Failed to fetch news archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('News archive fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        // [FIXED] Access the 'news' array directly from the response object.
        const newsItems = data.r?.news;
        if (!newsItems || newsItems.length === 0) {
            console.log('No recent news items found.');
            return;
        }

        let newTitansFound = false;

        for (const news of newsItems.reverse()) {
            // Use a much more reliable filter based on the news subject.
            if (news.type !== 4 || news.subject !== "Titan Spotted!") {
                continue;
            }

            const newsId = news.id;
            if (processedNewsIds.has(newsId)) {
                continue;
            }

            newTitansFound = true;
            console.log(`New titan sighting found! News ID: ${newsId}`);

            const titanId = news.content.attachments?.[0]?.data;
            if (!titanId) {
                WARN('titans', `Found a titan news item (ID: ${newsId}) but it was missing the creature ID attachment.`);
                continue;
            }

            const titan = getCreatureById(titanId);
            if (!titan) {
                WARN('titans', `Could not find titan with ID ${titanId} in the database. Skipping news ID: ${newsId}.`);
                continue;
            }
            
            const locationMatch = news.content.text.match(/in (.*?)\!/);
            const location = locationMatch ? locationMatch[1] : 'an unknown location';
            
            const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });

            const message = `
:boar: **${titan.name}**
:calendar_spiral: ${dateTime}
:map: Spotted at: **${location}**`
.trim();

            try {
                sendExtraDiscordMessage(
                    message,
                    "Titan Spotted!",
                    "1127128", // A dark red color
                    "A new titan has appeared in the realm!",
                    TitanGroup,
                    titanWebhook,
                    "", // No primary image for titans
                    titan.imageUrl || "" // Use the creature's image as the thumbnail
                );
                LOG('titans', `Notified: ${titan.name} spotted at ${location}`);
            } catch (e) {
                ERR('titans', 'Failed to send titan notification to Discord', e);
            }

            processedNewsIds.add(newsId);
        }

        if (newTitansFound) {
            let idsToStore = Array.from(processedNewsIds);

            if (idsToStore.length > TITAN_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - TITAN_HISTORY_LIMIT);
            }
            
            setContent(TITAN_NEWS_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed titan news IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking for titan notifications:', error);
    }
}

