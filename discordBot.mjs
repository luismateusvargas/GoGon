// app_modules/discordBot.mjs
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { ensureLogin } from './session.mjs';
import { secureFetch } from './utils.js';
import { guideCommand, handleGuideInteraction, handleGuideComponent } from './discord_modules/guide.js';
import { handleGvgCooldownInteraction } from './discord_modules/gvg.js';
// Import the new handler for /checkbuffs
import { handleBuffInteraction, handleBeBuffInteraction, handleCheckBuffsInteraction } from './discord_modules/buffs.js';

export async function setupDiscord(token, appId, guildId) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const rest = new REST({ version: '10' }).setToken(token);

    // --- Command Definitions ---

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
        
    // Definition for the new /checkbuffs command
    const checkBuffsCmd = new SlashCommandBuilder()
        .setName('checkbuffs')
        .setDescription('Checks the active buffs on a FallenSword character.')
        .addStringOption(o => o.setName('username').setDescription('The character name to check').setRequired(true));

    const gvgCmd = new SlashCommandBuilder()
        .setName('gvgcooldown')
        .setDescription('Shows the current GvG cooldown timer.');

    // --- Command Registration ---
    
    // Add the new command to the registration list
    await rest.put(
        Routes.applicationGuildCommands(appId, guildId),
        { body: [
            buffCmd.toJSON(),
            beBuffCmd.toJSON(),
            checkBuffsCmd.toJSON(),
            guideCommand.toJSON(),
            gvgCmd.toJSON()
        ] }
    );

    client.on(Events.InteractionCreate, async (interaction) => {
        // Handle Component Interactions (Buttons, etc.)
        if (!interaction.isChatInputCommand()) {
            if (interaction.customId?.startsWith('guide:')) {
                await handleGuideComponent(interaction);
            }
            return;
        }

        // Handle Slash Command Interactions
        const { commandName } = interaction;

        if (commandName === 'buff') {
            await handleBuffInteraction(interaction);
        } else if (commandName === 'bebuff') {
            await handleBeBuffInteraction(interaction);
        } else if (commandName === 'checkbuffs') { // Add router logic for the new command
            await handleCheckBuffsInteraction(interaction);
        } else if (commandName === 'guide') {
            await handleGuideInteraction(interaction);
        } else if (commandName === 'gvgcooldown') {
            await handleGvgCooldownInteraction(interaction);
        }
    });

    await client.login(token);
    return client;
}