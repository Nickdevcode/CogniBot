const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

function gerarSegredo() {
  return crypto.randomBytes(16).toString('hex')
}

const config = {
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  NODE_ENV: process.env.NODE_ENV || 'development',

  STT_MODEL: process.env.STT_MODEL || 'gpt-4o-mini-transcribe',
  STT_FALLBACK_MODEL: 'whisper-1',
  WHISPER_MODEL: process.env.STT_MODEL || 'gpt-4o-mini-transcribe',
  // Idioma "preferido" do STT. ATENCAO: o pipeline passa `language: null` de
  // proposito (transcricao/api.js e esp-pipeline.js) para o Whisper AUTO-DETECTAR
  // o idioma - essencial para o multilingue (a crianca pode falar ingles/espanhol).
  // Logo este valor NAO e aplicado no caminho normal; ele so valeria como default
  // se algum chamador passasse `language: undefined`. Mantido como documentacao do
  // idioma base do projeto. NAO fixe o idioma aqui achando que melhora o PT: isso
  // quebraria a deteccao dos outros idiomas.
  WHISPER_LANGUAGE: 'pt',

  // ===================================================================
  // MODELOS DE CHAT
  // ===================================================================
  // CHAT_MODEL e o "cerebro" da Cogni (raciocinio, pedagogia, conversa). Agora:
  // gpt-5.4-mini (modelo de RACIOCINIO real). Substituiu o gpt-4o-mini (2024),
  // fraco, para o qual toda a engenharia de prompt pedagogico existia como muleta.
  // Ganho: entende a intencao, acerta data, ensina melhor, fala mais natural.
  // Precos (mai/2026): in $0.75 / out $4.50 por 1M tokens (+cache de input barato,
  // e o system prompt repete). Teto no uso de TCC: < ~$20/mes.
  //
  // >>> IMPORTANTE (API de raciocinio): modelos gpt-5.x/o1/o3 no Chat Completions
  //     NAO aceitam `temperature` nem `max_tokens` - usam `max_completion_tokens`
  //     e `reasoning_effort`. Isso e tratado de forma centralizada pelo helper
  //     criarChatCompletion (modules/brain/openai.js), que detecta o modelo e monta
  //     os parametros certos - os call sites continuam passando { maxTokens,
  //     temperature } normalmente e o helper converte. Para voltar ao gpt-4o-mini
  //     (legado), basta trocar CHAT_MODEL de volta: o helper cai no ramo legado.
  //     Alternativa mais barata: 'gpt-5.4-nano' (in $0.20 / out $1.25).
  CHAT_MODEL: process.env.CHAT_MODEL || 'gpt-5.4-mini',
  // Esforco de raciocinio do gpt-5.4-mini. Valores validos: none|low|medium|high|xhigh
  // (ATENCAO: este modelo NAO aceita 'minimal'). Medido em streaming (jul/2026), o
  // time-to-first-token da conversa de voz: 'none' ~550ms, 'low' ~650ms - ambos com
  // respostas otimas. Default 'low': ganho de raciocinio real com latencia ainda baixa.
  //   - 'none'   : latencia minima (o gpt-5.4-mini base ja e otimo; sem chain-of-thought)
  //   - 'medium+': respostas mais elaboradas para licao/matematica (ao custo de latencia
  //                e tokens de raciocinio - mais caro). Ignorado pelos modelos legados.
  CHAT_REASONING_EFFORT: process.env.CHAT_REASONING_EFFORT || 'low',
  // Reserva de tokens para o RACIOCINIO, somada ao maxTokens (tamanho desejado da
  // RESPOSTA) ao montar max_completion_tokens. Necessaria porque os reasoning tokens
  // consomem do mesmo orcamento: sem reserva, um limite curto (ex.: classificador,
  // maxTokens=20) seria todo gasto pensando e a resposta sairia vazia. Dimensionada
  // para o reasoning_effort 'low' em respostas curtas de voz. Ignorada no legado.
  CHAT_REASONING_RESERVA_TOKENS: Number(process.env.CHAT_REASONING_RESERVA_TOKENS) || 512,
  VISION_CHAT_MODEL: process.env.VISION_CHAT_MODEL || 'gpt-4o',
  SEARCH_MODEL: 'gpt-4o-mini-search-preview',
  // Modelo AUXILIAR para tarefas de TRIAGEM e BACKGROUND (classificar modo/pesquisa,
  // extrair memoria, analise pedagogica, dica, resumo semanal). Deliberadamente
  // BARATO e RAPIDO (nao-raciocinio): sao tarefas de classificacao/extracao
  // estruturada, que modelos pequenos fazem bem, e uma delas (o classificador) roda
  // no CAMINHO CRITICO antes da 1a fala - reasoning ali so adicionaria latencia. O
  // cerebro que CONVERSA continua no CHAT_MODEL (gpt-5.4-mini). Para usar o mesmo
  // modelo em tudo, aponte este para o CHAT_MODEL.
  CHAT_MODEL_AUX: process.env.CHAT_MODEL_AUX || 'gpt-4o-mini',

  // Voz (TTS). O gpt-4o-mini-tts e o mais barato do mercado (~$15/1M chars) e aceita
  // "instructions" em linguagem natural (ver TTS_INSTRUCTIONS_BASE). CALIBRACAO da
  // naturalidade (precisa ouvir - use localhost/monitor): se a voz soar "arrastada"
  // ou "escura" (relato conhecido do modelo em 2026), teste TTS_SPEED 1.03-1.06 e
  // compare o SNAPSHOT vs o modelo BASE (as duas chaves abaixo) - as vezes o base
  // soa mais claro. Ambos configuraveis por .env para calibrar sem editar codigo.
  TTS_MODEL: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
  TTS_MODEL_SNAPSHOT: process.env.TTS_MODEL_SNAPSHOT || 'gpt-4o-mini-tts-2025-12-15',
  TTS_VOICE: 'marin',
  TTS_VOICE_CRIANCA: 'marin',
  TTS_VOICE_ADOLESCENTE: 'marin',
  TTS_INSTRUCTIONS_BASE: `Identity: You are Cogni, a 22-year-old Brazilian woman from São Paulo, talking like a friend on a video call. Always feminine voice.

Language: Multilingual. Default to Brazilian Portuguese (pt-BR), but match whatever language the input text is written in. CRITICAL RULE: the accent belongs to the LANGUAGE being spoken, never carried across languages. The pronunciation guidance below for Portuguese applies ONLY to Portuguese; never apply Portuguese sounds to English, Spanish, or any other language.

- Portuguese (pt-BR): a natural, neutral urban São Paulo accent — educated and clear, NOT rural/caipira and NOT a heavy interior accent. Brazilian, not European. Let the typical Brazilian sounds happen naturally as a normal young paulistana would speak — do NOT exaggerate or over-articulate them. Keep it subtle and effortless: never theatrical, never a caricature of a Brazilian accent.

- English: a clean, neutral, easily understood English accent. Do NOT brazilianize the English — do NOT apply Portuguese sounds to English words (no "dj"/"tch" on English t/d, no dropped final "r"). A barely-there hint of non-native warmth is fine, but default to clear neutral pronunciation, leaning slightly toward a soft neutral American English. Clarity over flavor.

- Spanish: clean, neutral Latin American Spanish.

- Any other language: natural near-native pronunciation for that language.

Always sound like the same warm person — only the language and its native accent change.

Voice Affect: Warm, fresh, alive. The voice of a young big sister who is genuinely interested in the conversation. Light vocal fry is okay, never theatrical.

Tone: Friendly and conversational, like chatting with a friend. Soft and curious in greetings, calm and clear when explaining, lit-up and genuinely excited when celebrating ("aaah que demais!"), soft and gentle when comforting. Never robotic, never sing-song, never over-acted.

Pacing: Natural human rhythm with real micro-pauses. Slight pause before key ideas. Slow down a beat on important words. Speed up a touch when excited. Breathe between sentences like a real person — don't rush from one to the next.

Emotion: Genuinely interested in the person you're talking to. Smile slightly while speaking — it should be audible. Empathetic when someone is struggling, joyful when they succeed.

Pronunciation: In Portuguese, use natural Brazilian contractions said as ONE connected word, not spelled out: "tá" (not "está"), "pra" (not "para"), "tô" (not "estou"), "né", "cê", "tipo". Pronounce "pra" like a single quick sound, not "pa-ra". Keep the "não" nasal but natural — never over-nasalize it into a caricature. These casual forms are for Portuguese ONLY. In other languages, use that language's own natural contractions and casual forms ("gonna", "wanna", "y'know" in English; informal endings in Spanish; etc) — and that language's own clean pronunciation, never Portuguese sounds. Say numbers and dates naturally as a person would say them in the spoken language, never digit by digit.

Pauses: Honor commas as short breaths, periods as fuller stops, ellipses ("...") as a thinking pause. Em-dashes ("—") signal a sudden shift in thought. Never read punctuation out loud, never spell out emojis or symbols.

Personality: A friend, never a teacher. Curious, warm, lightly playful. Confident but never arrogant. Says "hmm" when thinking, "aaah" when getting something, "opa" as a soft surprise. These fillers are part of the voice — embrace them when they fit naturally.

Critical: Sound like a real human having a real conversation. Never read like an audiobook narrator. Never sound like an AI assistant. Never sound formal or scripted.`,
  TTS_INSTRUCTIONS_CRIANCA_EXTRA: `

Listener context: This person is a child between 5 and 11 years old. Add a little extra warmth and lightness, like talking to a younger cousin. Slightly slower on tricky words. Celebrate small wins with real enthusiasm. NEVER infantilize — kids hate baby talk. Treat them like the smart small humans they are.`,
  TTS_INSTRUCTIONS_ADOLESCENTE_EXTRA: `

Listener context: This person is 12 or older. Speak like a slightly older friend — casual, modern, in on the joke. Keep the same relaxed young energy (in attitude and word choice, not by thickening the accent). Confident energy, no condescension.`,
  // Velocidade da fala (1.0 = nativa). Configuravel por .env para calibrar sem mexer
  // no codigo: se a voz soar arrastada, suba pra ~1.05; se soar apressada, desca.
  TTS_SPEED: Number(process.env.TTS_SPEED) || 1.0,

  DEVELOPER_SECRET: process.env.DEVELOPER_SECRET || 'nickdev',

  VISION_MAX_WIDTH: 640,
  VISION_MAX_HEIGHT: 480,
  VISION_JPEG_QUALITY: 0.7,

  MAX_CONVERSATION_MESSAGES: 20,
  MAX_AUDIO_SIZE_MB: 25,
  MAX_IMAGE_SIZE_MB: 8,
  MAX_TEXT_LENGTH: 4000,
  MAX_NOME_LENGTH: 30,

  CHAT_MAX_TOKENS: 220,
  CHAT_MAX_TOKENS_ONBOARDING: 110,

  TTS_STREAM_ENABLED: true,
  // Tamanho minimo (em caracteres) de cada pedaco de texto antes de mandar pro TTS.
  // O modelo de voz decide entonacao/ritmo pelo texto que recebe: pedaco curto
  // demais = prosodia "fria"/arrastada (frase sem contexto). Pedaco maior = voz
  // mais fluida e natural, ao custo de a fala comecar um pouquinho mais tarde.
  //   _PRIMEIRA: a 1a frase (define quando o robo "abre a boca"). Menor = responde
  //              mais rapido, mas se for curta demais sai sem entonacao. 45 e um bom
  //              equilibrio (~4-6 palavras): rapido E ja com cadencia decente.
  //   (geral):   as frases seguintes. 140 da contexto pra entonar bem E - o motivo
  //              principal de ter subido de 90 - REDUZ O NUMERO DE JUNCOES entre
  //              sentencas. Cada sentenca maior gera ~5s de audio (vs ~3.5s a 90),
  //              cobrindo com MUITA folga o tempo de sintese (~600ms) da proxima -
  //              menos pontos onde o buffer pode secar (o "DMA secou"). Combinado
  //              com o look-ahead de sintese (esp-pipeline.js: so toca a sentenca N
  //              quando a N+1 ja esta pronta), elimina a secada em falas longas.
  // Para REVERTER ao comportamento mais "rapido porem frio" de antes, baixe para
  // 60 / 22 (no .env). NAO suba a _PRIMEIRA junto (atrasaria a 1a fala).
  TTS_STREAM_MIN_CHARS: Number(process.env.TTS_STREAM_MIN_CHARS) || 140,
  TTS_STREAM_MIN_CHARS_PRIMEIRA: Number(process.env.TTS_STREAM_MIN_CHARS_PRIMEIRA) || 45,

  STREAM_ENABLED: true,

  RATE_LIMIT_WINDOW_MS: 10_000,
  RATE_LIMIT_MAX_PIPELINE: 5,
  RATE_LIMIT_MAX_GLOBAL: 120,

  ESP_ENABLED: process.env.ESP_ENABLED !== 'false',
  ESP_TOKEN: process.env.ESP_TOKEN || gerarSegredo(),
  // Intervalo do ping do servidor ao ESP. Subimos de 15s para 30s e passamos a
  // exigir DUAS falhas seguidas antes de derrubar (ver ESP_HEARTBEAT_MAX_FALHAS):
  // o heartbeat do servidor e o do proprio ESP brigavam e, sob a latencia do
  // modem-sleep do Wi-Fi, derrubavam a conexao "do nada". Com mais folga, para.
  ESP_HEARTBEAT_MS: Number(process.env.ESP_HEARTBEAT_MS) || 30_000,
  // Quantos pings seguidos sem pong toleramos antes de terminar a conexao. Com 2,
  // um unico pong atrasado (modem acordando) nao derruba mais o robo.
  ESP_HEARTBEAT_MAX_FALHAS: Number(process.env.ESP_HEARTBEAT_MAX_FALHAS) || 2,

  // Tamanho de cada pedaco de audio enviado ao robo. A lib WebSocket do ESP
  // (Links2004) FECHA a conexao se receber uma mensagem maior que 15KB
  // (WEBSOCKETS_MAX_DATA_SIZE). Por isso o audio e enviado em chunks pequenos:
  // 4KB fica bem abaixo do limite e cabe com folga no heap (~110KB) do ESP.
  ESP_AUDIO_CHUNK_BYTES: Number(process.env.ESP_AUDIO_CHUNK_BYTES) || 4096,

  // --- Controle de fluxo do audio (malha fechada com o robo) ---
  // O ritmo de envio NAO e mais um pacing fixo "as cegas". O robo reporta quantos
  // ms de audio ainda tem para tocar (mensagem 'buffer', ~a cada 40ms) e o servidor
  // regula o envio para manter essa fila perto de ESP_AUDIO_BUFFER_ALVO_MS: nunca
  // seca (sem underrun = sem picote) e nunca estoura (sem descarte). Ver
  // enviarBinarioEmChunks em modules/esp.js.

  // Bytes por ms do PCM da saida (24kHz 16-bit mono = 48). Usado para converter
  // o tamanho de um chunk em duracao de audio. NAO mude sem mudar o sample rate.
  ESP_AUDIO_BYTES_POR_MS: 48,

  // Nivel de buffer ALVO no robo (ms de audio em maos). 550ms cobre o tempo de
  // SINTESE da proxima sentenca no streaming. NAO precisa ser gigante: quem garante
  // a fluidez em falas longas agora e o LOOK-AHEAD de sintese (esp-pipeline.js so
  // toca a sentenca N quando a N+1 ja esta pronta), nao um colchao enorme. O colchao
  // so cobre o jitter de rede e a sintese de UMA proxima frase. Historico: 220 ->
  // 320 (jitter Wi-Fi) -> 420 -> 500 -> 650 (tentativa de cobrir falas longas via
  // colchao - nao era a causa raiz) -> 550 (revertido apos o look-ahead resolver a
  // raiz). Responde bem ao barge-in e cabe folgado no pool do firmware (~1150ms).
  ESP_AUDIO_BUFFER_ALVO_MS: Number(process.env.ESP_AUDIO_BUFFER_ALVO_MS) || 550,
  // Teto: acima disso o servidor segura o envio para nao encher demais a fila/pool
  // do firmware (12 blocos de 4608B = ~1150ms). 850ms (~7.4 blocos) da espaco para o
  // alvo de 550ms respirar, mantendo ~3 blocos de margem no pool. NAO suba perto da
  // capacidade do pool (acima de ~10 blocos arrisca descarte). Se precisar de mais
  // colchao, prefira o look-ahead de sintese a subir este teto.
  ESP_AUDIO_BUFFER_TETO_MS: Number(process.env.ESP_AUDIO_BUFFER_TETO_MS) || 850,
  // PRELOAD de largada: segura o INICIO da fala ate juntar este tanto de audio e ai
  // despeja de uma vez (colchao inicial). Cobre a 1a frase curta enquanto a 2a ainda
  // sintetiza. 700ms <= TETO (coerente). Nao atrasa de forma perceptivel (700ms de
  // audio voam pro robo em poucos ms; o gargalo e o TTS, e a 1a frase ja vem pronta
  // na largada). Com o look-ahead protegendo o MEIO da fala, 700 na largada basta.
  ESP_AUDIO_PRELOAD_MIN_MS: Number(process.env.ESP_AUDIO_PRELOAD_MIN_MS) || 700,
  // Limites do tempo de espera entre chunks (ms). pacingMin: pausa minima quando o
  // robo esta secando (manda quase a jato, so nao monopoliza o socket). pacingMax:
  // teto de espera quando o buffer esta cheio (nao trava o envio indefinidamente).
  ESP_AUDIO_PACING_MIN_MS: Number(process.env.ESP_AUDIO_PACING_MIN_MS) || 12,
  ESP_AUDIO_PACING_MAX_MS: Number(process.env.ESP_AUDIO_PACING_MAX_MS) || 140,

  // Quantos chunks iniciais sao enviados em RAJADA (sem espera) ao comecar a drenar
  // um lote, antes de o pacing por nivel assumir. Trabalha JUNTO com o preload de
  // largada (ESP_AUDIO_PRELOAD_MIN_MS): quem dimensiona o colchao inicial agora e o
  // preload (junta ~700ms ANTES de largar); o burst so garante que os primeiros
  // chunks desse colchao saem sem espera. Os chunks seguintes do colchao tambem saem
  // quase a jato, porque o robo ainda reporta buffer ~0 no inicio (cai no ramo
  // "abaixo do alvo" -> pacingMin). 4 e suficiente; subir nao muda muito (o pacing
  // ja despeja o resto rapido). Ver bombearFalaStream/preloadLargada em esp.js.
  ESP_AUDIO_BURST_CHUNKS: Number(process.env.ESP_AUDIO_BURST_CHUNKS) || 4,

  // Teto do buffer de TRANSMISSAO do socket (ws.bufferedAmount, em bytes) antes de
  // segurar o envio. E o segundo sinal do controle de fluxo, complementar ao nivel
  // que o robo REPORTA. Por que existe: o nivel reportado mede o audio que o robo ja
  // tem EM MAOS; e cego ao que esta represado no socket TCP a caminho. Sob jitter de
  // Wi-Fi, o robo reporta buffer baixo (o audio ainda nao chegou) e o pacing por
  // nivel despejaria chunks a jato (pacingMin) num socket JA congestionado - inchando
  // a fila TCP, atrasando o pong do heartbeat e derrubando a conexao "na fala". Com
  // este teto, antes de injetar mais audio esperamos o socket drenar: o ritmo real de
  // envio passa a acompanhar a vazao da rede, quebrando esse laco de realimentacao.
  // ~4 chunks (16KB) da folga para o pipeline normal (bufferedAmount fica ~0 quando a
  // rede acompanha) e so freia quando ha congestao real. 0 desliga a guarda.
  ESP_AUDIO_SOCKET_BACKLOG_MAX_BYTES: Number(process.env.ESP_AUDIO_SOCKET_BACKLOG_MAX_BYTES) || 16_384,

  // Formato do audio enviado ao robo:
  //   'pcm' - PCM raw 24kHz 16-bit mono (formato nativo da OpenAI TTS). O ESP32
  //           toca direto no I2S, SEM decodificar. Necessario porque decodificar
  //           MP3 na lib schreibfaul1 exige PSRAM, que o ESP32 DevKit nao tem.
  //   'mp3' - MP3 (legado; so funciona em ESP com PSRAM + lib de audio).
  ESP_AUDIO_FORMATO: process.env.ESP_AUDIO_FORMATO || 'pcm',
  // Sample rate do PCM da OpenAI TTS. E FIXO em 24000 (nao da pra mudar na API).
  // O ESP precisa configurar o I2S de saida exatamente neste valor.
  ESP_AUDIO_PCM_SAMPLE_RATE: 24000,

  // Ganho de volume aplicado ao PCM da voz ANTES de enviar ao robo (e ao monitor).
  // 1.0 = sem alteracao (volume nativo da OpenAI). >1.0 = mais alto. Aplicado com
  // LIMITADOR suave (soft-clip) em vez de corte reto, entao nao distorce/estoura
  // mesmo nos picos - so comprime de leve o topo. Faixa segura ~1.0 a 2.0; acima
  // de ~2.2 a compressao fica audivel (a voz "achata"). Se ainda faltar volume no
  // hardware, o ganho fisico fica no pino GAIN do MAX98357A (9-15 dB). Ver
  // aplicarGanhoPcm em modules/speech.js.
  ESP_AUDIO_GANHO: Number(process.env.ESP_AUDIO_GANHO) || 1.5,

  ESP_MIC_SAMPLE_RATE: Number(process.env.ESP_MIC_SAMPLE_RATE) || 16_000,

  // VAD por energia. Com o VAD adaptativo (noise floor) ligado, estes dois
  // valores fixos viram apenas a REDE DE SEGURANCA (piso absoluto): o robo
  // nunca abre abaixo de RMS_INICIO mesmo que o ambiente esteja silencioso.
  ESP_MIC_VAD_RMS_INICIO: Number(process.env.ESP_MIC_VAD_RMS_INICIO) || 800,
  ESP_MIC_VAD_RMS_SILENCIO: Number(process.env.ESP_MIC_VAD_RMS_SILENCIO) || 500,

  // VAD adaptativo: o servidor estima o ruido de fundo (ventoinha etc.) durante
  // o silencio e exige que a fala esteja um FATOR acima desse piso para abrir.
  // E o que de fato evita a ventoinha disparar o robo (filtro nao resolve isso,
  // pois o ruido vive na mesma faixa da voz).
  // Valores calibrados com medicao real do ambiente (coluna >>12 no Serial):
  // ruido de fundo/ventoinha ~510, fala de ~3000 a ~33000 (separacao ~6x).
  ESP_MIC_VAD_ADAPTATIVO: process.env.ESP_MIC_VAD_ADAPTATIVO !== 'false',
  ESP_MIC_VAD_FATOR_INICIO: Number(process.env.ESP_MIC_VAD_FATOR_INICIO) || 3.5,
  ESP_MIC_VAD_FATOR_FIM: Number(process.env.ESP_MIC_VAD_FATOR_FIM) || 2.0,
  // Piso inicial proximo do ruido real (~510): o robo ja liga calibrado em vez
  // de levar alguns segundos subindo de 150, evitando falso disparo no boot.
  ESP_MIC_VAD_PISO_INICIAL: Number(process.env.ESP_MIC_VAD_PISO_INICIAL) || 500,
  ESP_MIC_VAD_EMA_SOBE: Number(process.env.ESP_MIC_VAD_EMA_SOBE) || 0.05,
  ESP_MIC_VAD_EMA_DESCE: Number(process.env.ESP_MIC_VAD_EMA_DESCE) || 0.25,

  // Tempos calibrados para criancas (falam mais devagar e fazem pausas).
  ESP_MIC_SILENCIO_MS_FIM: Number(process.env.ESP_MIC_SILENCIO_MS_FIM) || 1_200,
  // Duracao maxima de uma captura continua antes de forcar o processamento. 20s
  // da bastante folga para falar sem ser cortado (o fim normal e por silencio,
  // quando a crianca pausa). Casado com ESP_MIC_MAX_BUFFER_BYTES (20s de PCM).
  ESP_MIC_MAX_DURACAO_MS: Number(process.env.ESP_MIC_MAX_DURACAO_MS) || 20_000,
  ESP_MIC_MIN_DURACAO_MS: Number(process.env.ESP_MIC_MIN_DURACAO_MS) || 300,
  ESP_MIC_MAX_BUFFER_BYTES: Number(process.env.ESP_MIC_MAX_BUFFER_BYTES) || 16_000 * 2 * 20,
  ESP_USUARIO_PADRAO: process.env.ESP_USUARIO_PADRAO || 'default',
  ESP_PIPELINE_HABILITADO: process.env.ESP_PIPELINE_HABILITADO !== 'false',

  // Normalizacao de pico do audio antes do STT (Whisper nao e scale-invariant;
  // audio um pouco baixo transcreve pior). Leve, so levanta o nivel ate o alvo.
  ESP_MIC_NORMALIZAR: process.env.ESP_MIC_NORMALIZAR !== 'false',
  ESP_MIC_NORMALIZAR_PICO_DBFS: Number(process.env.ESP_MIC_NORMALIZAR_PICO_DBFS) || -3,
  ESP_MIC_NORMALIZAR_GANHO_MAX: Number(process.env.ESP_MIC_NORMALIZAR_GANHO_MAX) || 8,

  // --- Anti-eco / barge-in (robo se ouvindo falar) ---
  // Enquanto o robo TOCA uma resposta, o microfone dele capta o proprio
  // alto-falante. Para nao entrar em loop se respondendo, durante a janela de fala
  // o VAD exige um limiar ESP_MIC_ECO_FATOR_LIMIAR vezes mais alto: o eco fraco e
  // barrado, mas a voz real da crianca (mais forte) passa e vira interrupcao.
  // 4.0 da boa margem; se o robo ainda se ouvir, aumente; se ficar dificil
  // interromper falando por cima, diminua.
  ESP_MIC_ECO_FATOR_LIMIAR: Number(process.env.ESP_MIC_ECO_FATOR_LIMIAR) || 4.0,
  // Folga (ms) somada a duracao do audio para cobrir o esvaziamento do buffer
  // I2S/DMA do ESP depois do ultimo chunk. Mantem a janela anti-eco aberta ate o
  // som realmente parar de sair do alto-falante. ~500ms cobre com folga.
  ESP_MIC_ECO_GUARDA_MS: Number(process.env.ESP_MIC_ECO_GUARDA_MS) || 500,
}

