// configValidator.mjs - GoGon Configuration Validator
// Validates critical environment variables at startup
// Project: GoGon (GG) v1.8.0
import { ENV_ALIASES } from './app_modules/constants.js';
import { getBooleanSetting } from './config/runtime.mjs';

/**
 * Configuration validation rules
 * Each entry defines a required or optional environment variable
 */
const CONFIG_RULES = {
    // Critical - Bot cannot function without these
    critical: [
        { 
            key: 'GG_EMAIL', 
            fallback: 'FS_EMAIL',
            description: 'Fallensword account email',
            example: 'your_email@example.com'
        },
        { 
            key: 'GG_PASSWORD', 
            fallback: 'FS_PASSWORD',
            description: 'Fallensword account password',
            example: 'your_password'
        },
        { 
            key: 'GG_BOT_CHARACTER', 
            fallback: 'FS_BOT_CHARACTER',
            description: 'Bot character name',
            example: 'YourBotName'
        },
        { 
            key: 'GG_BOT_ID_CHARACTER', 
            fallback: 'FS_BOT_ID_CHARACTER',
            description: 'Bot character ID (numeric)',
            example: '123456',
            validate: (val) => /^\d+$/.test(val)
        }
    ],
    
    // Important - Bot can run but features may not work
    important: [
        { 
            key: 'GG_DISCORD_TOKEN', 
            fallback: 'DISCORD_TOKEN',
            description: 'Discord bot token',
            example: 'your_discord_bot_token'
        },
        { 
            key: 'GG_DISCORD_APP_ID', 
            fallback: 'DISCORD_APP_ID',
            description: 'Discord application ID',
            example: '1234567890123456789'
        },
        { 
            key: 'GG_DISCORD_GUILD_ID', 
            fallback: 'DISCORD_GUILD_ID',
            description: 'Discord guild (server) ID',
            example: '1234567890123456789'
        }
    ],
    
    // Optional - Nice to have but not required
    optional: [
        { 
            key: 'GG_HEALTH_CHECK_ENABLED', 
            description: 'Enable health check server',
            example: '1',
            default: '1'
        },
        { 
            key: 'GG_HEALTH_CHECK_PORT', 
            description: 'Health check server port',
            example: '3000',
            default: '3000',
            validate: (val) => /^\d+$/.test(val) && parseInt(val) > 0 && parseInt(val) < 65536
        },
        { 
            key: 'GG_DEBUG', 
            description: 'Enable debug logging',
            example: '1',
            default: '1'
        },
        { 
            key: 'GG_DB_DEBUG', 
            description: 'Enable database debug logging',
            example: '0',
            default: '0'
        }
    ]
};

/**
 * Validation result structure
 */
class ValidationResult {
    constructor() {
        this.errors = [];
        this.warnings = [];
        this.info = [];
        this.valid = true;
    }

    addError(message) {
        this.errors.push(message);
        this.valid = false;
    }

    addWarning(message) {
        this.warnings.push(message);
    }

    addInfo(message) {
        this.info.push(message);
    }

    hasErrors() {
        return this.errors.length > 0;
    }

    hasWarnings() {
        return this.warnings.length > 0;
    }
}

/**
 * Gets the value of an environment variable with fallback support
 * @param {object} rule - The configuration rule
 * @returns {string|null} The value or null if not found
 */
function envKeys(rule) {
    // Same GG_ > SWS_ > FS_ order that session.mjs resolves (AUTH-TASK-001)
    const keys = ENV_ALIASES[rule.key] ? [...ENV_ALIASES[rule.key]] : [rule.key];
    if (rule.fallback && !keys.includes(rule.fallback)) keys.push(rule.fallback);
    return keys;
}

function getEnvValue(rule) {
    for (const key of envKeys(rule)) {
        const value = process.env[key];
        if (value) return value;
    }

    // Try default
    if (rule.default !== undefined) {
        return rule.default;
    }

    return null;
}

/**
 * Validates a single configuration rule
 * @param {object} rule - The configuration rule
 * @param {ValidationResult} result - The validation result object
 * @param {string} severity - 'critical', 'important', or 'optional'
 */
