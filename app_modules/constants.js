// app_modules/constants.js - GoGon Configuration Constants
// Centralizes all magic numbers and configuration values
// Project: GoGon (GG)

/**
 * History limits for processed ID storage
 * These determine how many IDs are kept in memory to prevent re-processing
 */
export const HISTORY_LIMITS = {
    STANDARD: 100,      // Default for most modules
    EXTENDED: 200,      // High-volume modules (SuperElites)
    LARGE: 500,         // Very high-volume (Relics)
    UNLIMITED: -1       // No limit (state-based modules)
};

/**
 * Timing delays in milliseconds
 */
export const DELAYS = {
    // Discord rate limiting
    BETWEEN_MESSAGES: 2000,     // 2 seconds between Discord messages
    RETRY: 2000,                // 2 seconds before retrying failed requests
    
    // Gear swapping
    BETWEEN_EQUIPS: 500,        // 500ms between equipping items
    
    // Message processing
    BETWEEN_CHUNKS: 500,        // 500ms between message chunks
    LADDER_BETWEEN_BANDS: 750,  // 750ms between ladder band posts
    
    // Task staggering
    TASK_STAGGER: 2000,         // 2 seconds between task starts
    
    // Shutdown grace period
    SHUTDOWN_GRACE: 5000        // 5 seconds for tasks to finish
};

/**
 * Database cache sizes
 */
export const CACHE_SIZES = {
    CREATURES: 500,   // Cache up to 500 creatures
    ITEMS: 1000,      // Cache up to 1000 items
    REALMS: 300       // Cache up to 300 realms
};

/**
 * Discord embed colors (decimal format)
 */
export const EMBED_COLORS = {
    // Relics
    RELIC_CAPTURED: 3066993,    // Green
    RELIC_LOST: 15158332,       // Red
    RELIC_DEFENDED: 3447003,    // Blue
    RELIC_FAILED: 16737095,     // Gold/Orange
    
    // General
    BOUNTY: 16711680,           // Red
    TITAN: 1127128,             // Green-ish
    LADDER_RESET: 16711680,     // Red
    LADDER_RANKING: 16776960,   // Gold
    SE_KILL: 5763719,           // Purple-ish
    CRATE: 15466240,            // Orange
    NEWS: 5763719,              // Purple
    SHOUTBOX: 10494192,         // Teal
    GUILD_MESSAGE: 7506394,     // Purple
    
    // Conflict states
    CONFLICT_NEW: 16711680,     // Red
    CONFLICT_YOUR_TURN: 9807270,// Grey
    CONFLICT_THEIR_TURN: 16776960, // Gold
    CONFLICT_ENDED: 3066993     // Green
};

/**
 * Module task intervals in milliseconds
 */
export const TASK_INTERVALS = {
    SUPER_ELITES: 15 * 1000,    // 15 seconds
    BOUNTY_BOARD: 5 * 1000,     // 5 seconds
    CRATES: 1 * 60 * 1000,      // 1 minute
    TITANS: 1 * 60 * 1000,      // 1 minute
    LADDER: 1 * 60 * 1000,      // 1 minute
    SHOUTBOX: 5 * 60 * 1000,    // 5 minutes
    GAME_UPDATES: 5 * 60 * 1000,// 5 minutes
    RELICS: 1 * 60 * 1000,      // 1 minute
    GUILD_CONFLICTS: 1 * 60 * 1000, // 1 minute
    GROUPS: 1 * 60 * 1000,      // 1 minute
    AUTO_GEAR_SWAP: 1 * 60 * 1000,  // 1 minute
    GUILD_MESSAGES: 5 * 60 * 1000   // 5 minutes
};

/**
 * Retry configuration
 */
export const RETRY_CONFIG = {
    MAX_RETRIES: 3,             // Maximum number of retry attempts
    INITIAL_DELAY: 1000,        // Initial retry delay (1 second)
    BACKOFF_MULTIPLIER: 2       // Exponential backoff multiplier
};

/**
 * Discord message limits
 */
export const DISCORD_LIMITS = {
    MAX_MESSAGE_LENGTH: 2000,   // Discord's character limit
    MAX_EMBED_DESCRIPTION: 4096, // Max embed description length
    MAX_EMBED_FIELDS: 25,       // Max number of fields in embed
    MAX_EMBED_FIELD_NAME: 256,  // Max field name length
    MAX_EMBED_FIELD_VALUE: 1024 // Max field value length
};

