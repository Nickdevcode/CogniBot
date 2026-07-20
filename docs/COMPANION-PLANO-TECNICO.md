# 🛠️ Cogni Companion — Plano Técnico & Contrato de Dados

> Documento-mãe da construção do **Companion** (o app dos pais). Reúne a arquitetura, o escopo do MVP, o schema do banco e o **contrato de dados** que tanto o backend (servidor da Cogni) quanto o front-end (site na Vercel) seguem. Sempre que algo mudar, atualize **aqui primeiro**.
>
> 📌 Companheiro de leitura: `docs/APP-COMPANION.md` (a visão/produto). Este aqui é o **como**.

---

## 🎯 A ideia em uma frase

O robô da Cogni roda **local** (no notebook, na mesma rede Wi-Fi — a voz e a IA não dependem da nuvem). O site do Companion roda na **Vercel**. A ponte entre os dois é o **Supabase** (Postgres + Auth + RLS), a **fonte única de dados**: o servidor sincroniza pra lá, o site lê de lá. Assim os pais acompanham tudo de qualquer lugar, e o robô continua funcionando mesmo se a internet cair na hora da apresentação.

```
   🏠 LOCAL (notebook na apresentação)          ☁️ NUVEM (grátis)
   🤖 Robô ESP32 ──Wi-Fi──┐
                          ▼                      ┌──────────────────┐
   💻 Servidor Cogni ─────────── internet ─────▶ │  SUPABASE        │
      (localhost:3000)                           │  Postgres + Auth │
      voz/IA/TTS = LOCAL ✅                       │  + RLS + Realtime│
      cache RAM (leitura síncrona)               │                  │
                                                 │  responsaveis    │
   🌍 Pais (qualquer lugar)                       │  criancas        │
   📱 Companion (Vercel) ──────── internet ─────▶ │  conversas       │
      anon key + RLS                             │  planos_estudo   │
                                                 │  pareamentos     │
                                                 └──────────────────┘
```

---

## 🤝 Workflow (quem faz o quê)

São **dois projetos/repositórios separados**:

| Projeto | Pasta | Papel |
| --- | --- | --- |
| 🧠 **Servidor + robô** | `Cogni/` | Backend: refactor pro Supabase, persistência de conversas, injeção dos planos no cérebro da Cogni, pareamento |
| 🎨 **Site / Companion** | `Cogni Software/` | Front-end: telas do dashboard (seguindo o **contrato de dados** abaixo), auth, leitura/escrita no Supabase |

A regra de ouro: **as duas pontas programam contra o contrato de dados deste documento**. Nomes de tabela/coluna e formatos saem daqui — ninguém inventa.

---

## 🧱 Princípios da arquitetura (inegociáveis)

1. **Robô nunca trava esperando a nuvem.** No servidor, a leitura de perfil é **síncrona do cache em RAM**. A nuvem é sincronizada **por baixo** (write-through assíncrono).
2. **Fallback local.** O `usuarios.json` continua existindo como rede de segurança. Sem as credenciais do Supabase no `.env`, o servidor roda **exatamente como hoje** (flag `SUPABASE_HABILITADO`).
3. **De graça.** Supabase free tier + Vercel free.
4. **Segurança real (LGPD — dados de menores).** RLS por padrão nega tudo; cada responsável só enxerga os filhos vinculados a ele. A `service_role key` fica **só** no `.env` do servidor; o site usa a `anon key` (pública por design, protegida por RLS).
5. **Mexer no mínimo.** Reaproveitar o que já existe no servidor (cache, fila por usuário, filtro de segurança, pipeline pós-resposta).

---

## 🗂️ Escopo do MVP (o que entra de verdade)

### Telas do dashboard
Sidebar: **Início · Conversas · Aprendizado · Planos · Configurações** (a "Família" foi fundida em Configurações: o item da sidebar chama "Configurações", o título da tela continua "Configurações da família"). Entrada: badge de logado → dropdown → **Dashboard**.

