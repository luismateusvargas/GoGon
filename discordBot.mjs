// app_modules/discordBot.mjs (slash /buff com QuickBuff + meta-buffs)
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { ensureLogin } from './session.mjs';
import { secureFetch } from './utils.js';

const NAME_TO_ID = {"great vigor": 12, "absorb": 13, "evade": 10, "fortify": 8, "enchanted armor": 9, "rock skin": 11, "aura of protection": 15, "deflect": 14, "force shield": 27, "unbreakable": 28, "assist": 36, "honor": 82, "constitution": 37, "counter attack": 54, "summon shield imp": 55, "fortitude": 57, "vision": 56, "flinch": 58, "nightmare visage": 60, "terrorize": 59, "sanctuary": 44, "dull edge": 46, "erosion": 80, "avert gaze": 71, "enchant shield": 77, "smite": 97, "balanced defense": 117, "bastion": 122, "side step": 86, "high guard": 96, "barricade": 98, "coordinated defense": 119, "degrade": 121, "retaliate": 123, "shame": 110, "dispel curse": 114, "anchored": 154, "hardened": 153, "armor boost": 136, "shield wall": 135, "layered armor": 170, "aegis shield": 181, "defensive aura": 171, "fumble": 172, "allied frenzy": 145, "healer": 178, "stalwart heart": 183, "rage": 0, "stun": 1, "bloodthirst": 4, "enchant weapon": 5, "fury": 2, "berserk": 3, "holy flame": 6, "dark curse": 7, "ignite": 30, "shockwave": 29, "super elite slayer": 31, "wither": 32, "deathwish": 34, "shatter armor": 33, "spell breaker": 35, "keen edge": 47, "spectral knight": 48, "arterial strike": 49, "death dealer": 50, "savagery": 51, "chi strike": 52, "shield strike": 53, "demoralize": 73, "poison": 70, "iron fist": 74, "spell leech": 79, "distraction": 78, "coordinated attack": 118, "undermine": 108, "cursed rune": 89, "anti deflect": 105, "overkill": 109, "smashing hammer": 111, "mighty vigor": 113, "fist fight": 115, "cursed ring": 88, "sharpen": 106, "balanced attack": 116, "heavy weight": 146, "armored strike": 130, "invert": 173, "relentless": 179, "reign of terror": 174, "critical strike": 175, "guild berserker": 155, "avenger": 180, "deep pockets": 22, "find item": 16, "quest finder": 61, "treasure hunter": 17, "adept learner": 19, "defiance": 18, "librarian": 20, "merchant": 21, "last ditch": 23, "animal magnetism": 24, "doubler": 26, "empower": 25, "brewing master": 40, "conserve": 39, "four leaf": 41, "extend": 42, "extractor": 63, "inventor": 62, "buff master": 65, "inventor ii": 64, "reflection": 66, "guild buffer": 160, "light foot": 67, "mesmerize": 68, "resource finder": 76, "quest hunter": 166, "gloat": 81, "sacrifice": 75, "reckoning": 72, "reinforce": 126, "bodyguard": 120, "riposte": 124, "severe condition": 101, "sealed": 112, "righteous": 107, "epic forge": 102, "golden shield": 103, "stalker": 125, "ageless": 100, "extractor ii": 104, "epic craft": 159, "gold foot": 137, "titan doubler": 167, "all for one": 161, "teleport": 168, "invigorate": 169, "gambler": 177};
const ID_TO_NAME = {"12": "Great Vigor", "13": "Absorb", "10": "Evade", "8": "Fortify", "9": "Enchanted Armor", "11": "Rock Skin", "15": "Aura of Protection", "14": "Deflect", "27": "Force Shield", "28": "Unbreakable", "36": "Assist", "82": "Honor", "37": "Constitution", "54": "Counter Attack", "55": "Summon Shield Imp", "57": "Fortitude", "56": "Vision", "58": "Flinch", "60": "Nightmare Visage", "59": "Terrorize", "44": "Sanctuary", "46": "Dull Edge", "80": "Erosion", "71": "Avert Gaze", "77": "Enchant Shield", "97": "Smite", "117": "Balanced Defense", "122": "Bastion", "86": "Side Step", "96": "High Guard", "98": "Barricade", "119": "Coordinated Defense", "121": "Degrade", "123": "Retaliate", "110": "Shame", "114": "Dispel Curse", "154": "Anchored", "153": "Hardened", "136": "Armor Boost", "135": "Shield Wall", "170": "Layered Armor", "181": "Aegis Shield", "171": "Defensive Aura", "172": "Fumble", "145": "Allied Frenzy", "178": "Healer", "183": "Stalwart Heart", "0": "Rage", "1": "Stun", "4": "Bloodthirst", "5": "Enchant Weapon", "2": "Fury", "3": "Berserk", "6": "Holy Flame", "7": "Dark Curse", "30": "Ignite", "29": "Shockwave", "31": "Super Elite Slayer", "32": "Wither", "34": "Deathwish", "33": "Shatter Armor", "35": "Spell Breaker", "47": "Keen Edge", "48": "Spectral Knight", "49": "Arterial Strike", "50": "Death Dealer", "51": "Savagery", "52": "Chi Strike", "53": "Shield Strike", "73": "Demoralize", "70": "Poison", "74": "Iron Fist", "79": "Spell Leech", "78": "Distraction", "118": "Coordinated Attack", "108": "Undermine", "89": "Cursed Rune", "105": "Anti Deflect", "109": "Overkill", "111": "Smashing Hammer", "113": "Mighty Vigor", "115": "Fist Fight", "88": "Cursed Ring", "106": "Sharpen", "116": "Balanced Attack", "146": "Heavy Weight", "130": "Armored Strike", "173": "Invert", "179": "Relentless", "174": "Reign of Terror", "175": "Critical Strike", "155": "Guild Berserker", "180": "Avenger", "22": "Deep Pockets", "16": "Find Item", "61": "Quest Finder", "17": "Treasure Hunter", "19": "Adept Learner", "18": "Defiance", "20": "Librarian", "21": "Merchant", "23": "Last Ditch", "24": "Animal Magnetism", "26": "Doubler", "25": "Empower", "40": "Brewing Master", "39": "Conserve", "41": "Four Leaf", "42": "Extend", "63": "Extractor", "62": "Inventor", "65": "Buff Master", "64": "Inventor II", "66": "Reflection", "160": "Guild Buffer", "67": "Light Foot", "68": "Mesmerize", "76": "Resource Finder", "166": "Quest Hunter", "81": "Gloat", "75": "Sacrifice", "72": "Reckoning", "126": "Reinforce", "120": "Bodyguard", "124": "Riposte", "101": "Severe Condition", "112": "Sealed", "107": "Righteous", "102": "Epic Forge", "103": "Golden Shield", "125": "Stalker", "100": "Ageless", "104": "Extractor II", "159": "Epic Craft", "137": "Gold Foot", "167": "Titan Doubler", "161": "All For One", "168": "Teleport", "169": "Invigorate", "177": "Gambler"};
const META_NAMES = ['Extend','Reinforce','Buff Master','Guild Buffer'];
const META_IDS = [42, 126, 65, 160];
const PVP_IDS = [12,9,13,14,27,28,82,37,57,58,59,44,80,77,97,86,96,119,121,123,110,114,154,136,135,170,171,172,178,183,0,1,4,5,2,7,30,
29,32,33,35,47,51,52,73,70,74,118,108,89,105,111,88,106,175,180,23,25,39,66,81,72,124,112,102,103,100,159,161];
const ALL_IDS = [12,13,10,8,9,11,15,14,27,28,36,82,37,54,55,57,56,58,60,59,44,46,80,71,77,97,117,122,86,96,98,119,121,123,110,114,154,153,136,135,170,181,171,172,145,178,183,0,1,4,5,2,3,6,7,30,29,31,32,34,33,35,47,48,49,50,51,52,53,73,70,74,79,78,118,108,89,105,109,111,113,115,88,106,116,146,130,173,179,174,175,155,180,22,16,61,17,19,18,20,21,23,24,26,25,40,39,41,42,63,62,65,64,66,160,67,68,76,166,81,75,72,126,120,124,101,112,107,102,103,125,100,104,159,137,167,161,168,169,177
];

