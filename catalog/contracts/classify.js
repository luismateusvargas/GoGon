// catalog/contracts/classify.js - CAT-TASK-001 / AC-CAT-003, AC-CAT-004, AC-CAT-011 (catalog-sync-v1 1.2.x)
// Classifies a game or guide response before anything reads it. Only 'ok' may be parsed; every other
// class leaves the cursor where it is (catalog-sync constraint). Inlined into the relay userscript,
// so it has no imports.
//
// Classes: ok | challenge | login | unauthenticated | rate_limited | server_error | not_found |
//          http_error | malformed | too_large
// A Cloudflare challenge is only recognized and reported; nothing here tries to complete one.

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Markers of a Cloudflare interstitial or managed challenge (title, script, and form signatures).
const CHALLENGE_MARKERS = [
    /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
    /\/cdn-cgi\/challenge-platform\//i,
    /\bcf[_-]chl[_-]/i,
    /\bchallenge-form\b/i,
    /Attention Required! \| Cloudflare/i,
];
// The game's login page (the same signature utils.js secureFetch uses).
const LOGIN_MARKER = /\bid\s*=\s*["']hc-account-link["']/i;

/**
 * @param {object} res
 * @param {number} res.status
 * @param {string} [res.contentType]
 * @param {string|null} [res.cfMitigated] - the cf-mitigated response header
 * @param {string} res.body - response text (already read)
 * @param {'json'|'html'} expect
 * @returns {{ class: string, reason: string, json?: any }}
 */
export function classifyResponse({ status, contentType = '', cfMitigated = null, body = '' }, expect) {
    const text = typeof body === 'string' ? body : '';
    if (text.length > MAX_RESPONSE_BYTES) return { class: 'too_large', reason: 'response exceeds the byte limit' };
    const isHtml = /text\/html/i.test(contentType) || /^\s*</.test(text);
    if (String(cfMitigated || '').toLowerCase() === 'challenge' || (isHtml && CHALLENGE_MARKERS.some(m => m.test(text)))) {
        return { class: 'challenge', reason: 'cloudflare challenge' };
    }
    if (status === 429) return { class: 'rate_limited', reason: 'HTTP 429' };
    if (status >= 500) return { class: 'server_error', reason: `HTTP ${status}` };
    if (status === 404) return { class: 'not_found', reason: 'HTTP 404' };
    if (status < 200 || status >= 300) return { class: 'http_error', reason: `HTTP ${status}` };
    if (isHtml && LOGIN_MARKER.test(text)) return { class: 'login', reason: 'login page' };

    if (expect === 'json') {
        let json;
        try { json = JSON.parse(text); } catch { return { class: 'malformed', reason: 'invalid JSON' }; }
        if (!json || typeof json !== 'object' || Array.isArray(json)) return { class: 'malformed', reason: 'JSON is not an object' };
        if (json.s === false) {
            return json.e && typeof json.e === 'object'
                ? { class: 'unauthenticated', reason: 'game rejected the session' }
                : { class: 'malformed', reason: 'unsuccessful game response' };
        }
        return { class: 'ok', reason: 'ok', json };
    }
    if (!isHtml) return { class: 'malformed', reason: 'not an HTML page' };
    return { class: 'ok', reason: 'ok' };
}

/** Classes after which the same request may be retried later without being counted as data. */
export const RETRYABLE = Object.freeze(['rate_limited', 'server_error', 'http_error']);