> **Vínculo 1:1 (single-child).** No Companion, **um responsável acompanha UMA criança** — a que estiver com o **código de pareamento ativo**. Não há seletor de criança nem lista de filhos. (O robô continua multi-perfil para teste/dev, mas só o perfil pareado aparece no Companion. Despareou/pareou outro → o Companion reflete o outro.)

### Funções e seus dados

| Tela | Entra no MVP | Como o dado nasce |
| --- | --- | --- |
| 🏠 **Início** | Tempo de uso do dia, última conversa, próximo plano, resumo da semana (**sem conquistas**), Dica do Cogni (IA) | Tempo de uso = soma da duração das conversas. Dica = IA 1×/dia com base em memórias + tópicos recentes |
| 🗣️ **Conversas** | Timeline por dia; cada conversa com **matéria** + **horário**; balões criança/Cogni; filtro de **tópicos sensíveis**; busca + filtro por matéria | Gravado a cada turno (ver Diário). Sensível = a **IA** marca (bullying, tristeza, medo… mesmo sem palavra-chave) + `verificarEntrada()` do `safety.js` como rede de segurança |
| 📚 **Aprendizado** | Tempo por matéria, tópicos explorados, gráfico de evolução (min/dia), **Dicas da Cogni** (era "Curiosidades da criança"), contadores (**sem conquistas**) | Tempo por matéria/gráfico = soma das durações por matéria. Tópicos = extraídos das conversas. **Dicas da Cogni** = dica atual (`/api/dica`) + histórico (tabela `dicas`). As "curiosidades da criança" (frases tipo "perguntou 4× sobre X") foram **aposentadas** (jun/2026) — a seção virou Dicas da Cogni |
| ✏️ **Planos** | Lista (Ativos/Todos/Concluídos) + criar/editar. Campos: título, conteúdo, foco, duração (dias), status | O **pai digita**. O plano ativo é injetado no system prompt da Cogni |
| ⚙️ **Configurações** (inclui "Família") | Perfil da criança pareada → detalhe (ver/editar infos + prompt personalizado); conta; tema; status da conexão do robô | Edição bidirecional do perfil (pai edita no site, robô capta por voz — os dois mexem no mesmo registro). O pai pode preencher infos antes mesmo do robô captar. **Editar o perfil no site já conta como onboarding feito**: a Cogni não refaz as perguntas de apresentação (ver instrumentação) |
| 📬 **Resumo Semanal** | Bilhete carinhoso por IA | IA resume as conversas da semana (depende do Diário; feito por último) |

### ❌ Anulado (decisão explícita — NÃO construir)
- **Conquistas / badges** (apareciam em 3 telas).
- **Limites de tempo e horários do robô** (site→robô forçar limite) — desnecessário pro TCC.
- **Humor** e **Concentração** (chips do Início + filtro de humor em Conversas) e a frase-resumo do dia.
- **"Adicionar responsável"** e **multi-filho / seletor de criança** — o Companion é **1 responsável ↔ 1 criança** (a pareada).
- **Filtros de segurança na tela de Configurações** (o robô já tem o filtro infantil).
- **Notificações / sininho 🔔 / preferências de notificação** — removido do MVP (decisão de jun/2026). Não há sininho nem preferências de notificação; o backend nunca teve lógica de notificação pro pai (o acompanhamento é o pai abrindo o dashboard).

> ⚠️ Os designs do Figma foram gerados por IA como **base visual** — há inconsistências entre telas (header/menu). Seguimos as **features**, não os detalhes visuais exatos.

---

## 💡 A chave de dados que economiza trabalho

Gravar em **cada conversa** a `materia` + a `duração` (início/fim) resolve de uma vez **três** features:
- ⏱️ Tempo de uso do dia (Início)
- 📊 Tempo por matéria (Aprendizado)
- 📈 Gráfico de evolução min/dia (Aprendizado)

Um dado, três coelhos. 🎯

