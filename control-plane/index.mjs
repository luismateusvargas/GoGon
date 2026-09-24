// control-plane/index.mjs - CTRL-TASK-003/004/005 bootstrap wiring for app.mjs.
// prepareControlPlane() runs before the first game login: it validates the .env bootstrap values
// (fail closed, AC-CTRL-005), loads dashboard overrides into config/runtime.mjs, and installs the
// active account profile's credentials. startControlPlane() then serves the dashboard.
import { loadControlPlaneConfig, createControlPlane } from './server.mjs';
import { createKeyring } from './crypto.mjs';
import { createAccountSwitcher } from './accountSwitch.mjs';
import { createControlStore } from '../_gg_data/handler/controlStore.js';
import { getConnection } from '../_gg_data/handler/gg_database.js';
import { getSetting, loadOverrides } from '../config/runtime.mjs';
import * as engine from '../engine.js';
import { drainDiscordQueue } from '../utils.js';
import { resetSession, setCredentialProvider, login, isLoggedIn } from '../session.mjs';

export function isControlPlaneEnabled(env = process.env) {
    return getSetting('GG_CONTROL_ENABLED', env) === '1';
}

/**
 * @returns {Promise<{ config, store, switcher, preferences: Map, activeLabel: string|null }>}
 * @throws when bootstrap values are missing/invalid or the active profile cannot be decrypted.
 */
export async function prepareControlPlane(env = process.env) {
    const config = loadControlPlaneConfig(env);
    const keyring = createKeyring(config.encryptionKey, config.previousEncryptionKey);
    const store = createControlStore(await getConnection(), keyring);
    loadOverrides(await store.loadOverrides());
    const switcher = createAccountSwitcher({
        store,
        engine: { pauseAll: engine.pauseAll, resumeAll: engine.resumeAll },
        drainQueue: () => drainDiscordQueue(),
        session: { resetSession, setCredentialProvider, login, isLoggedIn },
    });
    let activeLabel;
    try {
        activeLabel = await switcher.applyStoredActiveProfile();
    } catch {
        throw new Error('The active account profile cannot be decrypted with GG_CONTROL_ENCRYPTION_KEY (see scripts/control-plane/rotate-key.mjs).');
    }
    return { config, store, switcher, preferences: await store.listModulePreferences(), activeLabel };
}

/**
 * Serves the dashboard on GG_CONTROL_HOST:GG_CONTROL_PORT.
 * @param {ReturnType<typeof prepareControlPlane>} prepared
 * @param {object} hooks - rebind(subsystem), healthReport(), metrics(), validation()
 */
export async function startControlPlane(prepared, hooks) {
    const cp = createControlPlane({ config: prepared.config, store: prepared.store, switcher: prepared.switcher, engine, ...hooks });
    await cp.listen();
    await prepared.store.audit({ action: 'control-plane.start', subject: 'dashboard', detail: { port: prepared.config.port } });
    console.log(`[GoGon] Control plane listening on http://${prepared.config.host}:${prepared.config.port}/ (publish on 127.0.0.1 only)`);
    return cp;
}
