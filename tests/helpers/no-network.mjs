// tests/helpers/no-network.mjs - REC-TASK-006 / AC-REC-004 no-live-network guard.
// Preloaded into every test process with `node --import ./tests/helpers/no-network.mjs --test`.
// Any outbound connection to a non-loopback host (FallenSword, HuntedCow, Discord, webhooks, CDNs)
// throws instead of leaving the machine. Loopback stays open for in-process HTTP servers under test.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const blockedAttempts = [];

export class LiveNetworkError extends Error {
    constructor(target) {
        super(`Live network access blocked in tests: ${target}`);
        this.name = 'LiveNetworkError';
        this.code = 'GG_NO_LIVE_NETWORK';
    }
}

function isLoopback(host) {
    if (host === undefined || host === null || host === '') return true; // Node defaults to localhost
    const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
    return LOOPBACK.has(h) || h.startsWith('127.');
}

function refuse(target) {
    blockedAttempts.push(target);
    throw new LiveNetworkError(target);
}

/** Extracts host/port from the many net.connect call shapes; IPC paths are always allowed. */
function targetOf(args) {
    let [first, second] = args;
    if (Array.isArray(first)) first = first[0];               // internal normalized form
    if (first && typeof first === 'object') {
        if (first.path) return null;
        return { host: first.host ?? first.hostname, port: first.port };
    }
    if (typeof first === 'string' && !/^\d+$/.test(first)) return null;  // IPC path
    return { host: typeof second === 'string' ? second : undefined, port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args);
    if (target && !isLoopback(target.host)) refuse(`${target.host}:${target.port}`);
    return originalConnect.apply(this, args);
};

const originalTlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
    const opts = args.find(a => a && typeof a === 'object') || {};
    const host = opts.host ?? opts.servername ?? (typeof args[1] === 'string' ? args[1] : undefined);
    if (!opts.socket && !isLoopback(host)) refuse(`tls:${host}`);
    return originalTlsConnect.apply(this, args);
};

for (const api of [dns, dns.promises]) {
    for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
        const original = api[fn];
        if (typeof original !== 'function') continue;
        api[fn] = function guardedDns(host, ...rest) {
            if (!isLoopback(host)) {
                blockedAttempts.push(`dns:${host}`);
                const err = new LiveNetworkError(`dns:${host}`);
                const cb = rest.find(r => typeof r === 'function');
                if (cb) { process.nextTick(cb, err); return undefined; }
                if (api === dns.promises) return Promise.reject(err);
                throw err;
            }
            return original.call(this, host, ...rest);
        };
    }
}

// fetch() (undici) connects through its own pooled sockets; guard it by URL for a clear error.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
    const url = new URL(String(input?.url ?? input));
    if (!isLoopback(url.hostname)) {
        blockedAttempts.push(url.origin);
        throw new TypeError('fetch failed', { cause: new LiveNetworkError(url.origin) });
    }
    return originalFetch(input, init);
};

globalThis.__GG_NO_LIVE_NETWORK__ = { blockedAttempts, isLoopback };
