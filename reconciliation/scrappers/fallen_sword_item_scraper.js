// ==UserScript==
// @name         Fallen Sword Item Scraper v2.0
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Two-phase concurrent scraping: (1) Collect item_ids from index pages, (2) Scrape individual item pages
// @author       Fallen Sword Automation Architect
// @match        https://guide.fallensword.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════
    // CONFIGURAÇÕES
    // ═══════════════════════════════════════════════════════════════════════

    const CONFIG = {
        BASE_INDEX_URL: 'https://guide.fallensword.com/index.php?cmd=items&index=',
        BASE_ITEM_URL: 'https://guide.fallensword.com/index.php?cmd=items&subcmd=view&item_id=',
        MIN_INDEX: 0,
        MAX_INDEX: 660,
        CONCURRENT_REQUESTS: 10, // HTTP/2 permite mais requisições paralelas
        CHUNK_SIZE: 100, // Items por arquivo JSON
        DELAY_BETWEEN_BATCHES: 1000, // 800ms entre batches
        STORAGE_KEY_PROGRESS: 'fs_item_scraper_progress_v2',
        STORAGE_KEY_ITEMS: 'fs_items_data_v2'
    };

    // ═══════════════════════════════════════════════════════════════════════
    // ESTADO GLOBAL
    // ═══════════════════════════════════════════════════════════════════════

    let scraperState = {
        phase: 'idle',
        itemIds: new Set(),
        items: [],
        sets: {}, // NOVO: Estrutura para armazenar sets { setId: setData }
        currentIndexPage: 0,
        currentItemIndex: 0,
        isRunning: false,
        errors: [],
        downloadedChunks: 0,
        totalProcessed: 0,
        startTime: null
    };

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1: COLETAR ITEM IDs DOS ÍNDICES
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Architect Note: Extrai todos os item_id dos links presentes nas páginas
     * de índice (0 a 660). Cada índice contém ~25 items.
     */
    async function collectItemIds() {
        scraperState.phase = 'collecting_ids';
        scraperState.startTime = Date.now();
        logMessage('🔍 FASE 1: Coletando item_ids das páginas de índice...');

        try {
            const totalPages = CONFIG.MAX_INDEX - CONFIG.MIN_INDEX + 1;

            for (let index = scraperState.currentIndexPage; index <= CONFIG.MAX_INDEX; index += CONFIG.CONCURRENT_REQUESTS) {
                if (!scraperState.isRunning) {
                    logMessage('⏸️ Coleta de IDs pausada.');
                    return;
                }

                const batch = [];
                for (let i = 0; i < CONFIG.CONCURRENT_REQUESTS && (index + i) <= CONFIG.MAX_INDEX; i++) {
                    batch.push(fetchIndexPage(index + i));
                }

                // Fetch concorrente
                const results = await Promise.all(batch);

                // Adicionar item_ids ao Set
                results.forEach(itemIdsArray => {
                    itemIdsArray.forEach(id => scraperState.itemIds.add(id));
                });

                scraperState.currentIndexPage = index + CONFIG.CONCURRENT_REQUESTS;
                saveProgress();
                updateUI();

                const progress = ((index / totalPages) * 100).toFixed(1);
                const elapsed = ((Date.now() - scraperState.startTime) / 1000).toFixed(1);
                logMessage(`📊 Progresso Fase 1: ${progress}% | Item IDs coletados: ${scraperState.itemIds.size} | Tempo: ${elapsed}s`);

                await sleep(CONFIG.DELAY_BETWEEN_BATCHES);
            }

            logMessage(`✅ FASE 1 COMPLETA! Total de ${scraperState.itemIds.size} item_ids coletados.`);

            // Próxima fase
            scraperState.currentItemIndex = 0;
            await scrapeItems();

        } catch (error) {
            console.error('[COLLECT IDs ERROR]', error);
            scraperState.errors.push({
                phase: 'collecting_ids',
                error: error.message
            });
            scraperState.isRunning = false;
            updateUI();
        }
    }

    /**
     * Busca uma página de índice e extrai todos os item_id dos links
     */
    async function fetchIndexPage(indexNum) {
        const itemIds = [];

        try {
            const url = `${CONFIG.BASE_INDEX_URL}${indexNum}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Extrair item_id de todos os links do tipo:
            // "index.php?cmd=items&subcmd=view&item_id=16882&..."
            const links = doc.querySelectorAll('a[href*="item_id="]');

            links.forEach(link => {
                const href = link.getAttribute('href');
                const match = href.match(/item_id=(\d+)/);
                if (match) {
                    itemIds.push(match[1]);
                }
            });

        } catch (error) {
            console.error(`[FETCH INDEX ERROR] Index ${indexNum}:`, error);
            scraperState.errors.push({
                indexNum: indexNum,
                phase: 'fetching_index',
                error: error.message
            });
        }

        return itemIds;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2: SCRAPING DE ITEMS INDIVIDUAIS
    // ═══════════════════════════════════════════════════════════════════════

    async function scrapeItems() {
        scraperState.phase = 'scraping_items';
        scraperState.startTime = Date.now();
        logMessage('🚀 FASE 2: Iniciando scraping de items individuais...');

        const itemIdsArray = Array.from(scraperState.itemIds);

        try {
            for (let i = scraperState.currentItemIndex; i < itemIdsArray.length; i += CONFIG.CONCURRENT_REQUESTS) {
                if (!scraperState.isRunning) {
                    logMessage('⏸️ Scraping pausado.');
                    return;
                }

                const batch = itemIdsArray.slice(i, i + CONFIG.CONCURRENT_REQUESTS);

                // Fetch concorrente
                const promises = batch.map(itemId => fetchItemPage(itemId));
                const results = await Promise.all(promises);

                // Adicionar items válidos
                results.forEach(item => {
                    if (item && item.name) {
                        scraperState.items.push(item);
                        scraperState.totalProcessed++;
                    }
                });

                scraperState.currentItemIndex = i + CONFIG.CONCURRENT_REQUESTS;

                // Auto-download em chunks
                if (scraperState.items.length >= CONFIG.CHUNK_SIZE) {
                    autoDownloadItemChunk();
                }

                saveProgress();
                updateUI();

                const progress = ((i / itemIdsArray.length) * 100).toFixed(1);
                const elapsed = ((Date.now() - scraperState.startTime) / 1000).toFixed(1);
                logMessage(`📊 Progresso Fase 2: ${progress}% | Items: ${scraperState.totalProcessed} | Tempo: ${elapsed}s`);

                await sleep(CONFIG.DELAY_BETWEEN_BATCHES);
            }

            // Download final
            if (scraperState.items.length > 0) {
                autoDownloadItemChunk();
            }

            // NOVO: Download do JSON de Sets
            downloadSetsJson();

            scraperState.phase = 'completed';
            scraperState.isRunning = false;

            const totalTime = ((Date.now() - scraperState.startTime) / 1000).toFixed(1);
            logMessage(`✅ SCRAPING COMPLETO! ${scraperState.totalProcessed} items em ${totalTime}s`);
            logMessage(`📦 Total de ${scraperState.downloadedChunks} arquivos JSON exportados.`);
            logMessage(`🎁 Total de ${Object.keys(scraperState.sets).length} sets únicos encontrados.`);

            updateUI();

        } catch (error) {
            console.error('[SCRAPING ERROR]', error);
            scraperState.errors.push({
                phase: 'scraping_items',
                error: error.message
            });
            scraperState.isRunning = false;
            updateUI();
        }

    }

    /**
     * Busca e faz o parse de uma página de item individual
     */
    async function fetchItemPage(itemId) {
        try {
            const url = `${CONFIG.BASE_ITEM_URL}${itemId}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            return parseItemPage(doc, itemId);

        } catch (error) {
            console.error(`[FETCH ITEM ERROR] Item ID ${itemId}:`, error);
            scraperState.errors.push({
                itemId: itemId,
                phase: 'fetching_item',
                error: error.message
            });
            return null;
        }
    }

    function parseItemPage(doc, itemId) {
        const item = {
            itemId: itemId,
            name: null,
            rarity: null,
            imageUrl: null,

            statistics: {
                type: null,
                level: null,
                attack: null,
                defense: null,
                armor: null,
                damage: null,
                hp: null,
                xpGain: null,
                stamina: null,
                staminaGain: null,
                goldGain: null
            },

            enhancements: [],
            crafting: { attackRange: null, armorRange: null, defenseRange: null, damageRange: null, hpRange: null },
            droppedBy: [],
            questReward: null,
            soldAt: null,

            isSetItem: false,
            setName: null,
            setBonuses: {
                attack: null,
                defense: null,
                armor: null,
                damage: null,
                hp: null,
                xpGain: null,
                stamina: null,
                staminaGain: null,
                goldGain: null
            },
            setEnhancements: [],

            extraInfo: null,
            usedInRecipes: null,
            requiredInQuest: null,
            createdByRecipe: null,
            ingredients: [],
            extractableComponents: [],
            extractedFrom: null,
            fragmentStash: null
        };

        try {
            // ══════════════════════════════════════════════════════════════
            // IMAGEM DO ITEM
            // ══════════════════════════════════════════════════════════════
            const imageElement = doc.querySelector('img[src*="cdn"]');
            if (imageElement) {
                item.imageUrl = imageElement.src;
            }

            // ══════════════════════════════════════════════════════════════
            // NOME E RARIDADE - EXTRAÇÃO CORRIGIDA (com parênteses aninhados)
            // ══════════════════════════════════════════════════════════════
            const validRarities = ['Common', 'Uncommon', 'Rare', 'Unique', 'Legendary', 'Epic', 'Super Elite', 'Crystalline'];

            // Buscar <td class="tHeader" colspan="10"> que contém o nome
            const headerCells = doc.querySelectorAll('td.tHeader[colspan="10"]');

            for (let cell of headerCells) {
                // Pegar o <b> dentro desta célula
                const boldElement = cell.querySelector('b');
                if (!boldElement) continue;

                // Nome está dentro do <b>
                const nameText = boldElement.textContent.trim();

                // Texto completo da célula (nome + raridade)
                const fullText = cell.textContent.trim();

                // CRITICAL: Extrair raridade considerando parênteses aninhados
                // Padrão: "Item Name (Rarity)" ou "Item Name (Rarity (Extra Info))"

                // Remover o nome do início para isolar a parte da raridade
                const rarityPart = fullText.replace(nameText, '').trim();

                // Verificar se há parênteses
                if (rarityPart.startsWith('(') && rarityPart.endsWith(')')) {
                    // Remover parênteses externos
                    const innerText = rarityPart.slice(1, -1).trim();

                    // Caso 1: Raridade simples - "Legendary"
                    // Caso 2: Raridade com info extra - "Crystalline (Non-Repairable)"

                    // Extrair a primeira palavra (que é a raridade base)
                    const firstWord = innerText.split(/[\s(]/)[0];

                    // Verificar se é uma raridade válida
                    const matchedRarity = validRarities.find(r => r.toLowerCase() === firstWord.toLowerCase());

                    if (matchedRarity && nameText.length > 0) {
                        item.name = nameText;
                        item.rarity = innerText; // Guardar a raridade completa com info extra

                        console.log(`[PARSER] Item ${itemId}: Nome="${item.name}", Rarity="${item.rarity}"`);
                        break;
                    }
                } else if (nameText.length > 3) {
                    // Se não tem raridade mas tem nome válido, aceitar mesmo assim
                    item.name = nameText;
                    console.log(`[PARSER] Item ${itemId}: Nome="${item.name}" (sem raridade)`);
                    break;
                }
            }

            // Se ainda não encontrou, tentar método alternativo
            if (!item.name) {
                console.warn(`[PARSER WARNING] Item ${itemId}: Tentando método alternativo...`);

                // Buscar primeiro <b> que não seja uma seção
                const knownSections = ['Statistics', 'Enhancements', 'Crafting', 'Dropped By', 'Quest Reward',
                                       'Sold At', 'Set Bonuses', 'Set Enhancements', 'Extra Info',
                                       'Used in recipes', 'Required in Quest', 'Created by Recipe',
                                       'Ingredients', 'Extractable Components', 'Extracted From', 'Fragment Stash'];

                const allBolds = doc.querySelectorAll('b');
                for (let bold of allBolds) {
                    const text = bold.textContent.trim();
                    if (!knownSections.includes(text) && text.length > 3 && !text.endsWith(':')) {
                        item.name = text;
                        console.log(`[PARSER] Item ${itemId}: Nome encontrado via fallback: "${item.name}"`);
                        break;
                    }
                }
            }

            // Se AINDA não encontrou, logar erro detalhado
            if (!item.name) {
                console.error(`[PARSER ERROR] Item ${itemId}: NOME NÃO ENCONTRADO! HTML debug:`);
                console.log(doc.documentElement.innerHTML.substring(0, 1000)); // Primeiros 1000 chars
            }

            // ══════════════════════════════════════════════════════════════
            // PROCESSAR LINHAS DA TABELA
            // ══════════════════════════════════════════════════════════════
            const allRows = doc.querySelectorAll('tr');
            let currentSection = null;

            for (let row of allRows) {
                const cells = row.querySelectorAll('td');
                if (cells.length === 0) continue;

                const firstCell = cells[0];

                // ══════════════════════════════════════════════════════════
                // DETECTAR SEÇÃO (apenas se tem class="tHeader")
                // ══════════════════════════════════════════════════════════
                if (cells.length === 1 && firstCell.classList.contains('tHeader')) {
                    const boldElement = firstCell.querySelector('b');
                    if (boldElement) {
                        currentSection = boldElement.textContent.trim();
                        console.log(`[PARSER] Item ${itemId}: Seção = "${currentSection}"`);
                        continue;
                    }
                }

                // ══════════════════════════════════════════════════════════
                // EXTRAIR DADOS BASEADO NA SEÇÃO ATUAL
                // ══════════════════════════════════════════════════════════
                if (currentSection === 'Statistics') {
                    extractStatistics(cells, item.statistics);
                }
                else if (currentSection === 'Enhancements') {
                    extractEnhancementsFromRow(cells, item.enhancements);
                }
                else if (currentSection === 'Crafting') {
                    extractCrafting(cells, item.crafting);
                }
                else if (currentSection === 'Dropped By') {
                    extractDroppedByRow(cells, item.droppedBy);
                }
                else if (currentSection === 'Quest Reward') {
                    const text = firstCell.textContent.trim();
                    if (!item.questReward && text && text !== 'Quest Reward') {
                        item.questReward = text.includes('[not gained from a quest]') ? null : text;
                    }
                }
                else if (currentSection === 'Sold At') {
                    const text = firstCell.textContent.trim();
                    if (!item.soldAt && text && text !== 'Sold At') {
                        item.soldAt = text.includes('[not sold]') ? null : text;
                    }
                }
                else if (currentSection === 'Set Bonuses') {
                    // Linha de descrição do set (colspan="10", não é tHeader)
                    if (cells.length === 1 && cells[0].getAttribute('colspan') === '10') {
                        const setLink = cells[0].querySelector('a[href*="search_set_id"]');
                        if (setLink) {
                            const boldInLink = setLink.querySelector('b');
                            item.setName = boldInLink ? boldInLink.textContent.trim() : setLink.textContent.trim();
                            item.isSetItem = true;
                            console.log(`[PARSER] Item ${itemId}: Set Name="${item.setName}"`);
                        }
                        continue;
                    }

                    // Linhas de stats: filtrar células vazias
                    if (cells.length > 1) {
                        const nonEmptyCells = [];
                        for (let cell of cells) {
                            if (cell.textContent.trim().length > 0) {
                                nonEmptyCells.push(cell);
                            }
                        }

                        if (nonEmptyCells.length >= 2) {
                            extractStatistics(nonEmptyCells, item.setBonuses);
                        }
                    }
                }
                else if (currentSection === 'Set Enhancements') {
                    extractEnhancementsFromRow(cells, item.setEnhancements);
                    if (item.setEnhancements.length > 0 && !item.isSetItem) {
                        item.isSetItem = true;
                    }
                }
                else if (currentSection === 'Extra Info') {
                    const text = firstCell.textContent.trim();
                    if (!item.extraInfo && text && text !== 'Extra Info') {
                        item.extraInfo = text.includes('[none]') ? null : text;
                    }
                }
                else if (currentSection === 'Used in recipes') {
                    const text = firstCell.textContent.trim();
                    if (!item.usedInRecipes && text && text !== 'Used in recipes') {
                        item.usedInRecipes = text;
                    }
                }
                else if (currentSection === 'Required in Quest') {
                    const text = firstCell.textContent.trim();
                    if (!item.requiredInQuest && text && text !== 'Required in Quest') {
                        item.requiredInQuest = text;
                    }
                }
                else if (currentSection === 'Created by Recipe') {
                    const text = firstCell.textContent.trim();
                    if (!item.createdByRecipe && text && text !== 'Created by Recipe') {
                        item.createdByRecipe = text;
                    }
                }
                else if (currentSection === 'Ingredients') {
                    extractListFromRow(row, item.ingredients);
                }
                else if (currentSection === 'Extractable Components') {
                    extractListFromRow(row, item.extractableComponents);
                }
                else if (currentSection === 'Extracted From') {
                    const text = firstCell.textContent.trim();
                    if (!item.extractedFrom && text && text !== 'Extracted From') {
                        item.extractedFrom = text;
                    }
                }
                else if (currentSection === 'Fragment Stash') {
                    const text = firstCell.textContent.trim();
                    if (!item.fragmentStash && text && text !== 'Fragment Stash') {
                        item.fragmentStash = text;
                    }
                }
            }

            // ══════════════════════════════════════════════════════════════
            // PROCESSAR SET DATA (se for set item)
            // ══════════════════════════════════════════════════════════════
            if (item.isSetItem && item.setName) {
                // Extrair setId do document (se houver link de set)
                const setLink = doc.querySelector('a[href*="search_set_id"]');
                let setId = null;

                if (setLink) {
                    const hrefMatch = setLink.href.match(/search_set_id=(\d+)/);
                    if (hrefMatch) {
                        setId = hrefMatch[1];
                    }
                }

                if (setId) {
                    // Verificar se o set já existe na estrutura
                    if (!scraperState.sets[setId]) {
                        // Primeira vez vendo este set - criar entrada
                        scraperState.sets[setId] = {
                            setId: setId,
                            setName: item.setName,
                            items: [],
                            setBonuses: { ...item.setBonuses }, // Copiar bonuses
                            setEnhancements: [...item.setEnhancements] // Copiar enhancements
                        };

                        console.log(`[SETS] Novo set criado: ${setId} - "${item.setName}"`);
                    }

                    // Adicionar este item à lista de items do set
                    scraperState.sets[setId].items.push({
                        itemId: item.itemId,
                        itemName: item.name,
                        itemLevel: item.statistics.level,
                        itemType: item.statistics.type,
                        rarity: item.rarity
                    });

                    console.log(`[SETS] Item adicionado ao set ${setId}: "${item.name}" (${item.statistics.type})`);
                }
            }

        } catch (error) {
            console.error(`[PARSER ERROR] Item ID ${itemId}:`, error);
            scraperState.errors.push({
                itemId: itemId,
                phase: 'parsing',
                error: error.message
            });
        }

        return item;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS - EXTRAÇÃO DE DADOS DE CÉLULAS
    // ═══════════════════════════════════════════════════════════════════════
    /**
 * Remove entidades HTML como &nbsp; de uma string
 */
    function cleanLabel(text) {
        return text
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
 * Filtra células vazias ou com apenas espaços/width
 */
    function filterEmptyCells(cells) {
        const filtered = [];
        for (let cell of cells) {
            const text = cell.textContent.trim();
            // Ignorar células vazias ou que só têm atributos de layout
            if (text.length > 0) {
                filtered.push(cell);
            }
        }
        return filtered;
    }
    /**
 * Extrai statistics de uma linha com múltiplas células
 * Ex: <td>Attack:</td><td>3650</td><td>Defense:</td><td>0</td>
 */
    function extractStatistics(cells, statsObject, prefix = '') {
        for (let i = 0; i < cells.length - 1; i += 2) {
            const labelCell = cleanLabel(cells[i].textContent);
            const valueCell = cells[i + 1].textContent.trim();

            // Extrair label (remover ':' e prefix se houver)
            const label = labelCell.replace(':', '').replace(prefix, '').trim();

            // Tentar converter para número
            const numValue = parseInt(valueCell);
            const finalValue = isNaN(numValue) ? null : numValue;

            switch (label) {
                case 'Type':
                    statsObject.type = valueCell;
                    break;
                case 'Level':
                    statsObject.level = finalValue;
                    break;
                case 'Attack':
                    statsObject.attack = finalValue;
                    break;
                case 'Defense':
                    statsObject.defense = finalValue;
                    break;
                case 'Armor':
                    statsObject.armor = finalValue;
                    break;
                case 'Damage':
                    statsObject.damage = finalValue;
                    break;
                case 'HP':
                    statsObject.hp = finalValue;
                    break;
                case 'XP Gain':
                    statsObject.xpGain = finalValue;
                    break;
                case 'Stamina':
                    statsObject.stamina = finalValue;
                    break;
                case 'Stamina Gain':
                    statsObject.staminaGain = finalValue;
                    break;
                case 'Gold Gain':
                    statsObject.goldGain = finalValue;
                    break;
            }
        }
    }
    /**
 * Extrai enhancements de uma linha
 * Ex: <td>Piercing Strike:</td><td>30%</td>
 */
    function extractEnhancementsFromRow(cells, enhancementsArray) {
        if (cells.length < 2) return;

        for (let i = 0; i < cells.length - 1; i += 2) {
            const name = cells[i].textContent.trim().replace(':', '');
            const valueText = cells[i + 1].textContent.trim();
            const match = valueText.match(/(\d+)%/);

            if (match && name) {
                enhancementsArray.push({
                    name: name,
                    value: parseInt(match[1])
                });
            }
        }
    }

    /**
 * Extrai crafting range
 * Ex: <td>Attack:</td><td>18</td><td>-</td><td>180</td>
 */
    function extractCrafting(cells, craftingObject) {
        if (cells.length < 4) return;

        const label = cells[0].textContent.trim().replace(':', '');
        const min = cells[1].textContent.trim();
        const max = cells[3].textContent.trim();
        const range = `${min} - ${max}`;

        if (label === 'Attack') {
            craftingObject.attackRange = range;
        } else if (label === 'Armor') {
            craftingObject.armorRange = range;
        } else if (label === 'Defense') {
            craftingObject.defenseRange = range;
        } else if (label === 'Damage') {
            craftingObject.damageRange = range;
        } else if (label === 'HP') {
            craftingObject.hpRange = range;
        }
    }

    /**
 * Extrai dropped by
 * Ex: <td>Montmarr the Dragon Golem (Dragon LE):</td><td>0.5%</td>
 */
    function extractDroppedByRow(cells, droppedByArray) {
        if (cells.length < 2) return;

        const creatureName = cells[0].textContent.trim().replace(':', '');
        const rateText = cells[1].textContent.trim();
        const match = rateText.match(/([\d.]+)%/);

        if (match && creatureName) {
            droppedByArray.push({
                creatureName: creatureName,
                dropRate: parseFloat(match[1])
            });
        }
    }

    /**
 * Extrai lista de items de uma linha (ex: ingredients)
 */
    function extractListFromRow(row, targetArray) {
        const links = row.querySelectorAll('a');
        links.forEach(link => {
            const text = link.textContent.trim();
            if (text && !targetArray.includes(text)) {
                targetArray.push(text);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS - DOM NAVIGATION
    // ═══════════════════════════════════════════════════════════════════════

    function findSectionByHeader(doc, headerText) {
        const allElements = doc.querySelectorAll('b, strong, h2, h3, h4, .section-title');
        for (let element of allElements) {
            if (element.textContent.trim() === headerText) {
                // Retornar o elemento pai ou próximo sibling
                return element.parentElement || element.nextElementSibling;
            }
        }
        return null;
    }

    function extractValue(section, fieldName) {
        if (!section) return null;

        const regex = new RegExp(`${fieldName}[:\s]+([^\\n<]+)`, 'i');
        const match = section.textContent.match(regex);
        return match ? match[1].trim() : null;
    }

    function extractEnhancements(section) {
        const enhancements = [];
        if (!section) return enhancements;

        const regex = /([A-Za-z\s]+):\s*(\d+)%/g;
        let match;
        while ((match = regex.exec(section.textContent)) !== null) {
            enhancements.push({
                name: match[1].trim(),
                value: parseInt(match[2])
            });
        }

        return enhancements;
    }

    function extractDroppedBy(section) {
        const droppedBy = [];
        if (!section) return droppedBy;

        const regex = /([^:]+):\s*([\d.]+)%/g;
        let match;
        while ((match = regex.exec(section.textContent)) !== null) {
            droppedBy.push({
                creatureName: match[1].trim(),
                dropRate: parseFloat(match[2])
            });
        }

        return droppedBy;
    }

    function extractListItems(section) {
        if (!section) return [];

        const items = [];
        const links = section.querySelectorAll('a');

        links.forEach(link => {
            items.push(link.textContent.trim());
        });

        return items;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITÁRIOS
    // ═══════════════════════════════════════════════════════════════════════

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function downloadJSON(data, filename) {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function autoDownloadItemChunk() {
        scraperState.downloadedChunks++;
        const filename = `fs_items_chunk_${scraperState.downloadedChunks}.json`;

        downloadJSON(scraperState.items, filename);
        logMessage(`📥 Download: ${filename} (${scraperState.items.length} items)`);

        scraperState.items = [];
    }

    /**
 * Download do JSON de Sets (executado no final do scraping)
 */
    function downloadSetsJson() {
        const setsArray = Object.values(scraperState.sets);

        if (setsArray.length === 0) {
            logMessage('⚠️ Nenhum set encontrado para exportar.');
            return;
        }

        const filename = `fs_sets_complete.json`;
        downloadJSON(setsArray, filename);
        logMessage(`📥 Download: ${filename} (${setsArray.length} sets)`);
    }

    function saveProgress() {
        try {
            const progress = {
                phase: scraperState.phase,
                itemIds: Array.from(scraperState.itemIds),
                sets: scraperState.sets, // NOVO: Salvar sets
                currentIndexPage: scraperState.currentIndexPage,
                currentItemIndex: scraperState.currentItemIndex,
                totalProcessed: scraperState.totalProcessed,
                downloadedChunks: scraperState.downloadedChunks,
                errors: scraperState.errors
            };
            localStorage.setItem(CONFIG.STORAGE_KEY_PROGRESS, JSON.stringify(progress));
        } catch (error) {
            console.error('[SAVE ERROR]', error);
        }
    }

    function loadProgress() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY_PROGRESS);
            if (saved) {
                const progress = JSON.parse(saved);
                scraperState.phase = progress.phase || 'idle';
                scraperState.itemIds = new Set(progress.itemIds || []);
                scraperState.sets = progress.sets || {}; // NOVO: Carregar sets
                scraperState.currentIndexPage = progress.currentIndexPage || 0;
                scraperState.currentItemIndex = progress.currentItemIndex || 0;
                scraperState.totalProcessed = progress.totalProcessed || 0;
                scraperState.downloadedChunks = progress.downloadedChunks || 0;
                scraperState.errors = progress.errors || [];

                logMessage('📂 Progresso anterior carregado.');
                updateUI();
            }
        } catch (error) {
            console.error('[LOAD ERROR]', error);
        }
    }

    function logMessage(msg) {
        console.log(`[FS ITEM SCRAPER] ${msg}`);
        const logDiv = document.getElementById('fs-item-log');
        if (logDiv) {
            const entry = document.createElement('div');
            entry.textContent = `${new Date().toLocaleTimeString()} - ${msg}`;
            logDiv.appendChild(entry);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════════════════════════════════

    function createUI() {
        const container = document.createElement('div');
        container.id = 'fs-item-scraper-ui';
        container.innerHTML = `
    <style>
        #fs-item-scraper-ui {
            position: fixed;
            top: 10px;
            right: 10px;
            width: 380px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: 2px solid #fff;
            border-radius: 12px;
            padding: 15px;
            z-index: 10000;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            color: #fff;
            font-family: 'Courier New', monospace;
            font-size: 13px;
        }
        #fs-item-scraper-ui h3 {
            margin: 0 0 10px 0;
            font-size: 16px;
            text-align: center;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        #fs-item-scraper-ui .info {
            background: rgba(0, 0, 0, 0.3);
            padding: 8px;
            border-radius: 6px;
            margin-bottom: 10px;
        }
        #fs-item-scraper-ui .info div {
            margin: 3px 0;
        }
        #fs-item-scraper-ui .buttons {
            display: flex;
            gap: 5px;
            margin-bottom: 10px;
        }
        #fs-item-scraper-ui button {
            flex: 1;
            padding: 8px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
            transition: all 0.3s;
        }
        #fs-item-scraper-ui button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        #fs-item-start-btn {
            background: #10b981;
            color: white;
        }
        #fs-item-stop-btn {
            background: #ef4444;
            color: white;
        }
        #fs-item-clear-btn {
            background: #f59e0b;
            color: white;
        }
        #fs-item-log {
            background: rgba(0, 0, 0, 0.5);
            padding: 8px;
            border-radius: 6px;
            max-height: 150px;
            overflow-y: auto;
            font-size: 11px;
            line-height: 1.4;
        }
        #fs-item-log div {
            margin-bottom: 3px;
        }
    </style>
    <h3>⚔️ FS Item Scraper v2.0</h3>
    <div class="info">
        <div><strong>Fase:</strong> <span id="fs-item-phase">idle</span></div>
        <div><strong>Item IDs Coletados:</strong> <span id="fs-item-ids-count">0</span></div>
        <div><strong>Items Processados:</strong> <span id="fs-item-processed">0</span></div>
        <div><strong>Chunks Exportados:</strong> <span id="fs-item-chunks">0</span></div>
        <div><strong>Sets Encontrados:</strong> <span id="fs-item-sets-count">0</span></div>
        <div><strong>Erros:</strong> <span id="fs-item-errors">0</span></div>
    </div>
    <div class="buttons">
        <button id="fs-item-start-btn">▶ Start</button>
        <button id="fs-item-stop-btn">⏸ Stop</button>
        <button id="fs-item-clear-btn">🗑 Clear</button>
    </div>
    <div id="fs-item-log"></div>
`;
        document.body.appendChild(container);

        document.getElementById('fs-item-start-btn').addEventListener('click', async () => {
            if (scraperState.isRunning) {
                logMessage('⚠️ Scraping já está em execução.');
                return;
            }

            scraperState.isRunning = true;
            updateUI();

            if (scraperState.phase === 'idle' || scraperState.phase === 'completed') {
                await collectItemIds();
            } else if (scraperState.phase === 'collecting_ids') {
                await collectItemIds();
            } else if (scraperState.phase === 'scraping_items') {
                await scrapeItems();
            }
        });

        document.getElementById('fs-item-stop-btn').addEventListener('click', () => {
            scraperState.isRunning = false;
            logMessage('🛑 Scraping interrompido.');
            updateUI();
        });

        document.getElementById('fs-item-clear-btn').addEventListener('click', () => {
            if (confirm('Limpar todo o progresso? Esta ação não pode ser desfeita.')) {
                localStorage.removeItem(CONFIG.STORAGE_KEY_PROGRESS);
                localStorage.removeItem(CONFIG.STORAGE_KEY_ITEMS);
                scraperState = {
                    phase: 'idle',
                    itemIds: new Set(),
                    items: [],
                    sets: {}, // NOVO: Limpar sets
                    currentIndexPage: 0,
                    currentItemIndex: 0,
                    isRunning: false,
                    errors: [],
                    downloadedChunks: 0,
                    totalProcessed: 0,
                    startTime: null
                };
                document.getElementById('fs-item-log').innerHTML = '';
                logMessage('🗑️ Progresso limpo.');
                updateUI();
            }
        });
    }

function updateUI() {
    document.getElementById('fs-item-phase').textContent = scraperState.phase;
    document.getElementById('fs-item-ids-count').textContent = scraperState.itemIds.size;
    document.getElementById('fs-item-processed').textContent = scraperState.totalProcessed;
    document.getElementById('fs-item-chunks').textContent = scraperState.downloadedChunks;
    document.getElementById('fs-item-errors').textContent = scraperState.errors.length;
    document.getElementById('fs-item-sets-count').textContent = Object.keys(scraperState.sets).length; // NOVO
}

// ═══════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

function init() {
    loadProgress();
    createUI();
    logMessage('✅ Item Scraper v2.0 inicializado.');
}

})();