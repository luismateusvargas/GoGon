// discord_modules/guide.js
import { LOG, WARN, ERR } from '../app_modules/core.js';
import { secureFetchExternal as _secureFetchExternal } from '../utils.js';
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as cheerio from 'cheerio';

const BASE = 'https://guide.fallensword.com/index.php';

export const TAB_CMD = {
  items: 'items', item: 'items',
  creatures: 'creatures', creature: 'creatures',
  quests: 'quests', quest: 'quests',
  realms: 'realms',
  'master-realms': 'masterrealms',
  relics: 'relics', relic: 'relics',
  shops: 'shops', shop: 'shops',
};

export const guideCommand = new SlashCommandBuilder()
  .setName('guide')
  .setDescription('Search the Fallen Sword Guide with interactive menus.')
  .addStringOption(o =>
    o.setName('search')
     .setDescription('Guide Section (items, creatures, etc.)')
     .setRequired(true)
     .addChoices(
       { name: 'Items', value: 'items' },
       { name: 'Creatures', value: 'creatures' },
       { name: 'Quests', value: 'quests' },
       { name: 'Realms', value: 'realms' },
       { name: 'Master Realms', value: 'master-realms' },
       { name: 'Relics', value: 'relics' },
       { name: 'Shops', value: 'shops' },
     ));

// --- Networking & Parsing Helpers ---

async function extFetch(url, options = {}) {
  try {
    if (typeof _secureFetchExternal === 'function') return await _secureFetchExternal(url, options);
  } catch {}
  return await fetch(url, options);
}

