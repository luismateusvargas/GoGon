// app_modules/GameUpdates.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { newsWebhook } from '../webhooks.js'; // Assuming you have these
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_sws_data/handler/sws_database.js';
import * as cheerio from 'cheerio'; // Import cheerio to parse HTML content

// --- CONFIGURATION & STATE ---
const UPDATES_STORAGE_KEY = 'processed_update_archive_ids';
const UPDATES_HISTORY_LIMIT = 100;
const DISCORD_CHAR_LIMIT = 2000;

/**
 * Loads the set of processed update news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
function loadProcessedUpdates() {
    try {
        const storedIdsJson = getContent(UPDATES_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed update news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed update news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * [MODIFIED] Formats the raw text from the game's news. It now parses HTML
 * to extract clean text, image URLs, and external links separately.
 * @param {string} text - The raw text content from the API, which may contain HTML.
 * @returns {{cleanText: string, images: string[], links: string[]}}
 */
function formatNewsContent(text) {
    if (!text) return { cleanText: '', images: [], links: [] };

    // First, handle the game's custom formatting tags
    let processedText = text
        .replace(/\[list\]/g, '')
        .replace(/\[\/list\]/g, '')
        .replace(/\[\*\]/g, '\n• ')
        .replace(/\\r\\n/g, '\n');

    // Now, parse the result as HTML to handle tags like <div>, <img>, <a>
    const $ = cheerio.load(processedText);

    // Extract image URLs
    const images = [];
    $('img').each((i, el) => {
        const src = $(el).attr('src');
        if (src && !src.includes('a.fs-img.net')) { // Filter out tracker pixels
            images.push(src);
        }
    });

    // Extract external links
    const links = [];
    $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
            links.push(href);
        }
    });

    // Convert <br> tags to newlines for proper text extraction
    $('br').replaceWith('\n');
    const cleanText = $('body').text().trim().replace(/\n\s*\n/g, '\n'); // Remove excess blank lines

    return { cleanText, images, links };
}


/**
 * Splits a long message into multiple chunks that respect Discord's character limit.
 * @param {string} title - The title of the news, prefixed to each part.
 * @param {string} content - The main body of the message.
 * @returns {string[]} An array of message chunks.
 */
function splitMessage(title, content) {
    const chunks = [];
    const contentLines = content.split('\n');
    let currentChunk = `${title}\n\n`;

    for (const line of contentLines) {
        if (currentChunk.length + line.length + 1 > DISCORD_CHAR_LIMIT) {
            chunks.push(currentChunk);
            currentChunk = `${title} (Cont.)\n\n`;
        }
        currentChunk += line + '\n';
    }
    chunks.push(currentChunk);
    return chunks;
}


/**
 * The main function to check for and announce new game updates.
 */
export async function checkForUpdatesArchive() {
    console.log('Checking for new game updates...');
    try {
        const processedUpdateIds = loadProcessedUpdates();

        const response = await secureFetch(apiEndpoints.game.updateArchive);
        if (!response.ok) throw new Error(`Failed to fetch update archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Update archive fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }
        
        const newsItems = data.r?.news;
        if (!newsItems || newsItems.length === 0) {
            return;
        }

        let newUpdatesFound = false;

        for (const news of newsItems.reverse()) {
            const newsId = news.id;
            if (processedUpdateIds.has(newsId)) {
                continue;
            }

            if (news.type !== 0) {
                continue;
            }

            newUpdatesFound = true;
            console.log(`New game update found! ID: ${newsId}, Subject: "${news.subject}"`);
            
            const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
            const title = `:loudspeaker: **${news.subject}**`;
            
            // [MODIFIED] Process the content to separate text, images, and links.
            const formattedContent = formatNewsContent(news.content.text);
            
            let fullMessageBody = formattedContent.cleanText;

            if (formattedContent.images.length > 0) {
                fullMessageBody += '\n\n:camera_with_flash: **Images Found:**\n' + formattedContent.images.join('\n');
            }
            if (formattedContent.links.length > 0) {
                fullMessageBody += '\n\n:link: **Related Links:**\n' + formattedContent.links.join('\n');
            }
            
            const messageChunks = splitMessage(title, fullMessageBody);

            try {
                for (const chunk of messageChunks) {
                    await sendExtraDiscordMessage(
                        chunk,
                        "Game Update & Events",
                        "5763719", // A green color
                        `Posted at ${dateTime}`,
                        "",
                        newsWebhook
                    );
                    if (messageChunks.length > 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                LOG('updates', `Notified: "${news.subject}" (ID: ${newsId})`);
            } catch (e) {
                ERR('updates', 'Failed to send update notification to Discord', e);
            }

            processedUpdateIds.add(newsId);
        }

        if (newUpdatesFound) {
            let idsToStore = Array.from(processedUpdateIds);

            if (idsToStore.length > UPDATES_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - UPDATES_HISTORY_LIMIT);
            }
            
            setContent(UPDATES_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed update news IDs to database.`);
        }
    } catch (error) {
        console.error('An error occurred while checking for game updates:', error);
    }
}

