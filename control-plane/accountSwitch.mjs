// control-plane/accountSwitch.mjs - CTRL-TASK-004 / AC-CTRL-004
// Serialized account-profile switch:
//   pause modules -> flush Discord queue -> clear credentials and cookie jar -> authenticate the
//   target profile -> validate the session -> mark it active -> resume the modules that were enabled.
// Any failure after the pause leaves the engine paused with no active account ("failed-closed");
// the owner may retry or pick another profile. Audit events carry profile labels only.
import { EventEmitter } from 'node:events';

/**
 * @param {object} deps
 * @param {ReturnType<import('../_gg_data/handler/controlStore.js').createControlStore>} deps.store
 * @param {{ pauseAll: Function, resumeAll: Function }} deps.engine
 * @param {() => Promise<boolean>} deps.drainQueue - flushes pending Discord notifications
 * @param {{ resetSession: Function, setCredentialProvider: Function, login: Function, isLoggedIn: Function }} deps.session
 */
export function createAccountSwitcher({ store, engine, drainQueue, session }) {
    const events = new EventEmitter();
    let state = 'idle';            // idle | switching | failed-closed
    let lastError = null;
    let activeLabel = null;        // set by applyStoredActiveProfile() at boot
    let inFlight = null;

    const snapshot = () => ({ state, activeLabel, lastError });
    const emit = () => events.emit('change', snapshot());

    /** Installs a profile's credentials as the session's credential source. */
    function useProfileCredentials(creds) {
        const frozen = Object.freeze({ email: creds.email, password: creds.password });
        session.setCredentialProvider(() => frozen);
    }

    async function run(profileId, actor) {
        let creds;
        try {
            creds = await store.getProfileCredentials(profileId);
        } catch {
            creds = undefined;
        }
        if (!creds) {
            await store.audit({ actor, action: 'account.switch', subject: String(profileId).slice(0, 64), outcome: 'failed', detail: { reason: 'profile unavailable' } });
            throw Object.assign(new Error('Profile not found or could not be decrypted.'), { status: 404 });
        }

        const from = activeLabel;
        state = 'switching';
        lastError = null;
        emit();

        const resumeList = await engine.pauseAll();
        try {
            await drainQueue();
        } catch { /* a stuck webhook must not block the switch; the queue belongs to the old account */ }

        // Invalidate the old account before authenticating the new one: no partial account.
        session.setCredentialProvider(null);
        await session.resetSession();
        await store.setActiveProfile(null);
        activeLabel = null;

        try {
            await session.login(creds.email, creds.password, { useBootstrap: false });
            if (!(await session.isLoggedIn())) throw new Error('Session validation failed after login.');
        } catch (e) {
            session.setCredentialProvider(null);
            await session.resetSession().catch(() => {});
            state = 'failed-closed';
            lastError = `Could not sign in to profile "${creds.label}". Tasks stay paused; retry or choose another profile.`;
            await store.audit({ actor, action: 'account.switch', subject: creds.label, outcome: 'failed', detail: { from, reason: /Connection failure/.test(e?.message) ? 'connection' : 'authentication' } });
            emit();
            throw Object.assign(new Error(lastError), { status: 502 });
        }

        useProfileCredentials(creds);
        await store.setActiveProfile(profileId);
        activeLabel = creds.label;
        await store.audit({ actor, action: 'account.switch', subject: creds.label, detail: { from } });
        const resumed = await engine.resumeAll(resumeList);
        state = 'idle';
        emit();
        return { activeLabel, resumed };
    }

    return {
        events,
        status: snapshot,

        /**
         * Applies the stored active profile at boot (before the first login). Throws when it cannot
         * be decrypted, so GoGon never silently falls back to a different account.
         * @returns {Promise<string|null>} The active profile label, or null to use .env credentials.
         */
        async applyStoredActiveProfile() {
            const active = await store.getActiveProfile();
            if (!active) return null;
            const creds = await store.getProfileCredentials(active.id);
            useProfileCredentials(creds);
            activeLabel = creds.label;
            return creds.label;
        },

        /** Switches to a profile. Concurrent requests are refused while one is running. */
        async switchTo(profileId, actor = 'owner') {
            if (inFlight) throw Object.assign(new Error('An account switch is already in progress.'), { status: 409 });
            inFlight = run(profileId, actor);
            try { return await inFlight; } finally { inFlight = null; }
        },
    };
}
