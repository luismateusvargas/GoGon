// discordBot.mjs - GoGon Discord Bot Setup
import { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    Events 
} from 'discord.js';

// Guide module is disabled (Cloudflare bot detection)
// import { guideCommand, handleGuideInteraction, handleGuideComponent } from './discord_modules/guide.js';

import { handleGvgCooldownInteraction } from './discord_modules/gvg.js';
import { handleBuffInteraction, handleBeBuffInteraction, handleCheckBuffsInteraction } from './discord_modules/buffs.js';

// The running client, so the control plane can rebind the Discord subsystem (CTRL-TASK-003/005).
let activeClient = null;

/** Logs the current client out, if any. */
export async function stopDiscord() {
    const client = activeClient;
    activeClient = null;
    if (client) await client.destroy();
}

/**
 * Restarts only the Discord subsystem with fresh settings (reloadMode: subsystem-rebind).
 * @returns {Promise<boolean>} False when the Discord settings are incomplete (the bot stays stopped).
 */
export async function restartDiscord(token, appId, guildId) {
    await stopDiscord();
    if (!token || !appId || !guildId) {
        console.warn('[GoGon] Discord settings incomplete; the Discord bot is stopped.');
        return false;
    }
    await setupDiscord(token, appId, guildId);
    return true;
}

export async function setupDiscord(token, appId, guildId) {
    console.log('[GoGon] 🔧 Setting up Discord client...');
    
    const client = new Client({ 
        intents: [GatewayIntentBits.Guilds] 
    });
    
    const rest = new REST({ version: '10' }).setToken(token);

    // --- Command Definitions ---
    console.log('[GoGon] 📝 Defining slash commands...');

    const buffCmd = new SlashCommandBuilder()
        .setName('buff')
        .setDescription('Cast buffs on a FallenSword character.')
        .addStringOption(o => o.setName('target').setDescription('Character Name(s), comma separated').setRequired(true))
        .addStringOption(o => o.setName('buffs').setDescription('Buff name(s) or keyword (PVP, TITAN)').setRequired(true));

    const beBuffCmd = new SlashCommandBuilder()
        .setName('bebuff')
        .setDescription('Uses BE potions and then casts buffs on a target.')
        .addStringOption(o => o.setName('target').setDescription('Character Name(s), comma separated').setRequired(true))
        .addStringOption(o => o.setName('buffs').setDescription('Buff name(s) or keyword (PVP, TITAN)').setRequired(true));
        
    const checkBuffsCmd = new SlashCommandBuilder()
        .setName('checkbuffs')
        .setDescription('Checks the active buffs on a FallenSword character.')
        .addStringOption(o => o.setName('username').setDescription('The character name to check').setRequired(true));

    const gvgCmd = new SlashCommandBuilder()
        .setName('gvgcooldown')
        .setDescription('Shows the current GvG cooldown timer.');

    // --- Command Registration ---
    console.log('[GoGon] 📡 Registering slash commands with Discord...');
    
    try {
        await rest.put(
            Routes.applicationGuildCommands(appId, guildId),
            { body: [
                buffCmd.toJSON(),
                beBuffCmd.toJSON(),
                checkBuffsCmd.toJSON(),
                // guideCommand.toJSON(), // DISABLED - Cloudflare blocking
                gvgCmd.toJSON()
            ] }
        );
        console.log('[GoGon] ✅ Slash commands registered successfully');
    } catch (error) {
        console.error('[GoGon] ❌ Failed to register slash commands:', error);
        throw error;
    }

    // --- Event Handlers ---
    client.on(Events.InteractionCreate, async (interaction) => {
        // Handle Component Interactions (Buttons, etc.)
        if (!interaction.isChatInputCommand()) {
            // Guide component interactions disabled
            // if (interaction.customId?.startsWith('guide:')) {
            //     await handleGuideComponent(interaction);
            // }
            return;
        }

        // Handle Slash Command Interactions
        const { commandName } = interaction;

        try {
            if (commandName === 'buff') {
                await handleBuffInteraction(interaction);
            } else if (commandName === 'bebuff') {
                await handleBeBuffInteraction(interaction);
            } else if (commandName === 'checkbuffs') {
                await handleCheckBuffsInteraction(interaction);
            } else if (commandName === 'gvgcooldown') {
                await handleGvgCooldownInteraction(interaction);
            }
        } catch (error) {
            console.error(`[GoGon] ❌ Error handling command ${commandName}:`, error);
            const errorMessage = '❌ An error occurred while processing your command. Please try again.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMessage).catch(console.error);
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true }).catch(console.error);
            }
        }
    });

    client.on(Events.ClientReady, () => {
        console.log(`[GoGon] ✅ Discord bot logged in as ${client.user.tag}`);
    });

    client.on(Events.Error, (error) => {
        console.error('[GoGon] ❌ Discord client error:', error);
    });

    // --- Login ---
    console.log('[GoGon] 🔑 Logging in to Discord...');
    await client.login(token);
    activeClient = client;
    
    return client;
}