// catalog/requestPolicy.js - CAT-TASK-003 / AC-CAT-001, AC-CAT-002 (catalog-sync-v1 1.3.0)
// What the catalog may request from the game, and how fast. Reads are a code-owned allow-list:
// a job kind maps to one read operation, whose URL comes from game_modules/API.js and must pass
// assertPassiveGameUrl(). Nothing from the dashboard ever becomes a URL. The queue keeps one game
// request in flight process-wide with GAME_POLICY.minDelayMs between starts.
import { apiEndpoints } from '../game_modules/API.js';
import { GAME_POLICY } from './contracts/policy.js';
import { GAME_LOCATION_CONTRACT, GAME_DETAIL_CONTRACTS, isContractUsable } from './contracts/gameLocation.js';

// No catalog module may reference a game action builder (attack, move, travel, equip, use item,
// form posts, group joins); tests/catalog-sync/collector.test.mjs scans catalog/ for them.

// fetchdata.php world reads use a=-1; attack (a=2), move (a=4), and travel (a=5) are actions.
const PASSIVE_WORLD_READS = new Set(['1409', '81']);   // d= of fetchLocation and fetchWorldMap

/** Throws unless url is a passive game read: GET-only fetchdata a=-1 with an allow-listed d. */
export function assertPassiveGameUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('Catalog request URL is invalid.'); }
    const ok = u.protocol === 'https:' && u.hostname === 'www.fallensword.com' && u.pathname === '/fetchdata.php'
        && u.searchParams.get('a') === '-1' && PASSIVE_WORLD_READS.has(u.searchParams.get('d') ?? '')
        && !u.username && !u.password;
    if (!ok) throw new Error('Catalog request URL is not an allow-listed passive read.');
    return u.toString();
}

/** Resolves a dotted key into apiEndpoints ("world.fetchLocation"); only string endpoints. */
function endpoint(key) {
    let v = apiEndpoints;
    for (const part of key.split('.')) {
        if (!v || typeof v !== 'object' || !Object.hasOwn(v, part)) throw new Error(`Unknown endpoint ${key}.`);
        v = v[part];
    }
    if (typeof v !== 'string') throw new Error(`Endpoint ${key} is not a fixed URL.`);
    return v;
}

/**
 * Job kind -> read operation. A kind whose contract is unverified is known but unavailable.
 * @param {object} [contracts] - test seam; production uses the committed contracts
 */
export function readOperations(contracts = { location: GAME_LOCATION_CONTRACT, itemDetail: GAME_DETAIL_CONTRACTS.item }) {
    return {
        observe_realm: {
            contract: contracts.location,
            available: isContractUsable(contracts.location),
            request: () => ({ url: assertPassiveGameUrl(endpoint(contracts.location.endpoint)), expect: 'json' }),
        },
        item_frontier: {
            contract: contracts.itemDetail,
            available: isContractUsable(contracts.itemDetail),
            // A validated item-detail contract supplies its own passive request builder.
            request: id => {
                const r = contracts.itemDetail.request(id);
                return { url: contracts.itemDetail.passive ? contracts.itemDetail.passive(r.url) : assertPassiveGameUrl(r.url), expect: r.expect ?? 'json' };
            },
        },
    };
}

/** Why a catalog job kind cannot run, or null. Guide work uses the server worker or legacy relay. */
export function unavailableReason(kind, ops = readOperations()) {
    if (kind === 'guide_discovery') return null;
    const op = ops[kind];
    if (!op) return 'unknown_kind';
    return op.available ? null : 'contract_unverified';
}

/**
 * One game request at a time, process-wide, at least minDelayMs between request starts.
 * @param {{ minDelayMs?: number, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [opts]
 */
export function createRequestQueue({ minDelayMs = GAME_POLICY.minDelayMs, now = Date.now, sleep = abortableSleep } = {}) {
    let tail = Promise.resolve();
    let lastStart = -Infinity;
    let inFlight = 0;
    let maxInFlight = 0;
    return {
        /** Runs fn() after every earlier request settled and the delay passed; honors signal. */
        run(fn, signal) {
            const turn = tail.then(async () => {
                signal?.throwIfAborted();
                const wait = lastStart + minDelayMs - now();
                if (wait > 0) await sleep(wait, signal);
                signal?.throwIfAborted();
                lastStart = now();
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try { return await fn(); } finally { inFlight--; }
            });
            tail = turn.catch(() => {});
            return turn;
        },
        get maxInFlight() { return maxInFlight; },
    };
}

export function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** The process-wide game queue shared by every catalog job. */
export const gameQueue = createRequestQueue();
