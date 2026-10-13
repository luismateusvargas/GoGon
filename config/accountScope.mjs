// config/accountScope.mjs - specs/tasks/2026-10-notification-outbox.md (AC-4)
// The game account whose alerts may be claimed and sent right now: 'env' (the .env credentials) or
// 'profile:<id>' (an account profile). The account switcher sets it to null while no account is
// signed in, so nothing is claimed or sent under a half-switched session.

let scope = 'env';

export const profileScope = id => (id ? `profile:${id}` : 'env');

export function getAccountScope() {
    return scope;
}

/** @param {string|null} next - 'env', 'profile:<id>', or null (no active account). */
export function setAccountScope(next) {
    scope = next;
}
