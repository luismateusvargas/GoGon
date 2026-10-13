// tests/helpers/outbox-alerts.mjs - specs/tasks/2026-10-notification-outbox.md
// Monitors no longer call sendExtraDiscordMessage*: they claim an event and store its alert in
// notification_outbox. These helpers read the stored alerts back in the shape the monitor tests
// used for captured sends: args mirror sendExtraDiscordMessage(message, title, color, footer, group,
// webhookSetting, imageUrl, thumbnailUrl), and kind is 'drop' (with thumbnail) or 'nodrop'.

/** Webhook settings the monitors need configured; alerts for unset webhooks are not stored. */
export const MONITOR_WEBHOOK_SETTINGS = [
    'GG_RELIC_WEBHOOK', 'GG_BOUNTY_WEBHOOK', 'GG_TITAN_WEBHOOK', 'GG_LADDER_WEBHOOK', 'GG_SUPER_ELITE_WEBHOOK',
    'GG_CRATES_WEBHOOK', 'GG_NEWS_WEBHOOK', 'GG_SHOUTBOX_WEBHOOK', 'GG_GUILD_MESSAGE_WEBHOOK',
];

/** Points every monitor webhook at a placeholder URL (nothing is sent: no dispatcher runs). */
export function configureTestWebhooks(env = process.env) {
    for (const key of MONITOR_WEBHOOK_SETTINGS) {
        env[key] = `https://discord.com/api/webhooks/1/${key.toLowerCase()}`;
    }
}

/** Every stored alert, oldest first. */
export async function storedAlerts(db) {
    const client = await db.getConnection();
    const rows = await client.query('SELECT source, event_id, part, account_scope, setting_key, payload, state FROM notification_outbox ORDER BY id');
    return rows.map(row => {
        const payload = JSON.parse(row.payload);
        const embed = payload.embeds[0];
        return {
            kind: 'thumbnail' in embed ? 'drop' : 'nodrop',
            args: [embed.description, embed.title, embed.color, embed.footer?.text, payload.content, row.setting_key, embed.image?.url, embed.thumbnail?.url],
            payload,
            row,
        };
    });
}

export async function clearOutbox(db) {
    await (await db.getConnection()).query('DELETE FROM notification_outbox');
}
