// catalog/relayClient.js - CAT-TASK-010 / AC-CAT-011, AC-CAT-014 (catalog-sync-v1 1.3.0)
// The browser half of the guide relay, inlined into the userscript by
// scripts/catalog/build-relay-userscript.mjs together with the three modules imported below (the
// build drops these import lines; the inlined modules put the same names in scope). runLease() reads exactly the pages or IDs the server's lease names, one at a time with the
// lease's delay, classifies each response, parses it, and returns results in lease order. It stops at
// the first challenge or unusable page (including a detail page it cannot parse), so the server keeps
// its cursor there. A detail is 'missing' only on HTTP 404. relayCycle() saves the results of a lease
// until GoGon settles them, so a failed submission is resent, never read again. It never retries past a
// challenge, never submits a challenge form, and never sees or sends cookies itself.
import { GUIDE_URLS, guideUrl, isDescendingPage } from './contracts/guide.js';
import { classifyResponse } from './contracts/classify.js';
import { isGuidePage, parseIndexPage, DETAIL_PARSERS } from './guideParsers.js';

/** Bytes of a submission outside its results: {"results":[...],"requests":N}, with room to spare. */
const ENVELOPE_BYTES = 1024;
const utf8Bytes = s => new TextEncoder().encode(s).length;

/**
 * An incremental lease carries stopAtId (the kind's last_seen_id) and overlapPages: once a page
 * reaches stopAtId the relay reads overlapPages more and stops, as long as the pages it saw were in
 * descending order. The server applies the same rule and stays authoritative; this only saves requests.
 * A lease also carries maxBodyBytes, the server's body limit: the relay stops before its results would
 * no longer fit in one submission. A page that does not fit is left for the next lease (its request is
 * still reported); one that cannot fit even alone is sent as 'too_large', so the server stops there.
 * @param {{ kind: string, work: Array<{ type: 'index'|'detail', page?: number, id?: number }>, minDelayMs: number, expiresAt: string, maxBodyBytes?: number, stopAtId?: number|null, overlapPages?: number }} lease
 * @param {object} deps
 * @param {(url: string) => Promise<{ status: number, contentType: string, cfMitigated: string|null, body: string }>} deps.fetchPage
 * @param {(html: string) => Document} deps.parseHtml
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => boolean} [deps.stopped] - the owner pressed stop
 * @param {() => number} [deps.now] - the relay stops at the lease's expiresAt; the server reserved its
 *   requests against the daily cap only for the days up to then
 * @param {() => void} [deps.onRequest] - called once per guide request
 * @returns {Promise<Array<object>>} results in lease order (possibly fewer than the work items)
 */
export async function runLease(lease, { fetchPage, parseHtml, sleep, stopped = () => false, now = Date.now, onRequest = () => {} }) {
    const results = [];
    const budget = (lease.maxBodyBytes ?? Infinity) - ENVELOPE_BYTES;
    let size = 0;
    let reachedAt = null;       // incremental: the page that reached stopAtId
    let descending = true;
    let prevMin = null;
    for (let i = 0; i < lease.work.length; i++) {
        if (stopped()) break;
        if (i > 0) await sleep(lease.minDelayMs);
        if (now() >= Date.parse(lease.expiresAt)) break;   // an expired lease is refused anyway
        const item = lease.work[i];
        const key = item.type === 'index' ? { type: 'index', page: item.page } : { type: 'detail', id: item.id };
        onRequest();
        const { result, stop } = await readItem(lease, item, key, fetchPage, parseHtml);
        const bytes = utf8Bytes(JSON.stringify(result)) + 1;
        if (size + bytes > budget) {
            if (!results.length) results.push({ ...key, outcome: 'too_large' });
            break;
        }
        size += bytes;
        results.push(result);
        if (stop) break;
        if (result.type === 'index') {
            const ids = result.entries.map(e => e.id);
            descending = descending && isDescendingPage(ids, prevMin);
            prevMin = Math.min(...ids);
            if (descending && typeof lease.stopAtId === 'number' && reachedAt === null && prevMin <= lease.stopAtId) reachedAt = item.page;
            if (descending && reachedAt !== null && item.page >= reachedAt + (lease.overlapPages ?? 1)) break;
        }
    }
    return results;
}

