// tests/control-plane/catalog-ui.test.mjs - CAT-TASK-006 / AC-CAT-007, AC-CAT-008, AC-CAT-009
// The real dashboard page and script in a linkedom DOM, with fetch and EventSource doubles. Checks
// that catalog text is rendered as text (never markup), that coverage and guide status are shown,
// and that a destructive plan needs the exact server phrase before its button is enabled.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const PUBLIC = path.resolve('control-plane/public');
const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const HOSTILE = '<img src=x onerror=alert(1)>Golem';

const requests = [];
let ui;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

const STATE = {
    generatedAt: '2026-09-28T12:00:00.000Z', engine: { paused: false }, account: { state: 'idle', activeLabel: null },
    modules: [], intervalBounds: { min: 5000, max: 86400000 }, sections: {}, settings: [], profiles: [], validation: null, audit: [],
    catalog: {
        jobs: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'guide_discovery', state: 'queued', requestBudget: 50, cursor: {}, lastResult: null }],
        guide: [
            { entityKind: 'item', display: 'waiting_for_browser', status: 'idle', statusReason: null, overdue: true, lastSuccessfulCheckAt: null, lastSeenId: 0, sweepMode: null, nextPage: 0, sweepPagesChecked: 0, orderState: 'attested' },
            { entityKind: 'creature', display: 'challenged', status: 'challenged', statusReason: 'cloudflare challenge', overdue: false, lastSuccessfulCheckAt: '2026-09-27T12:00:00.000Z', lastSeenId: 7002, sweepMode: 'incremental', nextPage: 3, sweepPagesChecked: 3, orderState: 'verified' },
        ],
        available: { observe_realm: 'contract_unverified', item_frontier: 'contract_unverified', guide_discovery: null },
    },
};
const SUMMARY = {
    ...STATE.catalog,
    kinds: { item: { rows: 2, tracked: 2, incomplete: 1, complete: 1 }, creature: { rows: 1, tracked: 1, incomplete: 1, complete: 0 } },
    coverage: { item: { ok: 1, pending: 1, failed: 0, missing: 0 }, creature: { ok: 0, pending: 1, failed: 0, missing: 0 } },
    guideRequestsToday: 12, relayLastSeenAt: null,
    policy: { guide: { checkIntervalMs: 86400000, minDelayMs: 3000, maxRequestsPerExecution: 50, dailyRequestCap: 2000 }, ordering: { order: 'newest_first', firstIndex: 0 }, fullSweep: { indexPages: 1279 } },
};
const PLAN = { id: '22222222-2222-4222-8222-222222222222', action: 'rollback', targetRunId: '33333333-3333-4333-8333-333333333333', expectedCounts: { entities: 1, remove: 1, rows: { items: -1 } }, confirmation: 'ROLLBACK 33333333 1', expiresAt: '2026-09-28T12:10:00.000Z' };

function respond(url, init) {
    const u = new URL(url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/api/session') return { csrf: 'csrf-token' };
    if (p === '/api/catalog/summary') return SUMMARY;
    if (p === '/api/catalog/entities') return { kind: u.searchParams.get('kind'), page: 1, pageSize: 25, total: 1, items: [{ key: '7001', id: 7001, name: HOSTILE, catalog: { completeness: 'incomplete', incompleteReasons: ['known_drop_unresolved'], lastSeenAt: '2026-09-28T11:00:00.000Z' } }] };
    if (p === '/api/catalog/entities/creature/7001') {
        return { kind: 'creature', key: '7001', fields: { id: 7001, name: HOSTILE, description: '<script>steal()</script>', stats: { level: 5 } }, relations: { realms: [{ id: 1200, name: '<b>Path</b>' }], drops: [] },
            provenance: [{ source: 'guide_baseline', hash: 'abcdef012345', runId: 'r', observedAt: '2026-09-28T11:00:00.000Z', mode: 'guide_discovery', runStatus: 'succeeded' }],
            catalog: { completeness: 'incomplete', incompleteReasons: ['known_drop_unresolved'], firstSeenAt: null, lastSeenAt: null, verifiedAt: null }, guide: null };
    }
    if (p === '/api/catalog/runs') return { page: 1, pageSize: 25, runs: [{ id: PLAN.targetRunId, mode: 'guide_discovery', source: 'guide_baseline', status: 'succeeded', startedAt: '2026-09-28T11:00:00.000Z', summary: { observations: 1 } }] };
    if (p.endsWith('/rollback-plan')) return { ok: true, plan: PLAN };
    if (p.endsWith('/execute')) return { ok: true, result: { runId: PLAN.targetRunId, status: 'reverted' } };
    return { error: 'unexpected' };
}

before(async () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
    const dom = parseHTML(html);
    const sources = [];
    const location = { assign: url => { location.assigned = url; } };
    const fetch = async (url, init = {}) => {
        requests.push({ url, method: init.method ?? 'GET', body: init.body ?? null, headers: init.headers ?? {} });
        const json = respond(url, init);
        return { ok: !json.error, status: json.error ? 404 : 200, json: async () => json };
    };
    class EventSource { constructor(url) { this.url = url; this.handlers = {}; sources.push(this); } addEventListener(type, fn) { this.handlers[type] = fn; } }
    Object.assign(dom.window, { location, confirm: () => true, EventSource, fetch });
    const context = vm.createContext({
        window: dom.window, document: dom.document, fetch, EventSource, Node: dom.Node, CSS: { escape: s => s },
        URLSearchParams, setTimeout, clearTimeout, console, Date, JSON, Math, Number, String, Object, Array, Promise, Error, Map, Set,
    });
    vm.runInContext(APP, context);
    await flush();
    sources[0].handlers.state({ data: JSON.stringify(STATE) });
    ui = { dom, document: dom.document, sources, Event: dom.Event ?? dom.window.Event };
});

