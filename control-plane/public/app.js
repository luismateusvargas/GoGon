// control-plane/public/app.js - GoGon owner dashboard (AC-CTRL-002, AC-CTRL-003, AC-CTRL-004, AC-CTRL-006).
// All server data is rendered with textContent / element properties, never parsed as HTML markup.
'use strict';

let csrf = null;
let state = null;
const settingForms = new Map();   // key -> { form, notifForm }
let formCounter = 0;              // notification settings appear in two tabs; element IDs stay unique

// --- utilities -------------------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) node[k] = v;
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
}

function fmtTime(value) {
    if (!value) return '-';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function fmtAgo(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

function showBanner(message, kind = 'error') {
    const b = document.getElementById('banner');
    b.textContent = message;
    b.className = `banner banner-${kind}`;
    b.hidden = !message;
    if (message && kind !== 'error') setTimeout(() => { if (b.textContent === message) b.hidden = true; }, 4000);
}

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { window.location.assign('/login'); throw new Error('Signed out.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status}).`);
        err.fields = data.fields || {};
        throw err;
    }
    return data;
}

function fieldMessage(err) {
    const f = err.fields || {};
    return Object.values(f)[0] || err.message;
}

// --- rendering ---------------------------------------------------------------------------------------
function renderHeader() {
    const engine = document.getElementById('engine-indicator');
    engine.textContent = state.engine.paused ? 'engine paused' : 'engine running';
    engine.className = `pill ${state.engine.paused ? 'pill-warn' : 'pill-ok'}`;

    const acct = document.getElementById('account-indicator');
    const a = state.account;
    acct.textContent = a.state === 'switching' ? 'switching account...'
        : a.state === 'failed-closed' ? 'no active account'
        : `account: ${a.activeLabel ?? '.env credentials'}`;
    acct.className = `pill ${a.state === 'failed-closed' ? 'pill-bad' : a.state === 'switching' ? 'pill-warn' : ''}`;
    if (a.state === 'failed-closed' && a.lastError) showBanner(a.lastError);
}

function renderModules() {
    const body = document.getElementById('modules-body');
    const focused = document.activeElement?.closest?.('#modules-body tr')?.dataset.id;
    const rows = [];
    for (const m of state.modules) {
        if (m.id === focused) { rows.push(body.querySelector(`tr[data-id="${CSS.escape(m.id)}"]`)); continue; }
        const toggle = el('input', { type: 'checkbox', checked: m.enabled, disabled: state.engine.paused, title: m.enabled ? 'Disable' : 'Enable' });
        toggle.addEventListener('change', async () => {
            toggle.disabled = true;
            try { await api('PATCH', `/api/modules/${encodeURIComponent(m.id)}`, { enabled: toggle.checked }); showBanner(`${m.id} ${toggle.checked ? 'enabled' : 'disabled'}.`, 'ok'); }
            catch (e) { toggle.checked = !toggle.checked; showBanner(fieldMessage(e)); }
            finally { toggle.disabled = false; }
        });
        const interval = el('input', {
            type: 'number', min: state.intervalBounds.min / 1000, max: state.intervalBounds.max / 1000, step: 1,
            value: Math.round(m.intervalMs / 1000), class: 'interval', title: `Default ${m.defaultIntervalMs / 1000}s`,
        });
        interval.addEventListener('change', async () => {
            const ms = Math.round(Number(interval.value) * 1000);
            try { await api('PATCH', `/api/modules/${encodeURIComponent(m.id)}`, { intervalMs: ms }); showBanner(`${m.id} interval set to ${ms / 1000}s (applies after the current run).`, 'ok'); }
            catch (e) { interval.value = Math.round(m.intervalMs / 1000); showBanner(fieldMessage(e)); }
        });
        const last = m.lastRun;
        const result = !last ? '-' : last.outcome === 'ok' ? `ok in ${last.durationMs} ms` : last.outcome === 'aborted' ? 'stopped' : `error: ${last.error ?? ''}`;
        rows.push(el('tr', { dataset: { id: m.id } },
            el('td', {}, el('strong', {}, m.id)),
            el('td', {}, el('span', { class: `pill pill-${m.health}` }, m.running ? 'running' : m.health)),
            el('td', {}, toggle),
            el('td', {}, interval),
            el('td', {}, last ? fmtAgo(last.startedAt) : 'never'),
            el('td', { class: last?.outcome === 'error' ? 'error' : '' }, result),
        ));
    }
    body.replaceChildren(...rows);
}

function badge(text, cls = '') { return el('span', { class: `badge ${cls}` }, text); }

function buildSettingForm(def) {
    const form = document.getElementById('setting-template').content.firstElementChild.cloneNode(true);
    const input = form.querySelector('.setting-input');
    const id = `setting-${def.key}-${++formCounter}`;
    input.id = id;
    form.querySelector('.setting-label').htmlFor = id;
    form.querySelector('.setting-label').textContent = def.label;
    form.querySelector('.setting-desc').textContent = `${def.key} - ${def.description}`;
    input.name = 'value';
    if (def.sensitivity === 'secret') { input.type = 'password'; input.autocomplete = 'new-password'; }
    if (def.type === 'boolean') { input.inputMode = 'numeric'; input.maxLength = 1; }
    const error = form.querySelector('.field-error');
    const revert = form.querySelector('.revert');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        try {
            const r = await api('PUT', `/api/config/${def.key}`, { value: input.value });
            if (def.sensitivity === 'secret') input.value = '';
            input.dataset.dirty = '';
            showBanner(`${def.label} saved (${r.applied}).`, 'ok');
        } catch (e) {
            error.textContent = fieldMessage(e);
            error.hidden = false;
        }
    });
    input.addEventListener('input', () => { input.dataset.dirty = '1'; });
    revert.addEventListener('click', async () => {
        error.hidden = true;
        try {
            await api('DELETE', `/api/config/${def.key}`);
            input.dataset.dirty = '';
            showBanner(`${def.label} now uses the .env/default value.`, 'ok');
        } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
    });
    return form;
}