function normName(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function resolveBuffIds(input) {
  if (!input) return [];
  const raw = input.split(',').map(x => x.trim()).filter(Boolean);
  if (raw.length === 1 && normName(raw[0]) === 'pvp') return Array.from(new Set(PVP_IDS));
  else if (raw.length === 1 && normName(raw[0]) === 'all') return Array.from(new Set(ALL_IDS));
  const out = [];
  for (const token of raw) {
    if (/^\d+$/.test(token)) { out.push(parseInt(token,10)); continue; }
    const id = NAME_TO_ID[normName(token)];
    if (id) { out.push(id); continue; }
    const key = Object.keys(NAME_TO_ID).find(k => k.startsWith(normName(token)));
    if (key) out.push(NAME_TO_ID[key]);
  }
  return Array.from(new Set(out));
}

/* async function getSelfName() {
  const resp = await secureFetch('https://www.fallensword.com/index.php?cmd=profile');
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const h1 = doc.querySelector('#profileRightColumn h1, #profileLeftColumn h1, h1');
  if (h1) return h1.textContent.trim().replace(/\s+\[.*?\]$/, '').trim();
  const t = (doc.querySelector('title')?.textContent || '').trim();
  const m = /Profile\s*-\s*(.+)$/i.exec(t);
  if (m) return m[1].trim();
  return '';
} */

async function getActiveCasterBuffs() {
  const resp = await secureFetch('https://www.fallensword.com/index.php?cmd=profile');
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const active = new Set();
  const imgs = doc.querySelectorAll('img[data-tipped]');
  imgs.forEach(img => {
    const tip = img.getAttribute('data-tipped') || '';
    if (!tip) return;
    try {
      const tipDoc = new DOMParser().parseFromString(tip, 'text/html');
      const name = tipDoc.querySelector('span > b')?.textContent?.trim();
      if (name) active.add(normName(name));
    } catch { }
  });
  return active;
}

async function quickBuff(target, skillIds) {
  if (!skillIds?.length) return { ok: true, html: '' };
  const params = new URLSearchParams();
  params.set('cmd','quickbuff');
  params.set('subcmd','activate');
  params.set('targetPlayers', target);
  params.set('add','');
  for (const id of skillIds) params.append('skills[]', String(id));
  const url = 'https://www.fallensword.com/index.php?' + params.toString();
  const resp = await secureFetch(url);
  const html = await resp.text();
  return { ok: resp.status === 200, html, url };
}

async function ensureMetaBuffs() {
  const selfName = process.env.SWS_BOT_CHARACTER;
  const active = await getActiveCasterBuffs();
  const missing = META_NAMES.map((name, idx) => [name, META_IDS[idx]])
    .filter(([name, id]) => !!id && !active.has(normName(name)))
    .map(([name, id]) => id);
  if (!missing.length) return { applied: [], selfName };
  const res = await quickBuff(selfName, missing);
  return { applied: missing, selfName, res };
}

export async function setupDiscord(token, appId, guildId) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const rest = new REST({ version: '10' }).setToken(token);
  const cmd = new SlashCommandBuilder()
    .setName('buff')
    .setDescription('Cast buffs on FallenSword')
    .addStringOption(o => o.setName('target').setDescription('Character Name').setRequired(true))
    .addStringOption(o => o.setName('buffs').setDescription('Buff name separated by (,) or "PVP"').setRequired(true));
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [cmd.toJSON()] });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'buff') return;
    await interaction.deferReply({ ephemeral: false });
    try {
      await ensureLogin();
      const target = interaction.options.getString('target', true).trim();
      const buffsArg = interaction.options.getString('buffs', true).trim();

      const meta = await ensureMetaBuffs();
      const skillIds = resolveBuffIds(buffsArg);
      if (!skillIds.length) {
        await interaction.editReply(`❌ No buff found at: \`${buffsArg}\`. Check name (separate by comma (,)) or use \`PVP\`.`);
        return;
      }

      const res = await quickBuff(target, skillIds);

      const names = skillIds.map(id => ID_TO_NAME[String(id)] || `#${id}`);
      const metaNames = (meta.applied || []).map(id => ID_TO_NAME[String(id)] || `#${id}`);
      const summary = [
        `🎯 Target: **${target}**`,
        meta.applied?.length ? `🧪 Meta-buffs applied in **${meta.selfName || 'caster'}**: ${metaNames.join(', ')}` : '🧪 Meta-buffs: already active',
        `✨ Buffs: ${names.join(', ')}`,
        res.ok ? '✅ Buff cast' : '⚠️ Buff failed or already active',
      ].join('\n');

      await interaction.editReply(summary);
    } catch (e) {
      await interaction.editReply('❌ Command failed. Check logs.');
      console.error('slash /buff error:', e);
    }
  });

  await client.login(token);
  return client;
}
