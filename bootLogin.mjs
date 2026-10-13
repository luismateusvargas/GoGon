// bootLogin.mjs - specs/tasks/2026-10-notification-outbox.counter-plan.md (O3, AC-4)
// The boot login step of app.mjs. The stored account profile is selected before login (its
// credentials are what login uses), but its alerts become dispatch-eligible only once the game login
// is validated: the account scope is cleared while login() and ensureLogin() run, and the outbox
// starts (replaying pending rows) only after both succeed. A failed boot login sends nothing.
// Project: GoGon (GG)

import { getAccountScope, setAccountScope } from './config/accountScope.mjs';

/**
 * @param {object} boot
 * @param {string} boot.email
 * @param {string} boot.password
 * @param {(email: string, password: string) => Promise<any>} boot.login
 * @param {() => Promise<any>} boot.ensureLogin
 * @param {() => Promise<any>} boot.startOutbox - Starts the notification outbox (replays pending rows).
 * @throws when login or ensureLogin fails; the account scope then stays cleared.
 */
export async function loginBeforeDelivery({ email, password, login, ensureLogin, startOutbox, log = console.log }) {
    const selected = getAccountScope();
    setAccountScope(null); // nothing is claimed or sent until this account's login is validated

    log('[GoGon] Performing initial login...');
    const loginStatus = await login(email, password);
    log(`[GoGon] Login successful: ${loginStatus}`);

    log('[GoGon] Verifying and ensuring login session...');
    await ensureLogin();
    log('[GoGon] Login session validated.');

    setAccountScope(selected);
    // Replay alerts claimed before the last stop for this account. New claims wake the dispatcher.
    try {
        await startOutbox();
    } catch (e) {
        console.error(`[GoGon_ERROR] Notification outbox could not start: ${e.message}`);
    }
}