function updateSettingForm(form, def) {
    const input = form.querySelector('.setting-input');
    const badges = form.querySelector('.badges');
    const save = form.querySelector('.save');
    const revert = form.querySelector('.revert');
    badges.replaceChildren(
        badge(def.reloadMode, `reload-${def.reloadMode}`),
        badge(`source: ${def.source}`),
        def.sensitivity === 'secret' ? badge(def.isSet ? 'set' : 'not set', def.isSet ? 'ok' : 'warn') : null,
    );
    input.disabled = !def.editable;
    save.hidden = !def.editable;
    revert.hidden = !def.editable || def.source !== 'override';
    if (def.reloadMode === 'controlled-session-switch') input.placeholder = 'Use the Accounts tab';
    else if (def.sensitivity === 'secret') input.placeholder = def.isSet ? 'set (enter a new value to replace)' : 'not set';
    else if (def.options) input.placeholder = def.options.join(' | ');
    if (def.sensitivity !== 'secret' && document.activeElement !== input && !input.dataset.dirty) input.value = def.value ?? '';
}

function renderSettings() {
    const notif = document.getElementById('notifications-settings');
    const all = document.getElementById('all-settings');
    const bySection = new Map();
    for (const def of state.settings) {
        let entry = settingForms.get(def.key);
        if (!entry) { entry = { form: buildSettingForm(def), notifForm: null }; settingForms.set(def.key, entry); }
        updateSettingForm(entry.form, def);
        if (!bySection.has(def.section)) bySection.set(def.section, []);
        bySection.get(def.section).push(entry.form);
        if (def.section === 'notifications' || def.section === 'webhooks') {
            if (!entry.notifForm) entry.notifForm = buildSettingForm(def);
            updateSettingForm(entry.notifForm, def);
        }
    }
    const order = ['GG_CONFLICT_PING_MENTION'];
    const notifForms = state.settings.filter(d => d.section === 'notifications' || d.section === 'webhooks')
        .sort((a, b) => (order.includes(b.key) - order.includes(a.key)))
        .map(d => settingForms.get(d.key).notifForm);
    if (notif.children.length !== notifForms.length) notif.replaceChildren(...notifForms);

    if (all.childElementCount === 0) {
        for (const [section, forms] of bySection) {
            all.append(el('h3', {}, state.sections[section] ?? section), el('div', { class: 'settings-grid' }, ...forms));
        }
    }

    const v = state.validation;
    const box = document.getElementById('validation');
    const problems = v ? [...(v.details?.errors ?? []), ...(v.details?.warnings ?? [])] : [];
    box.hidden = problems.length === 0;
    box.replaceChildren(el('strong', {}, 'Configuration validation'), ...problems.map(p => el('pre', {}, p)));
}

