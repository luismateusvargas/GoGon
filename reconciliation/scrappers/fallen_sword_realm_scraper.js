// ==UserScript==
// @name         Fallen Sword Realm Mapper
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Maps all realms and master realms for pathfinding
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
        DELAY_BETWEEN_REQUESTS: 500,
        CHUNK_SIZE: 100,
        STORAGE_KEY_PROGRESS: 'fs_realm_mapper_progress',
        STORAGE_KEY_MASTER: 'fs_master_realms_minimal',
        STORAGE_KEY_REALMS: 'fs_realms_minimal'
    };

    // ═══════════════════════════════════════════════════════════════════════
    // ESTADO GLOBAL
    // ═══════════════════════════════════════════════════════════════════════

    let mapperState = {
        phase: 'idle', // idle, collecting_master_ids, scraping_masters, collecting_realm_ids, scraping_realms, completed
        masterRealmIds: new Set(),
        realmIds: new Set(),
        masterRealms: [],
        realms: [],
        currentMasterIndex: 0,
        currentRealmIndex: 0,
        isRunning: false,
        errors: [],
        downloadedChunks: 0
    };

    // ═══════════════════════════════════════════════════════════════════════
    // PARSERS - MASTER REALMS
    // ═══════════════════════════════════════════════════════════════════════

    function parseMasterRealmPage(doc, masterRealmId) {
        const masterRealm = {
            masterRealmId: masterRealmId,
            name: null,
            minLevel: null,
            imageUrl: null,
            connectedRealms: [] // Array de { realmId, realmName, minLevel }
        };

        try {
            // Extrai nome e min level do header
            // Formato: "Elya Desert (Min Level: 5)"
            const headerCell = doc.querySelector('.tHeader b');
            if (headerCell) {
                const headerText = headerCell.textContent.trim();
                const match = headerText.match(/^(.+?)\s*\(Min\s*Level:\s*(\d+)\)$/i);
                if (match) {
                    masterRealm.name = match[1].trim();
                    masterRealm.minLevel = parseInt(match[2]);
                }
            }

            // Extrai imagem do master realm
            const imgElement = doc.querySelector('img[src*="masterrealms/"]');
            if (imgElement) {
                masterRealm.imageUrl = imgElement.src.replace('http://', 'https://');
            }

            // Extrai "Main Realms in this area"
            const realmLinks = doc.querySelectorAll('a[href*="realm_id"]');
            realmLinks.forEach(link => {
                const href = link.getAttribute('href');
                const realmIdMatch = href.match(/realm_id=(\d+)/);

                if (realmIdMatch) {
                    const realmId = parseInt(realmIdMatch[1]);
                    const realmName = link.textContent.trim();

                    // Min level pode estar na próxima célula
                    const parent = link.closest('tr');
                    let minLevel = null;
                    if (parent) {
                        const cells = parent.querySelectorAll('td');
                        if (cells.length > 1) {
                            const levelText = cells[1].textContent.trim();
                            const levelMatch = levelText.match(/(\d+)/);
                            if (levelMatch) {
                                minLevel = parseInt(levelMatch[1]);
                            }
                        }
                    }

                    masterRealm.connectedRealms.push({
                        realmId,
                        realmName,
                        minLevel
                    });
                }
            });

        } catch (error) {
            logMessage(`⚠️ Erro ao parsear master realm ${masterRealmId}: ${error.message}`);
            mapperState.errors.push({ masterRealmId, error: error.message });
        }

        return masterRealm;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PARSERS - REALMS
    // ═══════════════════════════════════════════════════════════════════════

    function parseRealmPage(doc, realmId) {
        const realm = {
            realmId: realmId,
            name: null,
            minLevel: null,
            shops: [],
            relics: [],
            quests: [],
            creatures: [],
            stairways: [] // Array de { targetRealmId, targetRealmName, x, y }
        };

        try {
            // Extrai nome e min level do header
            // Formato: "MOUNTAIN PATH (Min Level: 1)"
            const headerCell = doc.querySelector('.tHeader b');
            if (headerCell) {
                const headerText = headerCell.textContent.trim();
                const match = headerText.match(/^(.+?)\s*\(Min\s*Level:\s*(\d+)\)$/i);
                if (match) {
                    realm.name = match[1].trim();
                    realm.minLevel = parseInt(match[2]);
                }
            }

            // Extrai Shops
            const shopLinks = doc.querySelectorAll('a[href*="shop_id"]');
            shopLinks.forEach(link => {
                const shopIdMatch = link.href.match(/shop_id=(\d+)/);
                if (shopIdMatch) {
                    realm.shops.push({
                        shopId: parseInt(shopIdMatch[1]),
                        shopName: link.textContent.trim()
                    });
                }
            });

            // Extrai Relics
            const relicLinks = doc.querySelectorAll('a[href*="relic_id"]');
            relicLinks.forEach(link => {
                const relicIdMatch = link.href.match(/relic_id=(\d+)/);
                if (relicIdMatch) {
                    realm.relics.push({
                        relicId: parseInt(relicIdMatch[1]),
                        relicName: link.textContent.trim()
                    });
                }
            });

            // Extrai Quests
            const questLinks = doc.querySelectorAll('a[href*="quest_id"]');
            questLinks.forEach(link => {
                const questIdMatch = link.href.match(/quest_id=(\d+)/);
                if (questIdMatch) {
                    realm.quests.push({
                        questId: parseInt(questIdMatch[1]),
                        questName: link.textContent.trim()
                    });
                }
            });

            // Extrai Creatures
            const creatureLinks = doc.querySelectorAll('a[href*="creature_id"]');
            const creatureSet = new Set(); // Evita duplicatas

            creatureLinks.forEach(link => {
                const creatureIdMatch = link.href.match(/creature_id=(\d+)/);
                if (creatureIdMatch) {
                    const creatureId = parseInt(creatureIdMatch[1]);
                    if (!creatureSet.has(creatureId)) {
                        creatureSet.add(creatureId);

                        // Texto pode ser: "Snow Leopard (Feline)"
                        const fullText = link.textContent.trim();
                        let creatureName = fullText;
                        let creatureClass = null;

                        // Tenta extrair classe entre parênteses
                        const parent = link.parentNode;
                        if (parent) {
                            const parentText = parent.textContent.trim();
                            const classMatch = parentText.match(/\(([^)]+)\)\s*$/);
                            if (classMatch) {
                                creatureClass = classMatch[1];
                                creatureName = fullText;
                            }
                        }

                        realm.creatures.push({
                            creatureId,
                            creatureName,
                            creatureClass
                        });
                    }
                }
            });

            // Extrai Stairways do mapa visual
            // Stairways aparecem como <a href="...realm_id=X"><img src="...stairways/..."></a>
            const stairwayLinks = doc.querySelectorAll('a[href*="realm_id"] img[src*="stairways"]');

            stairwayLinks.forEach(img => {
                const link = img.closest('a');
                if (link) {
                    const href = link.getAttribute('href');
                    const realmIdMatch = href.match(/realm_id=(\d+)/);

                    if (realmIdMatch) {
                        const targetRealmId = parseInt(realmIdMatch[1]);

                        // Extrai nome do tooltip (onmouseover)
                        let targetRealmName = null;
                        const onmouseover = img.getAttribute('onmouseover');
                        if (onmouseover) {
                            const nameMatch = onmouseover.match(/Stairway to (.+?)['"]?\)/);
                            if (nameMatch) {
                                targetRealmName = nameMatch[1];
                            }
                        }

                        // Tenta encontrar coordenadas (x, y) - isso é mais complexo
                        // As imagens estão em uma grid, mas não têm coordenadas explícitas
                        // Vamos deixar null por enquanto, ou calcular pela posição na tabela

                        realm.stairways.push({
                            targetRealmId,
                            targetRealmName,
                            x: null, // Pode ser calculado posteriormente
                            y: null
                        });
                    }
                }
            });

            // Remove duplicatas de stairways
            const stairwaySet = new Set();
            realm.stairways = realm.stairways.filter(s => {
                const key = s.targetRealmId;
                if (stairwaySet.has(key)) return false;
                stairwaySet.add(key);
                return true;
            });

        } catch (error) {
            logMessage(`⚠️ Erro ao parsear realm ${realmId}: ${error.message}`);
            mapperState.errors.push({ realmId, error: error.message });
        }

        return realm;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1: COLETAR MASTER REALM IDs
    // ═══════════════════════════════════════════════════════════════════════

    async function collectMasterRealmIds() {
        logMessage('🔍 Fase 1: Coletando Master Realm IDs...');
        mapperState.phase = 'collecting_master_ids';

        const MAX_INDEX = 15;
        let totalFound = 0;

        for (let pageIndex = 0; pageIndex < MAX_INDEX; pageIndex++) {
            if (!mapperState.isRunning) {
                logMessage('⏸️ Coleta pausada');
                saveProgress();
                return;
            }

            try {
                // 🔧 FIX: Usar backticks para template string
                const url = `https://guide.fallensword.com/index.php?cmd=masterrealms&index=${pageIndex}`;

                logMessage(`   📄 Buscando página ${pageIndex}/${MAX_INDEX}...`);

                const response = await fetch(url);

                // Validar resposta HTTP
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const html = await response.text();

                // Validar se HTML não está vazio
                if (!html || html.length < 100) {
                    logMessage(`⚠️ Página ${pageIndex} retornou HTML inválido ou vazio`);
                    continue;
                }

                // Extrair IDs usando regex
                const regex = /masterrealm_id=(\d+)/g;
                const matches = [...html.matchAll(regex)];

                let foundInPage = 0;
                for (const match of matches) {
                    const realmId = parseInt(match[1], 10);
                    if (!mapperState.masterRealmIds.has(realmId)) {
                        mapperState.masterRealmIds.add(realmId);
                        foundInPage++;
                    }
                }

                totalFound += foundInPage;
                logMessage(`   ✅ Página ${pageIndex}: ${foundInPage} novos IDs | Total: ${mapperState.masterRealmIds.size}`);

                // Se última página não retornou IDs, pode ter acabado
                if (foundInPage === 0 && pageIndex > 2) {
                    logMessage(`   ℹ️ Nenhum ID novo na página ${pageIndex}, mas continuando até ${MAX_INDEX}...`);
                }

                await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);

            } catch (error) {
                logMessage(`❌ Erro na página ${pageIndex}: ${error.message}`);
                mapperState.errors.push({
                    phase: 'collecting_master_ids',
                    pageIndex,
                    error: error.message
                });
            }
        }

        // Validação final crítica
        if (mapperState.masterRealmIds.size === 0) {
            throw new Error('❌ FATAL: Nenhum Master Realm ID foi coletado! Verifique a estrutura do HTML ou a URL.');
        }

        logMessage(`✅ Coleta completa: ${mapperState.masterRealmIds.size} Master Realm IDs únicos`);
        saveProgress();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2: SCRAPING MASTER REALMS
    // ═══════════════════════════════════════════════════════════════════════

    async function scrapeMasterRealms() {
        logMessage('🗺️ Fase 2: Scraping Master Realms...');
        mapperState.phase = 'scraping_masters';

        // Validação antes de iniciar scraping
        if (mapperState.masterRealmIds.size === 0) {
            logMessage('❌ Nenhum ID para scraping. Execute collectMasterRealmIds() primeiro.');
            return;
        }

        const idsArray = Array.from(mapperState.masterRealmIds).sort((a, b) => a - b);
        const totalIds = idsArray.length;

        logMessage(`   📊 Total de IDs para processar: ${totalIds}`);

        for (let i = mapperState.currentMasterIndex; i < totalIds; i++) {
            if (!mapperState.isRunning) {
                logMessage('⏸️ Scraping pausado');
                saveProgress();
                return;
            }

            const masterRealmId = idsArray[i];
            mapperState.currentMasterIndex = i;

            try {
                const url = `https://guide.fallensword.com/index.php?cmd=masterrealms&subcmd=view&masterrealm_id=${masterRealmId}`;

                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = await response.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

                const masterRealm = parseMasterRealmPage(doc, masterRealmId);
                mapperState.masterRealms.push(masterRealm);

                // Log a cada 5 processados
                if ((i + 1) % 5 === 0) {
                    logMessage(`   ⚙️ Processados: ${i + 1}/${totalIds} (${((i + 1) / totalIds * 100).toFixed(1)}%)`);
                }

            } catch (error) {
                logMessage(`❌ Erro no master_realm_id ${masterRealmId}: ${error.message}`);
                mapperState.errors.push({
                    phase: 'scraping_masters',
                    masterRealmId,
                    error: error.message
                });
            }

            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
        }

        // Download final
        if (mapperState.masterRealms.length > 0) {
            downloadJSON(mapperState.masterRealms, 'master_realms.json');
            logMessage(`✅ Scraping completo! ${mapperState.masterRealms.length} Master Realms extraídos`);
        } else {
            logMessage('⚠️ Nenhum Master Realm foi scraped com sucesso');
        }

        mapperState.currentMasterIndex = 0;
        saveProgress();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 3: COLETAR REALM IDs
    // ═══════════════════════════════════════════════════════════════════════

    async function collectRealmIds() {
        logMessage('🔍 Fase 3: Coletando Realm IDs...');
        mapperState.phase = 'collecting_realm_ids';

        try {
            // O index de realms tem paginação
            let pageIndex = 0;
            let hasMore = true;

            while (hasMore) {
                const url = `https://guide.fallensword.com/index.php?cmd=realms&index=${pageIndex}`;
                const response = await fetch(url);
                const html = await response.text();

                const matches = Array.from(html.matchAll(/realm_id=(\d+)/g));

                if (matches.length === 0 || pageIndex === 281) {
                    hasMore = false;
                } else {
                    matches.forEach(match => {
                        mapperState.realmIds.add(parseInt(match[1]));
                    });

                    if (pageIndex % 10 === 0) {
                        logMessage(`   Página ${pageIndex}: ${mapperState.realmIds.size} realm IDs`);
                    }

                    pageIndex++;
                    await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
                }
            }

            logMessage(`✅ ${mapperState.realmIds.size} Realm IDs coletados`);

        } catch (error) {
            logMessage(`❌ Erro ao coletar Realm IDs: ${error.message}`);
            mapperState.errors.push({ phase: 'collecting_realm_ids', error: error.message });
        }

        saveProgress();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 4: SCRAPING REALMS
    // ═══════════════════════════════════════════════════════════════════════

    async function scrapeRealms() {
        logMessage('🗺️ Fase 4: Scraping Realms...');
        mapperState.phase = 'scraping_realms';

        const idsArray = Array.from(mapperState.realmIds).sort((a, b) => a - b);

        for (let i = mapperState.currentRealmIndex; i < idsArray.length; i++) {
            if (!mapperState.isRunning) {
                logMessage('⏸️ Scraping pausado');
                saveProgress();
                return;
            }

            const realmId = idsArray[i];
            mapperState.currentRealmIndex = i;

            try {
                const url = `https://guide.fallensword.com/index.php?cmd=realms&subcmd=view&realm_id=${realmId}`;

                const response = await fetch(url);
                const html = await response.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

                const realm = parseRealmPage(doc, realmId);
                mapperState.realms.push(realm);

                // Auto-download a cada CHUNK_SIZE
                if (mapperState.realms.length >= CONFIG.CHUNK_SIZE) {
                    autoDownloadRealmChunk();
                    saveProgress();
                }

                if ((i + 1) % 10 === 0) {
                    logMessage(`   Realms: ${i + 1}/${idsArray.length}`);
                    updateUI();
                }

            } catch (error) {
                logMessage(`❌ Erro no realm_id ${realmId}: ${error.message}`);
                mapperState.errors.push({ realmId, error: error.message });
            }

            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
        }

        // Download final
        if (mapperState.realms.length > 0) {
            autoDownloadRealmChunk();
        }

        mapperState.phase = 'completed';
        logMessage(`✅ Scraping completo!`);
        saveProgress();
        updateUI();
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
        a.click();
        URL.revokeObjectURL(url);
        logMessage(`📥 ${filename} baixado`);
    }

    function autoDownloadRealmChunk() {
        const chunkNumber = mapperState.downloadedChunks + 1;
        downloadJSON(mapperState.realms, `realms_chunk_${chunkNumber}.json`);

        mapperState.realms = [];
        mapperState.downloadedChunks = chunkNumber;
    }

    function saveProgress() {
        try {
            const minimalData = {
                masterRealmIds: Array.from(mapperState.masterRealmIds),
                realmIds: Array.from(mapperState.realmIds),
                currentMasterIndex: mapperState.currentMasterIndex,
                currentRealmIndex: mapperState.currentRealmIndex,
                downloadedChunks: mapperState.downloadedChunks,
                phase: mapperState.phase,
                errors: mapperState.errors
            };
            localStorage.setItem(CONFIG.STORAGE_KEY_PROGRESS, JSON.stringify(minimalData));
        } catch (error) {
            logMessage(`⚠️ Erro ao salvar progresso: ${error.message}`);
        }
    }

    function loadProgress() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY_PROGRESS);
            if (saved) {
                const data = JSON.parse(saved);
                mapperState.masterRealmIds = new Set(data.masterRealmIds || []);
                mapperState.realmIds = new Set(data.realmIds || []);
                mapperState.currentMasterIndex = data.currentMasterIndex || 0;
                mapperState.currentRealmIndex = data.currentRealmIndex || 0;
                mapperState.downloadedChunks = data.downloadedChunks || 0;
                mapperState.phase = data.phase || 'idle';
                mapperState.errors = data.errors || [];
                logMessage('✅ Progresso carregado');
            }
        } catch (error) {
            logMessage(`⚠️ Erro ao carregar progresso: ${error.message}`);
        }
    }

    function logMessage(msg) {
        console.log(msg);
        const logDiv = document.getElementById('fs-mapper-log');
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
        container.id = 'fs-mapper-ui';
        container.innerHTML = `
            <style>
                #fs-mapper-ui {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    width: 400px;
                    background: #1a1a1a;
                    border: 2px solid #2196F3;
                    border-radius: 8px;
                    padding: 15px;
                    color: #fff;
                    font-family: monospace;
                    z-index: 999999;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
                }
                #fs-mapper-ui h3 {
                    margin: 0 0 10px 0;
                    color: #2196F3;
                }
                #fs-mapper-ui button {
                    background: #2196F3;
                    color: white;
                    border: none;
                    padding: 8px 16px;
                    margin: 5px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                }
                #fs-mapper-ui button:hover {
                    background: #1976D2;
                }
                #fs-mapper-ui button:disabled {
                    background: #666;
                    cursor: not-allowed;
                }
                #fs-mapper-log {
                    background: #000;
                    padding: 10px;
                    height: 200px;
                    overflow-y: auto;
                    font-size: 11px;
                    margin-top: 10px;
                    border-radius: 4px;
                }
                #fs-mapper-log div {
                    margin-bottom: 3px;
                }
                .fs-stat {
                    margin: 5px 0;
                    font-size: 12px;
                }
            </style>
            <h3>🗺️ FS Realm Mapper</h3>
            <div>
                <button id="fs-map-start-btn">▶️ Iniciar</button>
                <button id="fs-map-stop-btn" disabled>⏸️ Parar</button>
                <button id="fs-map-clear-btn">🗑️ Limpar</button>
            </div>
            <div class="fs-stat">Fase: <span id="fs-map-phase">idle</span></div>
            <div class="fs-stat">Master Realms: <span id="fs-map-masters">0</span></div>
            <div class="fs-stat">Realms: <span id="fs-map-realms">0</span></div>
            <div class="fs-stat">Chunks: <span id="fs-map-chunks">0</span></div>
            <div id="fs-mapper-log"></div>
        `;
    document.body.appendChild(container);

    document.getElementById('fs-map-start-btn').addEventListener('click', async () => {
        mapperState.isRunning = true;
        document.getElementById('fs-map-start-btn').disabled = true;
        document.getElementById('fs-map-stop-btn').disabled = false;

        // Pipeline completo
        if (mapperState.masterRealmIds.size === 0) {
            await collectMasterRealmIds();
        }
        if (mapperState.isRunning && mapperState.currentMasterIndex < mapperState.masterRealmIds.size) {
            await scrapeMasterRealms();
        }
        if (mapperState.isRunning && mapperState.realmIds.size === 0) {
            await collectRealmIds();
        }
        if (mapperState.isRunning) {
            await scrapeRealms();
        }

        mapperState.isRunning = false;
        document.getElementById('fs-map-start-btn').disabled = false;
        document.getElementById('fs-map-stop-btn').disabled = true;
    });

    document.getElementById('fs-map-stop-btn').addEventListener('click', () => {
        mapperState.isRunning = false;
        logMessage('⏸️ Parando...');
    });

    document.getElementById('fs-map-clear-btn').addEventListener('click', () => {
        if (confirm('Limpar todos os dados?')) {
            localStorage.removeItem(CONFIG.STORAGE_KEY_PROGRESS);
            mapperState = {
                phase: 'idle',
                masterRealmIds: new Set(),
                realmIds: new Set(),
                masterRealms: [],
                realms: [],
                currentMasterIndex: 0,
                currentRealmIndex: 0,
                isRunning: false,
                errors: [],
                downloadedChunks: 0
            };
            updateUI();
            logMessage('🗑️ Dados limpos');
        }
    });

    loadProgress();
    updateUI();
    logMessage('✅ Realm Mapper inicializado');
}

    function updateUI() {
        document.getElementById('fs-map-phase').textContent = mapperState.phase;
        document.getElementById('fs-map-masters').textContent = mapperState.masterRealmIds.size;
        document.getElementById('fs-map-realms').textContent = mapperState.realmIds.size;
        document.getElementById('fs-map-chunks').textContent = mapperState.downloadedChunks;
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