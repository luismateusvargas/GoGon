// ==UserScript==
// @name         Trocar Sets Aleatoriamente
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Troca aleatoriamente os sets em um intervalo de tempo definido pelo usuário
// @author       Você
// @match        https://www.fallensword.com/index.php*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // Seletor CSS do elemento select
    var selectElement = document.querySelector("#profileCombatSetDiv > table:nth-child(1) > tbody:nth-child(4) > tr:nth-child(1) > td:nth-child(1) > select:nth-child(1)");

    // Filtra os elementos <option> para incluir apenas sets (ignora o primeiro)
    var sets = Array.from(selectElement.options)
        .slice(1)  // Ignora o primeiro elemento
        .map(option => ({
            name: option.text,
            value: option.value
        }));

    // Variável para controlar se a troca automática está em andamento
    var trocaAutomaticaAtiva = false;
    var intervaloTroca;

    // Armazena o conjunto atualmente selecionado
    var conjuntoAtual;

    // Adiciona um botão de Início/Fim
    var botaoInicioFim = document.createElement("button");
    botaoInicioFim.textContent = "Início";
    botaoInicioFim.id = "botaoInicioFim";

    // Adiciona estilos ao botão
    GM_addStyle(`
        #botaoInicioFim {
            position: fixed;
            top: 30px; /* Ajuste para compensar a barra fixa */
            left: 10px;
            background-color: #4CAF50;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            z-index: 10000; /* Garante que o botão esteja acima do campo de inserção de tempo */
        }
        #botaoInicioFim:hover {
            background-color: #45a049;
        }
    `);

    document.body.appendChild(botaoInicioFim);

    // Adiciona um campo de inserção para o tempo de atualização
    var campoTempoAtualizacao = document.createElement("input");
    campoTempoAtualizacao.type = "number";
    campoTempoAtualizacao.placeholder = "Tempo (segundos)";
    campoTempoAtualizacao.id = "campoTempoAtualizacao";

    // Adiciona estilos ao campo de inserção
    GM_addStyle(`
        #campoTempoAtualizacao {
            position: fixed;
            top: 30px; /* Ajuste para compensar a barra fixa */
            left: 80px; /* Ajuste para evitar sobreposição com o botão de Início/Fim */
            padding: 10px;
            font-size: 14px;
            z-index: 10000; /* Garante que o campo esteja acima do botão de Início/Fim */
        }
    `);

    document.body.appendChild(campoTempoAtualizacao);

    // Verifica se há mais de 1 set antes de criar o menu
    if (sets.length > 1) {
        // Cria um menu com uma lista de sets
        function criarMenuSets() {
            // Cria um div para o menu
            var menuDiv = document.createElement("div");
            menuDiv.id = "trocarSetsMenu";

            // Cria uma lista não ordenada (ul) para os sets
            var listaSets = document.createElement("ul");

            // Adiciona cada set à lista
            sets.forEach(function(set) {
                var itemLista = document.createElement("li");
                itemLista.textContent = set.name;
                itemLista.dataset.value = set.value; // Armazena o valor no atributo de dados

                // Adiciona um evento de clique para alterar a cor e selecionar/deselecionar
                itemLista.addEventListener('click', function() {
                    if (itemLista.classList.contains('selecionado')) {
                        itemLista.classList.remove('selecionado');
                        itemLista.style.color = '#000';
                    } else {
                        itemLista.classList.add('selecionado');
                        itemLista.style.color = '#FF0000'; // Cor vermelha como exemplo, ajuste conforme necessário
                    }
                });

                listaSets.appendChild(itemLista);
            });

            // Adiciona a lista ao menu
            menuDiv.appendChild(listaSets);

            // Adiciona estilos ao menu
            GM_addStyle(`
                #trocarSetsMenu {
                    position: fixed;
                    top: 70px; /* Ajuste para compensar a barra fixa e espaço para os botões e campo de inserção */
                    left: 10px;
                    background-color: #fff;
                    padding: 10px;
                    border: 1px solid #ccc;
                    z-index: 9999;
                }
                #trocarSetsMenu ul {
                    list-style-type: none;
                    padding: 0;
                }
                #trocarSetsMenu li {
                    cursor: pointer;
                    margin-bottom: 5px;
                    color: #000; /* Cor da fonte escura */
                    transition: color 0.3s ease; /* Adiciona uma transição suave para a mudança de cor */
                }
                #trocarSetsMenu li:hover {
                    background-color: #eee; /* Cor de fundo ao passar o mouse */
                }
                #trocarSetsMenu li.selecionado {
                    color: #FF0000; /* Cor quando selecionado */
                }
            `);

            // Adiciona o menu à página
            document.body.appendChild(menuDiv);
        }

        // Cria o menu na inicialização
        criarMenuSets();

        // Adiciona um evento de clique ao botão
        botaoInicioFim.addEventListener('click', function() {
            if (trocaAutomaticaAtiva) {
                // Se a troca automática estiver ativa, interrompe o processo
                clearInterval(intervaloTroca);
                botaoInicioFim.textContent = "Início";
            } else {
                // Se não estiver ativa, inicia o processo de troca automática
                var tempoAtualizacao = parseInt(campoTempoAtualizacao.value, 10) || 3; // Valor padrão é 3 segundos
                if (tempoAtualizacao < 1) tempoAtualizacao = 1; // Garante que o tempo mínimo seja 1 segundo
                intervaloTroca = setInterval(trocarSetAleatoriamente, tempoAtualizacao * 1000);
                botaoInicioFim.textContent = "Fim";
            }
            // Alterna o estado da troca automática
            trocaAutomaticaAtiva = !trocaAutomaticaAtiva;
        });

        // Função para trocar o set aleatoriamente
        async function trocarSetAleatoriamente() {
            // Filtra os sets selecionados
            var setsSelecionados = Array.from(document.querySelectorAll('#trocarSetsMenu li.selecionado'))
                .map(item => ({ name: item.textContent, value: item.dataset.value }));

            if (setsSelecionados.length === 0) {
                console.log("Nenhum set selecionado.");
                return;
            }

            // Escolhe aleatoriamente um set entre os selecionados, evitando repetição
            var setSelecionado;
            do {
                setSelecionado = setsSelecionados[Math.floor(Math.random() * setsSelecionados.length)];
            } while (setSelecionado.value === conjuntoAtual);

            // Armazena o conjunto atual
            conjuntoAtual = setSelecionado.value;

            // Monta o URL com o combatSetId escolhido
            var url = `https://www.fallensword.com/index.php?cmd=profile&subcmd=managecombatset&combatSetId=${setSelecionado.value}&submit=Use`;

            try {
                // Realiza a requisição fetch
                var resposta = await fetch(url);

                if (resposta.ok) {
                    console.log(`Set trocado para: ${setSelecionado.name}`);
                } else {
                    console.error(`Erro ao trocar o set. Status: ${resposta.status}`);
                }
            } catch (erro) {
                console.error("Erro na requisição fetch:", erro);
            }
        }

    }
})();
