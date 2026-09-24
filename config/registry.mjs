// config/registry.mjs - CTRL-TASK-001 / AC-CTRL-002, AC-CTRL-003
// The explicit, allow-listed configuration registry. Every setting GoGon reads is defined here with
// its type, sensitivity, reload mode, validator, default, and owning modules. The control plane can
// only read or write keys listed here; it never touches arbitrary process.env keys.
//
// reloadMode:
//   hot                       - read again by the next task run / next request
//   subsystem-rebind          - applying it restarts only the named subsystem (e.g. the Discord client)
//   controlled-session-switch - game credentials; changed only through the account-switch coordinator
//   bootstrap                 - .env only (paths, ports, admin identity, keys); shown read-only
//
// sensitivity: public | private (non-secret but account-specific) | secret (write-only, never returned)

const SNOWFLAKE = /^\d{17,20}$/;
const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Named validators: (value: string) => string|null (an error message, or null when valid). */
export const VALIDATORS = {
    boolean: v => (v === '0' || v === '1' ? null : 'Must be 0 or 1.'),
    port: v => (/^\d{1,5}$/.test(v) && +v > 0 && +v < 65536 ? null : 'Must be a TCP port (1-65535).'),
    'positive-integer': v => (/^\d{1,12}$/.test(v) && +v > 0 ? null : 'Must be a positive whole number.'),
    snowflake: v => (SNOWFLAKE.test(v) ? null : 'Must be a Discord ID (17-20 digits).'),
    'optional-snowflake': v => (v === '' || SNOWFLAKE.test(v) ? null : 'Must be empty or a Discord ID (17-20 digits).'),
    'conflict-mention': v => (v === 'none' || v === '@everyone' || SNOWFLAKE.test(v)
        ? null : 'Must be "none", "@everyone", or a Discord role ID (17-20 digits).'),
    'inventory-id-list': v => {
        if (v === '') return null;
        const parts = v.split(',').map(s => s.trim());
        if (parts.length > 50) return 'At most 50 inventory IDs.';
        return parts.every(p => /^\d{1,12}$/.test(p)) ? null : 'Must be comma-separated numeric inventory IDs.';
    },
    'short-text': v => (v.length <= 100 && !CONTROL_CHARS.test(v) ? null : 'At most 100 printable characters.'),
    'user-agent': v => (v.length > 0 && v.length <= 300 && !CONTROL_CHARS.test(v) ? null : 'A non-empty User-Agent of at most 300 printable characters.'),
    'accept-language': v => (/^[A-Za-z0-9,;=.\- *]{1,100}$/.test(v) ? null : 'An Accept-Language value such as "en-US,en;q=0.9".'),
    'discord-webhook-url': v => {
        if (v === '') return null;
        if (v.length > 512) return 'URL is too long.';
        let u;
        try { u = new URL(v); } catch { return 'Must be a Discord webhook URL.'; }
        if (u.protocol !== 'https:' || !WEBHOOK_HOSTS.has(u.hostname) || u.port || u.username || u.password
            || !/^\/api\/(v\d+\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{20,100}$/.test(u.pathname) || u.hash) {
            return 'Must be an https://discord.com/api/webhooks/<id>/<token> URL.';
        }
        return null;
    },
    'non-empty-secret': v => (v.length > 0 && v.length <= 512 ? null : 'Must be 1-512 characters.'),
    'https-url': v => {
        try { const u = new URL(v); return u.protocol === 'https:' ? null : 'Must be an https:// URL.'; } catch { return 'Must be an https:// URL.'; }
    },
    'bind-host': v => (/^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/.test(v) ? null : 'Must be 127.0.0.1, localhost, ::1, or 0.0.0.0 (containers only).'),
    hostname: v => (/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(v) ? null : 'Must be a host name or IP address.'),
    'db-identifier': v => (/^[A-Za-z0-9_]{1,64}$/.test(v) ? null : '1-64 letters, digits, or underscores.'),
    path: v => (v.length > 0 && v.length <= 260 && !CONTROL_CHARS.test(v) ? null : 'Must be a file system path.'),
    'scrypt-hash': v => (/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]{16,}\$[A-Za-z0-9+/=]{40,}$/.test(v) ? null : 'Must be a hash from scripts/control-plane/hash-password.mjs.'),
    'base64-32-bytes': v => (/^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32 ? null : 'Must be 32 random bytes, base64-encoded.'),
    'min-32-chars': v => (v.length >= 32 && v.length <= 512 ? null : 'Must be 32-512 characters.'),
    username: v => (/^[A-Za-z0-9_.-]{3,64}$/.test(v) ? null : '3-64 letters, digits, dot, dash, or underscore.'),
};

