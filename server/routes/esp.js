const express = require('express')
const {
  obterEstado, enviarComando, registrarOuvinteEstado,
  enviarAudioParaRobo, definirUsuarioAtivo, definirMicMutado, definirRoboHabilitado, interromperRobo,
  reagirCamera, enviarRostoParaEsp, ROSTO_PADRAO,
} = require('../modules/esp')
const { sintetizarPcm } = require('../modules/speech')
const { sanitizarTexto } = require('../modules/safety')
const { processarFrame, validarImagem } = require('../modules/vision')
const { definirFrameWebcam } = require('../modules/webcam')
const { carregarUsuario, atualizarUsuario } = require('../modules/memoria')
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

// Frame da WEBCAM DO PC enviado pela interface (a visao da Cogni). A interface
// captura UM frame quando o robo comeca a ouvir e o posta aqui; o esp-pipeline.js le
// esse frame na hora de chamar a IA. Valida ANTES de gravar pra nao poluir o store
// com lixo. Ver server/modules/webcam.js.
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
// `feedback:false` suprime a animacao de "pausa" nos olhos quando o interromper e
// so uma etapa do reset (que ja mostra o proprio icone).
router.post('/interromper', (req, res) => {
  const comFeedback = req.body?.feedback !== false && req.body?.feedback !== 'false'
  const total = interromperRobo(comFeedback)
  res.json({ interrompidos: total })
})

// POSICAO DO ROSTO da crianca (0..1), detectada no navegador, para os olhos do robo
// acompanharem. Chega a ~10Hz: a rota e de proposito minima (valida, repassa e
// responde vazio) e vai DIRETO ao WebSocket do robo, sem passar pelo barramento de
// atividade/SSE - a interface nao consome isso e nao faz sentido acordar todos os
// ouvintes 10 vezes por segundo.
router.post('/olhar', (req, res) => {
  const x = Number(req.body?.x)
  const y = Number(req.body?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ erro: 'x e y devem ser numeros' })
  }
  // Trava em 0..1: um valor fora da faixa (bug no cliente, video com dimensao zero)
  // viraria uma posicao absurda de olho no firmware.
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  // `t` = largura do rosto como fracao do quadro, a nossa medida de DISTANCIA (rosto
  // grande = crianca perto). Opcional de proposito: um cliente antigo que so mande
  // x/y continua funcionando, e o firmware trata 0 como "nao sei a distancia".
  const t = Number(req.body?.t)
  enviarComando('olhar', {
    x: clamp(x),
    y: clamp(y),
    t: Number.isFinite(t) ? clamp(t) : 0,
  })
  res.status(204).end()
})

// ROSTO CUSTOMIZAVEL: a geometria dos olhos que a crianca desenhou. Guardamos no
// perfil dela e empurramos para o robo na hora, para o editor do Companion poder
// mostrar o resultado AO VIVO no robo enquanto ela mexe nos controles - que e o que
// torna a coisa uma brincadeira em vez de um formulario.
//
// A validacao de FAIXA fica no firmware, que e quem conhece a tela; aqui so garantimos
// que os campos sao numeros e que nao estamos gravando lixo no perfil.
router.put('/rosto', async (req, res) => {
  const usuarioId = req.body?.usuarioId || req.query?.usuarioId
  if (!usuarioId) return res.status(400).json({ erro: 'usuarioId e obrigatorio' })
  if (!carregarUsuario(usuarioId)) return res.status(404).json({ erro: 'usuario nao encontrado' })

  const num = (v, padrao) => (Number.isFinite(Number(v)) ? Number(v) : padrao)
  const rostoRobo = {
    largura: num(req.body?.largura, ROSTO_PADRAO.largura),
    altura: num(req.body?.altura, ROSTO_PADRAO.altura),
    raio: num(req.body?.raio, ROSTO_PADRAO.raio),
    espaco: num(req.body?.espaco, ROSTO_PADRAO.espaco),
    sobrancelhas: req.body?.sobrancelhas !== false,
  }

  try {
    await atualizarUsuario(usuarioId, (u) => { u.rostoRobo = rostoRobo })
  } catch (err) {
    log('Erro', `Falha ao salvar o rosto do robo: ${err.message}`)
    return res.status(500).json({ erro: 'nao foi possivel salvar' })
  }

  // So empurra para o robo se o perfil editado for o que ele esta usando agora - senao
  // mexer no rosto de uma crianca mudaria a cara do robo enquanto a outra conversa.
  const enviado = enviarRostoParaEsp() > 0
  res.json({ rostoRobo, aplicadoNoRobo: enviado })
})

// Devolve o rosto salvo (ou o padrao de fabrica), para o editor do Companion abrir ja
// mostrando o que a crianca escolheu da ultima vez.
router.get('/rosto', (req, res) => {
  const usuarioId = req.query?.usuarioId
  if (!usuarioId) return res.status(400).json({ erro: 'usuarioId e obrigatorio' })
  const usuario = carregarUsuario(usuarioId)
  if (!usuario) return res.status(404).json({ erro: 'usuario nao encontrado' })
  res.json({ rostoRobo: { ...ROSTO_PADRAO, ...(usuario.rostoRobo || {}) }, padrao: ROSTO_PADRAO })
})

// A webcam vive no NAVEGADOR: o dashboard avisa aqui quando ela liga/desliga (tanto
// pelo botao da interface quanto pelo botao FISICO, que manda o dashboard alternar),
// e o robo mostra o icone de camera nos olhos.
router.post('/camera', (req, res) => {
  const ativa = req.body?.ativa === true || req.body?.ativa === 'true'
  reagirCamera(ativa)
  res.json({ ativa })
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
