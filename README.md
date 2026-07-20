<div align="center">

# 🤖 Cogni

### A tutora de IA que vira gente — com voz, visão e um robô de verdade

*Uma amiga inteligente pra criança estudar, conversar e aprender brincando.*
**Projeto de TCC — UNASP São Paulo · 2026**

</div>

---

## 👋 O que é o Cogni, em uma frase

O **Cogni** é uma assistente de inteligência artificial com **personalidade de gente** (a "Cogni", uma jovem paulistana de 22 anos 😄) que conversa **por voz**, **enxerga pela câmera**, **lembra de você** entre as conversas, **pesquisa na internet** quando precisa de algo atual, e **ensina idiomas** no seu ritmo. E o melhor: ela mora num **robô físico** que fala e escuta de verdade. 🦾

Pensa numa mistura de **professor particular + amigo de chamada de vídeo**, só que paciente infinito, disponível 24h e que nunca te faz sentir burro. 💜

E pros pais existe o **Cogni Companion** 📱 — um app web (o "diário escolar da era da IA") onde a família acompanha as conversas, vê as matérias e tópicos estudados, monta **planos de estudo** que a Cogni segue, e recebe um **resumo carinhoso da semana** escrito pela própria Cogni. O robô roda local; o Companion vive na nuvem; e os dois conversam pelo **Supabase**. (Detalhes técnicos em [`docs/COMPANION-PLANO-TECNICO.md`](docs/COMPANION-PLANO-TECNICO.md) e a visão em [`docs/APP-COMPANION.md`](docs/APP-COMPANION.md).)

---

## ✨ O que ela sabe fazer

| 🎁 Recurso | 💬 Na prática |
| --- | --- |
| 🎙️ **Conversa por voz** | Você fala, ela responde falando. Detecta sozinha quando você terminou de falar (não precisa segurar botão). |
| ✋ **Interrupção natural** | Falou por cima dela? Ela para na hora e te escuta — igual numa conversa de verdade. |
| 👁️ **Visão pela câmera** | Mostra o dever de casa, um desenho, um objeto… ela vê e te ajuda com aquilo. |
| 🧠 **Memória de verdade** | Lembra seu nome, sua idade, suas matérias, seus hobbies — conversa a conversa, sem você repetir. |
| 🌍 **Pesquisa na web** | Quando a pergunta é sobre algo **atual** (notícia, preço, clima, lançamento), ela busca na internet pra **não te dar informação errada**. |
| 🗣️ **Ensina idiomas** | Inglês, espanhol, francês… ela mistura na medida certa do seu nível e te corrige sem te envergonhar. |
| 👤 **Vários perfis** | Cada criança tem seu próprio "cérebro" — memórias e progresso separados. |
| 🤖 **Robô físico** | Um robozinho com ESP32 que escuta pelo microfone e responde pelo alto-falante. |
| 🎨 **Avatar vivo** | Uma carinha que reage à voz em tempo real, com cores próprias pra cada criança. |
| 📱 **App dos pais (Companion)** | A família acompanha conversas, matérias e tópicos, cria planos de estudo e recebe o resumo semanal — tudo de qualquer lugar. |
| ♿ **Acessível e responsivo** | Funciona no celular, tablet e PC, com suporte a leitor de tela e navegação por teclado. |

---

## 🧩 Como tudo se conecta (a visão geral)

O Cogni tem **4 peças** que conversam entre si:

```
   🧒 Criança fala
        │
        ▼
   🤖 ROBÔ (ESP32)  ──🎤 manda a voz──▶  💻 SERVIDOR (Node.js)  ──🌐──▶  ☁️ OpenAI
   microfone + alto-falante              o "cérebro" do Cogni            (entende, pensa, fala)
        ▲                                       │       │
        └──────🔊 recebe a resposta em áudio────┘       │ sincroniza conversas,
                                                        ▼ perfis e planos
   👨‍👩‍👧 Pais (de qualquer lugar)                   ☁️ SUPABASE (Postgres + Auth)
        │                                               ▲ fonte única de dados
        ▼                                               │
   📱 COMPANION (web) ──────── lê/escreve ──────────────┘
```

1. **🤖 O robô** (ou a interface no navegador) capta a voz da criança e envia pro servidor.
2. **💻 O servidor** é o cérebro: ele transcreve o áudio, decide o que responder (consultando a OpenAI e, se preciso, a internet), gera a voz da resposta e devolve. Em paralelo, ele sincroniza tudo (conversas, perfis, planos) pro Supabase — sem nunca travar a conversa esperando a nuvem.
3. **☁️ A OpenAI** fornece os modelos de IA que entendem a fala, pensam a resposta e geram a voz natural.
4. **📱 O Companion + Supabase** são o lado dos pais: o servidor escreve no **Supabase** (o banco de dados na nuvem, fonte única), e o app **Companion** lê de lá pra mostrar à família o que a criança aprendeu. Os planos que os pais criam voltam pelo mesmo caminho e a Cogni passa a segui-los.

> 💡 **Você não precisa do robô físico pra usar!** Tudo funciona direto no navegador (`http://localhost:3000`). O robô é a cereja do bolo. 🍒
>
> 💡 **E nem do Supabase:** sem as credenciais da nuvem no `.env`, o servidor roda **100% local** (os perfis ficam no `usuarios.json`). O Supabase só liga o app dos pais — é opcional. 🔌

