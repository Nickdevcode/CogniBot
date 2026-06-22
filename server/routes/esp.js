const express = require('express')
const {
  obterEstado, enviarComando, obterUltimoFrame, registrarOuvinteEstado,
  enviarAudioParaRobo, definirUsuarioAtivo, definirMicMutado, definirRoboHabilitado, interromperRobo,
} = require('../modules/esp')
const { sintetizarPcm } = require('../modules/speech')
const { sanitizarTexto } = require('../modules/safety')
const { processarFrame, validarImagem } = require('../modules/vision')
const { definirFrameWebcam } = require('../modules/webcam')
const { carregarUsuario } = require('../modules/memoria')
const { log } = require('../modules/logger')
const { registrarOuvinte: registrarOuvinteMonitor, transmitirAudio } = require('../modules/monitor')
const { registrarOuvinte: registrarOuvinteAtividade } = require('../modules/esp-atividade')
const config = require('../config')

const router = express.Router()

router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    habilitado: config.ESP_ENABLED,
    estado: obterEstado(),
  })
})

router.get('/status/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  const enviar = (estado) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: estado\ndata: ${JSON.stringify(estado)}\n\n`)
  }

  enviar(obterEstado())
  const cancelar = registrarOuvinteEstado(enviar)

  const intervaloHeartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    res.write(': heartbeat\n\n')
  }, 25000)

  req.on('close', () => {
    clearInterval(intervaloHeartbeat)
    cancelar()
  })
})

router.get('/camera/snapshot', (req, res) => {
  const buffer = obterUltimoFrame()
  if (!buffer) {
    return res.status(404).json({ erro: 'Nenhum frame recente da ESP-CAM' })
  }
  res.set('Content-Type', 'image/jpeg')
  res.set('Cache-Control', 'no-store')
  res.send(buffer)
})

// Frame da WEBCAM DO PC enviado pela interface (visao da Cogni no caminho do robo
// fisico). A interface captura UM frame quando o robo comeca a ouvir e o posta aqui;
// o esp-pipeline.js le esse frame na hora de chamar a IA. Valida ANTES de gravar pra
// nao poluir o store com lixo. Ver server/modules/webcam.js.
router.post('/webcam/frame', (req, res) => {
  const imagem = req.body?.imagem
  if (!validarImagem(imagem)) return res.status(400).json({ erro: 'Frame da webcam invalido' })
  const limpo = processarFrame(imagem)
  if (!limpo) return res.status(400).json({ erro: 'Frame da webcam vazio' })
  definirFrameWebcam(limpo)
  res.json({ ok: true })
})

router.post('/comando', (req, res) => {
  const comando = sanitizarTexto(req.body?.comando, 50)
  if (!comando) return res.status(400).json({ erro: 'Comando obrigatorio' })

  const enviados = enviarComando(comando, req.body?.payload || {})
  log('ESP', `Comando "${comando}" enviado para ${enviados} ESP(s)`)
  res.json({ enviados })
})

router.post('/falar', async (req, res, next) => {
  try {
    const texto = sanitizarTexto(req.body?.texto, config.MAX_TEXT_LENGTH)
    if (!texto) return res.status(400).json({ erro: 'Texto obrigatorio' })

    const audioBuffer = await sintetizarPcm(texto)
    const enviados = enviarAudioParaRobo(audioBuffer, { textoLength: texto.length })
    transmitirAudio(audioBuffer, {
      texto,
      origem: 'falar',
      formato: config.ESP_AUDIO_FORMATO,
      sampleRate: config.ESP_AUDIO_PCM_SAMPLE_RATE,
    })
    log('ESP', `Texto sintetizado e enviado para ${enviados} ESP(s)`)
    res.json({ enviados, tamanhoAudio: audioBuffer.length })
  } catch (erro) {
    log('Erro', `ESP falar: ${erro.message}`)
    next(erro)
  }
})

// Define o perfil/usuario ativo do robo em tempo real (a interface chama ao
// selecionar uma crianca). Valida que o usuario existe para nao deixar o robo
// numa sessao com memorias fantasmas.
router.post('/usuario', (req, res) => {
  const usuarioId = sanitizarTexto(req.body?.usuarioId, 100)
  if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatorio' })
  if (!carregarUsuario(usuarioId)) return res.status(404).json({ erro: 'Usuario nao encontrado' })

  const aplicados = definirUsuarioAtivo(usuarioId)
  log('ESP', `Perfil do robo definido: ${usuarioId} (${aplicados} conexao(oes))`)
  res.json({ aplicados, usuarioId })
})

// Muta/desmuta o mic do robo (servidor descarta o audio quando mutado).
router.post('/mic', (req, res) => {
  const mutado = req.body?.mutado === true || req.body?.mutado === 'true'
  const estado = definirMicMutado(mutado)
  log('ESP', `Mic do robo ${estado ? 'mutado' : 'ativo'}`)
  res.json({ mutado: estado })
})

// Liga/desliga o robo (GATE). Quando desligado, o robo fica mudo (servidor
// descarta o audio do mic). A interface liga ao entrar no modo "Controlar robo".
router.post('/habilitar', (req, res) => {
  const habilitado = req.body?.habilitado === true || req.body?.habilitado === 'true'
  const estado = definirRoboHabilitado(habilitado)
  log('ESP', `Robo ${estado ? 'HABILITADO (escutando)' : 'desabilitado (mudo)'}`)
  res.json({ habilitado: estado })
})

// Interrompe o robo (botao "Parar" da interface): encerra a fala e a captura.
router.post('/interromper', (req, res) => {
  const total = interromperRobo()
  res.json({ interrompidos: total })
})

// Canal de ATIVIDADE (SSE): transmite a interface a transcricao da crianca, a
// resposta da Cogni e o estado (ouvindo/pensando/falando/idle) do robo em tempo
// real. So texto/estado - o audio NAO trafega aqui (toca no proprio robo).
router.get('/atividade/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  res.write(`event: pronto\ndata: ${JSON.stringify({ em: Date.now() })}\n\n`)

  const enviar = (evento) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: atividade\ndata: ${JSON.stringify(evento)}\n\n`)
  }
  const cancelar = registrarOuvinteAtividade(enviar)

  const intervaloHeartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    res.write(': heartbeat\n\n')
  }, 25000)

  req.on('close', () => {
    clearInterval(intervaloHeartbeat)
    cancelar()
  })
})

// Canal de monitor (SSE): transmite ao navegador o mesmo audio enviado ao robo.
// Use a pagina /monitor para ouvir no PC enquanto o alto-falante nao esta montado.
router.get('/monitor/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  res.write(`event: pronto\ndata: ${JSON.stringify({ em: Date.now() })}\n\n`)

  const enviar = (evento) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: audio\ndata: ${JSON.stringify(evento)}\n\n`)
  }
  const cancelar = registrarOuvinteMonitor(enviar)

  const intervaloHeartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    res.write(': heartbeat\n\n')
  }, 25000)

  req.on('close', () => {
    clearInterval(intervaloHeartbeat)
    cancelar()
  })
})

router.get('/token', (req, res) => {
  if (config.IS_PROD) return res.status(403).json({ erro: 'Indisponivel em producao' })

  const apenasLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)
  if (!apenasLocal) {
    return res.status(403).json({ erro: 'Endpoint disponivel apenas em loopback (localhost)' })
  }

  res.json({ token: config.ESP_TOKEN, exemplo: `ws://${req.hostname}:${config.PORT}/ws/esp?token=${config.ESP_TOKEN}` })
})

module.exports = router
