// app_modules/GameUpdates.js - Refactored for JSON API and SQLite integration

import { LOG, WARN, ERR } from './core.js';
import { secureFetch } from '../utils.js';
import { extraDiscordPayload } from './discordPayload.js';
import { claimAlerts, alertFor } from './notify.js';
import { apiEndpoints } from '../game_modules/API.js';
import {
    getContent
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

        // 2. Build each update's messages (one outbox part per chunk, sent in order), then claim
        // the ID and enqueue them in one transaction
        LOG('updates', `Found ${newUpdates.length} new game updates. Claiming them now...`);
        await claimAlerts('updates', { storageKey: UPDATES_STORAGE_KEY, historyLimit: UPDATES_HISTORY_LIMIT }, newUpdates, {
            idOf: news => news.id,
            build: news => {
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
                
                LOG('updates', `Notifying: "${news.subject}" (ID: ${news.id})`);
                return splitMessage(title, fullMessageBody).map(chunk => alertFor('GG_NEWS_WEBHOOK', extraDiscordPayload(
                    chunk, "Game Update & Events", "5763719",
                    `Posted at ${dateTime}`, ""
                )));
            },
        });

    } catch (error) {
        ERR('updates', 'Error occurred while checking for game updates', error);
    }
}