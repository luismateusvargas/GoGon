// Server-owned guide reads. A clearance is obtained once through the VPS network and supplied
// through an authenticated hot setting; the worker uses the existing lease planner, classifier,
// and parsers. If the guide
// challenges a request, runLease reports it and the planner leaves that checkpoint incomplete.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { CatalogError } from '../_gg_data/handler/catalogStore.js';
import { runLease } from './relayClient.js';

export const DEFAULT_GUIDE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLEARANCE_PATTERN = /^[A-Za-z0-9._-]{1,4096}$/;

async function readBoundedBody(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let body = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return body + decoder.decode();
        bytesRead += value.byteLength;
        if (bytesRead > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Guide response exceeded the byte limit.');
        }
        body += decoder.decode(value, { stream: true });
    }
}

/** Runs at most one guide lease per CatalogSync tick. No clearance value enters a log or result. */
export function createGuideWorker({ relay, clearance, userAgent = DEFAULT_GUIDE_USER_AGENT,
    getClearance = () => clearance, getUserAgent = () => userAgent,
    fetchFn = globalThis.fetch, parseHtml = html => parseHTML(html).document, now = Date.now }) {
    let pendingSubmission = null;
    let challengedConfiguration = null;
    let seededDetailsScheduled = false;

    async function fetchPage(url, signal, currentClearance, currentUserAgent) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchFn(url, {
            headers: { cookie: `cf_clearance=${currentClearance}`, 'user-agent': currentUserAgent },
            redirect: 'follow',
            signal: requestSignal,
        });
        return {
            status: response.status,
            contentType: response.headers.get('content-type') ?? '',
            cfMitigated: response.headers.get('cf-mitigated'),
            body: await readBoundedBody(response),
        };
    }

    async function submitPending(workerId, currentConfiguration) {
        const { lease, results, requests } = pendingSubmission;
        try {
            const summary = await relay.submit(workerId, lease.leaseId, { results, requests });
            pendingSubmission = null;
            if (results.at(-1)?.outcome === 'challenge') challengedConfiguration = currentConfiguration;
            return { status: 'sent', kind: lease.kind, requests, results: results.length,
                challenge: results.at(-1)?.outcome === 'challenge', sweepComplete: Boolean(summary.sweepComplete) };
        } catch (error) {
            if (error instanceof CatalogError && ['not_found', 'conflict', 'invalid'].includes(error.code)) {
                pendingSubmission = null;
                return { status: 'refused', reason: error.code };
            }
            throw error;
        }
    }

    return {
        async run({ signal } = {}) {
            const currentClearance = getClearance();
            const currentUserAgent = getUserAgent();
            if (!currentClearance) return { status: 'unconfigured' };
            if (!CLEARANCE_PATTERN.test(currentClearance) || typeof currentUserAgent !== 'string' || currentUserAgent.length > 300
                || /[\r\n\x00-\x1f\x7f]/.test(currentUserAgent)) return { status: 'invalid_configuration' };
            if (signal?.aborted) return { status: 'aborted' };
            const currentConfiguration = `${currentClearance}\n${currentUserAgent}`;
            if (challengedConfiguration === currentConfiguration) return { status: 'challenged' };
            challengedConfiguration = null;

            if (!seededDetailsScheduled) {
                await relay.scheduleSeededDetails();
                seededDetailsScheduled = true;
            }
            const workerId = await relay.ensureServerWorker();
            if (pendingSubmission) {
                if (now() >= Date.parse(pendingSubmission.lease.expiresAt)) pendingSubmission = null;
                else return submitPending(workerId, currentConfiguration);
            }
            const next = await relay.nextLease(workerId);
            if (next.status !== 'lease') return { status: next.status };

            let requests = 0;
            const results = await runLease(next.lease, {
                fetchPage: url => fetchPage(url, signal, currentClearance, currentUserAgent),
                parseHtml,
                sleep: ms => sleep(ms, undefined, { signal }),
                stopped: () => Boolean(signal?.aborted),
                now,
                onRequest: () => { requests++; },
            });
            pendingSubmission = { lease: next.lease, results, requests };
            return submitPending(workerId, currentConfiguration);
        },
    };
}