---

## 🧬 Schema do banco (Supabase / Postgres)

> Tipos pensados pra simplicidade de TCC com segurança real. `idiomas_estudando` e `memorias` ficam como **jsonb** (são detalhe interno do perfil, ninguém faz query neles e têm limite embutido).

### `responsaveis` — os pais (espelha `auth.users`)
| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | uuid PK | = `auth.users.id` (FK, on delete cascade) |
| `nome` | text | |
| `email` | text | |
| `criado_em` | timestamptz | default now() |

### `criancas` — o perfil da criança (= o usuário de hoje)
| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | **text** PK | mantém o id do robô `usuario_<ts>_<hex>` — **não trocar pra uuid** (usado em sessão/ESP/rate-limit) |
| `nome` | text | |
| `role` | text | `estudante` \| `desenvolvedor` |
| `idade` | int | nullable |
| `serie` | text | nullable |
| `materia_favorita` | text | nullable |
| `materia_dificil` | text | nullable |
| `como_aprende` | text | nullable |
| `hobbies` | text | nullable |
| `estilo_linguagem` | text | nullable |
| `onboarding_completo` | boolean | default false |
| `memorias` | jsonb | array de strings, default `[]` |
| `idioma_nativo` | text | default `pt` |
| `idiomas_estudando` | jsonb | array de objetos, default `[]` |
| `prompt_personalizado` | text | **novo** — instruções do pai pra Cogni sobre esse filho |
| `responsavel_id` | uuid | FK → responsaveis(id), nullable até parear |
| `codigo_pareamento` | text unique | **novo** — código FIXO do perfil (6 chars, sem ambíguos), gerado no nascimento do perfil, permanente. O pai usa pra vincular no Companion |
| `rosto_robo` | jsonb | **novo** — a geometria dos olhos que a **criança** desenhou (ver "🎨 O editor de rosto"). Nullable: sem valor = rosto de fábrica. Cada criança tem o seu, e trocar de perfil troca a cara do robô na hora |
| `criado_em` | timestamptz | |
| `ultimo_acesso` | timestamptz | |
| `atualizado_em` | timestamptz | |

### `conversas` — o Diário
| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | bigint identity PK | |
| `crianca_id` | text | FK → criancas(id), on delete cascade |
| `texto_usuario` | text | fala da criança |
| `texto_resposta` | text | resposta da Cogni |
| `materia` | text | uma de: portugues, matematica, ciencias, historia, geografia, idiomas, outros. Classificada pela **IA** que já roda no servidor (mais precisa); o regex local é só fallback se a IA não classificar |
| `topico` | text | **novo** — assunto fino da troca (ex: "sistema solar", "tabuada do 7"); nullable (papo/turno sem assunto = NULL). Extraído pela IA que já roda no servidor (custo zero) |
| `sensivel` | boolean | true se a conversa tocou algo emocionalmente delicado pros pais (bullying, tristeza, medo, etc.) — detectado pela **IA** (entende nuance, não precisa de palavra-chave literal) **OU** pelo filtro de segurança como rede de proteção. default false. Marca pro pai ver; **não** bloqueia a conversa (bullying a Cogni acolhe) |
| `duracao_ms` | int | duração do turno (pra somar tempo de uso/matéria). **Voz (robô):** tempo real de fala medido pelo VAD do mic. **Texto/voz-navegador:** tempo de geração da resposta da IA. Preenchido pelo servidor nos dois fluxos (antes vinha `null` em conversa por texto) |
| `origem` | text | `robo` \| `navegador` |
| `criado_em` | timestamptz | default now() |

Índice: `(crianca_id, criado_em desc)`.