function validateRule(rule, result, severity) {
    const value = getEnvValue(rule);

    // Check if value exists
    if (value === null || value === undefined || value === '') {
        if (severity === 'critical') {
            result.addError(
                `? CRITICAL: Missing required config: ${rule.key}${rule.fallback ? ` (or ${rule.fallback})` : ''}\n` +
                `   Description: ${rule.description}\n` +
                `   Example: ${rule.example}`
            );
        } else if (severity === 'important') {
            result.addWarning(
                `??  WARNING: Missing important config: ${rule.key}${rule.fallback ? ` (or ${rule.fallback})` : ''}\n` +
                `   Description: ${rule.description}\n` +
                `   Example: ${rule.example}\n` +
                `   Impact: Some features may not work`
            );
        } else {
            result.addInfo(
                `??  INFO: Using default for ${rule.key}: ${rule.default || 'none'}\n` +
                `   Description: ${rule.description}`
            );
        }
        return;
    }

    // Validate value if validator provided
    if (rule.validate && !rule.validate(value)) {
        if (severity === 'critical') {
            result.addError(
                `? CRITICAL: Invalid value for ${rule.key}\n` +
                `   Current: ${value}\n` +
                `   Expected: ${rule.example}\n` +
                `   Description: ${rule.description}`
            );
        } else {
            result.addWarning(
                `??  WARNING: Invalid value for ${rule.key}\n` +
                `   Current: ${value}\n` +
                `   Expected: ${rule.example}`
            );
        }
    }

    // Check for fallback usage
    const usedFallback = !process.env[rule.key] && envKeys(rule).slice(1).find(key => process.env[key]);
    if (usedFallback) {
        result.addInfo(
            `??  INFO: Using fallback ${usedFallback} for ${rule.key}\n` +
            `   Recommendation: Rename to ${rule.key} in your .env file`
        );
    }
}

/**
 * Validates all configuration
 * @returns {ValidationResult} The validation result
 */
export function validateConfig() {
    const result = new ValidationResult();

    // Validate critical configs
    CONFIG_RULES.critical.forEach(rule => {
        validateRule(rule, result, 'critical');
    });

    // Validate important configs
    CONFIG_RULES.important.forEach(rule => {
        validateRule(rule, result, 'important');
    });

    // Validate optional configs
    CONFIG_RULES.optional.forEach(rule => {
        validateRule(rule, result, 'optional');
    });

    return result;
}

/**
 * Prints validation results to console
 * @param {ValidationResult} result - The validation result
 */
export function printValidationResults(result) {
    console.log('\n' + '='.repeat(80));
    console.log('?? GoGon Configuration Validation');
    console.log('='.repeat(80));

    if (result.hasErrors()) {
        console.log('\n? CRITICAL ERRORS:\n');
        result.errors.forEach(err => console.log(err + '\n'));
    }

    if (result.hasWarnings()) {
        console.log('\n??  WARNINGS:\n');
        result.warnings.forEach(warn => console.log(warn + '\n'));
    }

    if (result.info.length > 0 && getBooleanSetting('GG_DEBUG')) {
        console.log('\n??  INFORMATION:\n');
        result.info.forEach(info => console.log(info + '\n'));
    }

    if (!result.hasErrors() && !result.hasWarnings()) {
        console.log('\n? All critical and important configurations are valid!');
    }

    console.log('='.repeat(80) + '\n');
}

/**
 * Validates configuration and exits if critical errors found
 * @param {boolean} exitOnError - Whether to exit process on critical errors (default: true)
 * @returns {boolean} True if validation passed, false otherwise
 */
export function validateAndExit(exitOnError = true) {
    const result = validateConfig();
    printValidationResults(result);

    if (result.hasErrors()) {
        console.error('? Configuration validation failed. Please fix the errors above and restart.\n');
        if (exitOnError) {
            process.exit(1);
        }
        return false;
    }

    return true;
}

/**
 * Gets a summary of configuration status
 * @returns {object} Configuration summary
 */
export function getConfigSummary() {
    const result = validateConfig();
    return {
        valid: result.valid,
        errors: result.errors.length,
        warnings: result.warnings.length,
        info: result.info.length,
        details: {
            errors: result.errors,
            warnings: result.warnings,
            info: result.info
        }
    };
}
