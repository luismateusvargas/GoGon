// --- INITIALIZATION MODULE (app.mjs) ---
// This file is responsible for setting up the environment, logging in,
// and starting the main application engine.


/****************** DO NOT TOUCH **********************/
// MADE TO RESET A SPECIFIC TABLE 
//import { runReset } from './utils/db_cleanup.js';
//runReset();

//import { deleteContent } from './_sws_data/handler/sws_database.js';
//deleteContent('processed_shoutbox_ids');
//deleteContent('processed_ladder_news_ids');
//deleteContent('processed_titan_news_ids');
//deleteContent('processed_crate_ids');
//deleteContent('processed_se_kill_ids');
//deleteContent('processed_bounty_ids');
//deleteContent('processed_guild_message_ids');
//deleteContent('processed_bounty_ids');


// THIS IS INTENDED FOR WHEN THE GAME UPDATES IT'S CREATURES DATABASE
//import { updateCreatureDatabase } from './fs_database/creatureDatabase.js';
//updateCreatureDatabase();

// THIS IS INTENDED FOR WHEN THE GAME UPDATES IT'S ITEMS DATABASE
//import { updateItemDatabase } from './fs_database/itemDatabase.js';
//updateItemDatabase();

// THIS IS INTENDED FOR WHEN THE GAME UPDATES IT'S REALMS AND RELICS DATABASE
//import { updateRealmDatabase } from './fs_database/realmDatabase.js';
//updateRealmDatabase();
/******************************************************/


// 1. Environment Setup and Polyfills
import 'dotenv/config';
import { parseHTML, DOMParser } from 'linkedom';
import { authedFetch, login, ensureLogin } from './session.mjs';

// Polyfills to simulate a browser environment (required for FS libraries).
// This setup must come BEFORE importing the engine.
console.log('[SWS] Initializing DOM environment with linkedom...');
const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
global.window = window;
global.document = window.document;
global.DOMParser = DOMParser;

// Overwrites the global fetch to use the authenticated version with cookies.
global.fetch = authedFetch;
// Makes the login check function available globally.
global.ensureLogin = ensureLogin;

// 2. Main Module Imports
// The engine is imported AFTER the globals are ready.
import { initEngine } from './engine.js';

// The Discord bot.
 import { setupDiscord } from './discordBot.mjs';


// Main function that executes the application's boot sequence.
 
async function main() {
    console.log('[SWS] Starting boot sequence...');

    // 3. Loading Credentials
    const email = process.env.SWS_EMAIL || process.env.FS_EMAIL;
    const pass = process.env.SWS_PASSWORD || process.env.FS_PASSWORD;

    if (!email || !pass) {
        console.error('[SWS_ERROR] Credentials (SWS_EMAIL/SWS_PASSWORD) not found in the .env file. Exiting.');
        process.exit(1);
    }
    console.log('[SWS] Credentials loaded successfully.');

    // 4. Login Sequence
    try {
        console.log('[SWS] Performing initial login...');
        const loginStatus = await login(email, pass);
        console.log(`[SWS] Login successful: ${loginStatus}`);

        console.log('[SWS] Verifying and ensuring login session...');
        await ensureLogin();
        console.log('[SWS] Login session validated.');
    } catch (e) {
        console.error('[SWS_FATAL] Critical failure during the login process. Check your credentials and connection.', e?.stack || e);
        process.exit(1);
    }

    // 5. Engine Initialization
    try {
        console.log('[SWS] Invoking the application engine (engine.js)...');
        initEngine();
        console.log('[SWS] Engine started and running.');
    } catch (e) {
        console.error('[SWS_FATAL] Failed to invoke initEngine:', e?.stack || e);
        process.exit(1);
    }

    // 6. Discord Bot Initialization (uncomment to activate)
    // The Discord bot is usually what keeps the Node.js process alive.
     const token = process.env.DISCORD_TOKEN;
     const appId = process.env.DISCORD_APP_ID;
     const guildId = process.env.DISCORD_GUILD_ID;
     if (token && appId && guildId) {
         console.log('[SWS] Starting the Discord bot...');
         await setupDiscord(token, appId, guildId);
     } else {
         console.warn('[SWS] Discord credentials not found. The bot will not be started.');
     }
}

// --- Execution ---

// Listener for unhandled exceptions, preventing the application from crashing silently.
process.on('unhandledRejection', (reason) => {
    console.error('[SWS_ERROR] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[SWS_ERROR] Uncaught Exception:', err);
});

// Starts the application by calling the main function.
main().catch(err => {
    console.error('[SWS_FATAL] A fatal error occurred in the main function:', err?.stack || err);
    process.exit(1);
});