function renderAccounts() {
    const a = state.account;
    document.getElementById('account-state').replaceChildren(
        el('div', {}, el('strong', {}, 'Active account: '), a.activeLabel ?? (a.state === 'failed-closed' ? 'none (tasks paused)' : '.env credentials')),
        el('div', { class: 'muted' }, `Switch state: ${a.state}`),
        a.lastError ? el('div', { class: 'error' }, a.lastError) : null,
    );
    const body = document.getElementById('profiles-body');
    body.replaceChildren(...state.profiles.map(p => {
        const activate = el('button', { type: 'button', disabled: p.active || a.state === 'switching' }, p.active ? 'Active' : 'Switch to');
        activate.addEventListener('click', async () => {
            if (!window.confirm(`Switch the game account to "${p.label}"? All modules pause until the sign-in succeeds.`)) return;
            activate.disabled = true;
            try { const r = await api('POST', `/api/profiles/${p.id}/activate`); showBanner(`Now using "${r.activeLabel}". Resumed ${r.resumed.length} module(s).`, 'ok'); }
            catch (e) { showBanner(fieldMessage(e)); }
        });
        const rotateForm = el('form', { class: 'inline-form', hidden: true, autocomplete: 'off' },
            el('input', { name: 'email', type: 'email', placeholder: 'new email', maxLength: 254, required: true, autocomplete: 'off' }),
            el('input', { name: 'password', type: 'password', placeholder: 'new password', maxLength: 256, required: true, autocomplete: 'new-password' }),
            el('button', { type: 'submit' }, 'Save'));
        rotateForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
                await api('PUT', `/api/profiles/${p.id}/credentials`, { email: rotateForm.email.value, password: rotateForm.password.value });
                rotateForm.reset(); rotateForm.hidden = true;
                showBanner(`Credentials for "${p.label}" replaced.`, 'ok');
            } catch (e) { showBanner(fieldMessage(e)); }
        });
        const rotate = el('button', { type: 'button', class: 'ghost' }, 'Replace credentials');
        rotate.addEventListener('click', () => { rotateForm.hidden = !rotateForm.hidden; });
        const del = el('button', { type: 'button', class: 'ghost danger', disabled: p.active }, 'Delete');
        del.addEventListener('click', async () => {
            if (!window.confirm(`Delete profile "${p.label}"?`)) return;
            try { await api('DELETE', `/api/profiles/${p.id}`); showBanner(`Deleted "${p.label}".`, 'ok'); }
            catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {},
            el('td', {}, p.label),
            el('td', {}, p.active ? el('span', { class: 'pill pill-ok' }, 'active') : 'inactive'),
            el('td', {}, fmtTime(p.updatedAt)),
            el('td', { class: 'actions' }, activate, rotate, del, rotateForm));
    }));
}

function renderAudit() {
    document.getElementById('audit-body').replaceChildren(...state.audit.map(e => el('tr', {},
        el('td', {}, fmtTime(e.occurredAt)),
        el('td', {}, e.actor),
        el('td', {}, e.action),
        el('td', {}, e.subject),
        el('td', { class: e.outcome === 'success' ? '' : 'error' }, e.outcome))));
}

