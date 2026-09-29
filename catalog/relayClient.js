// catalog/relayClient.js - CAT-TASK-010 / AC-CAT-011, AC-CAT-014 (catalog-sync-v1 1.3.0)
// The browser half of the guide relay, inlined into the userscript by
// scripts/catalog/build-relay-userscript.mjs together with the three modules imported below (the
// build drops these import lines; the inlined modules put the same names in scope). runLease() reads exactly the pages or IDs the server's lease names, one at a time with the
// lease's delay, classifies each response, parses it, and returns results in lease order. It stops at
// the first challenge or unusable page, so the server keeps its cursor there. It never retries past a
// challenge, never submits a challenge form, and never sees or sends cookies itself.
import { GUIDE_URLS, guideUrl, isDescendingPage } from './contracts/guide.js';
import { classifyResponse } from './contracts/classify.js';
import { isGuidePage, parseIndexPage, DETAIL_PARSERS } from './guideParsers.js';

/**
 * An incremental lease carries stopAtId (the kind's last_seen_id) and overlapPages: once a page
 * reaches stopAtId the relay reads overlapPages more and stops, as long as the pages it saw were in
 * descending order. The server applies the same rule and stays authoritative; this only saves requests.
 * @param {{ kind: string, work: Array<{ type: 'index'|'detail', page?: number, id?: number }>, minDelayMs: number, stopAtId?: number|null, overlapPages?: number }} lease
 * @param {object} deps
 * @param {(url: string) => Promise<{ status: number, contentType: string, cfMitigated: string|null, body: string }>} deps.fetchPage
 * @param {(html: string) => Document} deps.parseHtml
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => boolean} [deps.stopped] - the owner pressed stop
 * @returns {Promise<Array<object>>} results in lease order (possibly fewer than the work items)
 */
export async function runLease(lease, { fetchPage, parseHtml, sleep, stopped = () => false }) {
    const results = [];
    const spec = GUIDE_URLS[lease.kind];
    let reachedAt = null;       // incremental: the page that reached stopAtId
    let descending = true;
    let prevMin = null;
    for (let i = 0; i < lease.work.length; i++) {
        if (stopped()) break;
        if (i > 0) await sleep(lease.minDelayMs);
        const item = lease.work[i];
        const key = item.type === 'index' ? { type: 'index', page: item.page } : { type: 'detail', id: item.id };
        let res;
        try {
            res = await fetchPage(guideUrl(lease.kind, item.type, item.type === 'index' ? item.page : item.id));
        } catch {
            results.push({ ...key, outcome: 'error' });
            break;
        }
        const cls = classifyResponse({ status: res.status, contentType: res.contentType, cfMitigated: res.cfMitigated, body: res.body }, 'html');
        if (cls.class === 'challenge') { results.push({ ...key, outcome: 'challenge' }); break; }
        if (cls.class === 'not_found' && item.type === 'detail') { results.push({ ...key, outcome: 'missing' }); continue; }
        if (cls.class !== 'ok') { results.push({ ...key, outcome: 'error' }); break; }
        const doc = parseHtml(res.body);
        if (!isGuidePage(doc)) { results.push({ ...key, outcome: 'invalid' }); break; }
        if (item.type === 'index') {
            const { entries } = parseIndexPage(doc, spec.idParam);
            if (!entries.length) { results.push({ ...key, outcome: 'empty' }); break; }   // past the last page
            results.push({ ...key, outcome: 'ok', entries });
            const ids = entries.map(e => e.id);
            descending = descending && isDescendingPage(ids, prevMin);
            prevMin = Math.min(...ids);
            if (descending && typeof lease.stopAtId === 'number' && reachedAt === null && prevMin <= lease.stopAtId) reachedAt = item.page;
            if (descending && reachedAt !== null && item.page >= reachedAt + (lease.overlapPages ?? 1)) break;
        } else {
            const record = DETAIL_PARSERS[lease.kind](doc, item.id);
            results.push(record ? { ...key, outcome: 'ok', record } : { ...key, outcome: 'missing' });
        }
    }
    return results;
}
