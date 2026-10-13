// app_modules/notify.js - specs/tasks/2026-10-notification-outbox.md (AC-1, AC-2)
// Claim-and-enqueue for monitors: an event's alert is built first, then the event ID and the alert
// are committed together (gg_database.claimNotification), and notificationDispatcher.js delivers it.
// A crash or webhook failure after the claim leaves a pending outbox row instead of a lost alert.
// Each monitor run is bound to the account active when it starts (review counter-plan O4): its reads,
// claims, and follow-up parts use that account, and nothing is claimed once another account took over.
import { LOG, WARN, ERR } from './core.js';
import { claimNotification, appendNotifications, getProcessedContent } from '../_gg_data/handler/gg_database.js';
import { getSetting } from '../config/runtime.mjs';
import { bindAccount, isCurrentAccount } from '../config/accountScope.mjs';

/** Binds a monitor run to the active account; call it before the run's first account-specific read. */
export { bindAccount };

/** One outbox notification: the webhook setting key (resolved at send time) and the message body. */
export const alertFor = (settingKey, payload) => ({ settingKey, payload });

/**
 * The monitor's processed IDs for the run's account, as stored JSON or null (AC-4): each account has
 * its own list, so another account's claim of the same game ID does not hide this event.
 * @param {string} storageKey
 * @param {{ scope: string|null }} account - From bindAccount() at the start of the run.
 */
export const processedContent = (storageKey, account) => getProcessedContent(storageKey, account.scope);

/**
 * Builds the alerts of new events concurrently, then claims the events oldest first.
 * An event whose alert cannot be built (e.g. a transient database lookup failure) is left unclaimed,
 * so the next run builds and claims it; later events are still claimed (AC-1: an event is handled
 * only with its pending alert). An event that builds no alert, or only alerts for a webhook that is
 * not configured, is claimed without a row, as such modules send nothing. A failed claim stops the run
 * so later events are not claimed ahead of it; the next run retries from there. Once the run's account
 * is no longer the active one (an account switch went ahead of this run), the rest stays unclaimed for
 * a later run under that account.
 *
 * @param {string} source - Monitor name used in logs and as the outbox source.
 * @param {{ storageKey: string, historyLimit: number, account?: { scope: string|null, epoch: number } }} list
 *   The monitor's processed-ID list and the run's bindAccount() (defaults to the account active now).
 * @param {Array<object>} events - New events, oldest first.
 * @param {{ idOf: (event: object) => string|number, build: (event: object) => Promise<Array>|Array }} how
 * @returns {Promise<Array<object>>} The events this run claimed.
 */
export async function claimAlerts(source, { storageKey, historyLimit, account = bindAccount() }, events, { idOf, build }) {
    const built = await Promise.allSettled(events.map(async event => build(event)));
    const claimed = [];
    for (const [i, event] of events.entries()) {
        const eventId = idOf(event);
        if (!isCurrentAccount(account)) {
            WARN(source, `The account changed during this run; ${events.length - i} event(s) stay unclaimed for a run under that account.`);
            break;
        }
        if (built[i].status === 'rejected') {
            ERR(source, `Failed to build the alert for event ${eventId}; it stays unclaimed and is retried on the next run.`, built[i].reason);
            continue;
        }
        const notifications = (built[i].value || []).filter(n => getSetting(n.settingKey));
        try {
            const ok = await claimNotification({
                source, storageKey, historyLimit, eventId, accountScope: account.scope, notifications,
            });
            if (ok) claimed.push(event);
        } catch (error) {
            ERR(source, `Failed to claim event ${eventId}; it will be retried on the next run.`, error);
            break;
        }
    }
    if (claimed.length) LOG(source, `Claimed ${claimed.length} new event(s) and queued their alerts.`);
    return claimed;
}

/**
 * Adds alerts to an event this monitor already claimed (follow-up messages fetched after the claim).
 * Parts that already exist are skipped. Parts fetched after the run's account stopped being the active
 * one are dropped, as they may come from another account's session. Returns the number of rows added.
 * @param {{ scope: string|null, epoch: number }} account - The bindAccount() of the run that claimed it.
 */
export async function appendAlerts(source, account, eventId, firstPart, notifications) {
    const configured = notifications.filter(n => getSetting(n.settingKey));
    if (!configured.length) return 0;
    if (!isCurrentAccount(account)) {
        WARN(source, `The account changed during this run; follow-up part ${firstPart} of event ${eventId} is not queued.`);
        return 0;
    }
    return appendNotifications({ source, eventId, accountScope: account.scope, firstPart, notifications: configured });
}
