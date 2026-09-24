// app_modules/GameUpdates.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch, sendExtraDiscordMessage } from '../utils.js';
import { newsWebhook } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent,
    setContent
} from '../_gg_data/handler/gg_database.js';
import * as cheerio from 'cheerio';

// --- CONFIGURATION & STATE ---
const UPDATES_STORAGE_KEY = 'processed_update_archive_ids';
const UPDATES_HISTORY_LIMIT = 100;
const DISCORD_CHAR_LIMIT = 2000;

/**
 * Loads the set of processed update news IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing the unique IDs of processed news items.
 */
async function loadProcessedUpdates() {
    try {
        const storedIdsJson = (await getContent(UPDATES_STORAGE_KEY)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('updates', `Loaded ${storedIdsArray.length} processed update news IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('updates', 'Failed to load processed update news IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * Formats the raw text from the game's news, parsing HTML.
 * @param {string} text - The raw text content from the API.
 * @returns {{cleanText: string, images: string[], links: string[]}}
 */
function formatNewsContent(text) {
    if (!text) return { cleanText: '', images: [], links: [] };
    let processedText = text
        .replace(/\[list\]/g, '')
        .replace(/\[\/list\]/g, '')
        .replace(/\[\*\]/g, '\n• ')
        .replace(/\\r\\n/g, '\n');

    const $ = cheerio.load(processedText);
    const images = [];
    $('img').each((i, el) => {
        const src = $(el).attr('src');
        if (src && !src.includes('a.fs-img.net')) {
            images.push(src);
        }
    });
    const links = [];
    $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
            links.push(href);
        }
    });
    $('br').replaceWith('\n');
    const cleanText = $('body').text().trim().replace(/\n\s*\n/g, '\n');
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
    LOG('updates', 'Checking for new game updates...');
    try {
        const processedUpdateIds = await loadProcessedUpdates();

        const response = await secureFetch(apiEndpoints.game.updateArchive);
        if (!response.ok) throw new Error(`Failed to fetch update archive data. Status: ${response.status}`);

        const data = await response.json();
        if (!data?.s || !data.r?.news) {
            WARN('updates', `Update archive fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }
        
        // 1. Filter to find only the new game updates
        const newUpdates = data.r.news.reverse().filter(news =>
            news.type === 0 && !processedUpdateIds.has(news.id)
        );

        if (newUpdates.length === 0) {
            return;
        }

        // 2. IMMEDIATELY claim and save the new IDs
        LOG('updates', `Found ${newUpdates.length} new game updates. Claiming them now...`);
        for (const news of newUpdates) {
            await setContent(UPDATES_STORAGE_KEY, news.id, UPDATES_HISTORY_LIMIT);
        }
        LOG('updates', `Claimed and saved ${newUpdates.length} new update news IDs.`);

        // 3. Now, safely process all notifications concurrently
        const notificationPromises = newUpdates.map(async (news) => {
            try {
                const newsId = news.id;
                const dateTime = new Date(news.time * 1000).toLocaleString('pt-BR', { timeZone: 'Europe/London' });
                const title = `:loudspeaker: **${news.subject}**`;
                
                const formattedContent = formatNewsContent(news.content.text);
                let fullMessageBody = formattedContent.cleanText;

                if (formattedContent.images.length > 0) {
                    fullMessageBody += '\n\n:camera_with_flash: **Images Found:**\n' + formattedContent.images.join('\n');
                }
                if (formattedContent.links.length > 0) {
                    fullMessageBody += '\n\n:link: **Related Links:**\n' + formattedContent.links.join('\n');
                }
                
                const messageChunks = splitMessage(title, fullMessageBody);

                // This inner loop is correct; it sends chunks of a single update in order.
                for (const chunk of messageChunks) {
                    await sendExtraDiscordMessage(
                        chunk, "Game Update & Events", "5763719",
                        `Posted at ${dateTime}`, "", newsWebhook
                    );
                    if (messageChunks.length > 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                LOG('updates', `Notified: "${news.subject}" (ID: ${newsId})`);
            } catch (e) {
                ERR('updates', `Failed to process update ID ${news.id}`, e);
            }
        });

        // 4. Wait for all separate update notifications to be sent
        await Promise.allSettled(notificationPromises);

    } catch (error) {
        ERR('updates', 'Error occurred while checking for game updates', error);
    }
}