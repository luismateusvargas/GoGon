Com certeza. Aqui está um resumo completo e estruturado, ideal para ser o `README.md` do seu projeto no GitHub.

Ele foi projetado para dar a qualquer visitante — seja um usuário ou um desenvolvedor — uma compreensão clara do que o projeto faz, suas principais características e como colocá-lo para funcionar.

-----

# SWS - Automação para Fallen Sword

SWS é uma poderosa ferramenta de automação e monitoramento em Node.js para o jogo web Fallen Sword. Ele opera em duas frentes principais: um motor de monitoramento que observa eventos no jogo e um bot de Discord interativo que permite aos usuários executar ações e consultar informações.

## ✨ Principais Funcionalidades

### Monitoramento de Eventos em Tempo Real

O motor de automação monitora o jogo continuamente e envia notificações detalhadas para canais específicos do Discord para eventos como:

  - **Bounties:** Anuncia novas bounties com informações enriquecidas do alvo (nível, ouro, buffs ativos).
  - **Conflitos de Guilda (GvG):** Posta uma mensagem **viva** que é editada em tempo real para refletir o placar e o status da batalha.
  - **Relíquias:** Notifica sobre a captura, perda, defesa bem-sucedida ou falha de ataque a relíquias, com mensagens contextuais.
  - **Super Elites & Titãs:** Alerta quando Super Elites são derrotados ou Titãs são avistados, mostrando informações da criatura e localização.
  - **Itens (Crates) e Notícias:** Anuncia quando caixas de itens são encontradas e replica notícias e atualizações do jogo.
  - **Chats do Jogo:** Atua como uma ponte, replicando mensagens do Shoutbox e do Chat da Guilda no Discord.

### Bot de Discord Interativo

Usuários podem interagir com o jogo através de um conjunto de comandos de barra (`/`):

  - **/buff & /bebuff:** Lança buffs em um ou mais alvos no jogo. A versão `/bebuff` utiliza poções de *Buff Enhancer* automaticamente.
  - **/checkbuffs:** Verifica os buffs ativos em qualquer jogador, com uma interface de **paginação** interativa para longas listas.
  - **/guide:** Uma mini-aplicação de busca dentro do Discord que permite pesquisar no site *Fallen Sword Guide* com filtros dinâmicos, menus e botões.
  - **/gvgcooldown:** Informa o tempo restante de cooldown contra guildas rivais após um conflito.

### Automação de "Qualidade de Vida" (QoL)

  - **Troca de Equipamento Automática:** Troca inteligentemente o equipamento do personagem entre um conjunto de "guerra" e um de "paz", baseado no status de conflito da guilda.
  - **Entrada Automática em Grupos:** Garante que o personagem sempre participe dos grupos de guilda disponíveis.

## 🚀 Arquitetura

O SWS é construído com uma arquitetura modular e resiliente, focada em eficiência e manutenibilidade.

  - **Motor de Tarefas (`engine.js`):** Um scheduler central que gerencia todos os módulos de monitoramento (`app_modules`).
  - **Gerenciador de Sessão (`session.mjs`):** Lida com a autenticação (incluindo SSO) e garante que a sessão com o jogo permaneça sempre ativa, com lógica de reautenticação automática.
  - **Camada de Persistência (`sws_database.js`):** Utiliza um banco de dados **SQLite** local para dois propósitos:
    1.  **Gerenciamento de Estado:** Armazena os IDs de eventos já processados para evitar notificações duplicadas.
    2.  **Cache de Dados do Jogo:** Mantém uma cópia local de dados como itens, criaturas e reinos para enriquecer as notificações de forma rápida e eficiente, sem a necessidade de chamadas de API extras.
  - **Design Resiliente:** A comunicação com a API do jogo é feita através de uma função `secureFetch` que detecta sessões expiradas, tenta relogar automaticamente e refaz a requisição.

## 🛠️ Tecnologias Utilizadas

  - **Runtime:** Node.js
  - **Banco de Dados:** SQLite (`better-sqlite3`)
  - **Interação com Discord:** `discord.js` v14
  - **Web Scraping & Sessão:** `fetch-cookie`, `tough-cookie`, `cheerio`
  - **Gerenciamento de Ambiente:** `dotenv`

## ⚙️ Instalação e Configuração

### Pré-requisitos

  - Node.js (v18 ou superior)

### Passos para Instalação

1.  Clone este repositório:
    ```bash
    git clone https://github.com/ColonelReaper/Shiv-s-Wall-of-Sayings---SWS.git
    cd [NOME_DA_PASTA]
    ```
2.  Instale as dependências:
    ```bash
    npm install
    ```
3.  Crie o seu arquivo de configuração a partir do exemplo:
    ```bash
    cp .env.example .env
    ```
4.  Edite o arquivo `.env` com suas credenciais (veja abaixo).
5.  Inicie a aplicação:
    ```bash
    npm start
    ```
    ou
    ```bash
    node app.mjs
    ```

### Variáveis de Ambiente (`.env`)

Você **precisa** preencher estas variáveis no arquivo `.env` para que a aplicação funcione:

```ini
# --- Credenciais do Jogo ---
SWS_EMAIL="seu_email@exemplo.com"
SWS_PASSWORD="sua_senha"

# --- Credenciais do Bot do Discord ---
DISCORD_TOKEN="token_do_seu_bot"
DISCORD_APP_ID="id_da_aplicacao_do_seu_bot"
DISCORD_GUILD_ID="id_do_seu_servidor_discord"

# --- Configuração do Personagem (para automações) ---
SWS_BOT_CHARACTER="NomeExatoDoSeuPersonagem"
SWS_BOT_ID_CHARACTER="ID_numerico_do_seu_personagem"
SWS_GUILD_NAME="NomeExatoDaSuaGuilda"
```

### Configuração Adicional

A automação de **Troca de Equipamento Automática** requer configuração manual dos IDs de inventário dos seus itens diretamente no arquivo `app_modules/QoL.js`, nas constantes `PEACE_GEAR_INVENTORY_IDS` e `WAR_GEAR_INVENTORY_IDS`.
