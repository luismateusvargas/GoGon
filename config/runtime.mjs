// config/runtime.mjs - CTRL-TASK-001/003 effective configuration.
// getSetting(key) = dashboard override (loaded by the control plane) ?? environment (GG_ > SWS_ > FS_)
// ?? registry default. Hot consumers call getSetting() on every run, so a saved override applies
// to the next task run without a restart. This module never opens the database: the control plane
// pushes overrides in with loadOverrides()/applyOverride(), which keeps tests and CLI imports pure.
import { CONFIG_BY_KEY, CONFIG_DEFINITIONS } from './registry.mjs';

const overrides = new Map();       // key -> string value (already validated and decrypted)
const listeners = new Set();       // (key) => void, called after an override changes

function envValue(def, env) {
    for (const name of def.aliases) {
        const v = env[name];
        if (typeof v === 'string' && v.trim() !== '') return { value: v, source: `env:${name}` };
    }
    return null;
}

/**
 * Resolves a registry setting. Unknown keys throw: callers may only read registered settings.
 * @returns {{ value: string, source: 'override'|'default'|string }}
 */
export function resolveSetting(key, env = process.env) {
    const def = CONFIG_BY_KEY.get(key);
    if (!def) throw new Error(`Unregistered setting: ${key}`);
    if (overrides.has(key)) return { value: overrides.get(key), source: 'override' };
    return envValue(def, env) ?? { value: def.default, source: 'default' };
}

/** The effective value of a registered setting ('' when unset and without default). */
export function getSetting(key, env = process.env) {
    return resolveSetting(key, env).value;
}

export function getBooleanSetting(key) {
    const v = getSetting(key).trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** Parses a comma-separated inventory ID setting into a Set of strings. */
export function getIdListSetting(key) {
    return new Set(getSetting(key).split(',').map(s => s.trim()).filter(Boolean));
}

/** Replaces all overrides (control-plane boot). Unknown keys are ignored. */
export function loadOverrides(entries) {
    overrides.clear();
    for (const [key, value] of entries) if (CONFIG_BY_KEY.has(key)) overrides.set(key, String(value));
    for (const l of listeners) l('*');
}

/** Sets (value: string) or clears (value: null) one override and notifies subscribers. */
export function applyOverride(key, value) {
    if (!CONFIG_BY_KEY.has(key)) throw new Error(`Unregistered setting: ${key}`);
    if (value === null) overrides.delete(key); else overrides.set(key, String(value));
    for (const l of listeners) l(key);
}

export function hasOverride(key) {
    return overrides.has(key);
}

/** Subscribes to override changes; returns an unsubscribe function. */
export function onSettingChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Browser-safe description of every registry entry: secrets are reduced to set/unset (AC-CTRL-002).
 */
export function describeSettings(env = process.env) {
    return CONFIG_DEFINITIONS.map(def => {
        const { value, source } = resolveSetting(def.key, env);
        const base = {
            key: def.key, label: def.label, section: def.section, type: def.type, sensitivity: def.sensitivity,
            reloadMode: def.reloadMode, editable: def.editable, validator: def.validator, description: def.description,
            options: def.options ?? null, source: source.startsWith('env:') ? 'env' : source, isSet: value !== '',
        };
        if (def.sensitivity !== 'secret') base.value = value;
        return base;
    });
}
