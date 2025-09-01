import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { ensureLogin } from './session.mjs';
import { secureFetch } from './utils.js'; // já existe no seu utils.js (versão Node)

/** Mapeie suas skills aqui (preenchimento seu) */
const SKILLS = {
  // exemplo: "AL": 140, "Conserve": 191, ...
};

async function registerCommands(appId, token, guildId) {
  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [
    new SlashCommandBuilder()
      .setName('buff')
      .setDescription('Casta um buff no jogador alvo.')
      .addStringOption(o => o.setName('alvo').setDescription('Nome do jogador').setRequired(true))
      .addStringOption(o => o.setName('skill').setDescription('Nome da skill (ex.: AL)').setRequired(true))
      .addIntegerOption(o => o.setName('minutos').setDescription('Duração em minutos (opcional)'))
      .toJSON(),
  ];

  // Registra como Guild Command (propaga rápido)
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
}

async function castBuff(targetName, skillName, minutes) {
  // 1) Garantir sessão válida
  await ensureLogin();

  // 2) Resolver skillId
  const skillId = SKILLS[skillName] ?? null;
  if (!skillId) throw new Error(`Skill desconhecida: ${skillName}`);

  // 3) (Exemplo) Descobrir playerId pelo nome — ajuste para o endpoint real:
  //    Você precisa adaptar conforme as páginas do Fallen Sword:
  //    - Buscar o perfil pelo nome e extrair playerId
  const searchResp = await secureFetch(`/index.php?cmd=players&subcmd=view&search_name=${encodeURIComponent(targetName)}`);
  const html = await searchResp.text();

  // TODO: parsear o HTML para achar playerId (use linkedom se preferir)
  // Exemplo fictício:
  const m = html.match(/data-player-id="(\d+)"/);
  if (!m) throw new Error(`Não encontrei o jogador "${targetName}"`);
  const playerId = m[1];

  // 4) Obter token CSRF/form da página de cast (ajuste pro endpoint real)
  const castPage = await secureFetch(`/index.php?cmd=skills&subcmd=cast&player_id=${playerId}`);
  const castHtml = await castPage.text();
  const token = (castHtml.match(/name="token" value="([^"]+)"/) || [])[1];
  if (!token) throw new Error('Token CSRF não encontrado (ajuste seletores).');

  // 5) Enviar POST para castar a skill (ajuste a URL/parametros REAIS do jogo)
  const form = new URLSearchParams();
  form.set('token', token);
  form.set('skill_id', String(skillId));
  if (minutes) form.set('minutes', String(minutes));
  form.set('player_id', String(playerId));

  const r = await secureFetch('/index.php?cmd=skills&subcmd=cast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const respText = await r.text();

  // 6) Heurística de sucesso/erro — ajuste a mensagem/seletores do jogo
  if (/success|casted|buff applied/i.test(respText)) {
    return { ok: true, playerId };
  }
  // tente extrair mensagem de erro do HTML:
  const errMsg = (respText.match(/<div class="error">([\s\S]*?)<\/div>/i) || [])[1] || `HTTP ${r.status}`;
  return { ok: false, playerId, err: errMsg.trim() };
}

export async function startDiscordBot() {
  const token  = process.env.DISCORD_TOKEN;
  const appId  = process.env.DISCORD_APP_ID;
  const guildId= process.env.DISCORD_GUILD_ID;
  if (!token || !appId || !guildId) {
    throw new Error('Defina DISCORD_TOKEN, DISCORD_APP_ID e DISCORD_GUILD_ID.');
  }

  await registerCommands(appId, token, guildId);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('clientReady', () => {
    console.log(`Discord bot logado como ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'buff') return;

    const alvo = interaction.options.getString('alvo', true);
    const skill = interaction.options.getString('skill', true);
    const minutos = interaction.options.getInteger('minutos', false);

    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await castBuff(alvo, skill, minutos);
      if (res.ok) {
        await interaction.editReply(`✅ Buff **${skill}** aplicado em **${alvo}** (id ${res.playerId}).`);
      } else {
        await interaction.editReply(`❌ Falha ao aplicar **${skill}** em **${alvo}**: ${res.err}`);
      }
    } catch (e) {
      await interaction.editReply(`❌ Erro: ${e.message}`);
    }
  });

  await client.login(token);
}