function urlWith(params) {
  const u = new URL(BASE);
  for (const [k,v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

async function getText(url) {
  const res = await extFetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function postForm(params) {
  const body = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) body.set(k, v === undefined ? '' : String(v));
  const res = await extFetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function decodeHtml(s = '') {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&#39;/g,"'").replace(/&quot;/g,'"');
}

function parseForm(html) {
  const $ = cheerio.load(html);
  const form = $('form').first();
  const inputs = [];

  form.find('input, select, textarea').each((i, el) => {
    const element = $(el);
    const tag = el.tagName.toLowerCase();
    const name = element.attr('name');
    if (!name) return;

    if (tag === 'select') {
      const values = [];
      element.find('option').each((j, opt) => {
        const option = $(opt);
        const value = option.attr('value');
        const label = decodeHtml(option.text().trim());
        if (label && (value !== null && value !== undefined)) {
          values.push({
            value: value === '' ? '__EMPTY__' : value,
            label: label.slice(0, 100),
          });
        }
      });
      inputs.push({ tag, name, type: 'select', values });
    } else if (tag === 'input') {
      const typeAttr = element.attr('type');
      const isCheckbox = typeAttr === 'checkbox';
      const isNumber = typeAttr === 'number' || typeAttr === 'range';
      inputs.push({ tag, name, type: isCheckbox ? 'checkbox' : (isNumber ? 'number' : 'text') });
    } else if (tag === 'textarea') {
      inputs.push({ tag, name, type: 'text' });
    }
  });

  const skip = new Set(['cmd', 'subcmd', 'page', 'ajax', 'submit', 'csrf_token', 'token']);
  return { inputs: inputs.filter(i => !skip.has(i.name)) };
}

function summarizeDetail(html) {
  const $ = cheerio.load(html);
  const title = decodeHtml($('h1').first().text() || $('title').first().text() || 'Detail');
  const pcc = $('#pCC');
  const contentClone = pcc.clone();
  contentClone.find('script, style, form, .inventory-panel').remove();
  let text = contentClone.text().replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 3500) text = text.slice(0, 3500) + '...';
  return { title, text };
}

// --- Session Management ---
const SESSIONS = new Map();
function newSession(payload) { const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`; SESSIONS.set(id, { ...payload, page: 0, values: {}, results: [] }); return id; }
function getSession(id) { return SESSIONS.get(id); }
function dropSession(id) { SESSIONS.delete(id); }

// --- UI Building & Parsers ---

function buildSearchParams(session) {
    const params = { cmd: TAB_CMD[session.tab] || session.tab };
    const settable = new Set(session.inputs.map(i => i.name));
    for (const [k,v] of Object.entries(session.values || {})) if (settable.has(k) && v) params[k] = v;
    return params;
}

function extractItemPreviews(html) {
    const $ = cheerio.load(html);
    const items = [];
    $('table[width="800"]').first().find('tr').each((i, row) => {
        const $row = $(row);
        if ($row.find('td.tHeader').length > 0) return;
        const cells = $row.find('td');
        if (cells.length < 9) return; 
        const nameLink = cells.eq(0).find('a');
        const item = {
            name: decodeHtml(nameLink.text().trim()),
            url: new URL(nameLink.attr('href'), BASE).toString(),
            level: cells.eq(1).text().trim(),
            type: cells.eq(2).text().trim(),
            rarity: cells.eq(3).text().trim(),
            attack: cells.eq(4).text().trim(),
            defense: cells.eq(5).text().trim(),
            armor: cells.eq(6).text().trim(),
            damage: cells.eq(7).text().trim(),
            hp: cells.eq(8).text().trim(),
        };
        if (item.name) items.push(item);
    });
    return items;
}

function extractCreaturePreviews(html) {
    const $ = cheerio.load(html);
    const creatures = [];
    $('table[width="800"]').first().find('tr').each((i, row) => {
        const $row = $(row);
        if ($row.find('td.tHeader').length > 0) return;
        const cells = $row.find('td');
        if (cells.length < 8) return;
        const nameLink = cells.eq(0).find('a');
        const creature = {
            name: decodeHtml(nameLink.text().trim()),
            url: new URL(nameLink.attr('href'), BASE).toString(),
            class: cells.eq(1).text().trim(),
            level: cells.eq(2).text().trim(),
            attack: cells.eq(3).text().trim(),
            defense: cells.eq(4).text().trim(),
            armor: cells.eq(5).text().trim(),
            damage: cells.eq(6).text().trim(),
            hp: cells.eq(7).text().trim(),
        };
        if (creature.name) creatures.push(creature);
    });
    return creatures;
}

// --- NEW PARSER FOR MASTER REALMS ---
function extractMasterRealmsPreviews(html) {
    const $ = cheerio.load(html);
    const realms = [];
    $('table[width="800"]').first().find('tr').each((i, row) => {
        const $row = $(row);
        if ($row.find('td.tHeader').length > 0) return;
        if ($row.find('td[colspan]').length > 0) return;
        const cells = $row.find('td');
        if (cells.length < 2) return;
        const nameLink = cells.eq(0).find('a');
        const name = decodeHtml(nameLink.text().trim());
        if (!name) return;
        const realm = {
            name: name,
            url: new URL(nameLink.attr('href'), BASE).toString(),
            minLevel: cells.eq(1).text().trim(),
        };
        realms.push(realm);
    });
    return realms;
}

function extractGenericPreviews(html) {
    const $ = cheerio.load(html);
    const results = [];
    $('table[width="800"]').first().find('tr').each((i, row) => {
        const $row = $(row);
        if ($row.find('td.tHeader').length > 0) return;
        if ($row.find('td[colspan]').length > 0) return;
        const cells = $row.find('td');
        if (cells.length < 1) return;
        const nameLink = cells.eq(0).find('a');
        const name = decodeHtml(nameLink.text().trim());
        if (!name || name.length < 2) return;
        const result = {
            name: name,
            url: new URL(nameLink.attr('href'), BASE).toString(),
            details: cells.slice(1).get().map(cell => $(cell).text().trim())
        };
        results.push(result);
    });
    return results;
}

function buildResultsDisplay(sessionId, session) {
    const { results = [], page = 0, tab } = session;
    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(results.length / ITEMS_PER_PAGE);
    const currentPageItems = results.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

    const embed = new EmbedBuilder()
        .setTitle(`Search Results for ${tab} (Page ${page + 1} of ${totalPages})`)
        .setColor('#ebd2ab')
        .setFooter({ text: `${results.length} total items found.` });

    if (currentPageItems.length === 0) {
        embed.setDescription('No results found for this page.');
    }

    currentPageItems.forEach(item => {
        let name = '';
        let value = '';

        // --- NEW: Helper function to create the multi-line stat block with icons ---
        const formatStats = (item) => {
            const lines = [];
            const atk = item.attack && item.attack !== '0' ? `⚔️ Atk: **${item.attack}**` : null;
            const def = item.defense && item.defense !== '0' ? `🛡️ Def: **${item.defense}**` : null;
            const arm = item.armor && item.armor !== '0' ? `🧱 Arm: **${item.armor}**` : null;
            const dmg = item.damage && item.damage !== '0' ? `🔥 Dmg: **${item.damage}**` : null;
            const hp = item.hp && item.hp !== '0' ? `❤️ HP: **${item.hp}**` : null;

            const line1 = [atk, def].filter(Boolean).join('    '); // Join with spaces for alignment
            const line2 = [arm, dmg].filter(Boolean).join('    ');

            if (line1) lines.push(line1);
            if (line2) lines.push(line2);
            if (hp) lines.push(hp);
            
            return lines.length > 0 ? lines.join('\n') : '';
        };

        switch (tab) {
            case 'items':
                name = `🏆 ${item.name} | ${item.type} (Lvl ${item.level})`;
                const itemStatBlock = formatStats(item);
                value = `**Rarity:** ${item.rarity}\n${itemStatBlock}`;
                break;
            
            case 'creatures':
                name = `💀 ${item.name} (Lvl ${item.level})`;
                const creatureStatBlock = formatStats(item);
                value = `*${item.class}*\n${creatureStatBlock}`;
                break;

            case 'master-realms':
                name = `🗺️ ${item.name}`;
                value = `**Min Level:** ${item.minLevel}`;
                break;
            
            default: // Generic for quests, shops, relics, realms
                name = `🧭 ${item.name}`;
                value = item.details.join(' | ') || 'No additional details.';
                break;
        }

        embed.addFields({ name, value, inline: false });
    });
    
    const selectMenu = new StringSelectMenuBuilder().setCustomId(`guide:pick:${sessionId}`).setPlaceholder('Select a result to view full details...');
    if (currentPageItems.length > 0) {
        selectMenu.addOptions(currentPageItems.map(item => ({
            label: item.name.slice(0, 100),
            value: item.url.slice(0, 100),
            description: `Level ${item.level || ''}`.slice(0,100)
        })));
    } else {
        selectMenu.addOptions({ label: 'No items to select', value: 'no_items' }).setDisabled(true);
    }
    
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`guide:result_page:${sessionId}:prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`guide:back_to_filters:${sessionId}`).setLabel('Back to Filters').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`guide:result_page:${sessionId}:next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    );

    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu), controls] };
}

function buildFilterRows(sessionId, session) {
    const { page = 0, inputs = [], values = {} } = session;
    const rows = [];
    const DROPDOWNS_PER_PAGE = 3;
    const dropdownInputs = inputs.filter(i => i.type === 'select' || i.type === 'checkbox');
    const totalPages = Math.ceil(dropdownInputs.length / DROPDOWNS_PER_PAGE);
    const currentPageFields = dropdownInputs.slice(page * DROPDOWNS_PER_PAGE, (page + 1) * DROPDOWNS_PER_PAGE);

    for (const f of currentPageFields) {
        const options = (f.values || [{ value: '__EMPTY__', label: '(Any)' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' }])
            .map(opt => ({
                label: opt.label.slice(0, 100),
                value: String(opt.value).slice(0, 100)
            }));
        const menu = new StringSelectMenuBuilder().setCustomId(`guide:field:${sessionId}:${f.name}`).setPlaceholder(f.name.replace(/_/g, ' ')).addOptions(options.slice(0, 25));
        rows.push(new ActionRowBuilder().addComponents(menu));
    }

    const textInputFields = inputs.filter(i => i.type === 'text' || i.type === 'number');
    if (textInputFields.length > 0) {
        const currentValues = textInputFields.map(f => (values[f.name] ? `${f.name}: "${values[f.name]}"` : '')).filter(Boolean).join(', ');
        const textFiltersButton = new ButtonBuilder().setCustomId(`guide:modal:${sessionId}:show`).setLabel('Set Text & Number Filters').setStyle(ButtonStyle.Success);
        if(currentValues) textFiltersButton.setLabel(`Filters: ${currentValues.slice(0, 50)}...`);
        rows.push(new ActionRowBuilder().addComponents(textFiltersButton));
    }

    const controls = [];
    if (page > 0) controls.push(new ButtonBuilder().setCustomId(`guide:page:${sessionId}:prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary));
    controls.push(new ButtonBuilder().setCustomId(`guide:page:${sessionId}:search`).setLabel('🔎 Search').setStyle(ButtonStyle.Primary));
    if (page < totalPages - 1) controls.push(new ButtonBuilder().setCustomId(`guide:page:${sessionId}:next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary));
    controls.push(new ButtonBuilder().setCustomId(`guide:page:${sessionId}:reset`).setLabel('Reset').setStyle(ButtonStyle.Danger));
    rows.push(new ActionRowBuilder().addComponents(...controls));
    return rows;
}

// --- Interaction Handlers ---

export async function handleGuideInteraction(interaction) {
  try {
    const tab = interaction.options.getString('search', true).trim().toLowerCase();
    await interaction.deferReply({ ephemeral: false });
    const cmd = TAB_CMD[tab] || tab;
    const html = await getText(urlWith({ cmd }));
    const { inputs } = parseForm(html);
    const sessionId = newSession({ tab, inputs });
    await interaction.editReply({
      content: `🧭 **/guide** – *${tab}*\nUse the menus to apply filters, then click **Search**.`,
      components: buildFilterRows(sessionId, getSession(sessionId)),
    });
  } catch (err) {
    console.error('[guide] handleGuideInteraction error:', err);
    try { await interaction.editReply(`❌ Failed to start /guide session: ${err?.message || err}`); } catch {}
  }
}

export async function handleGuideComponent(interaction) {
  try {
    const sessionId = interaction.customId.split(':')[2];
    const s = getSession(sessionId);
    if (!s) return interaction.reply({ content: 'This interactive session has expired.', ephemeral: true });

    if (interaction.isButton() && interaction.customId.startsWith('guide:modal:')) {
      const modal = new ModalBuilder().setCustomId(`guide:modal:${sessionId}:submit`).setTitle(`Text/Number Filters for ${s.tab}`);
      const textInputFields = s.inputs.filter(i => i.type === 'text' || i.type === 'number');
      textInputFields.slice(0, 5).forEach(field => {
        const textInput = new TextInputBuilder().setCustomId(field.name).setLabel(field.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).setStyle(TextInputStyle.Short).setRequired(false).setValue(s.values[field.name] || '');
        modal.addComponents(new ActionRowBuilder().addComponents(textInput));
      });
      await interaction.showModal(modal);
      return; 
    }
    
    await interaction.deferUpdate();

    if (interaction.isModalSubmit() && interaction.customId.startsWith('guide:modal:')) {
        s.inputs.filter(i => i.type === 'text' || i.type === 'number').slice(0, 5).forEach(field => {
            const value = interaction.fields.getTextInputValue(field.name);
            s.values[field.name] = value;
        });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('guide:field:')) {
      const [, , , field] = interaction.customId.split(':');
      let selectedValue = interaction.values?.[0] ?? '';
      if (selectedValue === '__EMPTY__') selectedValue = '';
      s.values[field] = selectedValue;
    }

    if (interaction.isButton() && interaction.customId.startsWith('guide:page:')) {
      const [, , , action] = interaction.customId.split(':');
      if (action === 'prev') s.page = Math.max(0, (s.page||0)-1);
      if (action === 'next') s.page = (s.page||0)+1;
      if (action === 'reset') { s.values = {}; s.page = 0; }
      
      if (action === 'search') {
        const params = buildSearchParams(s);
        const listHtml = await postForm(params);
        
        if (s.tab === 'items') {
            s.results = extractItemPreviews(listHtml);
        } else if (s.tab === 'creatures') {
            s.results = extractCreaturePreviews(listHtml);
        // --- NEW: Route to the Master Realms parser ---
        } else if (s.tab === 'master-realms') {
            s.results = extractMasterRealmsPreviews(listHtml);
        } else {
            s.results = extractGenericPreviews(listHtml);
        }

        if (s.tab === 'items' && s.values.search_stat && s.values.search_stat !== '-1') {
            const STAT_ID_TO_KEY = { '0': 'attack', '1': 'defense', '2': 'armor', '3': 'hp', '4': 'damage' };
            const sortKey = STAT_ID_TO_KEY[s.values.search_stat];
            if (sortKey) {
                s.results.sort((a, b) => Number(b[sortKey]) - Number(a[sortKey]));
                LOG('guide', `Sorted results by ${sortKey} descending.`);
            }
        }

        s.page = 0;
        await interaction.editReply(buildResultsDisplay(sessionId, s));
        return;
      }
    }
    
    if (interaction.isButton() && interaction.customId.startsWith('guide:back_to_filters:')) {
        s.page = 0; s.results = [];
        await interaction.editReply({
            content: `🧭 **/guide** – *${s.tab}*\nUse the menus to apply filters, then click **Search**.`,
            components: buildFilterRows(sessionId, s)
        });
        return;
    }
    
    if (interaction.isButton() && interaction.customId.startsWith('guide:result_page:')) {
        const [, , , action] = interaction.customId.split(':');
        if (action === 'prev') s.page = Math.max(0, (s.page||0)-1);
        if (action === 'next') s.page = (s.page||0)+1;
        await interaction.editReply(buildResultsDisplay(sessionId, s));
        return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('guide:pick:')) {
      const url = interaction.values?.[0];
      if (!url || url === 'no_items') {
        await interaction.editReply(buildResultsDisplay(sessionId, s));
        return;
      }
      
      const html = await getText(url);
      const { title, text } = summarizeDetail(html);
      const emb = new EmbedBuilder().setTitle(title).setURL(url).setDescription(text || 'No readable content.').setFooter({ text: `Guide · ${s.tab}` });
      
      await interaction.followUp({ embeds: [emb], ephemeral: true });
      return;
    }
    
    const activeFilters = Object.entries(s.values).map(([key, value]) => value ? `**${key.replace(/_/g, ' ')}:** "${value}"` : '').filter(Boolean).join(', ');
    const content = `🧭 **/guide** – *${s.tab}*\n` + (activeFilters ? `**Current Filters:** ${activeFilters}` : 'Use the menus to apply filters, then click **Search**.');
    await interaction.editReply({ content: content, components: buildFilterRows(sessionId, s) });

  } catch (e) {
    console.error('[guide] handleGuideComponent error:', e);
    try { await interaction.editReply({ content: '❌ An error occurred while processing this action. Please check the console log.', components: [] }); } catch {}
  }
}