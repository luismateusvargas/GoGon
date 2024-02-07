// ==UserScript==
// @name         Easy Hunter
// @version      0.5
// @description  it hunts
// @author       Zuco
// @match        https://www.fallensword.com/index.php?cmd=world
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // Variável de controle para ativar/desativar o script
    var scriptEnabled = false;
    var creatureName = '';

    // Função para encontrar e atacar criaturas
    async function attackCreatures(creatureName) {
        if (!creatureName) {
            console.log('Creature name not specified.');
            return;
        }

        // Continua verificando enquanto o script está ativado
        while (scriptEnabled) {
            // Verificar se a última criatura atacada está presente na lista
            var lastAttackedCreature = GM_getValue('lastAttackedCreature', '');

            if (lastAttackedCreature && !isCreatureInActionList(lastAttackedCreature)) {
                console.log('Last attacked creature', lastAttackedCreature, 'not found in the action list.');
                toggleScript();
                break;
            }

            // Encontrar o elemento da lista de ações
            var actionList = document.getElementById('actionList');

            if (actionList) {
                // Verificar se a criatura que você deseja atacar está presente na lista
                if (!isCreatureInActionList(creatureName)) {
                    console.log('Creature', creatureName, 'not found in the action list.');
                    toggleScript();
                    break;
                }

                // Encontrar os elementos li que representam as criaturas
                var creatureItems = actionList.querySelectorAll('.actionListItem.creature');

                // Iterar sobre os elementos li
                for (var i = 0; i < creatureItems.length; i++) {
                    var creatureItem = creatureItems[i];

                    // Verificar se o nome da criatura corresponde ao desejado
                    var creatureHeader = creatureItem.querySelector('.header');
                    var creatureNameElement = creatureHeader ? creatureHeader.textContent.trim() : '';

                    // Verificar se o nome da criatura contém o nome desejado
                    if (creatureNameElement.includes(creatureName)) {
                        // A criatura desejada foi encontrada, encontrar e clicar no botão de ataque
                        var attackButton = creatureItem.querySelector('.verb.attack');

                        if (attackButton) {
                            attackButton.click();
                            console.log('Attacking', creatureName);

                            // Armazenar o nome da criatura atacada no cache
                            GM_setValue('lastAttackedCreature', creatureName);
                        }
                    }
                }
            } else {
                console.log('Element #actionList not found.');
            }

            // Se não houver mais criaturas na lista, clique no botão de atualização
            refreshActionList();

            // Aguarda 1 segundo antes de verificar novamente
            await sleep(1000);
        }
    }

    // Função para verificar se a criatura está presente na lista de ações
    function isCreatureInActionList(creatureName) {
        var actionList = document.getElementById('actionList');
        if (!actionList) return false;

        var creatureItems = actionList.querySelectorAll('.actionListItem.creature');
        return Array.from(creatureItems).some(item => item.textContent.includes(creatureName));
    }

    // Função para atualizar a action list
    function refreshActionList() {
        var refreshButton = document.querySelector('.actionListHeaderButton.refresh');

        if (refreshButton) {
            var currentTime = new Date().toLocaleTimeString();
            refreshButton.click();
            console.log('Action list updated at', currentTime);
        } else {
            console.log('Refresh button not found.');
        }
    }

    // Função para alternar entre ativar e desativar o script
    function toggleScript() {
        scriptEnabled = !scriptEnabled;
        console.log('Script', scriptEnabled ? 'activated' : 'deactivated');
        attackCreatures(creatureName);
    }

    // Função para processar a inserção do nome da criatura
    function processCreatureName() {
        creatureName = prompt('Insert Creature Name:');

        if (creatureName) {
            attackCreatures(creatureName);
        } else {
            console.log('Canceled or Invalid.');
        }
    }

    // Criação do botão de ativação/desativação
    var toggleButton = document.createElement('button');
    toggleButton.innerHTML = 'Toggle Script';
    toggleButton.style.position = 'fixed';
    toggleButton.style.top = '40px';
    toggleButton.style.right = '10px';
    toggleButton.addEventListener('click', toggleScript);
    document.body.appendChild(toggleButton);

    // Criação do botão para inserir o nome da criatura
    var creatureNameButton = document.createElement('button');
    creatureNameButton.innerHTML = 'Creature Name';
    creatureNameButton.style.position = 'fixed';
    creatureNameButton.style.top = '65px';
    creatureNameButton.style.right = '10px';
    creatureNameButton.addEventListener('click', processCreatureName);
    document.body.appendChild(creatureNameButton);

    // Função de pausa para aguardar antes de verificar novamente
    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();