const def = (key, props) => Object.freeze({
    key,
    aliases: [key],
    editable: props.reloadMode === 'hot' || props.reloadMode === 'subsystem-rebind',
    default: '',
    ...props,
});

const webhook = (key, label, owners) => def(key, {
    label, section: 'webhooks', type: 'secret', sensitivity: 'secret', reloadMode: 'hot',
    validator: 'discord-webhook-url', owners, description: `Discord webhook for ${label.toLowerCase()} notifications.`,
});
const role = (key, label, owners) => def(key, {
    label, section: 'notifications', type: 'string', sensitivity: 'private', reloadMode: 'hot',
    validator: 'optional-snowflake', owners, description: `Discord role mentioned on ${label.toLowerCase()} notifications (numeric ID, no <@&>).`,
});

export const CONFIG_DEFINITIONS = Object.freeze([
    // --- Game account and session (auth-session-v1) ---
    def('GG_EMAIL', { label: 'Game account email', section: 'account', type: 'secret', sensitivity: 'secret',
        reloadMode: 'controlled-session-switch', validator: 'non-empty-secret', owners: ['session'],
        aliases: ['GG_EMAIL', 'SWS_EMAIL', 'FS_EMAIL'], description: 'Bootstrap login when no account profile is active. Change it through Account profiles.' }),
    def('GG_PASSWORD', { label: 'Game account password', section: 'account', type: 'secret', sensitivity: 'secret',
        reloadMode: 'controlled-session-switch', validator: 'non-empty-secret', owners: ['session'],
        aliases: ['GG_PASSWORD', 'SWS_PASSWORD', 'FS_PASSWORD'], description: 'Bootstrap login when no account profile is active. Change it through Account profiles.' }),
    def('GG_BOT_CHARACTER', { label: 'Bot character name', section: 'account', type: 'string', sensitivity: 'private',
        reloadMode: 'hot', validator: 'short-text', owners: ['buffs', 'inventory'],
        aliases: ['GG_BOT_CHARACTER', 'SWS_BOT_CHARACTER', 'FS_BOT_CHARACTER'], description: 'Character that casts buffs and uses BE potions.' }),
    def('GG_BOT_ID_CHARACTER', { label: 'Bot character ID', section: 'account', type: 'integer', sensitivity: 'private',
        reloadMode: 'hot', validator: 'positive-integer', owners: ['AutoGearSwap', 'buffs', 'inventory'],
        aliases: ['GG_BOT_ID_CHARACTER', 'SWS_BOT_ID_CHARACTER', 'FS_BOT_ID_CHARACTER'], description: 'Numeric player ID of the bot character.' }),
    def('GG_GUILD_NAME', { label: 'Guild name', section: 'account', type: 'string', sensitivity: 'public',
        reloadMode: 'hot', validator: 'short-text', default: 'My Guild', owners: ['GuildConflicts'],
        aliases: ['GG_GUILD_NAME', 'SWS_GUILD_NAME'], description: 'Your guild name, shown in conflict score titles.' }),
    def('GG_UA', { label: 'User-Agent', section: 'session', type: 'string', sensitivity: 'public',
        reloadMode: 'hot', validator: 'user-agent', owners: ['session', 'secureFetch'],
        aliases: ['GG_UA', 'SWS_UA'], description: 'User-Agent sent to the game. Empty uses the built-in browser UA.' }),
    def('GG_LANG', { label: 'Accept-Language', section: 'session', type: 'string', sensitivity: 'public',
        reloadMode: 'hot', validator: 'accept-language', owners: ['session', 'secureFetch'],
        aliases: ['GG_LANG', 'SWS_LANG'], description: 'Accept-Language sent to the game.' }),
    def('GG_LOGIN_DEBUG', { label: 'Login debug snapshots', section: 'debug', type: 'boolean', sensitivity: 'public',
        reloadMode: 'hot', validator: 'boolean', default: '0', owners: ['session'],
        aliases: ['GG_LOGIN_DEBUG', 'SWS_LOGIN_DEBUG'], description: 'Save SSO HTML snapshots to GG_DEBUG_DIR (may contain account pages).' }),
    def('GG_BASE', { label: 'Game base URL', section: 'session', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'https-url', default: 'https://www.fallensword.com', owners: ['session'],
        aliases: ['GG_BASE', 'SWS_BASE', 'FS_BASE'], description: 'Game origin.' }),
    def('GG_SSO_URL', { label: 'SSO entry URL', section: 'session', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'https-url', default: 'https://account.huntedcow.com/auth?game=6', owners: ['session'],
        aliases: ['GG_SSO_URL', 'SWS_SSO_URL'], description: 'HuntedCow SSO entry point.' }),

    // --- Discord bot (discord-integration-v1) ---
    def('GG_DISCORD_TOKEN', { label: 'Discord bot token', section: 'discord', type: 'secret', sensitivity: 'secret',
        reloadMode: 'subsystem-rebind', subsystem: 'discord', validator: 'non-empty-secret', owners: ['discordBot'],
        aliases: ['GG_DISCORD_TOKEN', 'DISCORD_TOKEN'], description: 'Bot token. Saving it restarts only the Discord client.' }),
    def('GG_DISCORD_APP_ID', { label: 'Discord application ID', section: 'discord', type: 'string', sensitivity: 'private',
        reloadMode: 'subsystem-rebind', subsystem: 'discord', validator: 'snowflake', owners: ['discordBot'],
        aliases: ['GG_DISCORD_APP_ID', 'DISCORD_APP_ID'], description: 'Application that owns the slash commands.' }),
    def('GG_DISCORD_GUILD_ID', { label: 'Discord server ID', section: 'discord', type: 'string', sensitivity: 'private',
        reloadMode: 'subsystem-rebind', subsystem: 'discord', validator: 'snowflake', owners: ['discordBot'],
        aliases: ['GG_DISCORD_GUILD_ID', 'DISCORD_GUILD_ID'], description: 'Server where slash commands are registered.' }),

    // --- Webhooks (secret: the URL is the credential) ---
    webhook('GG_RELIC_WEBHOOK', 'Relics', ['Relics']),
    webhook('GG_CONFLICT_WEBHOOK', 'Guild conflicts', ['GuildConflicts']),
    webhook('GG_BOUNTY_WEBHOOK', 'Bounty board', ['BountyBoard']),
    webhook('GG_TITAN_WEBHOOK', 'Titans', ['Titans']),
    webhook('GG_LADDER_WEBHOOK', 'Ladder', ['Ladder']),
    webhook('GG_LADDER_RANKING_WEBHOOK', 'Ladder ranking', ['Ladder']),
    webhook('GG_SUPER_ELITE_WEBHOOK', 'Super Elites', ['SuperElites']),
    webhook('GG_CRATES_WEBHOOK', 'Crates', ['Crates']),
    webhook('GG_NEWS_WEBHOOK', 'Game updates', ['GameUpdates']),
    webhook('GG_SHOUTBOX_WEBHOOK', 'Shoutbox', ['Shoutbox']),
    webhook('GG_GUILD_MESSAGE_WEBHOOK', 'Guild messages', ['GuildMessages']),

    // --- Notifications ---
    def('GG_CONFLICT_PING_MENTION', { label: 'Conflict attack ping mention', section: 'notifications', type: 'enum',
        sensitivity: 'private', reloadMode: 'hot', validator: 'conflict-mention', default: '@everyone',
        options: ['none', '@everyone', '<role ID>'], owners: ['GuildConflicts'],
        description: 'Who the incoming-attack ping mentions: none, @everyone, or a role ID. When to ping is fixed by AC-MON-007.' }),
    role('GG_SE_GROUP_ROLE_ID', 'Super Elite', ['SuperElites']),
    role('GG_BOUNTY_GROUP_ROLE_ID', 'Bounty', ['BountyBoard']),
    role('GG_TITAN_GROUP_ROLE_ID', 'Titan', ['Titans']),
    role('GG_LADDER_GROUP_ROLE_ID', 'Ladder', ['Ladder']),

    // --- Gear swap (game-monitors-v1 AC-MON-003) ---
    def('GG_PEACE_GEAR_IDS', { label: 'Peace gear inventory IDs', section: 'gear', type: 'string', sensitivity: 'private',
        reloadMode: 'hot', validator: 'inventory-id-list', owners: ['AutoGearSwap'], description: 'Comma-separated inventory IDs equipped outside conflicts.' }),
    def('GG_WAR_GEAR_IDS', { label: 'War gear inventory IDs', section: 'gear', type: 'string', sensitivity: 'private',
        reloadMode: 'hot', validator: 'inventory-id-list', owners: ['AutoGearSwap'], description: 'Comma-separated inventory IDs equipped during conflicts.' }),

    // --- Logging ---
    def('GG_DEBUG', { label: 'Verbose logging', section: 'debug', type: 'boolean', sensitivity: 'public',
        reloadMode: 'hot', validator: 'boolean', default: '1', owners: ['core'], description: 'Log routine LOG() lines (warnings and errors are always logged).' }),
    def('GG_DEBUG_DIR', { label: 'Debug dump directory', section: 'debug', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'path', owners: ['core', 'session'],
        aliases: ['GG_DEBUG_DIR', 'SWS_DEBUG_DIR'], description: 'Where HTML debug dumps are written.' }),
    def('GG_DB_DEBUG', { label: 'SQL statement logging', section: 'debug', type: 'boolean', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'boolean', default: '0', owners: ['database'], description: 'Log every SQL statement.' }),

    // --- Storage (data-storage-v1, MySQL since 2.0.0) ---
    def('GG_MYSQL_HOST', { label: 'MySQL host', section: 'storage', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'hostname', default: '127.0.0.1', owners: ['database'], description: 'MySQL server host. Docker Compose sets the mysql service.' }),
    def('GG_MYSQL_PORT', { label: 'MySQL port', section: 'storage', type: 'integer', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'port', default: '3306', owners: ['database'], description: 'MySQL server port.' }),
    def('GG_MYSQL_USER', { label: 'MySQL user', section: 'storage', type: 'string', sensitivity: 'private',
        reloadMode: 'bootstrap', validator: 'db-identifier', default: 'gogon', owners: ['database'], description: 'MySQL account GoGon connects as.' }),
    def('GG_MYSQL_PASSWORD', { label: 'MySQL password', section: 'storage', type: 'secret', sensitivity: 'secret',
        reloadMode: 'bootstrap', validator: 'non-empty-secret', owners: ['database'], description: 'Password of GG_MYSQL_USER (also creates the account in Docker Compose).' }),
    def('GG_MYSQL_DATABASE', { label: 'MySQL database', section: 'storage', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'db-identifier', default: 'gogon', owners: ['database'], description: 'Database (schema) name.' }),

    // --- Loopback probe (health-metrics-v1) ---
    def('GG_HEALTH_CHECK_ENABLED', { label: 'Loopback probe enabled', section: 'control', type: 'boolean', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'boolean', default: '1', owners: ['healthCheck'], description: 'Serve the unauthenticated loopback /health probe.' }),
    def('GG_HEALTH_CHECK_HOST', { label: 'Probe bind address', section: 'control', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'bind-host', default: '127.0.0.1', owners: ['healthCheck'], description: 'The probe always binds to loopback.' }),
    def('GG_HEALTH_CHECK_PORT', { label: 'Probe port', section: 'control', type: 'integer', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'port', default: '3000', owners: ['healthCheck'], description: 'Loopback probe port.' }),

    // --- Control plane bootstrap (.env only; never editable from the browser) ---
    def('GG_CONTROL_ENABLED', { label: 'Control plane enabled', section: 'control', type: 'boolean', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'boolean', default: '0', owners: ['control-plane'], description: 'Serve the authenticated dashboard. Docker Compose sets 1.' }),
    def('GG_CONTROL_HOST', { label: 'Control plane bind address', section: 'control', type: 'string', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'bind-host', default: '127.0.0.1', owners: ['control-plane'], description: '0.0.0.0 only inside a container whose port is published on 127.0.0.1.' }),
    def('GG_CONTROL_PORT', { label: 'Control plane port', section: 'control', type: 'integer', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'port', default: '8787', owners: ['control-plane'], description: 'Dashboard port (http://127.0.0.1:<port>).' }),
    def('GG_CONTROL_COOKIE_SECURE', { label: 'Secure session cookie', section: 'control', type: 'boolean', sensitivity: 'public',
        reloadMode: 'bootstrap', validator: 'boolean', default: '0', owners: ['control-plane'], description: 'Set when the dashboard is served over HTTPS.' }),
    def('GG_ADMIN_USERNAME', { label: 'Administrator username', section: 'control', type: 'string', sensitivity: 'private',
        reloadMode: 'bootstrap', validator: 'username', owners: ['control-plane'], description: 'Dashboard login name.' }),
    def('GG_ADMIN_PASSWORD_HASH', { label: 'Administrator password hash', section: 'control', type: 'secret', sensitivity: 'secret',
        reloadMode: 'bootstrap', validator: 'scrypt-hash', owners: ['control-plane'], description: 'scrypt hash; a plaintext password is not accepted.' }),
    def('GG_CONTROL_SESSION_SECRET', { label: 'Session signing secret', section: 'control', type: 'secret', sensitivity: 'secret',
        reloadMode: 'bootstrap', validator: 'min-32-chars', owners: ['control-plane'], description: 'Signs dashboard session cookies.' }),
    def('GG_CONTROL_ENCRYPTION_KEY', { label: 'Encryption key', section: 'control', type: 'secret', sensitivity: 'secret',
        reloadMode: 'bootstrap', validator: 'base64-32-bytes', owners: ['control-plane'], description: 'AES-256-GCM key for account profiles and secret overrides.' }),
    def('GG_CONTROL_ENCRYPTION_KEY_PREVIOUS', { label: 'Previous encryption key', section: 'control', type: 'secret', sensitivity: 'secret',
        reloadMode: 'bootstrap', validator: 'base64-32-bytes', owners: ['control-plane'], description: 'Only during key rotation (scripts/control-plane/rotate-key.mjs).' }),
]);