---

## 🛠️ As tecnologias por trás (a "stack")

Tudo construído com o que há de mais atual e estável (verificado em **junho/2026**), pensado como se fosse um produto de verdade — segurança, performance e organização nível profissional. 🏆

### 💻 O servidor (o cérebro)

| Peça | Tecnologia | Pra quê |
| --- | --- | --- |
| ⚙️ **Motor** | Node.js 20+ | Roda todo o backend |
| 🌐 **Servidor web** | Express 5 | Atende a interface e as rotas da API |
| 🔌 **Tempo real** | WebSocket (`ws` 8) | Canal ao vivo com o robô (áudio nos dois sentidos) |
| 🛡️ **Segurança** | Helmet 8 + rate-limit 8 + CORS | Protege contra ataques e abusos |
| 🗜️ **Velocidade** | compression | Comprime as respostas (menos dados, mais rápido) |
| 📤 **Upload** | multer | Recebe áudio e imagem da interface |
| ☁️ **Banco na nuvem** | Supabase (`@supabase/supabase-js` 2) | Fonte única de dados do Companion (Postgres + Auth + RLS). **Opcional** — sem credenciais, cai pro `usuarios.json` local |

### 🧠 A inteligência (modelos da OpenAI)

| Função | Modelo | O que faz |
| --- | --- | --- |
| 👂 **Ouvir** (STT) | `gpt-4o-mini-transcribe` | Transforma a voz em texto (com `whisper-1` de reserva) |
| 💭 **Pensar** (chat) | `gpt-4o-mini` | Gera a resposta da conversa |
| 👁️ **Ver** (visão) | `gpt-4o` | Entende as imagens da câmera |
| 🌐 **Buscar** (web) | `gpt-4o-mini-search-preview` | Pesquisa na internet quando precisa de info atual |
| 🗣️ **Falar** (TTS) | `gpt-4o-mini-tts` | Gera a voz natural da Cogni |

### 🎨 A interface (o que você vê)

HTML + CSS + JavaScript puro (sem framework pesado) — **ultraleve e rápido**. Áudio com Web Audio API, visualizador em tempo real e tema claro/escuro automático. 🌗

### 🦾 O robô

| Peça | Componente | Função |
| --- | --- | --- |
| 🧠 **Placa** | ESP32 DevKit V1 | O "computador" do robô |
| 🎤 **Microfone** | INMP441 (I2S) | Ouve a criança |
| 🔊 **Som** | MAX98357A + alto-falante | A voz da Cogni sai por aqui |
| 📸 **Visão** | Webcam do dispositivo | A Cogni enxerga pela câmera do PC/celular onde o painel está aberto |

> 🔊 **Curiosidade técnica:** a voz vai pro robô como **áudio cru (PCM)**, não como MP3. Por quê? Decodificar MP3 exigiria uma memória extra (PSRAM) que o ESP32 DevKit não tem. Então o servidor manda o som "pronto pra tocar" e o robô só reproduz. Simples e leve. 👌

---

## 📁 Como o projeto está organizado

```
Cogni/
├── 📄 README.md              ← você está aqui
├── 🔒 .env                   ← suas chaves secretas (NUNCA vai pro GitHub)
├── 📋 .env.example           ← modelo de configuração pra copiar
├── 📚 docs/                  ← documentação técnica (.md vão pro GitHub; .docx do artigo não)
│
├── 💻 client/                ← a interface (frontend)
│   ├── index.html            ← a tela principal
│   ├── monitor/              ← página de debug que toca o áudio do robô no PC
│   └── modules/              ← os pedacinhos da interface (áudio, câmera, etc.)
│
├── 🧠 server/                ← o cérebro (backend)
│   ├── index.js              ← o ponto de partida
│   ├── config.js             ← central de configurações
│   ├── routes/               ← as "portas" da API
│   ├── dados/                ← perfis dos usuários (usuarios.json vai pro GitHub; temporários .tmp não)
│   └── modules/
│       ├── brain.js          ← orquestra a IA (e decide se pesquisa na web)
│       ├── brain/            ← memória, idiomas, triagem, prompts, dica e resumo semanal
│       ├── speech.js         ← ouvir (STT) e falar (TTS)
│       ├── supabase.js       ← sincroniza dados pro Companion (perfis, conversas, planos)
│       ├── planos.js         ← cache dos planos de estudo que a Cogni segue
│       ├── pareamento.js     ← vincula o robô ao app dos pais (código de pareamento)
│       ├── esp.js            ← conexão WebSocket com o robô
│       └── esp-pipeline.js   ← o fluxo de voz do robô (ouve → pensa → fala)
│
└── 🦾 code/                  ← o firmware do robô (código que vai no ESP32)
    ├── esp32-controle/       ← ⭐ o principal: microfone + alto-falante (esp32-controle.ino)
    ├── esp32-cam/            ← sketch da ESP32-CAM, fora do projeto hoje (ver apêndice)
    └── teste-conexao/        ← comece por aqui pra testar Wi-Fi + conexão
```

---

## 🚀 Começando a usar (no SEU PC, do zero)

