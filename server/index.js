const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const { rateLimit } = require('express-rate-limit')
const path = require('path')
const http = require('http')
const config = require('./config')
const apiRoutes = require('./routes/api')
const espRoutes = require('./routes/esp')
const { configurarServidoresWebSocket } = require('./modules/esp')
const { inicializar: inicializarMemoria, flushSync } = require('./modules/memoria')
const { hidratarPlanos } = require('./modules/planos')
const { log } = require('./modules/logger')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' libera SO a compilacao de WebAssembly, necessaria para o
      // detector de rosto do MediaPipe (client/vendor/mediapipe) que faz os olhos do
      // robo acompanharem a crianca. NAO libera eval() de JavaScript - essa e uma
      // diretiva separada ('unsafe-eval'), que continua bloqueada. Sem isto o WASM e
      // barrado silenciosamente e o rastreio nunca liga.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}))

app.use(cors({
  origin: config.IS_PROD ? false : true,
  credentials: false,
}))

app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false
    return compression.filter(req, res)
  },
}))

app.use(express.json({ limit: '12mb' }))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))

app.use(rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_MAX_GLOBAL,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erro: 'Limite global de requisicoes excedido. Aguarde um momento.' },
  // SSE sao conexoes longas que ficam abertas: nao podem contar para o limite,
  // senao reconexoes legitimas (status, atividade do robo, monitor) sao barradas.
  // A posicao do rosto (olhar) chega a ~10Hz com a camera ligada — sozinha ela
  // estouraria o limite global em poucos segundos e derrubaria a sessao inteira.
  skip: (req) => req.path.startsWith('/api/esp/status/stream')
    || req.path.startsWith('/api/esp/atividade/stream')
    || req.path.startsWith('/api/esp/monitor/stream')
    || req.path === '/api/esp/olhar',
}))

app.use(express.static(path.join(__dirname, '../client'), {
  maxAge: config.IS_PROD ? '7d' : 0,
  etag: true,
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache')
    }
  },
}))

app.use('/api', apiRoutes)
app.use('/api/esp', espRoutes)

app.get(/^\/(?!api|ws).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'))
})

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada' })
})

app.use((err, req, res, _next) => {
  log('Erro', `Handler global: ${err.message}`)
  if (res.headersSent) return
  const status = err.status || 500
  res.status(status).json({
    erro: config.IS_PROD ? 'Erro interno' : err.message,
  })
})

const server = http.createServer(app)
const servidoresWs = configurarServidoresWebSocket(server)

// Hidrata o cache de usuarios (Supabase, com fallback local) ANTES de aceitar
// trafego — assim carregarUsuario ja serve do cache no fluxo de voz, sem I/O de
// rede. Se a hidratacao falhar, inicializarMemoria cai no usuarios.json e o
// servidor sobe assim mesmo (o robo nunca fica refem da nuvem).
async function iniciarServidor() {
  try {
    await inicializarMemoria()
  } catch (err) {
    log('Erro', `Inicializacao da memoria falhou (${err.message}). Seguindo com fallback local.`)
  }
  // Pre-carrega os planos de estudo ativos (igual a memoria). Isolado: se falhar,
  // o cache de planos comeca vazio e se preenche no 1o refresh — nao trava o boot.
  try {
    await hidratarPlanos()
  } catch (err) {
    log('Erro', `Hidratacao de planos falhou (${err.message}). Seguindo sem planos pre-carregados.`)
  }
  server.listen(config.PORT, config.HOST, aoSubir)
}

function aoSubir() {
  console.log('========================================')
  console.log('  [Cogni] Servidor iniciado!')
  console.log(`  [Cogni] URL local:    http://localhost:${config.PORT}`)
  console.log(`  [Cogni] URL rede:     http://${config.HOST === '0.0.0.0' ? '<seu-ip>' : config.HOST}:${config.PORT}`)
  console.log(`  [Cogni] Ambiente:     ${config.NODE_ENV}`)
  console.log(`  [Cogni] API Key:      ${config.OPENAI_API_KEY ? 'Configurada' : 'NAO CONFIGURADA'}`)
  console.log('  [Cogni] Modelos:')
  console.log(`    Chat:     ${config.CHAT_MODEL}`)
  console.log(`    Visao:    ${config.VISION_CHAT_MODEL}`)
  console.log(`    Pesquisa: ${config.SEARCH_MODEL}`)
  console.log(`    STT:      ${config.WHISPER_MODEL}`)
  console.log(`    TTS:      ${config.TTS_MODEL} (voz: ${config.TTS_VOICE})`)
  console.log('  [Cogni] ESP:')
  console.log(`    Habilitado: ${config.ESP_ENABLED ? 'sim' : 'nao'}`)
  if (config.ESP_ENABLED) {
    console.log(`    Token:      ${config.ESP_TOKEN}`)
    console.log(`    Controle:   ws://<host>:${config.PORT}/ws/esp?token=${config.ESP_TOKEN}`)
  }
  console.log('========================================')

  if (!config.OPENAI_API_KEY) {
    log('Aviso', 'OPENAI_API_KEY nao configurada! Crie um arquivo .env na raiz do projeto.')
  }
}

iniciarServidor()

let encerrando = false
function shutdown(sinal) {
  // Idempotente: um segundo Ctrl+C (ou SIGTERM apos SIGINT) nao reentra no fluxo.
  if (encerrando) return
  encerrando = true
  log('Servidor', `Recebido ${sinal}, finalizando graciosamente...`)
  flushSync()

  // Fecha os servidores WebSocket e derruba os clientes. Conexoes WS/SSE sao
  // longas e NUNCA terminam sozinhas; sem termina-las, o server.close() abaixo
  // ficaria pendurado ate o timeout de 10s (saindo com codigo 1). Fechando-as
  // aqui, o close resolve na hora e o processo sai limpo (codigo 0).
  if (servidoresWs) {
    for (const wss of [servidoresWs.wssControle]) {
      if (!wss) continue
      for (const ws of wss.clients) {
        try { ws.terminate() } catch { /* socket ja fechado */ }
      }
      try { wss.close() } catch { /* ja fechado */ }
    }
  }

  server.close((err) => {
    if (err) {
      log('Erro', `Falha ao fechar servidor: ${err.message}`)
      process.exit(1)
    }
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (err) => log('Erro', `uncaughtException: ${err.stack || err.message}`))
process.on('unhandledRejection', (reason) => log('Erro', `unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`))
