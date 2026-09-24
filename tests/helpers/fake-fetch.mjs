// tests/helpers/fake-fetch.mjs - in-process HTTP double for fetch(). No socket is ever opened.
// Install it before importing session.mjs: authedFetch captures globalThis.fetch at import time.

/**
 * Replaces globalThis.fetch with a router. `handler(req)` receives { url, method, headers, body }
 * and returns { status?, body?, headers?, json? } or throws to simulate a network failure.
 * @returns {{ calls: object[], setHandler(fn): void, restore(): void }}
 */
export function installFakeFetch(initialHandler = () => ({ status: 404, body: 'no route' })) {
    const original = globalThis.fetch;
    let handler = initialHandler;
    const calls = [];

    globalThis.fetch = async (input, init = {}) => {
        const url = String(input?.url ?? input);
        const headers = new Headers(init.headers || {});
        const body = init.body == null ? '' : String(init.body);
        const req = { url, method: (init.method || 'GET').toUpperCase(), headers, body };
        calls.push(req);
        const out = await handler(req);
        const resHeaders = new Headers(out.headers || {});
        let payload = out.body ?? '';
        if (out.json !== undefined) {
            payload = JSON.stringify(out.json);
            if (!resHeaders.has('content-type')) resHeaders.set('content-type', 'application/json');
        } else if (!resHeaders.has('content-type')) {
            resHeaders.set('content-type', 'text/html; charset=utf-8');
        }
        const status = out.status ?? 200;
        const res = new Response([204, 301, 302, 303, 304, 307, 308].includes(status) ? null : payload, { status, headers: resHeaders });
        Object.defineProperty(res, 'url', { value: url });
        return res;
    };

    return {
        calls,
        setHandler(fn) { handler = fn; },
        restore() { globalThis.fetch = original; },
    };
}

/** Parses an application/x-www-form-urlencoded request body. */
export function formOf(req) {
    return Object.fromEntries(new URLSearchParams(req.body));
}
