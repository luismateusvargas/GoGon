// catalog/guideParsers.js - CAT-TASK-001 / AC-CAT-011, AC-CAT-013 (catalog-sync-v1 1.2.x)
// Guide page parsers, ported from the supplied userscripts in reconciliation/scrappers
// (fallen_sword_item_scraper.js parseItemPage, fallen_sword_creature_scraper.js parseCreatureFromDoc,
// fallen_sword_realm_scraper.js parseRealmPage / parseMasterRealmPage). They run in the owner's
// browser inside the relay userscript (inlined by scripts/catalog/build-relay-userscript.mjs) and in
// Node tests on linkedom, so they use only querySelectorAll/getAttribute/textContent and have no
// imports. Output is plain data in the relay wire shape; the server validates it again
// (catalog/guideNormalizers.js) and never trusts it. A page without a name is not a record.

const PARSER_BASE = 'https://guide.fallensword.com/';
const PARSER_LIMITS = { name: 191, text: 8192, list: 500 };

function cleanText(value, max = PARSER_LIMITS.name) {
    const t = String(value ?? '').replace(/ |&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

function toInt(value) {
    const n = parseInt(String(value ?? '').replace(/,/g, ''), 10);
    return Number.isSafeInteger(n) ? n : null;
}

function idFromHref(href, param) {
    const m = String(href ?? '').match(new RegExp(`[?&]${param}=(\\d{1,9})(?:&|$|#)`));
    const n = m ? Number(m[1]) : null;
    return n && n > 0 ? n : null;
}

/** An https image URL on a fallensword.com host, or null. */
function imageUrl(src) {
    if (!src) return null;
    try {
        const u = new URL(String(src), PARSER_BASE);
        u.protocol = 'https:';
        if (!/(^|\.)fallensword\.com$/i.test(u.hostname) || u.username || u.password) return null;
        const s = u.toString();
        return s.length <= 512 ? s : null;
    } catch { return null; }
}

/** A page from the guide itself: it carries the guide's own index.php?cmd= navigation. */
export function isGuidePage(doc) {
    return Boolean(doc?.querySelector?.('a[href*="index.php?cmd="]'));
}

/**
 * Index page: IDs in document order (first occurrence), each with its link text as a name hint.
 * @returns {{ entries: Array<{ id: number, name: string|null }> }}
 */
export function parseIndexPage(doc, idParam) {
    const seen = new Map();
    for (const a of doc.querySelectorAll(`a[href*="${idParam}="]`)) {
        const id = idFromHref(a.getAttribute('href'), idParam);
        if (!id) continue;
        const name = cleanText(a.textContent);
        if (!seen.has(id)) seen.set(id, name);
        else if (!seen.get(id) && name) seen.set(id, name);
        if (seen.size >= PARSER_LIMITS.list) break;
    }
    return { entries: [...seen].map(([id, name]) => ({ id, name })) };
}

function headerNameAndLevel(doc) {
    const header = cleanText(doc.querySelector('.tHeader b')?.textContent, 300);
    if (!header) return { name: null, minLevel: null };
    const m = header.match(/^(.+?)\s*\(Min\s*Level:\s*(\d+)\)$/i);
    return m ? { name: cleanText(m[1]), minLevel: Number(m[2]) } : { name: cleanText(header), minLevel: null };
}

// --- item ------------------------------------------------------------------------------------------

const RARITIES = ['common', 'uncommon', 'rare', 'unique', 'legendary', 'epic', 'super elite', 'crystalline'];
const STAT_LABELS = {
    Type: 'type', Level: 'level', Attack: 'attack', Defense: 'defense', Armor: 'armor', Damage: 'damage', HP: 'hp',
    'XP Gain': 'xpGain', Stamina: 'stamina', 'Stamina Gain': 'staminaGain', 'Gold Gain': 'goldGain',
};

function readStats(cells, into) {
    for (let i = 0; i + 1 < cells.length; i += 2) {
        const label = cleanText(cells[i].textContent)?.replace(/:$/, '');
        const key = STAT_LABELS[label];
        if (!key) continue;
        const raw = cleanText(cells[i + 1].textContent, 64);
        into[key] = key === 'type' ? raw : toInt(raw);
    }
}

function readEnhancements(cells, into) {
    for (let i = 0; i + 1 < cells.length; i += 2) {
        const name = cleanText(cells[i].textContent)?.replace(/:$/, '');
        const m = String(cells[i + 1].textContent).match(/(\d+)%/);
        if (name && m && into.length < 64) into.push({ name, value: Number(m[1]) });
    }
}

export function parseItemDetail(doc, id) {
    let name = null;
    let rarity = null;
    for (const cell of doc.querySelectorAll('td.tHeader[colspan="10"]')) {
        const bold = cleanText(cell.querySelector('b')?.textContent);
        if (!bold) continue;
        const rest = cleanText(cell.textContent, 300)?.replace(bold, '').trim() ?? '';
        if (rest.startsWith('(') && rest.endsWith(')')) {
            const inner = rest.slice(1, -1).trim();
            if (RARITIES.some(r => inner.toLowerCase().startsWith(r))) { name = bold; rarity = cleanText(inner, 64); break; }
        } else if (bold.length > 3) { name = bold; break; }
    }
    if (!name) return null;

    const stats = {};
    const enhancements = [];
    const droppedBy = [];
    const setStats = {};
    const setEnhancements = [];
    let setName = null;
    let setId = null;
    let section = null;
    for (const row of doc.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td')];
        if (!cells.length) continue;
        if (cells.length === 1 && cells[0].classList.contains('tHeader') && cells[0].querySelector('b')) {
            section = cleanText(cells[0].querySelector('b').textContent);
            continue;
        }
        if (section === 'Statistics') readStats(cells, stats);
        else if (section === 'Enhancements') readEnhancements(cells, enhancements);
        else if (section === 'Dropped By' && cells.length >= 2) {
            const creatureName = cleanText(cells[0].textContent)?.replace(/:$/, '');
            const m = String(cells[1].textContent).match(/([\d.]+)%/);
            if (creatureName && m && droppedBy.length < 200) droppedBy.push({ creatureName, dropRate: Number(m[1]) });
        } else if (section === 'Set Bonuses') {
            const link = cells.length === 1 ? cells[0].querySelector('a[href*="search_set_id"]') : null;
            if (link) {
                setName = cleanText(link.textContent);
                setId = idFromHref(link.getAttribute('href'), 'search_set_id');
            } else if (cells.length > 1) {
                readStats(cells.filter(c => cleanText(c.textContent)), setStats);
            }
        } else if (section === 'Set Enhancements') readEnhancements(cells, setEnhancements);
    }
    const image = doc.querySelector('img[src*="cdn"]');
    const isSet = Boolean(setName || setEnhancements.length);
    return {
        id,
        name,
        rarity,
        imageUrl: imageUrl(image?.getAttribute('src')),
        stats,
        enhancements,
        droppedBy,
        setId,
        setName,
        setBonuses: isSet ? { ...setStats, enhancements: setEnhancements } : null,
    };
}

// --- creature --------------------------------------------------------------------------------------

const RANGE_STATS = { 'Attack:': 'attack', 'Defense:': 'defense', 'Armor:': 'armor', 'Damage:': 'damage', 'HP:': 'hp', 'Gold:': 'gold', 'XP:': 'xp' };

export function parseCreatureDetail(doc, id) {
    const name = cleanText(doc.querySelector('.tHeader b')?.textContent);
    if (!name) return null;
    const rows = [...doc.querySelectorAll('tr')];
    let description = null;
    for (let i = 0; i < rows.length; i++) {
        if (cleanText(rows[i].querySelector('.tHeader b')?.textContent) !== name) continue;
        const cell = rows[i + 1]?.querySelector('td[colspan="10"]');
        if (cell && !cell.classList.contains('tHeader')) description = cleanText(cell.textContent, PARSER_LIMITS.text);
        break;
    }
    const stats = {};
    const cells = [...doc.querySelectorAll('td')];
    cells.forEach((cell, i) => {
        const label = cleanText(cell.textContent, 32);
        if (label === 'Class:') stats.class = cleanText(cells[i + 1]?.textContent, 64);
        else if (label === 'Level:') { const v = toInt(cells[i + 1]?.textContent); if (v !== null) stats.level = v; }
        else if (RANGE_STATS[label]) {
            const min = toInt(cells[i + 1]?.textContent);
            const max = toInt(cells[i + 3]?.textContent);
            if (min !== null && max !== null) stats[RANGE_STATS[label]] = { min, max };
        }
    });
    const enhancements = [];
    let inEnhancements = false;
    for (const row of rows) {
        const header = row.querySelector('.tHeader');
        if (header && /Enhancements/.test(header.textContent)) { inEnhancements = true; continue; }
        if (inEnhancements && header) inEnhancements = false;
        if (inEnhancements) {
            const text = cleanText(row.textContent, 256);
            if (text && !text.includes('[no enhancements]') && enhancements.length < 64) enhancements.push(text);
        }
    }
    const droppedItems = [];
    const seenItems = new Set();
    for (const a of doc.querySelectorAll('a[href*="item_id="]')) {
        const itemId = idFromHref(a.getAttribute('href'), 'item_id');
        if (!itemId || seenItems.has(itemId) || droppedItems.length >= 200) continue;
        seenItems.add(itemId);
        droppedItems.push({ itemId, itemName: cleanText(a.textContent) });
    }
    const realms = [];
    const seenRealms = new Set();
    for (const a of doc.querySelectorAll('a[href*="realm_id="]')) {
        const realmId = idFromHref(a.getAttribute('href'), 'realm_id');
        if (!realmId || seenRealms.has(realmId) || realms.length >= 200) continue;
        seenRealms.add(realmId);
        realms.push({ realmId, realmName: cleanText(a.textContent) });
    }
    return {
        id, name, description, stats, enhancements, droppedItems, realms,
        imageUrl: imageUrl(doc.querySelector('.creatureImg img')?.getAttribute('src')),
    };
}

// --- realm and master realm --------------------------------------------------------------------------

function linkList(doc, param, max = 200) {
    const out = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll(`a[href*="${param}="]`)) {
        const id = idFromHref(a.getAttribute('href'), param);
        if (!id || seen.has(id) || out.length >= max) continue;
        seen.add(id);
        out.push({ id, name: cleanText(a.textContent), anchor: a });
    }
    return out;
}

export function parseRealmDetail(doc, id) {
    const { name, minLevel } = headerNameAndLevel(doc);
    if (!name) return null;
    const stairways = [];
    const seenStairs = new Set();
    for (const img of doc.querySelectorAll('a[href*="realm_id="] img[src*="stairways"]')) {
        const target = idFromHref(img.closest('a')?.getAttribute('href'), 'realm_id');
        if (!target || seenStairs.has(target)) continue;
        seenStairs.add(target);
        const tip = String(img.getAttribute('onmouseover') ?? '').match(/Stairway to (.+?)['"]?\)/);
        stairways.push({ targetRealmId: target, targetRealmName: cleanText(tip?.[1]) });
    }
    return {
        id, name, minLevel,
        shops: linkList(doc, 'shop_id').map(s => ({ shopId: s.id, shopName: s.name })),
        relics: linkList(doc, 'relic_id').map(r => r.name).filter(Boolean),
        quests: linkList(doc, 'quest_id').map(q => ({ questId: q.id, questName: q.name })).filter(q => q.questName),
        creatures: linkList(doc, 'creature_id').map(c => ({ creatureId: c.id, creatureName: c.name })),
        stairways,
    };
}

export function parseMasterRealmDetail(doc, id) {
    const { name, minLevel } = headerNameAndLevel(doc);
    if (!name) return null;
    return {
        id, name, minLevel,
        imageUrl: imageUrl(doc.querySelector('img[src*="masterrealms/"]')?.getAttribute('src')),
        realms: linkList(doc, 'realm_id').map(r => {
            const cells = r.anchor.closest('tr')?.querySelectorAll('td') ?? [];
            const level = cells.length > 1 ? String(cells[1].textContent).match(/(\d+)/) : null;
            return { realmId: r.id, realmName: r.name, minLevel: level ? Number(level[1]) : null };
        }),
    };
}

export const DETAIL_PARSERS = { item: parseItemDetail, creature: parseCreatureDetail, realm: parseRealmDetail, master_realm: parseMasterRealmDetail };
