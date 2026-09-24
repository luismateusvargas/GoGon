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

function render() {
    if (!state) return;
    renderHeader();
    renderModules();
    renderSettings();
    renderAccounts();
    renderAudit();
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
}));

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