### `planos_estudo` — os Planos
| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | bigint identity PK | |
| `crianca_id` | text | FK → criancas(id), on delete cascade |
| `responsavel_id` | uuid | FK → responsaveis(id) — **NOT NULL** no banco (o site deve sempre enviar o `auth.uid()` ao criar um plano) |
| `titulo` | text | |
| `conteudo` | text | texto livre injetado no system prompt |
| `foco` | text | matéria (mesma lista de `conversas.materia`) |
| `duracao_dias` | int | |
| `status` | text | `ativo` \| `em_andamento` \| `pausado` \| `concluido`. A Cogni **segue** (injeta no prompt) só os planos `ativo` **ou** `em_andamento`; `pausado`/`concluido` ela ignora |
| `criado_em` / `atualizado_em` | timestamptz | `criado_em` define a expiração: um plano vence quando `criado_em + duracao_dias` já passou (1 dia dura 1 dia). Plano vencido a Cogni para de cobrar, mesmo que o status ainda esteja `ativo`. `duracao_dias` null/0 = sem prazo |

Índice parcial: `(crianca_id) where status = 'ativo'`.

### `dicas` — histórico das Dicas da Cogni
> A "Dica do Cogni" da tela Início é gerada por IA (cache curto de 1h no servidor). Cada dica gerada é **guardada** aqui (só se diferente da última) pra o Companion listar o histórico na tela **"Dicas da Cogni"** (a antiga "Curiosidades da criança", em Aprendizado).

| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | bigint identity PK | |
| `crianca_id` | text | FK → criancas(id), on delete cascade |
| `texto` | text | o texto da dica |
| `criado_em` | timestamptz | default now() |

Índice: `(crianca_id, criado_em desc)`. RLS: pai só **lê** (SELECT) as dicas dos próprios filhos; **só o servidor grava** (service_role), igual `conversas`.

### ~~`pareamentos`~~ — DESCARTADA
> A tabela `pareamentos` do plano original **não é usada** (foi dropada). Em vez de um código temporário numa tabela à parte, o código vive **no próprio perfil** (`criancas.codigo_pareamento`): é fixo, nasce com o perfil e não expira. Mais simples e bate com o modelo single-child. Ver o fluxo de pareamento no contrato de dados abaixo.

### Matérias (lista fixa — categorização da conversa)
`portugues · matematica · ciencias · historia · geografia · idiomas · outros`
(o "outros" cobre papo/conversa que não é matéria escolar.)

---

## 🔐 RLS (Row Level Security)

Todas as tabelas com RLS **habilitado** e default-deny. O `service_role` (servidor) **bypassa** RLS — então as policies protegem só a superfície exposta na internet (site com anon key).

- **responsaveis**: pai só vê/edita a própria linha (`auth.uid() = id`).
- **criancas**: pai só vê/edita as crianças onde `responsavel_id = auth.uid()`.
- **conversas**: pai só **lê** (SELECT) as conversas dos próprios filhos; **não escreve** (só o servidor grava).
- **dicas**: pai só **lê** (SELECT) as dicas dos próprios filhos; **não escreve** (só o servidor grava). Mesma policy de `conversas`.
- **planos_estudo**: pai vê/cria/edita planos dos próprios filhos.
- **pareamento**: não há tabela exposta. O código mora em `criancas.codigo_pareamento` e o vínculo (setar `responsavel_id`) é feito **só pelo servidor** (service_role, via `POST /api/pareamento/vincular`) — o site nunca escreve esse campo direto.

`on delete cascade` nas FKs = **direito ao esquecimento** (apagar a criança apaga conversas e planos).

---

## 📡 Contrato de dados (para o front-end)

O site lê/escreve via `@supabase/supabase-js` (anon key, já carregado nos HTMLs). Regras práticas pro front:

- **Ler perfil da criança:** `from('criancas').select('*').eq('id', criancaId)` — campos conforme a tabela acima (snake_case).
- **Carregar a criança do pai logado (single-child):** `from('criancas').select('*').eq('responsavel_id', user.id).maybeSingle()` — a RLS garante que só vem a criança vinculada a ele. Se vier vazio → o pai ainda não pareou (mostrar o onboarding de código).
- **Ler conversas (Diário):** `from('conversas').select('*').eq('crianca_id', id).order('criado_em', { ascending: false })`. Agrupar por dia no front. Filtro de matéria = `.eq('materia', x)`; tópicos sensíveis = `.eq('sensivel', true)`.
- **Aprendizado:** derivar do `select` de `conversas` (somar `duracao_ms` por `materia` e por dia) + ler `idiomas_estudando`/`memorias` do perfil. **Tópicos explorados:** usar a coluna `topico` (preenchida pelo servidor; `null` = papo sem assunto) → lista de `topico` distintos. As **"curiosidades da criança"** (agrupar `topico` e contar, ex: "perguntou 4× sobre dinossauros") foram **aposentadas** (jun/2026): aquela seção da tela Aprendizado virou **"Dicas da Cogni"** (ver Dica do Cogni / Histórico de dicas acima). O `topico` continua alimentando "Tópicos explorados" e o Resumo Semanal.
- **Planos:** CRUD em `planos_estudo` (o pai escreve direto; RLS protege).
- **Resumo Semanal:** **não** é Supabase — é um endpoint do servidor (a chave da OpenAI vive só lá). O site faz `GET {SERVIDOR}/api/resumo-semanal?criancaId=<id>` e recebe `{ resumo, periodoDias, totalConversas, materias, topicos, vazio }`. O servidor lê as conversas dos últimos 7 dias e gera o bilhete com IA, sob demanda (quando o pai abre a tela). `vazio: true` = sem conversas na semana (o `resumo` já vem com uma mensagem amigável). `{SERVIDOR}` = a URL do servidor local da Cogni (ex: `http://localhost:3000`).
- **Dica do Cogni (tela Início):** endpoint do servidor (IA + chave da OpenAI). O site faz `GET {SERVIDOR}/api/dica?criancaId=<id>` e recebe `{ dica, deCache, vazio }`. A IA gera **uma** dica curta e acionável pros pais, com base nas memórias + tópicos recentes da criança. **Cache curto de 1h** no servidor (reflete a conversa recente sem gerar a cada reload — antes era 1 dia, dava "delay"). `deCache: true` = veio do cache; `vazio: true` = perfil sem dados ainda (dica genérica amigável). `?forcar=1` ignora o cache. Cada dica gerada é **guardada na tabela `dicas`** (só se diferente da última).
- **Histórico de dicas (tela "Dicas da Cogni", em Aprendizado):** o site **lê direto do Supabase** (RLS), igual conversas: `from('dicas').select('*').eq('crianca_id', id).order('criado_em', { ascending: false })`. A dica **atual** (destaque) vem do `GET /api/dica`; o **histórico** (lista) vem desse select. Essa tela é a antiga "Curiosidades da criança", renomeada pra **"Dicas da Cogni"**.
- **Escrita de conversa:** o site **nunca** insere em `conversas` (RLS bloqueia) — quem grava é o servidor.
- **Pareamento (onboarding do site):** quando o pai loga e **não tem criança vinculada** (o `select` de `criancas` por `responsavel_id` vem vazio), o site mostra o onboarding pedindo o **código de pareamento** (6 caracteres, o pai pega no robô — na tela do painel ou pedindo pra Cogni falar). O site faz `POST {SERVIDOR}/api/pareamento/vincular` com `{ codigo, responsavelId }` (o `responsavelId` = `auth.uid()` do pai logado). Respostas: `200 { ok:true, jaPareado?, criancaId, nome }` (pareou ou já era dele) · `404` código inválido · `409` criança já vinculada a outro responsável · `400` dados faltando. Depois de pareado, o site lê a criança normalmente por `responsavel_id` (RLS) e tudo (conversas/planos/aprendizado) vem junto. O **vínculo é permanente** (não expira); só some se despareado. `{SERVIDOR}` = a URL do servidor local da Cogni.
- **Despareamento:** `POST {SERVIDOR}/api/pareamento/desvincular` com `{ criancaId, responsavelId }`. Zera o `responsavel_id` da criança (**só** se quem pede for o dono — um pai não desvincula filho de outro). Respostas: `200 { ok:true, jaDesvinculado? }` (`jaDesvinculado:true` quando já não estava vinculada a ele — idempotente) · `404` criança não encontrada · `400` dados faltando. O `codigo_pareamento` **não muda**, então dá pra reparear depois com o mesmo código. Uso no site (etapa "status de vínculo"): mostrar "Conectado ao perfil de [nome]" + botão "Desvincular" (recomenda-se confirmar antes — apagar o vínculo tira o acesso às conversas daquele filho).