> 🎯 Esta seção é pra quem está montando o projeto pela primeira vez. É passo a passo e sem pressa. Se algo der errado, tem a seção [🆘 Deu problema?](#-deu-problema) lá embaixo.

### 1️⃣ O que você precisa ter instalado

- **Node.js 20 ou mais novo** → baixe em [nodejs.org](https://nodejs.org) (pegue a versão "LTS").
- **Uma chave da OpenAI** → crie em [platform.openai.com](https://platform.openai.com) (precisa de créditos, é paga por uso 💳).
- **Um navegador moderno** (Chrome, Edge, Firefox ou Safari atualizados).
- **Um microfone** (e câmera, se quiser usar a visão).

Pra conferir se o Node está instalado, abra o terminal e digite:
```bash
node --version
```
Se aparecer algo como `v20.x.x` ou maior, tá certo! ✅

### 2️⃣ Criar o arquivo de chaves (`.env`)

Na **pasta raiz do projeto** (a pasta `Cogni/`, **não** dentro de `server/`), crie um arquivo chamado `.env`. A forma mais fácil: copie o `.env.example` e renomeie pra `.env`, depois preencha.

O conteúdo mínimo é:

```bash
# Sua chave da OpenAI (obrigatório!)
OPENAI_API_KEY=sk-sua-chave-aqui

# Servidor
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Modo desenvolvedor (opcional): coloque esse segredo no fim do seu nome de
# usuário, ex.: "Nicolas #seu-segredo-dev", pra liberar testes sem filtros.
DEVELOPER_SECRET=defina-um-segredo-dev

# Robô físico (só importa se você tiver o robô; pode deixar assim)
ESP_ENABLED=true
ESP_TOKEN=defina-um-token-secreto-aqui

# Banco na nuvem / app dos pais (OPCIONAL — sem isto roda 100% local):
# SUPABASE_URL=https://seu-projeto.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=cole-a-service-role-key-aqui
```

> ⚠️ **Importante:** o `.env` guarda segredos. Ele **nunca** deve ir pro GitHub — o projeto já está configurado pra ignorá-lo automaticamente. 🔐

### 3️⃣ Instalar as dependências

No terminal, entre na pasta do servidor e instale:

```bash
cd server
npm install
```

Isso baixa tudo que o servidor precisa (uma vez só). ⏳

Em seguida, baixe a biblioteca que faz **os olhos do robô seguirem a criança** (detector de rosto do MediaPipe, ~11 MB):

```bash
npm run vendor
```

> 🤔 **Por que num comando separado?** São 11 MB de WebAssembly compilado — peso demais pra deixar no Git, e não é código nosso. O comando baixa tudo pra `client/vendor/` (que está no `.gitignore`) e a partir daí **funciona offline**, sem depender de CDN na hora de apresentar. Se você pular este passo, tudo continua funcionando — só o rastreio de rosto fica desligado. 👍

### 4️⃣ Ligar o servidor

```bash
npm run dev
```

Vai aparecer uma mensagem dizendo que o servidor subiu. Agora abra o navegador em:

### 👉 **http://localhost:3000**

Pronto! A Cogni tá no ar. 🎉 Clique no botão grande do microfone (ou aperte a barra de espaço) e comece a conversar.

> 📱 **Quer usar do celular** (na mesma rede Wi-Fi)? Descubra o IP do seu PC (no Windows, digite `ipconfig` no terminal e procure "Endereço IPv4") e acesse `http://SEU-IP:3000` no celular.

---

## 🎮 Atalhos e dicas de uso

| Tecla / Ação | O que faz |
| --- | --- |
| 🎤 **Espaço** ou botão central | Liga/desliga o microfone |
| 📷 **C** | Liga/desliga a câmera do navegador |
| 🔄 **R** | Reinicia a conversa (as memórias continuam salvas!) |
| ✋ **Falar por cima** ou botão vermelho | Interrompe a Cogni na hora |
| ⬅️ **Seta superior esquerda** | Troca de usuário |
| ⎋ **Esc** | Fecha janelas e o painel do robô |

💡 **Dica:** ative o microfone **uma vez** e converse à vontade — a Cogni detecta sozinha quando você terminou de falar. Não precisa ficar clicando.

---

## 🖥️➡️🖥️ Passar o projeto pra OUTRO computador (guia completo)

> 🎯 **Esta é a seção técnica mais importante do README.** Aqui está, **sem pular nenhum passo**, como pegar o Cogni que funciona no seu PC e fazer ele funcionar **exatamente igual** em qualquer outro computador (outro Windows, um Mac, um notebook novo…). Siga na ordem. ✅

### 🧠 Primeiro, entenda: o que viaja e o que NÃO viaja

Quando você copia a pasta do projeto, **3 coisas críticas NÃO vão junto** (de propósito, por segurança) e **precisam ser recriadas** na máquina nova:

| Item | Vai junto ao copiar a pasta? | Por quê |
| --- | --- | --- |
| 📄 Código (`client/`, `server/`, `code/`) | ✅ Sim | É o projeto em si |
| 🔒 `.env` (suas chaves) | ❌ **NÃO** | Está no `.gitignore` — segredo não viaja |
| 🤫 `code/**/config.h` (Wi-Fi + token do ESP) | ❌ **NÃO** (via GitHub) | Está no `.gitignore` — você recria a partir do `config.example.h`. (Via pen drive a cópia vai junto.) |
| 📦 `node_modules/` (dependências) | ❌ **NÃO** | É pesado e específico de cada PC — reinstala-se |
| 👤 `server/dados/usuarios.json` (perfis) | ✅ **Sim** | Versionado de propósito — os perfis de teste viajam junto pelo GitHub |
| ☁️ Credenciais do Supabase (no `.env`) | ❌ **NÃO** | Estão no `.env` (não viaja). São **opcionais**: só precisa recriar se você usa o app dos pais (Companion); senão, ignore |

E tem **mais um detalhe que pega todo mundo**: o **IP do computador muda** de máquina pra máquina (e até de rede pra rede). O robô precisa saber o IP **novo**. 📍

---

### ✅ Checklist de migração (faça na ordem)

#### 🟦 Parte A — No computador NOVO: preparar o ambiente

**A1.** Instale o **Node.js 20+** ([nodejs.org](https://nodejs.org), versão LTS). Confira:
```bash
node --version
```
Tem que mostrar `v20.x.x` ou maior. Se não mostrar, o Node não instalou direito.

**A2.** Copie a **pasta do projeto** inteira pro PC novo (pen drive, nuvem, Git, do jeito que preferir). Pode copiar com `node_modules/` dentro — vamos reinstalar mesmo, então tanto faz.

> ⚠️ Se você copiou via **GitHub**, lembre que o `.env` (suas chaves) **não está** no repositório — você vai recriá-lo no próximo passo. Os perfis (`usuarios.json`) **vêm junto**, então não precisa recriar.

#### 🟩 Parte B — Recriar as chaves (`.env`)

**B1.** Na **raiz** do projeto (a pasta `Cogni/`, **não** `server/`), crie o arquivo `.env`. O jeito mais seguro: copie o `.env.example` e renomeie pra `.env`.

**B2.** Preencha **no mínimo** estas linhas:
```bash
OPENAI_API_KEY=sk-sua-chave-da-openai        # a MESMA chave, ou uma nova
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
DEVELOPER_SECRET=defina-um-segredo-dev        # opcional, pra modo dev
ESP_ENABLED=true
ESP_TOKEN=defina-um-token-secreto             # ⚠️ ANOTE este valor — o robô vai precisar dele
```

> 🔑 **Sobre a chave da OpenAI:** você pode reusar a mesma chave do PC antigo. Mas se ela ficou exposta em algum lugar, o ideal é **gerar uma nova** em [platform.openai.com](https://platform.openai.com) → *API Keys* → *Create new secret key*, e **revogar a antiga**.

**B3.** **Perfis dos usuários:** se você trouxe o projeto via **GitHub**, o `usuarios.json` (memórias, idades, progresso) **já veio junto** — não precisa fazer nada. ✅ Só se você copiou via pen drive/nuvem **sem** o GitHub é que vale copiar a pasta `server/dados/` manualmente. (Sem ela, o Cogni só começa com os perfis zerados — e tá tudo bem também.)

#### 🟨 Parte C — Instalar e ligar o servidor

**C1.** No terminal, dentro da pasta do projeto:
```bash
cd server
npm install
```
Isso recria o `node_modules/` na máquina nova (baixa tudo de novo). ⏳

**C2.** Ligue o servidor:
```bash
npm run dev
```

**C3.** Abra **http://localhost:3000** no navegador. Se a interface abrir e você conseguir conversar por voz, **a parte do PC está 100% migrada.** 🎉

> ✋ **Se você NÃO usa o robô físico, pode parar aqui.** O resto é só pra quem tem o ESP32.

#### 🟥 Parte D — Reapontar o robô pro PC novo (o passo que todo mundo esquece)

O robô guarda o **IP do servidor** e o **token** dentro do firmware. Na máquina nova o IP é outro, então **precisa regravar** o robô.

**D1.** Descubra o **IP do PC novo** na rede Wi-Fi:
- **Windows:** abra o terminal, digite `ipconfig` e procure o **"Endereço IPv4"** do adaptador Wi-Fi (algo como `192.168.0.150`).
- **Mac/Linux:** digite `ifconfig` (ou `ip addr`) e procure o IP da interface de Wi-Fi.

**D2.** Na pasta `code/esp32-controle/`, **copie** o arquivo `config.example.h` e renomeie a cópia para `config.h` (esse `config.h` é só seu — ele fica de fora do GitHub de propósito, pra não vazar a senha do Wi-Fi e o token). Abra esse `config.h` na Arduino IDE e ajuste **3 coisas**:
```cpp
#define COGNI_WIFI_SSID     "SuaRedeWiFi_2.4g"      // a rede do PC novo (2,4 GHz!)
#define COGNI_WIFI_PASSWORD "senha-da-rede"
#define COGNI_SERVER_HOST   "192.168.0.150"         // ⬅️ o IP do PASSO D1
#define COGNI_ESP_TOKEN     "defina-um-token-secreto"  // ⬅️ IGUAL ao ESP_TOKEN do .env (passo B2)
```

> ⚠️ **Os dois erros mais comuns aqui:**
> 1. **IP errado ou desatualizado** → o robô não acha o servidor. Sempre confira com `ipconfig` na hora.
> 2. **Token diferente** entre o `config.h` e o `.env` → o servidor recusa a conexão do robô (erro 401).

**D3.** Conecte o ESP32 no USB, na Arduino IDE selecione `Tools → Board → DOIT ESP32 DEVKIT V1` e a porta `COMx`, abra `esp32-controle.ino` (dentro de `code/esp32-controle/`) e clique em **Upload** ⬆️.

**D4.** Abra o **Monitor Serial** (115200 baud). Você deve ver o robô conectar no Wi-Fi e depois no servidor (`Conectado em ws://...`). No terminal do servidor vai aparecer `ESP32 controle conectado`. ✅

**D5.** Na interface (http://localhost:3000), abra o painel do robô, ligue **"Controlar robô"**, escolha um perfil e fale. O robô deve responder pelo alto-falante. 🔊🎉

---

### 🧪 Conferência final (passou em tudo? migração completa!)

- [ ] `node --version` mostra v20+ no PC novo
- [ ] `.env` existe na **raiz** com a `OPENAI_API_KEY` e o `ESP_TOKEN`
- [ ] `npm install` rodou sem erro dentro de `server/`
- [ ] `npm run dev` sobe e **http://localhost:3000** abre
- [ ] Você consegue **conversar por voz** no navegador
- [ ] *(com robô)* O `config.h` tem o **IP novo** e o **token igual** ao `.env`
- [ ] *(com robô)* O Monitor Serial mostra o robô **conectado**
- [ ] *(com robô)* O robô **fala** quando você ativa o "Controlar robô" e conversa

> 💡 **Pra rede diferente:** mesmo no mesmo PC, se você trocar de rede Wi-Fi (casa → faculdade, por exemplo), o IP muda. Aí basta **repetir só a Parte D** (descobrir o IP novo e regravar o robô). O servidor e o `.env` continuam iguais.

---

## 🦾 Conectando o robô físico (opcional)

Se você montou o robô com ESP32, é aqui que ele ganha vida. 🤖

### Passo a passo pra gravar o firmware

1. **Instale a Arduino IDE 2.x** ([arduino.cc](https://www.arduino.cc/en/software)).
2. **Adicione o suporte ao ESP32** e instale as bibliotecas (versões verificadas em mai/2026):

   | Biblioteca | Versão | Onde instalar |
   | --- | --- | --- |
   | Arduino-ESP32 core | **3.3.8** | Boards Manager → "esp32 by Espressif Systems" |
   | WebSockets (Links2004) | **2.6.1** | Library Manager → "WebSockets" by Markus Sattler |
   | ArduinoJson | **7.4.3** | Library Manager → "ArduinoJson" by Benoit Blanchon |

3. **Crie o seu `config.h`**: na pasta `code/esp32-controle/`, copie `config.example.h` e renomeie a cópia para `config.h`. (Esse `config.h` guarda seus segredos e **não** vai pro GitHub — está no `.gitignore`. O `config.example.h`, com placeholders, é o que fica versionado.) Depois preencha no `config.h`:
   - `COGNI_WIFI_SSID` e `COGNI_WIFI_PASSWORD` → sua rede Wi-Fi (⚠️ **só 2,4 GHz**, o ESP32 não pega 5 GHz).
   - `COGNI_SERVER_HOST` → o IP do seu PC na rede (o tal do `ipconfig`).
   - `COGNI_ESP_TOKEN` → **exatamente o mesmo** valor do `ESP_TOKEN` que você pôs no `.env`.

4. Na Arduino IDE: `Tools → Board → DOIT ESP32 DEVKIT V1`, escolha a porta `COMx`, abra `esp32-controle.ino` (dentro de `code/esp32-controle/`) e clique em **Upload** ⬆️.

   > ⚠️ **Se der "sketch too big":** vá em `Tools → Partition Scheme` e escolha **Huge APP (3MB No OTA/1MB SPIFFS)**. O esquema padrão reserva metade do flash pra atualização pela rede (OTA), coisa que este projeto não usa — ele grava por USB. Trocando, o uso cai de ~90% pra ~38% e sobra espaço de sobra pra novas animações. É uma configuração **da IDE**, não do repositório: se trocar de computador, precisa marcar de novo.
5. Abra o **Monitor Serial** (115200 baud) pra ver o robô se conectando.

> 💡 **Dica:** comece testando com `code/teste-conexao/` — é um sketch mínimo que só valida Wi-Fi + conexão + token (copie o `config.example.h` dele pra `config.h` do mesmo jeito). Se ele conectar, o resto vai funcionar.

### 🎛️ Modo "Controlar robô"

Quando o robô está conectado, aparece na interface o botão **"Controlar robô"**. Ligando ele, **a tela do seu PC vira o painel de controle do robô**: o microfone e o alto-falante passam a ser os **do robô**, e você comanda tudo pela tela — escolhe o perfil da criança, muta, vê as legendas ao vivo e o estado (ouvindo / pensando / falando). E tudo isso **sem regravar o firmware**. 🪄

### 👀 O rosto do robô (tela OLED)

O robô tem **olhos animados** numa telinha OLED, e eles não ficam parados esperando comando. O que acontece ali:

| Situação | O que os olhos fazem |
| --- | --- |
| 😴 **Desconectado ou 2 min parado** | Dormem. Qualquer conversa, botão ou reconexão acorda na hora |
| 👂 **Ouvindo** | Atentos, olhando pra frente |
| 🤔 **Pensando** | Olham pra cima, pensativos |
| 🔎 **Pesquisando na web** | Varredura horizontal contínua, tipo scanner |
| 🗣️ **Falando** | **Pulsam no ritmo da própria voz** — a altura do olho acompanha a amplitude do áudio que está tocando naquele instante |
| 💜 **Reagindo ao papo** | Corações num elogio, risada numa piada, estrelinhas ao aprender algo novo |
| 🎛️ **Comando do painel** | Ícone central: microfone riscado, pausa, seta de recomeçar, câmera com flash… |
| 📐 **Assunto da conversa** | O ícone da matéria aparece antes da resposta (soma, erlenmeyer, livro, ampulheta, globo, balões de fala) |
| 🙂 **Com a câmera ligada** | **Seguem você pela sala** — o rosto é detectado no navegador e só a posição (dois números) vai pro robô |
| 🤨 **Sobrancelhas** | Duas barrinhas que inclinam com o humor. É o que diferencia "bravo" de "concentrado" e "triste" de "com sono" |
| 👃 **Você chega muito perto** | Fica **vesgo**, tentando focar — como alguém olhando a ponta do próprio nariz |
| 🥺 **Ninguém aparece há um tempo** | Com a câmera ligada, ele sente sua falta e fica tristinho (uma vez só, não fica de mimimi) |
| 🌙 **À noite** | Cochila na metade do tempo e o rosto neutro fica sonolento — ele vive no mesmo fuso que você |

**E quando ninguém está mexendo nele:**

| Cena | O que rola |
| --- | --- |
| 🪰 **A mosca** | Os olhos perseguem um inseto invisível pela tela, num caminho que nunca se repete |
| 💫 **A tontura** | Ele roda os olhos e vai "assentando" de volta no centro |
| 😪 **O cochilo** | A pálpebra desce em três degraus, lutando contra o sono — e ele acorda com um susto |

Fora isso, o tempo todo: **micro-sacadas** (o olho nunca fica 100% parado, igual ao seu), **respiração** (um balanço lento de 1–2 px) e uma **piscadinha na troca de estado**, que funciona como pontuação.

> 🧠 **Ele tem humor, não só reações.** Por baixo de tudo roda um motor de emoção em dois eixos (bom/mau humor e calmo/agitado) que as interações empurram e que volta sozinho ao neutro. Um elogio não "mostra um coração e acabou" — deixa a Cogni de bom humor pelos minutos seguintes, e isso aparece no formato do olho, no ritmo da piscada e nas sobrancelhas. 💜

> 🎨 **A criança pode desenhar o próprio rosto do robô** pelo Companion: largura, altura, quão redondo, distância entre os olhos e se tem sobrancelha. Não é enfeite — pesquisa com crianças mostra que um rosto desenhado por elas é percebido como **socialmente mais inteligente** que um genérico. Cada perfil tem o seu, e trocar de criança troca a cara do robô na hora.

> 🔒 **Sobre a câmera e privacidade:** a detecção de rosto acontece **inteiramente no seu dispositivo**. O que trafega pro servidor é só a posição normalizada do rosto e o tamanho dele (a "distância") — nenhuma imagem, nenhum dado biométrico. É, na prática, o equivalente a mover o mouse. 🙏

> ⚡ **Quer os olhos mais fluidos?** A tela é o gargalo: a 400 kHz, empurrar um quadro inteiro pelo I2C leva ~23 ms, o que trava o teto em ~43 quadros/s. Troque `COGNI_OLED_I2C_HZ` para `800000` no seu `config.h` e o teto dobra. O datasheet do SSD1309 especifica 400 kHz como máximo, mas a maioria dos módulos aguenta — **teste**: se aparecer chuvisco ou a tela congelar, volte. Não tem risco de dano.

> ⚖️ **Licença:** a animação dos olhos usa a biblioteca [FluxGarage RoboEyes](https://github.com/FluxGarage/RoboEyes), que é **GPLv3**. Nós **não a modificamos** (as sobrancelhas entram por uma subclasse do display, não por um fork), então ela é usada como biblioteca. Se for publicar o firmware junto do TCC, vale confirmar isso com seu orientador. 📄

### 🔊 Ouvindo o robô no PC (página de debug)

Ainda não montou o alto-falante? Sem problema. Acesse **http://localhost:3000/monitor** — essa página toca **no seu PC** o mesmo áudio que iria pro robô. Perfeito pra testar. 🎧

---

## 📱 O Cogni Companion (o app dos pais)

> 💜 A criança usa a Cogni; **os pais usam o Companion**. É um app web (abre lindo no celular, tablet e PC) onde a família entra na história sem invadir o espaço da criança.

A ideia é ser o **"diário escolar da era da IA"**: transparência total, zero burocracia. O que ele entrega:

| Tela | O que mostra |
| --- | --- |
| 🏠 **Início** | Tempo de uso do dia, última conversa, próximo plano e uma **Dica da Cogni** (a IA sugere, pros pais, do que conversar com a criança) |
| 🗣️ **Conversas** | Cada conversa transcrita, por dia, com a matéria e o horário — e os assuntos **delicados** ficam sinalizados pra revisão |
| 📚 **Aprendizado** | Tempo por matéria, tópicos explorados e a evolução (min/dia) num gráfico gostoso de olhar |
| ✏️ **Planos de estudo** | Os pais montam um roteiro ("Semana da Tabuada", 5 dias, 15 min/dia…) e **a Cogni passa a seguir** quando a criança chega pra conversar |
| 📬 **Resumo Semanal** | Toda semana, a própria Cogni escreve um **bilhetinho carinhoso** pros pais com os destaques |

### 🧠 Como funciona por baixo (a arquitetura)

O segredo é que **o robô roda local e o app vive na nuvem**, ligados por um banco de dados compartilhado (o **Supabase**, fonte única de dados):

```
🏠 LOCAL (seu notebook)                    ☁️ NUVEM (de graça)
🤖 Robô + 💻 Servidor Cogni                ┌─────────────────────┐
   voz / IA / TTS = 100% local ✅  ──────▶ │  SUPABASE           │
   (não trava esperando a nuvem)           │  Postgres + Auth    │
                                           │  + RLS (segurança)  │
🌍 Pais (de qualquer lugar)                 │                     │
📱 Companion (web) ────────────────────────▶ └─────────────────────┘
```

- 🔒 **O robô nunca trava esperando a internet.** A leitura de perfil é síncrona, do cache em RAM; a nuvem é sincronizada "por baixo". Se a internet cair na hora da apresentação, **o robô continua conversando** normalmente.
- 🔌 **Supabase é opcional.** Sem as credenciais no `.env`, o servidor roda exatamente como antes (perfis no `usuarios.json`). Com elas, liga o Companion.
- 🛡️ **Segurança de verdade (LGPD — são dados de crianças).** Cada responsável só enxerga o próprio filho (Row Level Security no banco). A chave-mestra (`service_role`) fica **só** no servidor; o site usa a chave pública, protegida pelas regras do banco.
- 🔗 **Pareamento por código.** Cada perfil tem um código fixo de 6 caracteres. O pai digita esse código no app uma vez e pronto — passa a acompanhar aquela criança.

> 🗂️ **O Companion é um projeto separado** (o site/front-end mora em outro repositório). Este repositório aqui é o **servidor + robô**, que é quem fala com o Supabase. O contrato técnico que liga os dois está em [`docs/COMPANION-PLANO-TECNICO.md`](docs/COMPANION-PLANO-TECNICO.md).

---

## 🎚️ Como o áudio do robô fica suave (controle de fluxo)

> 🤓 Seção um pouco mais técnica, mas vale entender — é o que faz a voz do robô sair **limpa, sem picotar ou travar**.

O servidor manda a voz pro robô em pedacinhos (chunks). O desafio: mandar **na velocidade certa**. Rápido demais, o robô não dá conta e descarta som. Devagar demais, o robô fica sem áudio pra tocar e a voz **gagueja** (aquele "tra-tra-tra" repetindo um pedaço — clássico de áudio travado).

A solução do Cogni é **controle de fluxo em malha fechada** 🔄:

- 🤖 O **robô avisa** o servidor, várias vezes por segundo, **quanto áudio ele ainda tem guardado** pra tocar. (E esse "quanto" conta o áudio certo: tanto o que está na fila esperando quanto o que já está saindo pelo alto-falante — antes ele só contava a fila e o servidor recebia um número baixo demais, achando que o robô vivia secando.)
- 💻 O **servidor ajusta o ritmo** com base nisso: se o robô está ficando sem som, manda mais rápido; se já tem bastante, segura um pouco.
- 🎯 Assim o "estoque" de áudio do robô fica sempre numa **faixa ideal**: nunca seca (sem travadas) e nunca estoura (sem descarte).

Além disso, o robô usa um **pool de memória fixo** (em vez de pedir/devolver memória a cada pedacinho, o que fragmentava e travava) e um **colchão de áudio inicial** pra começar firme. Resultado: voz fluida do começo ao fim. ✨

Os ajustes ficam no `.env` (com valores bons por padrão):

| Variável | Padrão | O que controla |
| --- | --- | --- |
| `ESP_AUDIO_BUFFER_ALVO_MS` | `320` | Quanto áudio (em ms) o robô tenta manter guardado |
| `ESP_AUDIO_BUFFER_TETO_MS` | `520` | O limite máximo antes do servidor segurar o envio |
| `ESP_AUDIO_BURST_CHUNKS` | `4` | Quantos pedaços vão "de largada" pra encher o colchão inicial |

### ⚡ Resposta mais rápida (fala por sentença)

Pra Cogni começar a falar **mais cedo**, o robô usa a mesma estratégia da interface no navegador: em vez de esperar a IA terminar a resposta **inteira** e só então gerar todo o áudio, o servidor vai **soltando frase por frase**. Assim que a primeira frase fica pronta, ela já é falada — enquanto as próximas ainda estão sendo geradas em paralelo (mas sempre tocadas na ordem certa, sem atravessar). Na prática, o tempo até o robô "abrir a boca" cai de *"IA inteira + voz inteira"* para *"primeira frase + voz dela"*. 🚀

---

## 🔐 Segurança

O Cogni foi feito levando segurança a sério, como um sistema de verdade. 🛡️

| Camada | Proteção |
| --- | --- |
| 🪖 **Cabeçalhos HTTP** | Helmet com política de conteúdo estrita |
| 🚦 **Limite de requisições** | Trava abusos (120/min geral, 5 conversas/10s por usuário) |
| 🧼 **Sanitização** | Limpa e limita todo texto que entra |
| 🚫 **Anti-manipulação** | Filtro contra 50+ truques de "jailbreak" da IA |
| 🔑 **Token do robô** | Conexão do ESP exige token secreto (comparação segura) |
| 👶 **Filtro infantil** | Bloqueia temas impróprios pra crianças |
| 💾 **Dados protegidos** | Perfis salvos localmente (escrita atômica) e, opcionalmente, no Supabase |
| 👨‍👩‍👧 **Privacidade dos pais (LGPD)** | No Supabase, cada responsável só enxerga o próprio filho (Row Level Security). A chave-mestra (`service_role`) fica **só** no servidor; o app usa a chave pública, protegida pelas regras do banco |
| 🤫 **Segredos do firmware** | A senha do Wi-Fi e o token ficam no `config.h` de cada ESP, que **não** vai pro GitHub (no `.gitignore`). O repositório só guarda o `config.example.h` com placeholders. |
| 🔐 **Chaves fora do Git** | O `.env` (OpenAI + Supabase) está no `.gitignore`. O repositório só carrega o `.env.example` com placeholders. |

---

## 🆘 Deu problema?

| 😵 Sintoma | 🔍 Provável causa | ✅ Solução |
| --- | --- | --- |
| `OPENAI_API_KEY nao configurada` | `.env` no lugar errado | Crie o `.env` na **raiz** do projeto, não em `server/` |
| `EADDRINUSE: 3000` | A porta 3000 já está ocupada | Use outra porta: `set PORT=3001` (Windows) e rode de novo |
| Microfone não liga | Permissão negada no navegador | Permita o microfone nas configurações do site |
| Câmera "está em uso" | Outro app usando | Feche Zoom/Teams/Meet e tente de novo |
| Áudio não toca | Navegador bloqueou o autoplay | Clique em qualquer lugar da página primeiro |
| Robô não conecta | Token diferente ou rede 5 GHz | Confira que o token do `config.h` == `.env` e use Wi-Fi 2,4 GHz |
| Robô conecta e cai sozinho | (já resolvido no firmware) | O firmware desliga o "modo econômico" do Wi-Fi que causava isso |
| Voz do robô picota/trava | (já resolvido) | O controle de fluxo novo mantém o áudio fluido; regrave o firmware se ainda estiver na versão antiga |

> 💬 **Travou de outro jeito?** Abra o Monitor Serial do robô (115200 baud) — ele mostra mensagens amigáveis dizendo o que está acontecendo (conexão, fala detectada, erros).

---

## 🧰 Comandos úteis

```bash
# Ligar o servidor (modo desenvolvimento, recarrega ao salvar)
cd server && npm run dev

# Ligar em modo produção
cd server && npm start

# Conferir se está tudo sem erro de sintaxe
cd server && npm run check

# Ver se há dependências desatualizadas
cd server && npm outdated

# Auditoria de segurança das dependências
cd server && npm audit
```

---

## 🔌 Apêndice: religando a ESP32-CAM

A câmera de um segundo ESP32 **saiu do projeto** — a visão da Cogni é a webcam do dispositivo onde o painel está aberto. O sketch continua em `code/esp32-cam/` (não é compilado por nada), mas a integração com o servidor foi removida. Se um dia ela voltar, é isto que precisa ser recriado:

| Camada | O que reconstruir |
| --- | --- |
| 🔧 `server/config.js` | `ESP_MAX_FRAME_BYTES: 200 * 1024` (limite do frame JPEG) |
| 🔌 `server/modules/esp.js` | Um `WebSocketServer` extra (`maxPayload: ESP_MAX_FRAME_BYTES + 4096`), o `Map` de conexões, um store `{ buffer, recebidoEm }` alimentado pelas mensagens **binárias**, a rota de upgrade `/ws/cam`, o `iniciarPing` dele, e getters `obterUltimoFrame()` / `obterUltimoFrameBase64()` com TTL de ~5s |
| 📊 `obterEstado()` | Voltar a chave `camera: { conectados, ultimoFrameMs }` — a UI lê daí |
| 🚪 `server/routes/esp.js` | `GET /camera/snapshot` devolvendo o JPEG com `Cache-Control: no-store` |
| 🖥️ `client/` | Polling do snapshot (~4s) no painel, a linha de status "ESP-CAM" e o `<img>` do último frame |
| 🧹 Encerramento | Incluir o novo `wss` no laço de `shutdown()` em `server/index.js`, senão o processo não sai limpo |

**O que já existe e NÃO precisa ser tocado:** `modules/vision.js` (valida/limpa frame), `modules/webcam.js` (store da webcam do PC) e o botão de câmera do robô — apesar do nome, ele liga a webcam do navegador, não a ESP-CAM.

> 💡 Decisão registrada: manter as duas fontes de imagem isoladas, cada uma com seu TTL. O frame da webcam vale 10s (é capturado no início da fala e consumido segundos depois, pós-STT); o da ESP-CAM valia 5s por ser um stream contínuo.

---

## 📝 Licença

Projeto acadêmico (TCC) — uso **educacional**. Cada biblioteca usada tem sua própria licença; confira separadamente se for reaproveitar. 📚

---

<div align="center">

Feito com 💜 para o TCC do **Nicolas** — UNASP São Paulo · 2026

*"Tecnologia que ensina com carinho."* ✨

</div>
