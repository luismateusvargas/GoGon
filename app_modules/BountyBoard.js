// app_modules/BountyBoard.js revamped on 09/26/2025
import { LOG, WARN, ERR } from './core.js';
// Make sure all necessary functions are imported from your utils and database modules.
import { secureFetch, getGoldInHand, getBuffs } from '../utils.js';
import { BountyGroup } from '../webhooks.js';
import { extraDiscordPayload } from './discordPayload.js';
import { claimAlerts, alertFor, processedContent, bindAccount } from './notify.js';
import { apiEndpoints } from '../game_modules/API.js';

// --- CONFIGURATION & STATE ---
const BOUNTY_ID_STORAGE_KEY = 'processed_bounty_ids';
const BOUNTY_HISTORY_LIMIT = 100; // Standard history limit
const GOLD_IMG_URL = 'https://cdn2.fallensword.com/currency/0.png';
const FSP_IMG_URL = 'https://cdn2.fallensword.com/currency/1.png';

/**
 * Formats the bounty reward into a readable string and provides the correct image URL.
 * @param {object} bounty - The bounty object from the API.
 * @returns {{type: string, imageUrl: string}}
 */
function formatBountyReward(bounty) {
    if (bounty.currency.type === 0 ) {
        return {
            type: `${new Intl.NumberFormat().format(bounty.currency.value)} Gold`,
            imageUrl: GOLD_IMG_URL
        };
    }
    if (bounty.currency.type === 1) {
        return {
            type: `${bounty.currency.value} FSP`,
            imageUrl: FSP_IMG_URL
        };
    }
    return {
        type: 'N/A',
        imageUrl: ''
    };
}

export const UNKNOWN = 'Unknown';

/**
 * Runs one target lookup; a thrown error is logged and reported as undefined (shown as 'Unknown').
 */
async function lookupOrUnknown(what, bounty, fn) {
    try {
        return await fn();
    } catch (error) {
        WARN('bounty', `Could not fetch ${what} for ${bounty.target?.name} (id=${bounty.id}); sending alert with '${UNKNOWN}'.`, error?.message);
        return undefined;
    }
}

/**
 * Loads the set of processed bounty IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing unique IDs of processed bounties.
 */
async function loadProcessedBounties(account) {
    try {
        const storedIdsJson = (await processedContent(BOUNTY_ID_STORAGE_KEY, account)) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        LOG('bounty', `Loaded ${storedIdsArray.length} processed bounty IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        WARN('bounty', 'Failed to load processed bounty IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new bounties.
 */
// The only function that needs changing is checkBounties.

export async function checkBounties() {
LOG('bounty', 'Checking for new bounties...');
    try {
        const account = bindAccount(); // this run reads and claims only for the account active now (O4)
        const processedBountyIds = await loadProcessedBounties(account);

        const response = await secureFetch(apiEndpoints.game.bountyBoard);
        if (!response.ok) {
            WARN('bounty', `Fail HTTP: ${response.status}`);
            return;
        }

        const data = await response.json();
        if (!data?.s || !data.r?.bounties) {
            WARN('bounty', `Bounty fetch failed: ${data.e?.message || 'Unknown error'}`);
            return;
        }

        // --- FIX APPLIED HERE ---
        // Iterate through the fetched bounties to build a truly unique list of new items.
        const newBounties = [];
        data.r.bounties.forEach(bounty => {
            // Check if we've ALREADY processed it (from DB or from earlier in this same API call)
            if (!processedBountyIds.has(bounty.id)) {
                newBounties.push(bounty);
                // Immediately add to the in-memory set to handle duplicates within the same API response.
                processedBountyIds.add(bounty.id);
            }
        });

        if (newBounties.length === 0) {
            return; // No new bounties, nothing to do.
        }

        console.log(`Found ${newBounties.length} new unique bounties to process.`);

        // 2. Build each alert (target lookups run concurrently), then claim the ID and enqueue the
        // alert in one transaction.
        await claimAlerts('bounty', { storageKey: BOUNTY_ID_STORAGE_KEY, historyLimit: BOUNTY_HISTORY_LIMIT, account }, newBounties, {
            idOf: bounty => bounty.id,
            build: async bounty => {
                // A failed profile or buff lookup must not drop the alert: it is sent with 'Unknown'. AC-MON-002
                const goldInHand = await lookupOrUnknown('gold in hand', bounty, () => getGoldInHand(apiEndpoints.player.details(bounty.target.id)));
                const buffs = await lookupOrUnknown('buffs', bounty, () => getBuffs(apiEndpoints.player.activeBuffs(bounty.target.id), true));
                const rewardInfo = formatBountyReward(bounty);

                const message = `
:hammer: Target: ${bounty.target.name} (Lvl ${bounty.target.level})
:scales: Offerer: ${bounty.offerer.name}
:moneybag: Reward: ${rewardInfo.type}
:money_with_wings: Gold in Hand: ${goldInHand ?? UNKNOWN}
:shield: Deflect? ${buffs?.hasDeflect ?? UNKNOWN}
:mage: Cloaked? ${buffs?.isCloaked ?? UNKNOWN}
:crystal_ball: Buffs: ${buffs?.numberOfBuffs ?? UNKNOWN}
            `.trim();

                LOG('bounty', `Notifying: ${bounty.target.name} (id=${bounty.id})`);
                return [alertFor('GG_BOUNTY_WEBHOOK', extraDiscordPayload(
                    message,
                    "Bounty Board",
                    "16711680",
                    "Gotta Smash'em all!",
                    BountyGroup,
                    "", // No primary image for bounties
                    rewardInfo.imageUrl || ""
                ))];
            },
        });

    } catch (error) {
        ERR('bounty', 'Error occurred while checking bounties', error);
    }
}