// --- catalog (CAT-TASK-006 / AC-CAT-007, AC-CAT-008, AC-CAT-009) --------------------------------------
// Every catalog value is data from the game or guide: it is rendered with textContent (el()), never as
// markup. Destructive actions show the server's plan and need its exact confirmation phrase.
const catalogView = { kind: 'item', q: '', completeness: '', page: 1, pageSize: 25, total: 0, runsPage: 1, summary: null };
const REASON_LABELS = {
    guide_detail_missing: 'guide detail not read yet',
    guide_detail_failed: 'guide detail failed validation',
    required_field_missing: 'a required field is missing',
    known_drop_unresolved: 'a known drop is not in the catalog',
};
const UNAVAILABLE_LABELS = { contract_unverified: 'needs a verified game read contract', browser_relay: 'runs in the guide relay userscript' };
const GUIDE_STATUS_CLASS = { ok: 'pill-ok', running: 'pill-ok', due: 'pill-warn', partial: 'pill-warn', waiting_for_browser: 'pill-warn', challenged: 'pill-bad', failed: 'pill-bad', idle: '' };

function coverageCell(c) {
    if (!c) return el('span', { class: 'muted' }, 'not tracked');
    if (!c.completeness) return el('span', { class: 'muted' }, '-');
    return el('span', {},
        el('span', { class: `pill ${c.completeness === 'complete' ? 'pill-ok' : 'pill-warn'}` }, c.completeness),
        c.incompleteReasons.length ? el('span', { class: 'muted' }, ` ${c.incompleteReasons.map(r => REASON_LABELS[r] ?? r).join('; ')}`) : null);
}

function jsonBlock(value) {
    return el('pre', {}, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function loadCatalogSummary() {
    try {
        catalogView.summary = await api('GET', '/api/catalog/summary');
    } catch (e) { showBanner(fieldMessage(e)); return; }
    const s = catalogView.summary;
    document.getElementById('catalog-kinds').replaceChildren(...Object.entries(s.kinds).map(([kind, k]) =>
        el('span', { class: 'stat' }, `${kind}: ${k.rows} rows, ${k.tracked} tracked${kind === 'item' || kind === 'creature' ? `, ${k.incomplete} incomplete` : ''}`)));
    const g = s.policy.guide;
    document.getElementById('guide-policy').textContent =
        `Checked every ${Math.round(g.checkIntervalMs / 3600_000)} h in your validated browser; ${g.minDelayMs / 1000} s between requests, ` +
        `${g.maxRequestsPerExecution} per run, ${s.guideRequestsToday} of ${g.dailyRequestCap} used today. Index order: ${s.policy.ordering.order} ` +
        `from page ${s.policy.ordering.firstIndex}, checked every run. A full sweep is about ${s.policy.fullSweep.indexPages} pages.`;
    renderRelayTokens(s.relayTokens ?? []);
    renderCatalogState();
}

/** CAT-TASK-010: stage-only relay tokens. A new token is shown once and never again. */
function renderRelayTokens(tokens, issued = null) {
    const box = document.getElementById('relay-tokens');
    const rows = tokens.map(t => {
        const revoke = el('button', { type: 'button', class: 'ghost danger', disabled: !t.active }, 'Revoke');
        revoke.addEventListener('click', async () => {
            if (!window.confirm(`Revoke relay token "${t.label}"? The browser using it stops at its next request.`)) return;
            try { await api('POST', `/api/catalog/relay-tokens/${t.id}/revoke`); showBanner('Relay token revoked.', 'ok'); loadCatalogSummary(); } catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {}, el('td', {}, t.label), el('td', {}, t.active ? 'active' : (t.revokedAt ? 'revoked' : 'expired')),
            el('td', {}, fmtTime(t.expiresAt)), el('td', {}, fmtTime(t.lastUsedAt)), el('td', { class: 'actions' }, revoke));
    });
    const label = el('input', { maxLength: 64, placeholder: 'browser label', value: 'my browser', id: 'rt-label' });
    const days = el('input', { type: 'number', min: 1, max: 7, value: 7, class: 'interval', id: 'rt-days' });
    const issue = el('button', { type: 'submit' }, 'Issue relay token');
    const form = el('form', { class: 'toolbar', autocomplete: 'off' }, el('label', { htmlFor: 'rt-label' }, 'Relay token'), label,
        el('label', { htmlFor: 'rt-days' }, 'days'), days, issue);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const r = await api('POST', '/api/catalog/relay-tokens', { label: label.value.trim(), ttlDays: Number(days.value) });
            renderRelayTokens((await api('GET', '/api/catalog/summary')).relayTokens, r);
        } catch (e) { showBanner(fieldMessage(e)); }
    });
    box.replaceChildren(
        el('h3', {}, 'Guide relay'),
        el('p', { class: 'muted' }, 'Install reconciliation/scrappers/gogon_guide_relay.user.js in Tampermonkey. In the script\'s Storage tab, set gogonRelayToken to a token issued here. Open the SSH tunnel, open a guide page, and press Start. The token can only fetch leases and return guide results.'),
        issued ? el('div', { class: 'card' }, el('strong', {}, 'Copy this token now; it is not shown again: '), el('code', {}, issued.token),
            el('div', { class: 'muted' }, `Expires ${fmtTime(issued.expiresAt)}.`)) : null,
        tokens.length ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, 'Label'), el('th', {}, 'State'), el('th', {}, 'Expires'), el('th', {}, 'Last used'), el('th', {}, ''))),
            el('tbody', {}, ...rows))) : null,
        form);
}