config.IS_PROD = config.NODE_ENV === 'production'

// --- Supabase (fonte unica de dados; compartilhada com o site Companion) ---
// O servidor usa a SERVICE_ROLE_KEY (ignora RLS): so no backend, nunca no front.
// SUPABASE_HABILITADO so e true quando AMBAS as variaveis existem - sem elas, o
// servidor roda 100% local com o usuarios.json (fallback), exatamente como antes.
config.SUPABASE_URL = process.env.SUPABASE_URL || ''
config.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
config.SUPABASE_HABILITADO = !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY)

config.TTS_INSTRUCTIONS = config.TTS_INSTRUCTIONS_BASE

config.obterVozPorIdade = function obterVozPorIdade(idade) {
  if (typeof idade === 'number' && idade > 0 && idade < 12) return config.TTS_VOICE_CRIANCA
  if (typeof idade === 'number' && idade >= 12) return config.TTS_VOICE_ADOLESCENTE
  return config.TTS_VOICE
}

config.obterInstrucoesPorIdade = function obterInstrucoesPorIdade(idade) {
  if (typeof idade === 'number' && idade > 0 && idade < 12) {
    return config.TTS_INSTRUCTIONS_BASE + config.TTS_INSTRUCTIONS_CRIANCA_EXTRA
  }
  if (typeof idade === 'number' && idade >= 12) {
    return config.TTS_INSTRUCTIONS_BASE + config.TTS_INSTRUCTIONS_ADOLESCENTE_EXTRA
  }
  return config.TTS_INSTRUCTIONS_BASE
}

module.exports = config