const $ = sel => ui.document.querySelector(sel);
const click = node => node.dispatchEvent(new ui.Event('click', { bubbles: true }));

test('CAT-TASK-006: the dashboard script never parses markup', () => {
    for (const sink of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/]) assert.doesNotMatch(APP, sink);
});

test('AC-CAT-008: guide status, overdue checks, and job availability come from the state stream', () => {
    const rows = [...ui.document.querySelectorAll('#guide-status tr')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /waiting for browser/);
    assert.match(rows[0].textContent, /overdue/);
    assert.match(rows[1].textContent, /challenged cloudflare challenge/);
    const options = [...ui.document.querySelectorAll('#jf-kind option')];
    assert.deepEqual(options.map(o => [o.value, o.disabled]), [['observe_realm', true], ['item_frontier', true], ['guide_discovery', false]]);
    assert.match(options[0].textContent, /needs a verified game read contract/);
    assert.match($('#catalog-jobs').textContent, /guide_discovery/);
});

test('AC-CAT-007: browse renders hostile names and details as text, with coverage reasons', async () => {
    click(ui.document.querySelector('.tabs button[data-tab="catalog"]'));
    await flush();
    assert.equal($('#tab-catalog').hidden, false);
    const row = $('#catalog-entities tr');
    assert.equal(row.children[1].textContent, HOSTILE);
    assert.equal($('#catalog-entities img'), null, 'no element was created from the name');
    assert.match(row.textContent, /a known drop is not in the catalog/);
    assert.match($('#catalog-kinds').textContent, /item: 2 rows, 2 tracked, 1 incomplete/);
    assert.match($('#guide-policy').textContent, /12 of 2000 used today/);
    assert.match($('#relay-tokens').textContent, /set gogonRelayToken to a token issued here/, 'relay setup is explained; no token is shown');
    // Switch the filter to creatures and search through the form.
    [...ui.document.querySelectorAll('#cf-kind option')].find(o => o.getAttribute('value') === 'creature').selected = true;
    $('#cf-q').value = 'Golem';
    $('#catalog-filter').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    const search = requests.filter(r => r.url.startsWith('/api/catalog/entities?')).at(-1).url;
    assert.equal(new URLSearchParams(search.split('?')[1]).get('kind'), 'creature');
    assert.equal(new URLSearchParams(search.split('?')[1]).get('q'), 'Golem');
    click($('#catalog-entities tr'));
    await flush();
    const detail = $('#catalog-detail');
    assert.equal(detail.hidden, false);
    assert.equal(detail.querySelector('img'), null);
    assert.equal(detail.querySelector('script'), null);
    assert.equal(detail.querySelector('b'), null);
    assert.match(detail.textContent, /<script>steal\(\)<\/script>/);
    assert.match(detail.textContent, /<b>Path<\/b> \(#1200\)/);
    assert.ok(requests.some(r => r.url === '/api/catalog/entities/creature/7001'));
});

test('AC-CAT-009: a rollback shows the server plan and stays disabled until the exact phrase is typed', async () => {
    click(ui.document.querySelector('.subtabs button[data-subtab="history"]'));
    await flush();
    const preview = [...ui.document.querySelectorAll('#catalog-runs button')].find(b => b.textContent === 'Preview rollback');
    click(preview);
    await flush();
    const panel = $('#plan-panel');
    assert.equal(panel.hidden, false);
    assert.equal(panel.querySelector('code').textContent, PLAN.confirmation);
    const input = panel.querySelector('input');
    const execute = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Roll back');
    assert.equal(execute.disabled, true);
    input.value = 'ROLLBACK 33333333';
    input.dispatchEvent(new ui.Event('input'));
    assert.equal(execute.disabled, true);
    input.value = PLAN.confirmation;
    input.dispatchEvent(new ui.Event('input'));
    assert.equal(execute.disabled, false);
    click(execute);
    await flush();
    const exec = requests.find(r => r.url.endsWith('/execute'));
    assert.equal(exec.method, 'POST');
    assert.deepEqual(JSON.parse(exec.body), { confirmation: PLAN.confirmation });
    assert.equal(exec.headers['X-CSRF-Token'], 'csrf-token');
    assert.equal(panel.hidden, true);
});