async function loadEntities() {
    const v = catalogView;
    const params = new URLSearchParams({ kind: v.kind, page: String(v.page), pageSize: String(v.pageSize) });
    if (v.q) params.set('q', v.q);
    if (v.completeness && (v.kind === 'item' || v.kind === 'creature')) params.set('completeness', v.completeness);
    let data;
    try { data = await api('GET', `/api/catalog/entities?${params}`); } catch (e) { showBanner(fieldMessage(e)); return; }
    v.total = data.total;
    document.getElementById('catalog-entities').replaceChildren(...data.items.map(item => {
        const row = el('tr', { class: 'clickable', tabIndex: 0, title: 'Show details' },
            el('td', {}, item.key),
            el('td', {}, item.name ?? '-'),
            el('td', {}, coverageCell(item.catalog)),
            el('td', {}, item.catalog ? fmtTime(item.catalog.lastSeenAt) : '-'));
        const open = () => showEntity(v.kind, item.key);
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
        return row;
    }));
    const pages = Math.max(1, Math.ceil(v.total / v.pageSize));
    document.getElementById('cf-page').textContent = `page ${v.page} of ${pages} (${v.total})`;
    document.getElementById('cf-prev').disabled = v.page <= 1;
    document.getElementById('cf-next').disabled = v.page >= pages;
}

