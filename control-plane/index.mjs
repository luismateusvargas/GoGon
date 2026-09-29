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
import { resetSession, setCredentialProvider, login, isLoggedIn, authedFetch } from '../session.mjs';
import { createCatalogStore } from '../_gg_data/handler/catalogStore.js';
import { createGuideDiscoveryStore } from '../_gg_data/handler/guideDiscoveryStore.js';
import { createCollector } from '../catalog/collector.js';
import { createCatalogService } from '../catalog/catalogService.js';
import { createSeedService } from '../catalog/seedService.js';
import { createGuideRelay } from '../catalog/guideRelay.js';
import { createGuideWorker } from '../catalog/guideWorker.js';
import { configureCatalogTask, runCatalogSync } from '../catalog/catalogTask.js';

/**
 * CAT-TASK-005: one catalog store and collector shared by the CatalogSync engine task and the
 * Catalog API, so a scheduled run and an owner command see the same jobs and the same lock.
 */
export async function createCatalog() {
    const db = await getConnection();
    const store = createCatalogStore(db);
    const guideStore = createGuideDiscoveryStore(db);
    const collector = createCollector({
        store,
        fetchFn: authedFetch,
        sessionReady: () => (engine.isPaused() ? { ok: false, reason: 'engine_paused' } : { ok: true }),
    });
    const relay = createGuideRelay({ db, store, guideStore });
    const guideWorker = createGuideWorker({ relay,
        getClearance: () => getSetting('GG_GUIDE_CLEARANCE'),
        getUserAgent: () => getSetting('GG_GUIDE_USER_AGENT'),
    });
    configureCatalogTask({ store, collector, guideWorker });
    const service = createCatalogService({ db, store, guideStore, collector, relay, seeds: createSeedService({ db, store }) });
    return { db, store, guideStore, collector, relay, service, runNow: () => runCatalogSync({}) };
}

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
    // Built before the engine starts, so an enabled CatalogSync task uses this store and collector.
    const catalog = await createCatalog();
    return { config, store, switcher, catalog, preferences: await store.listModulePreferences(), activeLabel };
}

/**
 * Serves the dashboard on GG_CONTROL_HOST:GG_CONTROL_PORT.
 * @param {ReturnType<typeof prepareControlPlane>} prepared
 * @param {object} hooks - rebind(subsystem), healthReport(), metrics(), validation()
 */
export async function startControlPlane(prepared, hooks) {
    const cp = createControlPlane({ config: prepared.config, store: prepared.store, switcher: prepared.switcher, engine, catalog: prepared.catalog, ...hooks });
    await cp.listen();
    await prepared.store.audit({ action: 'control-plane.start', subject: 'dashboard', detail: { port: prepared.config.port } });
    console.log(`[GoGon] Control plane listening on http://${prepared.config.host}:${prepared.config.port}/ (publish on 127.0.0.1 only)`);
    return cp;
}