/** One guide request, classified and parsed. stop: the lease ends at this result. */
async function readItem(lease, item, key, fetchPage, parseHtml) {
    let res;
    try {
        res = await fetchPage(guideUrl(lease.kind, item.type, item.type === 'index' ? item.page : item.id));
    } catch {
        return { result: { ...key, outcome: 'error' }, stop: true };
    }
    const cls = classifyResponse({ status: res.status, contentType: res.contentType, cfMitigated: res.cfMitigated, body: res.body }, 'html');
    if (cls.class === 'challenge') return { result: { ...key, outcome: 'challenge' }, stop: true };
    if (cls.class === 'not_found' && item.type === 'detail') return { result: { ...key, outcome: 'missing' }, stop: false };
    if (cls.class !== 'ok') return { result: { ...key, outcome: 'error' }, stop: true };
    const doc = parseHtml(res.body);
    if (!isGuidePage(doc)) return { result: { ...key, outcome: 'invalid' }, stop: true };
    if (item.type === 'index') {
        const { entries } = parseIndexPage(doc, GUIDE_URLS[lease.kind].idParam);
        if (!entries.length) return { result: { ...key, outcome: 'empty' }, stop: true };   // past the last page
        return { result: { ...key, outcome: 'ok', entries }, stop: false };
    }
    // Only an HTTP 404 means the record is gone; a guide page whose detail layout the parser
    // does not recognize is invalid and stops the lease like any other unusable page.
    const record = DETAIL_PARSERS[lease.kind](doc, item.id);
    if (!record) return { result: { ...key, outcome: 'invalid' }, stop: true };
    return { result: { ...key, outcome: 'ok', record }, stop: false };
}

/**
 * One relay cycle (AC-CAT-015). Results are saved before they are sent and kept until GoGon settles
 * them, so a submission that failed for a reason that may pass (GoGon unreachable, HTTP 429 or 5xx)
 * is resent exactly as read on the next cycle, before any new lease is asked for. The same pages are
 * never read twice for one lease, so every guide request is one the server reserved. Any other answer
 * settles the saved results: accepted, or refused for good (the lease closed, expired, or invalid).
 * Each submission reports how many guide requests the relay made, so a page read but not sent is not
 * given back to the daily cap. A submission the server finds too large (HTTP 413) is cut to its first
 * half and sent again; the pages cut off are read under a later lease. A single result that still does
 * not fit is sent as too_large, so the relay never submits an empty batch for a page it read.
 * @param {object} deps - runLease's deps, plus:
 * @param {() => Promise<{ status: number, json: any }>} deps.getLease - rejects when GoGon is unreachable
 * @param {(leaseId: string, body: object) => Promise<{ status: number, json: any }>} deps.postResults - same
 * @param {{ get: () => object|null, set: (value: object|null) => void }} deps.saved - survives a page reload
 * @param {(lease: object) => void} [deps.onRead] - called before a lease is read
 * @returns {Promise<{ step: 'unreachable'|'unauthorized'|'http'|'no_lease'|'refused'|'sent', status?: number|string, kept?: boolean, resent?: boolean, results?: number, sweepComplete?: boolean, challenge?: boolean, minDelayMs?: number }>}
 */
export async function relayCycle(deps) {
    const { getLease, postResults, saved, onRead = () => {} } = deps;
    let pending = saved.get();
    const resent = Boolean(pending);
    if (!pending) {
        let r;
        try { r = await getLease(); } catch { return { step: 'unreachable' }; }
        if (r.status === 401) return { step: 'unauthorized' };
        if (r.status !== 200 || !r.json) return { step: 'http', status: r.status };
        if (r.json.status !== 'lease') return { step: 'no_lease', status: r.json.status };
        const lease = r.json.lease;
        onRead(lease);
        let requests = 0;
        const results = await runLease(lease, { ...deps, onRequest: () => { requests++; } });
        pending = { leaseId: lease.leaseId, minDelayMs: lease.minDelayMs, results, requests };
        saved.set(pending);
    }
    let s;
    for (;;) {
        try { s = await postResults(pending.leaseId, { results: pending.results, requests: pending.requests }); } catch { return { step: 'unreachable', kept: true }; }
        if (s.status !== 413) break;
        // Keep the first half. A single result that still does not fit becomes too_large, so the server
        // stops the sweep at that page instead of leasing it again.
        const r = pending.results;
        const cut = r.length > 1 ? r.slice(0, Math.floor(r.length / 2))
            : r.length === 1 && r[0].outcome !== 'too_large' ? [r[0].type === 'index' ? { type: 'index', page: r[0].page, outcome: 'too_large' } : { type: 'detail', id: r[0].id, outcome: 'too_large' }]
            : null;
        if (!cut) break;
        pending = { ...pending, results: cut };
        saved.set(pending);
    }
    if (s.status === 429 || s.status >= 500) return { step: 'http', status: s.status, kept: true };
    saved.set(null);
    if (s.status === 401) return { step: 'unauthorized' };
    if (s.status !== 200) return { step: 'refused', status: s.status, resent };
    return {
        step: 'sent', resent, results: pending.results.length, sweepComplete: Boolean(s.json && s.json.sweepComplete),
        challenge: pending.results.length > 0 && pending.results[pending.results.length - 1].outcome === 'challenge', minDelayMs: pending.minDelayMs,
    };
}