> O front usa **snake_case** (como vem do Postgres). O servidor converte snake↔camel internamente (o código do servidor usa camelCase: `materiaFavorita` etc.).

---

## 🎨 O editor de rosto (a criança desenha os olhos do robô)

Essa é a única tela do Companion feita **para a criança**, não para o pai — e é a que tem respaldo acadêmico mais direto: um estudo de 2025 mostrou que um rosto **desenhado pela própria criança** tem *inteligência social percebida* significativamente maior que um rosto genérico, e aponta que quase todo robô infantil é projetado da perspectiva de um adulto. No TCC isso vira hipótese testável com grupo de controle: mesmo robô, mesmo conteúdo, mudando só quem desenhou a cara dele.

### O que a criança controla

O robô desenha os olhos **proceduralmente** (não são imagens), então o que o editor expõe são cinco parâmetros — e só esses cinco. Qualquer coisa fora dessa lista o firmware ignora.

| Campo | Tipo | Faixa aceita | Padrão | O que muda na cara |
| --- | --- | --- | --- | --- |
| `largura` | int (px) | 14 – 48 | 36 | Olho fino ou largo |
| `altura` | int (px) | 12 – 48 | 36 | Olho espremido ou arregalado |
| `raio` | int (px) | 0 – 16 | 8 | **0 = quadradão (sério/robótico)**, 16 = bem redondo (fofo) |
| `espaco` | int (px) | −4 – 34 | 10 | Distância entre os olhos; negativo cruza (vesguinho permanente) |
| `sobrancelhas` | boolean | — | `true` | Liga/desliga as sobrancelhas |

> ⚠️ **A faixa é validada no firmware**, que é quem conhece a tela de 128×64. O site deve respeitar os limites acima na UI (sliders), mas não precisa se preocupar em blindar: um valor fora da faixa é **grampeado**, nunca desenha fora da tela.

### Os dois endpoints

Ambos no servidor local da Cogni (`{SERVIDOR}`), porque quem fala com o robô é ele:

```
GET  {SERVIDOR}/api/esp/rosto?usuarioId=<id>
  → { rostoRobo: { largura, altura, raio, espaco, sobrancelhas }, padrao: {...} }

PUT  {SERVIDOR}/api/esp/rosto
  body: { usuarioId, largura, altura, raio, espaco, sobrancelhas }
  → { rostoRobo, aplicadoNoRobo: true|false }
```

`aplicadoNoRobo` diz se o robô estava conectado **e** usando aquele perfil. `false` não é erro: o rosto foi salvo e vai valer na próxima conexão.

### O detalhe que faz a tela ser divertida

O `PUT` aplica **na hora** no robô físico. Então o editor deve mandar a cada mudança de slider (com um *debounce* de ~150 ms) e a criança vê **o robô de verdade mudando de cara ao vivo** enquanto arrasta. É isso que transforma um formulário numa brincadeira — sem o preview ao vivo, a feature perde a graça inteira.

Recomendado: um preview em SVG/Canvas no próprio site (dois retângulos arredondados + as barrinhas das sobrancelhas), para funcionar mesmo com o robô desligado.

### Onde o dado mora

