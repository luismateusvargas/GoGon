// config/accountScope.mjs - specs/tasks/2026-10-notification-outbox.md (AC-4)
// The game account whose alerts may be claimed and sent right now: 'env' (the .env credentials) or
// 'profile:<id>' (an account profile). The account switcher sets it to null while no account is
// signed in, so nothing is claimed or sent under a half-switched session.

let scope = 'env';
let epoch = 0; // advances on every scope change, so A -> null -> A is not mistaken for the same session

export const profileScope = id => (id ? `profile:${id}` : 'env');

export function getAccountScope() {
    return scope;
}

/** @param {string|null} next - 'env', 'profile:<id>', or null (no active account). */
export function setAccountScope(next) {
    if (next !== scope) epoch++;
    scope = next;
}

/**
 * Pins the active account for one monitor run (review counter-plan O4): the run reads, claims, and
 * appends under this scope, and only while isCurrentAccount() still holds for it.
 * @returns {{ scope: string|null, epoch: number }}
 */
export function bindAccount() {
    return { scope, epoch };
}

/** True while the account a run was bound to is still the active, uninterrupted one. */
export function isCurrentAccount(binding) {
    return Boolean(binding?.scope) && binding.scope === scope && binding.epoch === epoch;
}
