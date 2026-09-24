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
import { authedFetch, login, ensureLogin, currentCredentials } from './session.mjs';
import { getSetting } from './config/runtime.mjs';

// Polyfills to simulate a browser environment (required for FS libraries).
// This setup must come BEFORE importing the engine.
console.log('[GoGon] Initializing DOM environment with linkedom...');
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
import { setupDiscord, restartDiscord } from './discordBot.mjs';

// Loopback health probe
import { startHealthCheckServer, healthReport } from './healthCheck.mjs';

// v1.8.0: Configuration validator
import { validateAndExit, getConfigSummary } from './configValidator.mjs';

// Private control plane (CTRL-TASK-003/004/005)
import { isControlPlaneEnabled, prepareControlPlane, startControlPlane } from './control-plane/index.mjs';
import { getMetrics } from './metrics.mjs';
import { initDatabase } from './_gg_data/handler/gg_database.js';


// Main function that executes the application's boot sequence.
 
async function main() {
    console.log('[GoGon] Starting boot sequence...');

    // v1.8.0: Validate configuration before proceeding
    console.log('[GoGon] Validating configuration...');
    validateAndExit(); // Will exit if critical errors found

    // 2a. MySQL (AC-DATA-007): connect and migrate before anything reads state; fail closed.
    try {
        console.log('[GoGon] Connecting to MySQL and applying migrations...');
        await initDatabase();
    } catch (e) {
        console.error(`[GoGon_FATAL] Database unavailable: ${e.message}`);
        process.exit(1);
    }

    // 2b. Control plane bootstrap (AC-CTRL-005): fail closed before any game login when it is
    // enabled but its .env bootstrap values are missing or invalid. It also loads dashboard
    // overrides and the active account profile.
    let controlPlane = null;
    if (isControlPlaneEnabled()) {
        try {
            controlPlane = await prepareControlPlane();
            console.log(`[GoGon] Control plane configured${controlPlane.activeLabel ? `; active account profile "${controlPlane.activeLabel}"` : ''}.`);
        } catch (e) {
            console.error(`[GoGon_FATAL] ${e.message}`);
            process.exit(1);
        }
    }

    // 3. Loading Credentials
    // The active account profile wins; otherwise GG_ names, then legacy SWS_/FS_ (AUTH-TASK-001, REC-TASK-002)
    const { email, password: pass } = currentCredentials();

    if (!email || !pass) {
        console.error('[GoGon_ERROR] Credentials (GG_EMAIL/GG_PASSWORD) not found in the .env file. Exiting.');
        process.exit(1);
    }
    console.log('[GoGon] Credentials loaded successfully.');

    // 4. Login Sequence
    try {
        console.log('[GoGon] Performing initial login...');
        const loginStatus = await login(email, pass);
        console.log(`[GoGon] Login successful: ${loginStatus}`);

        console.log('[GoGon] Verifying and ensuring login session...');
        await ensureLogin();
        console.log('[GoGon] Login session validated.');
    } catch (e) {
        console.error('[GoGon_FATAL] Critical failure during the login process. Check your credentials and connection.', e?.stack || e);
        process.exit(1);
    }

    // 5. Engine Initialization
    try {
        console.log('[GoGon] Invoking the application engine (engine.js)...');
        initEngine({ preferences: controlPlane?.preferences });
        console.log('[GoGon] Engine started and running.');
    } catch (e) {
        console.error('[GoGon_FATAL] Failed to invoke initEngine:', e?.stack || e);
        process.exit(1);
    }

    // 6. Discord Bot Initialization
    // The Discord bot is usually what keeps the Node.js process alive.
     const token = getSetting('GG_DISCORD_TOKEN');
     const appId = getSetting('GG_DISCORD_APP_ID');
     const guildId = getSetting('GG_DISCORD_GUILD_ID');
     if (token && appId && guildId) {
         console.log('[GoGon] Starting the Discord bot...');
         await setupDiscord(token, appId, guildId);
     } else {
         console.warn('[GoGon] Discord credentials not found. The bot will not be started.');
     }

    // 7. Control plane (authenticated dashboard)
    if (controlPlane) {
        try {
            await startControlPlane(controlPlane, {
                rebind: async (subsystem) => {
                    if (subsystem !== 'discord') throw new Error(`Unknown subsystem ${subsystem}`);
                    await restartDiscord(getSetting('GG_DISCORD_TOKEN'), getSetting('GG_DISCORD_APP_ID'), getSetting('GG_DISCORD_GUILD_ID'));
                },
                healthReport: () => healthReport(),
                metrics: () => getMetrics(),
                validation: () => getConfigSummary(),
            });
        } catch (e) {
            console.error(`[GoGon_ERROR] Control plane failed to start: ${e.message}`);
        }
    }

    // 8. Loopback health probe
    if (getSetting('GG_HEALTH_CHECK_ENABLED') !== '0') {
        console.log('[GoGon] Starting health check server...');
        startHealthCheckServer();
    } else {
        console.log('[GoGon] Health check server disabled (GG_HEALTH_CHECK_ENABLED=0)');
    }
}

// --- Execution ---

// Listener for unhandled exceptions, preventing the application from crashing silently.
process.on('unhandledRejection', (reason) => {
    console.error('[GoGon_ERROR] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[GoGon_ERROR] Uncaught Exception:', err);
});

// Starts the application by calling the main function.
main().catch(err => {
    console.error('[GoGon_FATAL] A fatal error occurred in the main function:', err?.stack || err);
    process.exit(1);
});