`criancas.rosto_robo` (jsonb). O robô lê do perfil local, que já é hidratado do Supabase pelo caminho normal — **não há sincronismo novo a construir**. O servidor manda o rosto pro robô em dois momentos: quando ele conecta (o firmware não guarda geometria entre reinícios) e quando **troca o perfil ativo** — o que é o que faz a ideia valer numa casa com mais de um filho.

---

## 🪜 Fases de execução (ordem de menor risco)

| Fase | O que | Risco no robô |
| --- | --- | --- |
| **0 — Fundação** | Criar projeto Supabase, rodar o SQL (schema + RLS), ativar Realtime, `npm i @supabase/supabase-js` | Zero |
| **1 — Auth** | Colar credenciais no site; ligar cadastro → `responsaveis`; onboarding de pareamento na 1ª entrada | Zero |
| **2 — Migração do servidor** | Cliente Supabase + hidratação no boot + write-through + Realtime, atrás da flag. `carregarUsuario` continua síncrono | Baixo (com fallback JSON) |
| **3 — Funções (1 por vez)** | Aprendizado → Diário → Planos → Resumo. Cada uma: backend + tela + teste | Baixo |
| **4 — Pareamento (single-child)** | Código no robô + onboarding no site na 1ª entrada (vincula a criança ao responsável); a criança pareada é a que o Companion mostra | Zero |

Cada função: **eu (backend) → atualizo o contrato → Claude do site (tela) → testamos juntos.**

---

## 🧩 Pontos de instrumentação no servidor (já mapeados)

