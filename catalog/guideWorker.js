// Server-owned guide reads. A browser renews clearance when Cloudflare challenges a request;
// the existing lease planner, classifier, and parsers still decide what enters the catalog.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { CatalogError } from '../_gg_data/handler/catalogStore.js';
import { nativeFetch } from '../session.mjs';
import { runLease } from './relayClient.js';
import { GUIDE_POLICY } from './contracts/policy.js';
import { classifyResponse } from './contracts/classify.js';
import { GuideClearanceError } from './guideClearance.js';

export const DEFAULT_GUIDE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RENEWAL_FAILURE_RETRY_MS = 5 * 60_000;
const CLEARANCE_PATTERN = /^[A-Za-z0-9._-]{1,4096}$/;

function validCredentials(credentials) {
    return typeof credentials?.clearance === 'string' && CLEARANCE_PATTERN.test(credentials.clearance)
        && typeof credentials.userAgent === 'string' && credentials.userAgent.length > 0
        && credentials.userAgent.length <= 300 && !/[\r\n\x00-\x1f\x7f]/.test(credentials.userAgent);
}

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
    fetchFn = nativeFetch, renewClearance = null,
    parseHtml = html => parseHTML(html).document, now = Date.now }) {
    let pendingSubmission = null;
    let lastChallenge = null;
    let seededDetailsScheduled = false;
    let activeCredentials = null;
    let suppliedConfiguration = null;

    async function readResponse(url, signal, credentials) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchFn(url, {
            headers: { cookie: `cf_clearance=${credentials.clearance}`, 'user-agent': credentials.userAgent },
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

    async function fetchPage(url, signal, suppliedCredentials, onRenewalFailure) {
        let credentials = activeCredentials ?? suppliedCredentials;
        let renewed = false;
        if (!validCredentials(credentials)) {
            try {
                credentials = await renewClearance({ signal });
            } catch (error) {
                if (error instanceof GuideClearanceError) console.warn('[Catalog] Guide browser verification did not complete.');
                throw error;
            }
            if (!validCredentials(credentials)) throw new GuideClearanceError('Guide browser returned invalid credentials.');
            activeCredentials = credentials;
            renewed = true;
        }
        const response = await readResponse(url, signal, credentials);
        if (renewed || !renewClearance || classifyResponse(response, 'html').class !== 'challenge') return response;
        try {
            credentials = await renewClearance({ signal });
            if (!validCredentials(credentials)) throw new GuideClearanceError('Guide browser returned invalid credentials.');
        } catch (error) {
            if (!(error instanceof GuideClearanceError)) throw error;
            console.warn('[Catalog] Guide browser verification did not complete.');
            onRenewalFailure();
            return response;
        }
        activeCredentials = credentials;
        return readResponse(url, signal, credentials);
    }

    async function submitPending(workerId, currentConfiguration) {
        const { lease, results, requests, renewalFailed } = pendingSubmission;
        try {
            const summary = await relay.submit(workerId, lease.leaseId, { results, requests });
            pendingSubmission = null;
            if (results.at(-1)?.outcome === 'challenge') {
                lastChallenge = { configuration: currentConfiguration, at: now(),
                    retryAfterMs: renewalFailed ? RENEWAL_FAILURE_RETRY_MS : GUIDE_POLICY.partialRetryMs };
            }
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
            const suppliedCredentials = { clearance: getClearance(), userAgent: getUserAgent() };
            const configuration = `${suppliedCredentials.clearance}\n${suppliedCredentials.userAgent}`;
            if (configuration !== suppliedConfiguration) {
                activeCredentials = null;
                suppliedConfiguration = configuration;
            }
            const currentCredentials = activeCredentials ?? suppliedCredentials;
            if (!validCredentials(currentCredentials) && !renewClearance) {
                return { status: suppliedCredentials.clearance ? 'invalid_configuration' : 'unconfigured' };
            }
            if (signal?.aborted) return { status: 'aborted' };
            const currentConfiguration = `${currentCredentials.clearance}\n${currentCredentials.userAgent}`;
            if (lastChallenge?.configuration === currentConfiguration
                && now() - lastChallenge.at < lastChallenge.retryAfterMs) return { status: 'challenged' };
            lastChallenge = null;

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
            let renewalFailed = false;
            const results = await runLease(next.lease, {
                fetchPage: url => fetchPage(url, signal, suppliedCredentials, () => { renewalFailed = true; }),
                parseHtml,
                sleep: ms => sleep(ms, undefined, { signal }),
                stopped: () => Boolean(signal?.aborted),
                now,
                onRequest: () => { requests++; },
            });
            pendingSubmission = { lease: next.lease, results, requests, renewalFailed };
            const submittedCredentials = activeCredentials ?? suppliedCredentials;
            return submitPending(workerId, `${submittedCredentials.clearance}\n${submittedCredentials.userAgent}`);
        },
    };
}
