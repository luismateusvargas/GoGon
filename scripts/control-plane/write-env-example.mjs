// scripts/control-plane/write-env-example.mjs - CTRL-TASK-001
// Regenerates .env.example from config/registry.mjs, with placeholders only.
// It never reads .env. Usage: node scripts/control-plane/write-env-example.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DEFINITIONS, SECTIONS } from '../../config/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLACEHOLDERS = {
    GG_EMAIL: 'your_email@example.com',
    GG_PASSWORD: 'your_game_password',
    GG_BOT_CHARACTER: 'YourBotName',
    GG_BOT_ID_CHARACTER: '123456',
    GG_DISCORD_TOKEN: 'your_discord_bot_token',
    GG_DISCORD_APP_ID: '123456789012345678',
    GG_DISCORD_GUILD_ID: '123456789012345678',
    GG_ADMIN_USERNAME: 'owner',
    GG_ADMIN_PASSWORD_HASH: '# run: node scripts/control-plane/hash-password.mjs',
    GG_CONTROL_SESSION_SECRET: '# run: node scripts/control-plane/generate-secrets.mjs',
    GG_CONTROL_ENCRYPTION_KEY: '# run: node scripts/control-plane/generate-secrets.mjs',
};

export function renderEnvExample() {
    const lines = [
        '# GoGon configuration template (CTRL-TASK-001). Copy to .env and fill in real values.',
        '# Generated from config/registry.mjs by scripts/control-plane/write-env-example.mjs; do not edit by hand.',
        '# Legacy SWS_/FS_ names still work as fallbacks, but GG_ names win.',
        '# reloadMode: hot = dashboard change applies next run; subsystem-rebind = restarts that subsystem;',
        '# controlled-session-switch = use dashboard account profiles; bootstrap = .env only.',
        '',
    ];
    for (const [section, title] of Object.entries(SECTIONS)) {
        const defs = CONFIG_DEFINITIONS.filter(d => d.section === section);
        if (!defs.length) continue;
        lines.push(`# --- ${title} ---`);
        for (const d of defs) {
            lines.push(`# ${d.label}. ${d.description} [${d.sensitivity}, ${d.reloadMode}${d.default ? `, default ${d.default}` : ''}]`);
            const placeholder = PLACEHOLDERS[d.key];
            if (placeholder?.startsWith('#')) {
                lines.push(`${placeholder}`, `${d.key}=`);
            } else if (placeholder) {
                lines.push(`${d.key}=${placeholder}`);
            } else {
                lines.push(`# ${d.key}=${d.default}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    fs.writeFileSync(path.join(ROOT, '.env.example'), renderEnvExample());
    console.log('Wrote .env.example');
}