async function showEntity(kind, key) {
    const box = document.getElementById('catalog-detail');
    let d;
    try { d = await api('GET', `/api/catalog/entities/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`); } catch (e) { showBanner(fieldMessage(e)); return; }
    const fields = el('dl', { class: 'kv' });
    for (const [k, value] of Object.entries(d.fields)) {
        fields.append(el('dt', {}, k), el('dd', {}, value !== null && typeof value === 'object' ? jsonBlock(value) : (value ?? '-')));
    }
    const relations = Object.entries(d.relations).map(([name, list]) => el('div', {},
        el('strong', {}, `${name}: `),
        list.length ? list.map(r => (typeof r === 'string' ? r : `${r.name ?? r.id}${r.id ? ` (#${r.id})` : ''}`)).join(', ') : 'none known'));
    const provenance = el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Observed'), el('th', {}, 'Source'), el('th', {}, 'Run'), el('th', {}, 'Hash'))),
        el('tbody', {}, ...d.provenance.map(p => el('tr', {},
            el('td', {}, fmtTime(p.observedAt)), el('td', {}, p.source), el('td', {}, `${p.mode} (${p.runStatus})`), el('td', {}, p.hash)))));
    box.replaceChildren(
        el('h3', {}, `${kind} ${d.key}`),
        el('div', {}, el('strong', {}, 'Coverage: '), coverageCell(d.catalog)),
        d.catalog ? el('div', { class: 'muted' }, `First seen ${fmtTime(d.catalog.firstSeenAt)}; last seen ${fmtTime(d.catalog.lastSeenAt)}; verified ${fmtTime(d.catalog.verifiedAt)}`) : null,
        d.guide ? el('div', { class: 'muted' }, `Guide detail: ${d.guide.status}; checked ${fmtTime(d.guide.checkedAt)}; next check ${fmtTime(d.guide.nextCheckAt)}`) : null,
        fields, ...relations, el('h3', {}, 'Provenance (newest first)'), el('div', { class: 'table-wrap' }, provenance));
    box.hidden = false;
}

/** Guide status and jobs come with every dashboard state update (SSE). */
function renderCatalogState() {
    const c = state?.catalog;
    if (!c) return;
    document.getElementById('guide-status').replaceChildren(...c.guide.map(g => el('tr', {},
        el('td', {}, g.entityKind),
        el('td', {}, el('span', { class: `pill ${GUIDE_STATUS_CLASS[g.display] ?? ''}` }, g.display.replace(/_/g, ' ')), g.statusReason ? el('span', { class: 'muted' }, ` ${g.statusReason}`) : null,
            g.overdue ? el('span', { class: 'error' }, ' overdue') : null),
        el('td', {}, fmtTime(g.lastSuccessfulCheckAt)),
        el('td', {}, String(g.lastSeenId || '-')),
        el('td', {}, g.sweepMode ? `${g.sweepMode}: next page ${g.nextPage}, ${g.sweepPagesChecked} checked` : '-'),
        el('td', {}, g.orderState),
        el('td', {}, catalogView.summary ? (() => { const k = catalogView.summary.coverage[g.entityKind]; return `${k.ok} read, ${k.pending} pending, ${k.failed} failed`; })() : '-'))));

    document.getElementById('catalog-jobs').replaceChildren(...c.jobs.map(j => {
        const actions = el('td', { class: 'actions' });
        const act = (label, action, cls = 'ghost') => {
            const b = el('button', { type: 'button', class: cls }, label);
            b.addEventListener('click', async () => {
                b.disabled = true;
                try { await api('POST', `/api/catalog/jobs/${j.id}/${action}`); showBanner(`Job ${action}d.`, 'ok'); }
                catch (e) { showBanner(fieldMessage(e)); b.disabled = false; }
            });
            return b;
        };
        if (j.state === 'queued' || j.state === 'running') actions.append(act('Pause', 'pause'));
        if (j.state === 'paused') actions.append(act('Resume', 'resume'));
        if (['queued', 'running', 'paused'].includes(j.state)) actions.append(act('Cancel', 'cancel', 'ghost danger'));
        const r = j.lastResult;
        return el('tr', {},
            el('td', {}, j.kind), el('td', {}, j.state), el('td', {}, String(j.requestBudget)),
            el('td', {}, Object.keys(j.cursor).length ? JSON.stringify(j.cursor) : '-'),
            el('td', { class: r && r.outcome !== 'ok' ? 'error' : '' }, r ? `${r.outcome}${r.reason ? `: ${r.reason}` : ''} (${fmtTime(r.at)})` : '-'),
            actions);
    }));

    const select = document.getElementById('jf-kind');
    if (select.options.length === 0) {
        for (const [kind, why] of Object.entries(c.available)) {
            const usable = why === null || why === 'browser_relay';
            const option = el('option', { disabled: !usable }, usable ? kind : `${kind} (${UNAVAILABLE_LABELS[why] ?? why})`);
            option.setAttribute('value', kind);
            select.append(option);
        }
        const first = [...select.options].find(o => !o.disabled);
        if (first) first.selected = true;
    }
}

function showPlan(plan, onDone) {
    const panel = document.getElementById('plan-panel');
    const input = el('input', { autocomplete: 'off', spellcheck: false, placeholder: 'type the phrase exactly' });
    const execute = el('button', { type: 'button', class: 'danger', disabled: true }, plan.action === 'promote' ? 'Promote' : 'Roll back');
    const cancel = el('button', { type: 'button', class: 'ghost' }, 'Cancel');
    input.addEventListener('input', () => { execute.disabled = input.value !== plan.confirmation; });
    cancel.addEventListener('click', () => { panel.hidden = true; panel.replaceChildren(); });
    execute.addEventListener('click', async () => {
        execute.disabled = true;
        try {
            const r = await api('POST', `/api/catalog/plans/${plan.id}/execute`, { confirmation: input.value });
            showBanner(`${plan.action === 'promote' ? 'Promoted' : 'Rolled back'} run ${r.result.runId.slice(0, 8)}.`, 'ok');
            panel.hidden = true;
            panel.replaceChildren();
            if (onDone) onDone();
        } catch (e) { showBanner(fieldMessage(e)); }
    });
    panel.replaceChildren(
        el('h3', {}, plan.action === 'promote' ? 'Promotion preview' : 'Rollback preview'),
        el('p', { class: 'muted' }, `Nothing has changed yet. This preview expires ${fmtTime(plan.expiresAt)} and can be used once.`),
        jsonBlock(plan.expectedCounts),
        el('p', {}, 'To continue, type ', el('code', {}, plan.confirmation)),
        el('div', { class: 'toolbar' }, input, execute, cancel));
    panel.hidden = false;
    input.focus?.();
}

async function loadRuns() {
    let data;
    try { data = await api('GET', `/api/catalog/runs?page=${catalogView.runsPage}&pageSize=25`); } catch (e) { showBanner(fieldMessage(e)); return; }
    document.getElementById('catalog-runs').replaceChildren(...data.runs.map(run => {
        const actions = el('td', { class: 'actions' });
        if (run.status === 'succeeded' && run.mode !== 'baseline_snapshot') {
            const b = el('button', { type: 'button', class: 'ghost danger' }, 'Preview rollback');
            b.addEventListener('click', async () => {
                try { showPlan((await api('POST', `/api/catalog/runs/${run.id}/rollback-plan`)).plan, loadRuns); } catch (e) { showBanner(fieldMessage(e)); }
            });
            actions.append(b);
        }
        return el('tr', {},
            el('td', {}, fmtTime(run.startedAt)), el('td', {}, run.mode), el('td', {}, run.source), el('td', {}, run.status),
            el('td', {}, run.summary ? JSON.stringify(run.summary).slice(0, 160) : '-'), actions);
    }));
    document.getElementById('runs-page').textContent = `page ${catalogView.runsPage}`;
    document.getElementById('runs-prev').disabled = catalogView.runsPage <= 1;
    document.getElementById('runs-next').disabled = data.runs.length < 25;
}

async function loadSeeds() {
    let sources;
    let runs;
    try {
        sources = (await api('GET', '/api/catalog/seed-sources')).sources;
        runs = (await api('GET', '/api/catalog/runs?page=1&pageSize=100')).runs;
    } catch (e) { showBanner(fieldMessage(e)); return; }
    document.getElementById('seed-sources').replaceChildren(...sources.map(s => {
        const b = el('button', { type: 'button' }, `Stage ${s.key}`);
        b.addEventListener('click', async () => {
            if (!window.confirm(`Download and stage "${s.label}"? Nothing reaches the serving tables until you promote each part.`)) return;
            b.disabled = true;
            try {
                const r = (await api('POST', '/api/catalog/seeds', { sourceKey: s.key })).staged;
                showBanner(`Staged ${r.observations} records in ${r.parts} part(s).`, 'ok');
                loadSeeds();
            } catch (e) { showBanner(fieldMessage(e)); } finally { b.disabled = false; }
        });
        return el('div', { class: 'card' }, el('strong', {}, s.label), el('div', { class: 'muted' }, `Kinds: ${s.kinds.join(', ')}; from ${s.hosts.join(', ')}`), b);
    }));
    const staged = runs.filter(r => r.mode === 'seed' && r.status === 'running' && r.summary?.seed)
        .sort((a, b) => (a.summary.seed.batchId === b.summary.seed.batchId ? a.summary.seed.part - b.summary.seed.part : 0));
    document.getElementById('seed-runs').replaceChildren(...staged.map(run => {
        const seed = run.summary.seed;
        const preview = el('button', { type: 'button' }, 'Preview promotion');
        preview.addEventListener('click', async () => {
            try { showPlan((await api('POST', `/api/catalog/runs/${run.id}/promote-plan`)).plan, loadSeeds); } catch (e) { showBanner(fieldMessage(e)); }
        });
        const discard = el('button', { type: 'button', class: 'ghost danger' }, 'Discard');
        discard.addEventListener('click', async () => {
            if (!window.confirm(`Discard staged part ${seed.part} of ${seed.parts}? It will never be promoted.`)) return;
            try { await api('POST', `/api/catalog/runs/${run.id}/discard`); loadSeeds(); } catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {},
            el('td', {}, `${seed.part} of ${seed.parts}`), el('td', {}, seed.kinds.join(', ')),
            el('td', {}, fmtTime(run.startedAt)), el('td', { class: 'actions' }, preview, discard));
    }));
}

const CATALOG_LOADERS = { browse: () => loadEntities(), sync: () => loadCatalogSummary(), seed: () => loadSeeds(), history: () => loadRuns() };

function openCatalogTab(name) {
    document.querySelectorAll('.subtabs button').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
    document.querySelectorAll('#tab-catalog .subtab').forEach(s => { s.hidden = s.id !== `catalog-${name}`; });
    document.getElementById('plan-panel').hidden = true;
    return CATALOG_LOADERS[name]();
}

function render() {
    if (!state) return;
    renderHeader();
    renderModules();
    renderSettings();
    renderAccounts();
    renderAudit();
    renderCatalogState();
}

// --- wiring ------------------------------------------------------------------------------------------
function connectEvents() {
    const live = document.getElementById('live-indicator');
    const source = new EventSource('/api/events');
    source.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        live.textContent = 'live';
        live.className = 'pill pill-ok';
        render();
    });
    source.addEventListener('error', () => {
        live.textContent = 'reconnecting';
        live.className = 'pill pill-warn';
        fetch('/api/session', { credentials: 'same-origin' }).then(r => { if (r.status === 401) window.location.assign('/login'); }).catch(() => {});
    });
}

document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${button.dataset.tab}`; });
    if (button.dataset.tab === 'catalog') { loadCatalogSummary(); loadEntities(); }
}));

document.querySelectorAll('.subtabs button').forEach(button => button.addEventListener('click', () => openCatalogTab(button.dataset.subtab)));

const fieldValue = id => document.getElementById(id).value;

document.getElementById('catalog-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    Object.assign(catalogView, { kind: fieldValue('cf-kind'), q: fieldValue('cf-q').trim(), completeness: fieldValue('cf-completeness'), page: 1 });
    document.getElementById('catalog-detail').hidden = true;
    loadEntities();
});
document.getElementById('cf-prev').addEventListener('click', () => { catalogView.page = Math.max(1, catalogView.page - 1); loadEntities(); });
document.getElementById('cf-next').addEventListener('click', () => { catalogView.page += 1; loadEntities(); });
document.getElementById('runs-prev').addEventListener('click', () => { catalogView.runsPage = Math.max(1, catalogView.runsPage - 1); loadRuns(); });
document.getElementById('runs-next').addEventListener('click', () => { catalogView.runsPage += 1; loadRuns(); });

document.getElementById('job-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.field-error');
    error.hidden = true;
    try {
        await api('POST', '/api/catalog/jobs', { kind: fieldValue('jf-kind'), requestBudget: Number(fieldValue('jf-budget')) });
        showBanner(`${fieldValue('jf-kind')} job created.`, 'ok');
    } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
});
document.getElementById('sync-now').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/catalog/sync-now'); showBanner(`Ran ${r.ran.length} game job(s).`, 'ok'); }
    catch (e) { showBanner(fieldMessage(e)); }
});

document.getElementById('logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* already signed out */ }
    window.location.assign('/login');
});

document.getElementById('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.field-error');
    error.hidden = true;
    try {
        await api('POST', '/api/profiles', { label: form.label.value, email: form.email.value, password: form.password.value });
        form.reset();
        showBanner('Profile added.', 'ok');
    } catch (e) {
        error.textContent = fieldMessage(e);
        error.hidden = false;
    }
});

(async () => {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (!res.ok) { window.location.assign('/login'); return; }
    csrf = (await res.json()).csrf;
    connectEvents();
})();