- **Gravar conversa:** `server/modules/brain.js` → `pipelinePosResposta(usuario, usuarioId, sessionId, textoUsuario, textoResposta, ehOnboarding, historico, contextoIdioma)` (linha ~230). Roda nos **dois** caminhos (robô e navegador), fire-and-forget. Já tem tudo no escopo; adicionar só o parâmetro `origem`.
- **Marcar sensível:** ✅ **feito.** A **IA** pós-resposta (`brain/memoria-ai.js`, a mesma chamada que extrai memória/tópico) devolve `sensivel` (entende nuance: bullying, tristeza, medo, sem precisar de palavra-chave). O `pipelinePosResposta` grava `sensivel = IA || verificarEntrada()` (regex do `safety.js` como rede de segurança). Sensível **marca pro pai**, não bloqueia (o bloqueio é só pro conteúdo realmente impróprio).
- **Classificar matéria:** ✅ **feito.** A **IA** pós-resposta também classifica a `materia` (mais precisa que regex). O `brain/materia.js` (regex) é só fallback quando a IA não classifica. Grava no insert (regex) e a IA enriquece via UPDATE (`atualizarConversaPosIA` em `supabase.js`).
- **Onboarding inteligente:** ✅ **feito.** `brain/memoria-ai.js` → `camposEssenciaisFaltantes(usuario)`/`temEssenciais(usuario)` (idade, série, hobbies, comoAprende). Se o pai preencheu tudo no site, o `verificarOnboarding` fecha a flag na hora e o `blocoOnboarding` (prompt.js) vira no-op — a Cogni **não refaz** as perguntas nem sobrescreve. Se faltam campos, ela pergunta **só os que faltam**.
- **Injetar plano no prompt:** ✅ **feito.** `server/modules/planos.js` (novo) faz cache RAM do plano ativo por criança — `obterPlanoAtivo(id)` é leitura **síncrona** (robô não trava), `refrescarPlanoAtivo(id)` atualiza em segundo plano (plano novo entra no turno seguinte), `hidratarPlanos()` pré-carrega no boot. O `blocoPlanoEstudo(usuario, plano)` em `prompt.js` injeta título+foco+conteúdo (tom roteiro-não-prisão, **proativo**: a Cogni puxa/retoma o assunto do plano) via `extras.plano`, só pro estudante. Conta `status` `ativo` **ou** `em_andamento`; **expira** por `criado_em + duracao_dias` (1 dia dura 1 dia → para de cobrar). **1 plano vigente por criança** (single-child); se houver vários, vale o mais recente por `atualizado_em`.
- **Dica do Cogni:** ✅ **feito.** `server/modules/brain/dica.js` (novo) → `gerarDicaDoCogni({openai, modelo}, criancaId)`, exposto em `GET /api/dica?criancaId=`. IA gera uma dica curta e acionável pros pais com base em memórias + tópicos recentes. **Cache RAM curto de 1h** por criança (antes era 1 dia, dava "delay" — agora reflete a conversa recente sem regerar a cada reload); `?forcar=1` ignora o cache. Cada dica gerada é guardada na tabela `dicas` (só se diferente da última).
- **Camada de dados:** `server/modules/memoria.js` (cache + fila por usuário `filasPorUsuario` + `atualizarUsuario` async já existem — reaproveitar pro merge robô↔pai).
- **Sync de volta (Supabase → robô):** ✅ **feito.** Antes a hidratação só rodava no **boot** — o que o pai editava no site nunca voltava pro cache do robô (ele refazia o onboarding por cima). Agora há 3 caminhos, com **degradação graciosa** (se um falha, o outro cobre): (a) `refrescarUsuario(id)` fire-and-forget no início de cada conversa (`brain.js`), traz a edição do pai pro turno seguinte; (b) `carregarUsuarioFresco(id)` **awaited** — só quando o perfil do cache parece incompleto (perfil novo / sem essenciais), garante que o **1º turno** já use o que o pai configurou, sem refazer onboarding; (c) **Realtime** do Supabase na tabela `criancas` (`iniciarRealtimeUsuarios` no boot) atualiza o cache **na hora** que o pai salva. Além disso, `GET /api/usuarios` chama `refrescarTodosUsuarios()` (puxa a lista fresca) pra um perfil **criado no site** aparecer na interface localhost sem reiniciar. **Regra de merge:** os campos que o pai edita (perfil, prompt, vínculo, `onboarding_completo`) vêm do Supabase; `memorias`/`idiomas_estudando`/`estilo` que o robô aprende são **preservados** (não sobrescritos). ⚠️ O Realtime exige habilitar a tabela `criancas` em *Database → Replication* no painel do Supabase — sem isso, só os caminhos (a)/(b) funcionam (suficientes, só não instantâneos).
- **Ciência do Companion no prompt:** ✅ **feito.** `secaoCompanion()` em `brain/prompt.js`: a Cogni **sabe** o que é o app dos pais (acompanham conversas/tempo/tópicos, criam planos, recebem resumo semanal + dicas, pareiam por código) e responde dúvidas da criança com **honestidade e leveza** (acompanham pra apoiar, não pra vigiar). Só pro estudante.
- **Boot/shutdown:** `server/index.js` (boot vira async com `await inicializar()` antes do `listen`; `flushSync` no shutdown).
- **Flag/config:** `server/config.js` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_HABILITADO`).

---

## ✅ Como testar (ponta a ponta)

- **Servidor sem credenciais** → robô/voz idênticos a hoje (fallback JSON).
- **Servidor com credenciais** → perfis hidratam do Supabase; conversas aparecem na tabela; plano editado no site entra no próximo turno do robô.
- **Internet cai com servidor no ar** → robô continua conversando (cache RAM).
- **Site** → logar → badge → Dashboard → dados da criança vinculada aparecem; criança de outra família **não** aparece (RLS).
- **Pareamento** → código no robô → digita no site → criança vincula.
- Ferramentas: Playwright (já em uso no site) pras telas; scripts pra checar persistência.

---

## 🔑 O que o Nicolas fornece (manual)

1. **Conta Supabase + credenciais** (URL, anon key, service_role key) — passo a passo no chat na Fase 0.
2. Decisões de produto pontuais que surgirem.

(O Claude gerencia os `.env`. Credenciais rotacionadas depois pelo Nicolas.)

---

*Documento vivo — atualizar aqui antes de mudar qualquer ponta. Feito pro TCC do Nicolas · UNASP · 2026.*
