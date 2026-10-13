// app_modules/notify.js - specs/tasks/2026-10-notification-outbox.md (AC-1, AC-2)
// Claim-and-enqueue for monitors: an event's alert is built first, then the event ID and the alert
// are committed together (gg_database.claimNotification), and notificationDispatcher.js delivers it.
// A crash or webhook failure after the claim leaves a pending outbox row instead of a lost alert.
import { LOG, ERR } from './core.js';
import { claimNotification, appendNotifications } from '../_gg_data/handler/gg_database.js';
import { getSetting } from '../config/runtime.mjs';
import { getAccountScope } from '../config/accountScope.mjs';

/** One outbox notification: the webhook setting key (resolved at send time) and the message body. */
export const alertFor = (settingKey, payload) => ({ settingKey, payload });

/**
 * Builds the alerts of new events concurrently, then claims the events oldest first.
 * An event whose alert cannot be built is still claimed without an alert (the existing dedupe
 * behavior: a failing event is not retried on every run). Alerts for a webhook that is not
 * configured are not stored, as such modules send nothing. A failed claim stops the run so later
 * events are not claimed ahead of it; the next run retries from there.
 *
 * @param {string} source - Monitor name used in logs and as the outbox source.
 * @param {{ storageKey: string, historyLimit: number }} list - The monitor's processed-ID list.
 * @param {Array<object>} events - New events, oldest first.
 * @param {{ idOf: (event: object) => string|number, build: (event: object) => Promise<Array>|Array }} how
 * @returns {Promise<Array<object>>} The events this run claimed.
 */
export async function claimAlerts(source, { storageKey, historyLimit }, events, { idOf, build }) {
    const built = await Promise.allSettled(events.map(async event => build(event)));
    const claimed = [];
    for (const [i, event] of events.entries()) {
        const eventId = idOf(event);
        let notifications = [];
        if (built[i].status === 'fulfilled') {
            notifications = (built[i].value || []).filter(n => getSetting(n.settingKey));
        } else {
            ERR(source, `Failed to build the alert for event ${eventId}; claiming it without an alert.`, built[i].reason);
        }
        try {
            const ok = await claimNotification({
                source, storageKey, historyLimit, eventId, accountScope: getAccountScope(), notifications,
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
 * Parts that already exist are skipped. Returns the number of rows added.
 */
export async function appendAlerts(source, eventId, firstPart, notifications) {
    const configured = notifications.filter(n => getSetting(n.settingKey));
    if (!configured.length) return 0;
    return appendNotifications({ source, eventId, accountScope: getAccountScope(), firstPart, notifications: configured });
}
