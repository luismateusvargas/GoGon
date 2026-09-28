// ==UserScript==
// @name         Fallen Sword Creature Scraper v2
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Scrapes all creatures with auto-chunk download
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
        MAX_PAGES: 320,
        DELAY_BETWEEN_REQUESTS: 500,
        MAX_CREATURE_ID: 7000,
        CHUNK_SIZE: 500, // Auto-download a cada 500 criaturas
        STORAGE_KEY: 'fs_creature_data',
        PROGRESS_KEY: 'fs_scraper_progress'
    };

    // ═══════════════════════════════════════════════════════════════════════
    // ESTADO GLOBAL
    // ═══════════════════════════════════════════════════════════════════════

    let scraperState = {
        phase: 'idle',
        collectedIds: new Set(),
        scrapedCreatures: [],
        currentPage: 0,
        currentCreatureIndex: 0,
        isRunning: false,
        errors: [],
        downloadedChunks: 0,
        totalDownloaded: 0
    };

    // ═══════════════════════════════════════════════════════════════════════
    // STORAGE COM FALLBACK PARA QUOTA EXCEEDED
    // ═══════════════════════════════════════════════════════════════════════

    function saveProgress() {
        try {
            // Tenta salvar apenas o essencial (sem os dados completos das criaturas)
            const minimalData = {
                collectedIds: Array.from(scraperState.collectedIds),
                currentPage: scraperState.currentPage,
                currentCreatureIndex: scraperState.currentCreatureIndex,
                errors: scraperState.errors,
                downloadedChunks: scraperState.downloadedChunks,
                totalDownloaded: scraperState.totalDownloaded,
                // NÃO salva scrapedCreatures para economizar espaço
            };
            localStorage.setItem(CONFIG.PROGRESS_KEY, JSON.stringify(minimalData));
            logMessage('💾 Progresso salvo (minimal)');
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                logMessage('⚠️ localStorage cheio - fazendo auto-download...');
                autoDownloadChunk();
            } else {
                logMessage(`❌ Erro ao salvar: ${error.message}`);
            }
        }
    }

    function loadProgress() {
        try {
            const saved = localStorage.getItem(CONFIG.PROGRESS_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                scraperState.collectedIds = new Set(data.collectedIds || []);
                scraperState.currentPage = data.currentPage || 0;
                scraperState.currentCreatureIndex = data.currentCreatureIndex || 0;
                scraperState.errors = data.errors || [];
                scraperState.downloadedChunks = data.downloadedChunks || 0;
                scraperState.totalDownloaded = data.totalDownloaded || 0;
                logMessage('✅ Progresso carregado');
            }
        } catch (error) {
            logMessage(`⚠️ Erro ao carregar progresso: ${error.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-DOWNLOAD DE CHUNKS
    // ═══════════════════════════════════════════════════════════════════════

    function autoDownloadChunk() {
        if (scraperState.scrapedCreatures.length === 0) {
            return;
        }

        const chunkNumber = scraperState.downloadedChunks + 1;
        const json = JSON.stringify(scraperState.scrapedCreatures, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fs_creatures_chunk_${chunkNumber}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);

        logMessage(`📥 Chunk ${chunkNumber} baixado (${scraperState.scrapedCreatures.length} criaturas)`);

        // Limpa o array para liberar memória
        scraperState.totalDownloaded += scraperState.scrapedCreatures.length;
        scraperState.scrapedCreatures = [];
        scraperState.downloadedChunks = chunkNumber;

        updateUI();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PARSING DE CRIATURAS
    // ═══════════════════════════════════════════════════════════════════════

    function parseCreatureFromDoc(doc, creatureId) {
        const creature = {
            creatureId: creatureId,
            creatureImg: null,
            creatureName: null,
            description: null,
            statistics: {},
            enhancements: [],
            droppedItems: [],
            spawningInfo: [],
            additionalNotes: null
        };

        try {
            // Imagem
            const imgElement = doc.querySelector('.creatureImg img');
            if (imgElement) {
                creature.creatureImg = imgElement.src.replace('http://', 'https://');
            }

            // Nome
            const nameHeader = doc.querySelector('.tHeader b');
            if (nameHeader) {
                creature.creatureName = nameHeader.textContent.trim();
            }

            // Descrição
            const allRows = doc.querySelectorAll('tr');
            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const nameCell = row.querySelector('.tHeader b');
                if (nameCell && nameCell.textContent.trim() === creature.creatureName) {
                    const nextRow = allRows[i + 1];
                    if (nextRow) {
                        const descCell = nextRow.querySelector('td[colspan="10"]');
                        if (descCell && !descCell.classList.contains('tHeader')) {
                            creature.description = descCell.textContent.trim();
                            break;
                        }
                    }
                }
            }

            // Statistics
            const statCells = Array.from(doc.querySelectorAll('td'));
            statCells.forEach((cell, index) => {
                const text = cell.textContent.trim();

                if (text === 'Class:') {
                    creature.statistics.class = statCells[index + 1]?.textContent.trim();
                } else if (text === 'Level:') {
                    const level = parseInt(statCells[index + 1]?.textContent.trim());
                    if (!isNaN(level)) creature.statistics.level = level;
                } else if (text === 'Attack:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.attack = { min, max };
                    }
                } else if (text === 'Defense:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.defense = { min, max };
                    }
                } else if (text === 'Armor:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.armor = { min, max };
                    }
                } else if (text === 'Damage:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.damage = { min, max };
                    }
                } else if (text === 'HP:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.hp = { min, max };
                    }
                } else if (text === 'Gold:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.gold = { min, max };
                    }
                } else if (text === 'XP:') {
                    const min = parseInt(statCells[index + 1]?.textContent.trim());
                    const max = parseInt(statCells[index + 3]?.textContent.trim());
                    if (!isNaN(min) && !isNaN(max)) {
                        creature.statistics.xp = { min, max };
                    }
                }
            });

            // Enhancements
            let inEnhSection = false;
            allRows.forEach(row => {
                const header = row.querySelector('.tHeader');
                if (header && header.textContent.includes('Enhancements')) {
                    inEnhSection = true;
                    return;
                }
                if (inEnhSection && row.querySelector('.tHeader')) {
                    inEnhSection = false;
                }
                if (inEnhSection) {
                    const text = row.textContent.trim();
                    if (text && !text.includes('[no enhancements]') && text !== 'Enhancements') {
                        creature.enhancements.push(text);
                    }
                }
            });

            // Dropped Items
            const itemLinks = doc.querySelectorAll('a[href*="item_id"]');
            itemLinks.forEach(link => {
                const itemId = new URLSearchParams(link.search).get('item_id');
                if (itemId) {
                    creature.droppedItems.push({
                        itemId: itemId,
                        itemName: link.textContent.trim()
                    });
                }
            });

            // Spawning Info
            const realmLinks = doc.querySelectorAll('a[href*="realm_id"]');
            realmLinks.forEach(link => {
                const realmId = new URLSearchParams(link.search).get('realm_id');
                if (realmId) {
                    creature.spawningInfo.push({
                        realmId: realmId,
                        realmName: link.textContent.trim()
                    });
                }
            });

            // Additional Notes
            let inNotesSection = false;
            allRows.forEach(row => {
                const header = row.querySelector('.tHeader');
                if (header && header.textContent.includes('Additional Notes')) {
                    inNotesSection = true;
                    return;
                }
                if (inNotesSection && row.querySelector('.tHeader')) {
                    inNotesSection = false;
                }
                if (inNotesSection) {
                    const cell = row.querySelector('td[colspan="10"]');
                    if (cell) {
                        const text = cell.textContent.trim();
                        if (text && text !== 'None') {
                            creature.additionalNotes = text;
                        }
                    }
                }
            });

        } catch (error) {
            logMessage(`⚠️ Erro ao parsear creature ${creatureId}: ${error.message}`);
        }

        return creature;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1: COLETAR IDs
    // ═══════════════════════════════════════════════════════════════════════

    async function collectCreatureIds() {
        logMessage('🔍 Fase 1: Coletando creature IDs...');
        scraperState.phase = 'collecting_ids';

        for (let page = scraperState.currentPage; page <= CONFIG.MAX_PAGES; page++) {
            if (!scraperState.isRunning) {
                logMessage('⏸️ Coleta pausada');
                return;
            }

            scraperState.currentPage = page;
            updateUI();

            try {
                const url = `https://guide.fallensword.com/index.php?cmd=creatures&index=${page}&search_name=&search_level_min=-1&search_level_max=-1&search_class=-1&search_type=-1`;

                const response = await fetch(url);
                const html = await response.text();

                const matches = html.matchAll(/creature_id=(\d+)/g);
                for (const match of matches) {
                    scraperState.collectedIds.add(parseInt(match[1]));
                }

                if (page % 10 === 0) {
                    logMessage(`   Página ${page}/${CONFIG.MAX_PAGES} - IDs: ${scraperState.collectedIds.size}`);
                }

            } catch (error) {
                logMessage(`❌ Erro na página ${page}: ${error.message}`);
                scraperState.errors.push({ page, error: error.message });
            }

            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
        }

        logMessage(`✅ Fase 1 completa! ${scraperState.collectedIds.size} IDs coletados`);
        scraperState.currentPage = 0; // Reset para fase 2
        saveProgress();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2: SCRAPING
    // ═══════════════════════════════════════════════════════════════════════

    async function scrapeCreatures() {
        logMessage('🕷️ Fase 2: Scraping de criaturas...');
        scraperState.phase = 'scraping_creatures';

        const idsArray = Array.from(scraperState.collectedIds).sort((a, b) => a - b);

        for (let i = scraperState.currentCreatureIndex; i < idsArray.length; i++) {
            if (!scraperState.isRunning) {
                logMessage('⏸️ Scraping pausado');
                saveProgress();
                return;
            }

            const creatureId = idsArray[i];
            scraperState.currentCreatureIndex = i;

            try {
                const url = `https://guide.fallensword.com/index.php?cmd=creatures&subcmd=view&creature_id=${creatureId}`;

                const response = await fetch(url);
                const html = await response.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

                const creature = parseCreatureFromDoc(doc, creatureId);
                scraperState.scrapedCreatures.push(creature);

                // Auto-download a cada CHUNK_SIZE criaturas
                if (scraperState.scrapedCreatures.length >= CONFIG.CHUNK_SIZE) {
                    autoDownloadChunk();
                    saveProgress();
                }

                if ((i + 1) % 10 === 0) {
                    logMessage(`   Progresso: ${i + 1}/${idsArray.length} criaturas`);
                    updateUI();
                }

            } catch (error) {
                logMessage(`❌ Erro no creature_id ${creatureId}: ${error.message}`);
                scraperState.errors.push({ creatureId, error: error.message });
            }

            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
        }

        // Download final do que sobrou
        if (scraperState.scrapedCreatures.length > 0) {
            autoDownloadChunk();
        }

        scraperState.phase = 'completed';
        logMessage(`✅ Scraping completo! Total: ${scraperState.totalDownloaded} criaturas`);
        saveProgress();
        updateUI();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITÁRIOS
    // ═══════════════════════════════════════════════════════════════════════

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function downloadCurrentBuffer() {
        if (scraperState.scrapedCreatures.length === 0) {
            logMessage('⚠️ Nenhuma criatura para baixar');
            return;
        }
        autoDownloadChunk();
    }

    function logMessage(msg) {
        console.log(msg);
        const logDiv = document.getElementById('fs-scraper-log');
        if (logDiv) {
            logDiv.innerHTML += `<div>${new Date().toLocaleTimeString()} - ${msg}</div>`;
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════════════════════════════════

    function createUI() {
        const container = document.createElement('div');
        container.id = 'fs-scraper-ui';
        container.innerHTML = `
            <style>
                #fs-scraper-ui {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    width: 400px;
                    background: #1a1a1a;
                    border: 2px solid #4CAF50;
                    border-radius: 8px;
                    padding: 15px;
                    color: #fff;
                    font-family: monospace;
                    z-index: 999999;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
                }
                #fs-scraper-ui h3 {
                    margin: 0 0 10px 0;
                    color: #4CAF50;
                }
                #fs-scraper-ui button {
                    background: #4CAF50;
                    color: white;
                    border: none;
                    padding: 8px 16px;
                    margin: 5px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                }
                #fs-scraper-ui button:hover {
                    background: #45a049;
                }
                #fs-scraper-ui button:disabled {
                    background: #666;
                    cursor: not-allowed;
                }
                #fs-scraper-log {
                    background: #000;
                    padding: 10px;
                    height: 200px;
                    overflow-y: auto;
                    font-size: 11px;
                    margin-top: 10px;
                    border-radius: 4px;
                }
                #fs-scraper-log div {
                    margin-bottom: 3px;
                }
                .fs-stat {
                    margin: 5px 0;
                    font-size: 12px;
                }
                .fs-warning {
                    background: #ff9800;
                    padding: 5px;
                    border-radius: 3px;
                    margin: 5px 0;
                    font-size: 10px;
                }
            </style>
            <h3>🕷️ FS Scraper v2</h3>
            <div>
                <button id="fs-start-btn">▶️ Iniciar</button>
                <button id="fs-stop-btn" disabled>⏸️ Parar</button>
                <button id="fs-download-btn">📥 Download Buffer</button>
                <button id="fs-clear-btn">🗑️ Limpar</button>
            </div>
            <div class="fs-warning">⚠️ Auto-download a cada ${CONFIG.CHUNK_SIZE} criaturas</div>
            <div class="fs-stat">Fase: <span id="fs-phase">idle</span></div>
            <div class="fs-stat">IDs Coletados: <span id="fs-ids-count">0</span></div>
            <div class="fs-stat">Buffer: <span id="fs-buffer-count">0</span></div>
            <div class="fs-stat">Chunks Baixados: <span id="fs-chunks-count">0</span></div>
            <div class="fs-stat">Total Baixado: <span id="fs-total-count">0</span></div>
            <div class="fs-stat">Progresso: <span id="fs-progress">0%</span></div>
            <div id="fs-scraper-log"></div>
        `;
        document.body.appendChild(container);

        document.getElementById('fs-start-btn').addEventListener('click', async () => {
            scraperState.isRunning = true;
            document.getElementById('fs-start-btn').disabled = true;
            document.getElementById('fs-stop-btn').disabled = false;

            if (scraperState.collectedIds.size === 0) {
                await collectCreatureIds();
            }
            if (scraperState.isRunning) {
                await scrapeCreatures();
            }

            scraperState.isRunning = false;
            document.getElementById('fs-start-btn').disabled = false;
            document.getElementById('fs-stop-btn').disabled = true;
        });

        document.getElementById('fs-stop-btn').addEventListener('click', () => {
            scraperState.isRunning = false;
            logMessage('⏸️ Parando...');
        });

        document.getElementById('fs-download-btn').addEventListener('click', downloadCurrentBuffer);

        document.getElementById('fs-clear-btn').addEventListener('click', () => {
            if (confirm('Limpar todos os dados?')) {
                localStorage.removeItem(CONFIG.PROGRESS_KEY);
                scraperState = {
                    phase: 'idle',
                    collectedIds: new Set(),
                    scrapedCreatures: [],
                    currentPage: 0,
                    currentCreatureIndex: 0,
                    isRunning: false,
                    errors: [],
                    downloadedChunks: 0,
                    totalDownloaded: 0
                };
                updateUI();
                logMessage('🗑️ Dados limpos');
            }
        });

        loadProgress();
        updateUI();
        logMessage('✅ Scraper v2 inicializado');
    }

    function updateUI() {
        document.getElementById('fs-phase').textContent = scraperState.phase;
        document.getElementById('fs-ids-count').textContent = scraperState.collectedIds.size;
        document.getElementById('fs-buffer-count').textContent = scraperState.scrapedCreatures.length;
        document.getElementById('fs-chunks-count').textContent = scraperState.downloadedChunks;
        document.getElementById('fs-total-count').textContent = scraperState.totalDownloaded;

        const totalIds = scraperState.collectedIds.size;
        const totalProcessed = scraperState.totalDownloaded + scraperState.scrapedCreatures.length;
        const progress = totalIds > 0 ? ((totalProcessed / totalIds) * 100).toFixed(1) : 0;
        document.getElementById('fs-progress').textContent = `${progress}%`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

})();