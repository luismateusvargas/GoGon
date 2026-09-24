// webhooks.js - Discord Webhook Configuration (GoGon Edition)
// All webhook URLs and role IDs are now loaded from .env for security
// Project: GoGon (GG) - Fallensword Monitoring Bot

// === Discord Webhooks and Role Mentions ===
// Hot registry settings (CTRL-TASK-001): these are live ES module bindings. rebindWebhooks() reassigns
// them when a dashboard override changes, and importers read the binding at send time, so the next
// notification uses the new value without a restart.
import { getSetting, onSettingChange } from './config/runtime.mjs';

export let relicWebhook, conflictWebhook, bountyWebhook, titanWebhook, ladderWebhook, ladderRankingWebhook,
  SuperEliteWebhook, cratesWebhook, newsWebhook, shoutboxWebhook, guildMessageWebhook;
// Format role mentions as <@&ROLE_ID>
export let SEgroup, BountyGroup, TitanGroup, LadderGroup;

const webhookOrEmpty = key => getSetting(key) || undefined;
const roleMention = key => (getSetting(key) ? `<@&${getSetting(key)}>` : '');

export function rebindWebhooks() {
  relicWebhook = webhookOrEmpty('GG_RELIC_WEBHOOK');
  conflictWebhook = webhookOrEmpty('GG_CONFLICT_WEBHOOK');
  bountyWebhook = webhookOrEmpty('GG_BOUNTY_WEBHOOK');
  titanWebhook = webhookOrEmpty('GG_TITAN_WEBHOOK');
  ladderWebhook = webhookOrEmpty('GG_LADDER_WEBHOOK');
  ladderRankingWebhook = webhookOrEmpty('GG_LADDER_RANKING_WEBHOOK');
  SuperEliteWebhook = webhookOrEmpty('GG_SUPER_ELITE_WEBHOOK');
  cratesWebhook = webhookOrEmpty('GG_CRATES_WEBHOOK');
  newsWebhook = webhookOrEmpty('GG_NEWS_WEBHOOK');
  shoutboxWebhook = webhookOrEmpty('GG_SHOUTBOX_WEBHOOK');
  guildMessageWebhook = webhookOrEmpty('GG_GUILD_MESSAGE_WEBHOOK');
  SEgroup = roleMention('GG_SE_GROUP_ROLE_ID');
  BountyGroup = roleMention('GG_BOUNTY_GROUP_ROLE_ID');
  TitanGroup = roleMention('GG_TITAN_GROUP_ROLE_ID');
  LadderGroup = roleMention('GG_LADDER_GROUP_ROLE_ID');
}
rebindWebhooks();
onSettingChange(key => {
  if (key === '*' || /_WEBHOOK$|_GROUP_ROLE_ID$/.test(key)) rebindWebhooks();
});

// === Rate Limiting Constants ===
export const DELAY_BETWEEN_MESSAGES = 2000; // 2 seconds between Discord messages
export const RETRY_DELAY = 2000; // 2 seconds retry delay

// === Validation ===
// Check if critical webhooks are configured
const requiredWebhooks = {
  GG_RELIC_WEBHOOK: relicWebhook,
  GG_CONFLICT_WEBHOOK: conflictWebhook,
  GG_BOUNTY_WEBHOOK: bountyWebhook,
  GG_TITAN_WEBHOOK: titanWebhook,
  GG_LADDER_WEBHOOK: ladderWebhook,
  GG_SUPER_ELITE_WEBHOOK: SuperEliteWebhook,
  GG_CRATES_WEBHOOK: cratesWebhook,
  GG_NEWS_WEBHOOK: newsWebhook,
  GG_SHOUTBOX_WEBHOOK: shoutboxWebhook,
  GG_GUILD_MESSAGE_WEBHOOK: guildMessageWebhook,
};

// Warn about missing webhooks (non-fatal, allows partial configuration)
const missingWebhooks = Object.entries(requiredWebhooks)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingWebhooks.length > 0) {
  console.warn('[GoGon] ⚠️  Missing webhook configuration for:', missingWebhooks.join(', '));
  console.warn('[GoGon] ⚠️  Add these to your .env file. Affected modules will not send notifications.');
}

// Validate role IDs (warn if they look malformed)
const roleVars = Object.fromEntries(
  ['GG_SE_GROUP_ROLE_ID', 'GG_BOUNTY_GROUP_ROLE_ID', 'GG_TITAN_GROUP_ROLE_ID', 'GG_LADDER_GROUP_ROLE_ID'].map(k => [k, getSetting(k)])
);

Object.entries(roleVars).forEach(([key, value]) => {
  if (value && (value.includes('<@&') || value.includes('\''))) {
    console.warn(`[GoGon] ⚠️  ${key} has invalid format. Remove quotes and <@&> wrapper. Use only the numeric ID.`);
    console.warn(`[GoGon] ⚠️  Example: ${key}=1234567890123456789`);
  }
});