/**
 * Emoji constants
 */
export const EMOJIS = {
    // Medals
    FIRST: '🥇',
    SECOND: '🥈',
    THIRD: '🥉',
    
    // Status
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    INFO: 'ℹ️',
    
    // Game elements
    CHEST: ':chest:',
    CALENDAR: '📅',
    RUNNER: '🏃',
    GIFT: '🎁',
    BOAR: '🐗',
    MAP: '🗺️',
    SPEECH_BUBBLE: '💬',
    LOUDSPEAKER: '📢',
    CAMERA: '📷',
    LINK: '🔗',
    
    // Relics
    TROPHY: '🏆',
    SHIELD: '🛡️',
    DASH: '💨'
};

/**
 * Database storage keys
 */
export const STORAGE_KEYS = {
    SE_KILLS: 'processed_se_kill_ids',
    BOUNTIES: 'processed_bounty_ids',
    CRATES: 'processed_crate_ids',
    TITANS: 'processed_titan_news_ids',
    LADDER: 'processed_ladder_news_ids',
    SHOUTBOX: 'processed_shoutbox_ids',
    UPDATES: 'processed_update_archive_ids',
    RELICS: 'processed_relic_log_ids',
    GUILD_CONFLICTS: 'active_guild_conflicts',
    GVG_COOLDOWNS: 'gvg_cooldowns',
    GUILD_MESSAGES: 'processed_guild_message_ids',
    GEAR_STATE: 'current_gear_state'
};

/**
 * Environment variable precedence: the GG_ name wins, then legacy SWS_, then legacy FS_.
 * Read through readEnv() in session.mjs. AUTH-TASK-001
 */
export const ENV_ALIASES = {
    GG_EMAIL: ['GG_EMAIL', 'SWS_EMAIL', 'FS_EMAIL'],
    GG_PASSWORD: ['GG_PASSWORD', 'SWS_PASSWORD', 'FS_PASSWORD'],
    GG_BASE: ['GG_BASE', 'SWS_BASE', 'FS_BASE'],
    GG_SSO_URL: ['GG_SSO_URL', 'SWS_SSO_URL'],
    GG_UA: ['GG_UA', 'SWS_UA'],
    GG_LANG: ['GG_LANG', 'SWS_LANG'],
    GG_LOGIN_DEBUG: ['GG_LOGIN_DEBUG', 'SWS_LOGIN_DEBUG'],
    GG_DEBUG_DIR: ['GG_DEBUG_DIR', 'SWS_DEBUG_DIR'],
    GG_GUILD_NAME: ['GG_GUILD_NAME', 'SWS_GUILD_NAME'],
    GG_BOT_CHARACTER: ['GG_BOT_CHARACTER', 'SWS_BOT_CHARACTER', 'FS_BOT_CHARACTER'],
    GG_BOT_ID_CHARACTER: ['GG_BOT_ID_CHARACTER', 'SWS_BOT_ID_CHARACTER', 'FS_BOT_ID_CHARACTER'],
    // Unprefixed Discord names are the legacy backup names, also accepted by configValidator
    GG_DISCORD_TOKEN: ['GG_DISCORD_TOKEN', 'DISCORD_TOKEN'],
    GG_DISCORD_APP_ID: ['GG_DISCORD_APP_ID', 'DISCORD_APP_ID'],
    GG_DISCORD_GUILD_ID: ['GG_DISCORD_GUILD_ID', 'DISCORD_GUILD_ID']
};

/**
 * Time formats
 */
export const TIME_FORMATS = {
    LOCALE: 'pt-BR',
    TIMEZONE: 'Europe/London'
};

/**
 * Cooldown durations
 */
export const CONFLICT_PING = {
    // Fallback only: the mention is the GG_CONFLICT_PING_MENTION registry setting (CTRL-TASK-008)
    DEFAULT_MENTION: GG_CONFLICT_PING_MENTION,
    QUIET_WINDOW_MS: 15 * 60 * 1000,    // No second ping within 15 minutes of the last one
    // Enemy attacks come at most every 2 minutes and the monitor polls every minute, so
    // no new incoming attack for over 3 minutes means the enemy guild has stopped
    BURST_GAP_MS: 3 * 60 * 1000
};

export const COOLDOWNS = {
    GVG: 10 * 24 * 60 * 60 * 1000  // 10 days (864000000 ms), owner-locked; used by GuildConflicts (MON-TASK-002)
};