export const CONFIG_BY_KEY = new Map(CONFIG_DEFINITIONS.map(d => [d.key, d]));

export const SECTIONS = Object.freeze({
    account: 'Game account', session: 'Game session', discord: 'Discord bot', webhooks: 'Webhooks',
    notifications: 'Notifications', gear: 'Gear swap', debug: 'Logging and debugging', storage: 'Storage', control: 'Control plane',
});

export const RELOAD_MODES = Object.freeze(['hot', 'subsystem-rebind', 'controlled-session-switch', 'bootstrap']);
export const SENSITIVITIES = Object.freeze(['public', 'private', 'secret']);

/** Bounds for module intervals set from the dashboard (AC-CTRL-003). */
export const MODULE_INTERVAL_BOUNDS = Object.freeze({ min: 5_000, max: 24 * 60 * 60 * 1000 });

/**
 * Validates a proposed value for a registry key. Unknown and non-editable keys are rejected.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateSetting(key, value) {
    const d = CONFIG_BY_KEY.get(key);
    if (!d) return { ok: false, error: 'Unknown setting.' };
    if (!d.editable) return { ok: false, error: d.reloadMode === 'controlled-session-switch' ? 'Change credentials through Account profiles.' : 'This setting is .env-only.' };
    if (typeof value !== 'string') return { ok: false, error: 'Value must be a string.' };
    const v = value.trim();
    if (v.length > 1024) return { ok: false, error: 'Value is too long.' };
    const err = VALIDATORS[d.validator](v);
    return err ? { ok: false, error: err } : { ok: true, value: v };
}
