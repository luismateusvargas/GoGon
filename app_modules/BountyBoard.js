// app_modules/BountyBoard.js revamped on 09/26/2025
import { LOG, WARN, ERR } from './core.js';
// Make sure all necessary functions are imported from your utils and database modules.
import { secureFetch, sendExtraDiscordMessage, getGoldInHand, getBuffs } from '../utils.js';
import { bountyWebhook, BountyGroup } from '../webhooks.js';
import { apiEndpoints } from '../game_modules/API.js';
import { getContent, setContent } from '../_sws_data/handler/sws_database.js';

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

/**
 * Loads the set of processed bounty IDs from the SQLite key-value store.
 * @returns {Set<number>} A Set containing unique IDs of processed bounties.
 */
function loadProcessedBounties() {
    try {
        const storedIdsJson = getContent(BOUNTY_ID_STORAGE_KEY) || '[]';
        const storedIdsArray = JSON.parse(storedIdsJson);
        console.log(`[SWS_DB] Loaded ${storedIdsArray.length} processed bounty IDs from database.`);
        return new Set(storedIdsArray);
    } catch (error) {
        console.error('Failed to load processed bounty IDs from database, starting fresh.', error);
        return new Set();
    }
}

/**
 * The main function to check for and announce new bounties.
 */
export async function checkBounties() {
    console.log('Checking for new bounties...');
    try {
        const processedBountyIds = loadProcessedBounties();

        const response = await secureFetch(apiEndpoints.game.bountyBoard);
        if (!response.ok) {
            WARN('bounty', `Fail HTTP: ${response.status}`);
            return;
        }

        const data = await response.json();
        if (!data || !data.s) {
            console.error('Bounty fetch was not successful:', data.e?.message || 'Unknown error');
            return;
        }

        const bounties = data.r?.bounties;
        if (!bounties || bounties.length === 0) {
            console.log('No active bounties found.');
            return;
        }

        let newBountiesFound = false;

        for (const bounty of bounties) {
            const bountyId = bounty.id;
            if (processedBountyIds.has(bountyId)) {
                continue;
            }

            newBountiesFound = true;
            console.log(`New bounty found! ID: ${bountyId}, Target: ${bounty.target.name}`);

            // --- [FIXED] All processing logic is now INSIDE the loop ---
            
            // Assume getGoldInHand and getBuffs are async and must be awaited.
            const goldInHand = await getGoldInHand(apiEndpoints.player.details(bounty.target.id));
            const buffs = await getBuffs(apiEndpoints.player.activeBuffs(bounty.target.id), true);
            const rewardInfo = formatBountyReward(bounty);

            const message = `
:hammer: Target: ${bounty.target.name} (Lvl ${bounty.target.level})
:scales: Offerer: ${bounty.offerer.name}
:moneybag: Reward: ${rewardInfo.type}
:money_with_wings: Gold in Hand: ${goldInHand ?? '-'}
:shield: Deflect? ${buffs?.hasDeflect ?? 'N/A'}
:mage: Cloaked? ${buffs?.isCloaked ?? 'N/A'}
:crystal_ball: Buffs: ${buffs?.numberOfBuffs ?? 'N/A'}
            `.trim();

            try {
                // Assuming sendExtraDiscordMessage can handle the image URL parameter.
                sendExtraDiscordMessage(
                    message,
                    "Bounty Board",
                    "16711680",
                    "Gotta Smash'em all!",
                    BountyGroup,
                    bountyWebhook,
                    "", // No primary image for bounties
                    rewardInfo.imageUrl || ""
                );
                LOG('bounty', `Notified: ${bounty.target.name} (id=${bountyId})`);
            } catch (e) {
                ERR('bounty', 'Failed to send bounty to Discord', e);
            }

            processedBountyIds.add(bountyId);
        }

        if (newBountiesFound) {
            let idsToStore = Array.from(processedBountyIds);

            // Trim the history if it exceeds the limit.
            if (idsToStore.length > BOUNTY_HISTORY_LIMIT) {
                idsToStore = idsToStore.slice(idsToStore.length - BOUNTY_HISTORY_LIMIT);
            }
            
            setContent(BOUNTY_ID_STORAGE_KEY, JSON.stringify(idsToStore));
            console.log(`[SWS_DB] Saved ${idsToStore.length} processed bounty IDs to database.`);
        }
    } catch (error) { // [FIXED] Added the missing catch block for the main try.
        console.error('An error occurred while checking bounties:', error);
    }
}
