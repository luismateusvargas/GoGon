// 015_outbox_account_identity.mjs - specs/tasks/2026-10-notification-outbox.counter-plan.md (O1, AC-4)
// Two game accounts can see the same event ID (crate 4242 for profile A and for profile B). An outbox
// row is now identified by (source, account_scope, event_id, part), so each account keeps its own
// pending alert. The wider key is added before the narrower one is dropped, so uniqueness per account
// never lapses; existing rows already satisfy it. Each step tolerates having run before, so a
// partially applied file re-runs safely. Additive: no row is changed or removed.

export async function up(client) {
    try {
        await client.query('CREATE UNIQUE INDEX notification_outbox_account_event ON notification_outbox (source, account_scope, event_id, part)');
    } catch (error) {
        if (error?.code !== 'ER_DUP_KEYNAME') throw error;
    }
    try {
        await client.query('ALTER TABLE notification_outbox DROP INDEX notification_outbox_event');
    } catch (error) {
        if (error?.code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
    }
}
