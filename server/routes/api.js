const express = require('express')
const multer = require('multer')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const { conversar, conversarStream, limparConversa, idiomaParaTTS } = require('../modules/brain')
const { transcrever, sintetizar, sintetizarPcm, opcoesTranscricaoPadrao, openai } = require('../modules/speech')
const { obterResumoSemanal } = require('../modules/brain/resumo-semanal')
const { gerarDicaDoCogni } = require('../modules/brain/dica')
const { vincularPorCodigo, desvincularPorCrianca } = require('../modules/pareamento')
const { processarFrame, validarImagem } = require('../modules/vision')
const { verificarEntrada, RESPOSTA_BLOQUEIO, sanitizarNome, sanitizarTexto, ehTextoLixo } = require('../modules/safety')
const { criarUsuario, listarUsuarios, carregarUsuario, excluirUsuario, refrescarTodosUsuarios } = require('../modules/memoria')
const { obterEstado, enviarAudioParaRobo, obterUltimoFrameBase64 } = require('../modules/esp')
const { limparReferenciasResposta, pediuFonte } = require('../modules/brain/prompt')
const { log } = require('../modules/logger')
const config = require('../config')

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.MAX_AUDIO_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 6,
  },
})

const limitePipeline = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX_PIPELINE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const usuarioId = typeof req.body?.usuarioId === 'string' ? req.body.usuarioId.slice(0, 100) : ''
    return usuarioId || ipKeyGenerator(req.ip)
  },
  message: { erro: 'Muitas requisicoes. Aguarde um momento.' },
})

// Rate-limit do resumo semanal: gera com IA, entao limitamos por crianca pra evitar
// abuso/custo (o pai nao precisa regenerar a cada segundo). Janela do config.
const limiteResumo = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const criancaId = typeof req.query?.criancaId === 'string' ? req.query.criancaId.slice(0, 100) : ''
    return criancaId || ipKeyGenerator(req.ip)
  },
  message: { erro: 'Muitas requisicoes de resumo. Aguarde um momento.' },
})

// Opcoes do STT: idioma auto + prompt de contexto do usuario (nome, dominio). Usa
// o helper central do speech.js, o mesmo que o robo (esp-pipeline.js) usa.
function opcoesTranscricao(usuario) {
  return opcoesTranscricaoPadrao(usuario)
}

function configurarSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
}

function criarEnviadorSSE(res) {
  return (evento, dados) => {
    if (res.writableEnded || res.destroyed) return false
    return res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`)
  }
}

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    apiConfigurada: !!config.OPENAI_API_KEY,
    versao: '2.0.0',
    esp: obterEstado(),
  })
})

router.get('/usuarios', async (req, res) => {
  // Puxa a lista fresca do Supabase ANTES de responder: assim um perfil criado no
  // site (Companion) ja aparece na interface localhost na primeira listagem, sem
  // precisar reiniciar o servidor nem depender do Realtime. Best-effort — se a rede
  // falhar, cai no cache local (refrescarTodosUsuarios nunca lanca pro chamador).
  await refrescarTodosUsuarios()
  res.json({ usuarios: listarUsuarios() })
})

router.post('/usuarios', (req, res) => {
  const nomeRaw = typeof req.body?.nome === 'string' ? req.body.nome : ''
  const nome = sanitizarNome(nomeRaw, config.MAX_NOME_LENGTH)

  if (!nome) {
    return res.status(400).json({ erro: 'Nome obrigatorio' })
  }

  const usuario = criarUsuario(nome)
  res.status(201).json({ usuario })
})

router.get('/usuarios/:id', (req, res) => {
  const usuario = carregarUsuario(req.params.id)
  if (!usuario) return res.status(404).json({ erro: 'Usuario nao encontrado' })
  res.json({ usuario })
})

router.delete('/usuarios/:id', (req, res) => {
  const removido = excluirUsuario(req.params.id)
  if (!removido) return res.status(404).json({ erro: 'Usuario nao encontrado' })
  limparConversa(req.params.id)
  res.json({ mensagem: 'Usuario removido' })
})

router.post('/transcribe', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo de audio enviado' })
    }
    const usuarioId = sanitizarTexto(req.body?.usuarioId, 100)
    const usuario = usuarioId ? carregarUsuario(usuarioId) : null
    const texto = await transcrever(req.file.buffer, req.file.mimetype, opcoesTranscricao(usuario))
    res.json({ texto })
  } catch (erro) {
    log('Erro', `Transcricao: ${erro.message}`)
    next(erro)
  }
})

router.post('/chat', async (req, res, next) => {
  try {
    const usuarioId = sanitizarTexto(req.body?.usuarioId, 100) || 'default'
    const texto = sanitizarTexto(req.body?.texto, config.MAX_TEXT_LENGTH)
    const imagem = req.body?.imagem

    if (!texto) {
      return res.status(400).json({ erro: 'Texto nao fornecido' })
    }

    const usuario = carregarUsuario(usuarioId)
    const ehDev = usuario && usuario.role === 'desenvolvedor'

    if (!ehDev) {
      const verificacao = verificarEntrada(texto)
      if (!verificacao.seguro) {
        return res.json({ resposta: RESPOSTA_BLOQUEIO })
      }
    }

    const imagemProcessada = imagem && validarImagem(imagem) ? processarFrame(imagem) : null

    if (!config.STREAM_ENABLED) {
      const resultado = await conversar(usuarioId, texto, imagemProcessada)
      return res.json({ resposta: resultado.texto, pesquisouWeb: resultado.pesquisouWeb })
    }

    configurarSSE(res)
    const enviarEvento = criarEnviadorSSE(res)
    let abortado = false
    res.on('close', () => { abortado = true })

    const resultado = await conversarStream(usuarioId, texto, imagemProcessada, {
      onChunk: (chunk) => { if (!abortado) enviarEvento('texto', { chunk }) },
      onPesquisa: () => { if (!abortado) enviarEvento('pesquisa', {}) },
    })

    if (!abortado) {
      enviarEvento('fim', { pesquisouWeb: resultado.pesquisouWeb })
      res.end()
    }
  } catch (erro) {
    log('Erro', `Chat: ${erro.message}`)
    if (!res.headersSent) return next(erro)
    res.write(`event: erro\ndata: ${JSON.stringify({ erro: 'Erro ao processar mensagem' })}\n\n`)
    res.end()
  }
})

router.post('/speak', async (req, res, next) => {
  try {
    const texto = sanitizarTexto(req.body?.texto, config.MAX_TEXT_LENGTH)
    if (!texto) return res.status(400).json({ erro: 'Texto nao fornecido' })

    const audioBuffer = await sintetizar(texto)
    res.set('Content-Type', 'audio/mpeg')
    res.send(audioBuffer)
  } catch (erro) {
    log('Erro', `Sintese de voz: ${erro.message}`)
    next(erro)
  }
})

router.post('/conversation', upload.single('audio'), limitePipeline, async (req, res, next) => {
  const tempoInicio = Date.now()
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo de audio enviado' })
    }

    const usuarioId = sanitizarTexto(req.body?.usuarioId, 100) || 'default'
    let imagem = req.body?.imagem || null

    if (!imagem) {
      const frameEsp = obterUltimoFrameBase64()
      if (frameEsp) imagem = frameEsp
    }

    const usarRobo = req.body?.usarRobo === 'true' || req.body?.usarRobo === true

    log('Pipeline', `Inicio (usuario=${usuarioId}, audio=${(req.file.size / 1024).toFixed(1)}KB${imagem ? ', com imagem' : ''}${usarRobo ? ', robo' : ''})`)

    if (!config.STREAM_ENABLED) {
      return await pipelineSemStream(req, res, usuarioId, imagem, usarRobo, tempoInicio)
    }

    return await pipelineComStream(req, res, usuarioId, imagem, usarRobo, tempoInicio)
  } catch (erro) {
    log('Erro', `Pipeline (${Date.now() - tempoInicio}ms): ${erro.message}`)
    if (!res.headersSent) return next(erro)
    res.write(`event: erro\ndata: ${JSON.stringify({ erro: 'Erro ao processar conversa' })}\n\n`)
    res.end()
  }
})

async function pipelineSemStream(req, res, usuarioId, imagem, usarRobo, tempoInicio) {
  const usuario = carregarUsuario(usuarioId)
  const ehDev = usuario && usuario.role === 'desenvolvedor'

  const tempoSTT = Date.now()
  const textoUsuario = await transcrever(req.file.buffer, req.file.mimetype, opcoesTranscricao(usuario))
  log('STT', `${Date.now() - tempoSTT}ms: "${textoUsuario || '(vazio)'}"`)

  if (!textoUsuario || ehTextoLixo(textoUsuario)) {
    return res.json({ transcricao: '', resposta: '', audio: null, mensagem: 'Nenhuma fala detectada' })
  }
  let textoResposta
  let pesquisouWeb = false

  if (!ehDev) {
    const verificacao = verificarEntrada(textoUsuario)
    if (!verificacao.seguro) {
      log('Seguranca', `Entrada bloqueada: "${textoUsuario.slice(0, 60)}"`)
      textoResposta = RESPOSTA_BLOQUEIO
    }
  }

  // Idioma para o TTS: 'pt' quando bloqueado (RESPOSTA_BLOQUEIO e sempre PT); senao
  // o idioma da conversa (evita aplicar conversoes de PT a resposta em outro idioma).
  let idiomaTTS = 'pt'
  if (!textoResposta) {
    const imagemProcessada = imagem && validarImagem(imagem) ? processarFrame(imagem) : null
    const resultado = await conversar(usuarioId, textoUsuario, imagemProcessada)
    textoResposta = resultado.texto
    pesquisouWeb = resultado.pesquisouWeb || false
    idiomaTTS = idiomaParaTTS(resultado.contextoIdioma)
  }

  const idadeUsuario = typeof usuario?.idade === 'number' ? usuario.idade : null
  const audioBuffer = await sintetizar(textoResposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
  if (usarRobo) {
    // O robo toca PCM (nao decodifica MP3). O navegador recebe o MP3 abaixo.
    const audioPcm = await sintetizarPcm(textoResposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
    enviarAudioParaRobo(audioPcm, { textoLength: textoResposta.length })
  }

  log('Pipeline', `Completo em ${Date.now() - tempoInicio}ms`)
  return res.json({
    transcricao: textoUsuario,
    resposta: textoResposta,
    audio: audioBuffer.toString('base64'),
    pesquisouWeb,
  })
}

async function pipelineComStream(req, res, usuarioId, imagem, usarRobo, tempoInicio) {
  req.socket.setNoDelay(true)
  configurarSSE(res)
  const enviarEvento = criarEnviadorSSE(res)

  let abortado = false
  res.on('close', () => {
    abortado = true
    log('SSE', 'Conexao fechada pelo cliente')
  })

  const usuario = carregarUsuario(usuarioId)
  const ehDev = usuario && usuario.role === 'desenvolvedor'

  const tempoSTT = Date.now()
  const textoUsuario = await transcrever(req.file.buffer, req.file.mimetype, opcoesTranscricao(usuario))
  log('STT', `${Date.now() - tempoSTT}ms: "${textoUsuario || '(vazio)'}"`)

  if (!textoUsuario || ehTextoLixo(textoUsuario)) {
    enviarEvento('fim', { vazio: true })
    return res.end()
  }

  enviarEvento('transcricao', { texto: textoUsuario })
  let textoResposta = null
  let pesquisouWeb = false

  if (!ehDev) {
    const verificacao = verificarEntrada(textoUsuario)
    if (!verificacao.seguro) {
      log('Seguranca', `Entrada bloqueada: "${textoUsuario.slice(0, 60)}"`)
      textoResposta = RESPOSTA_BLOQUEIO
    }
  }

  const idadeUsuario = typeof usuario?.idade === 'number' ? usuario.idade : null
  const usarTTSStream = config.TTS_STREAM_ENABLED && !usarRobo
  const audioBuffersOrdem = []
  const filaTTS = []
  let indiceTTS = 0
  let primeiroChunkMs = null
  // Idioma do TTS: 'pt' por padrao (e sempre PT quando a entrada e bloqueada). Para
  // a conversa normal, o callback onIdioma de conversarStream preenche isto ANTES
  // do primeiro chunk de texto, entao o TTS por sentenca ja sai no idioma certo.
  let idiomaTTS = 'pt'
  // A pessoa pediu a fonte/site? Entao a limpeza por sentenca PRESERVA o nome do
  // site (em vez de apaga-lo) - mesma decisao do brain.js. Ver pediuFonte/permitirFonte.
  const querFonte = pediuFonte(textoUsuario)

  function despacharSentencaParaTTS(sentenca) {
    if (abortado) return
    const limpa = limparReferenciasResposta(sentenca, { permitirFonte: querFonte })
    if (!limpa) return
    const meuIndice = indiceTTS++
    const tarefa = (async () => {
      try {
        const buf = await sintetizar(limpa, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
        if (abortado) return null
        if (primeiroChunkMs === null) {
          primeiroChunkMs = Date.now() - tempoInicio
          log('TTS', `Primeiro chunk em ${primeiroChunkMs}ms`)
        }
        audioBuffersOrdem[meuIndice] = buf
        if (!abortado) {
          enviarEvento('audio-chunk', {
            indice: meuIndice,
            audio: buf.toString('base64'),
            texto: limpa,
          })
        }
        return buf
      } catch (err) {
        log('Erro', `TTS sentenca falhou: ${err.message}`)
        return null
      }
    })()
    filaTTS.push(tarefa)
  }

  if (textoResposta) {
    enviarEvento('texto', { chunk: textoResposta })
    if (usarTTSStream) despacharSentencaParaTTS(textoResposta)
  } else {
    const imagemProcessada = imagem && validarImagem(imagem) ? processarFrame(imagem) : null
    if (imagemProcessada) log('Visao', 'Imagem incluida na requisicao')

    const tempoIA = Date.now()
    const callbacks = {
      onChunk: (chunk) => { if (!abortado) enviarEvento('texto', { chunk }) },
      onPesquisa: () => { if (!abortado) enviarEvento('pesquisa', {}) },
      // Chega antes do primeiro chunk: fixa o idioma do TTS para esta resposta.
      onIdioma: (ctx) => { idiomaTTS = idiomaParaTTS(ctx) },
    }
    if (usarTTSStream) {
      callbacks.onSentenca = (s) => despacharSentencaParaTTS(s)
    }
    const resultado = await conversarStream(usuarioId, textoUsuario, imagemProcessada, callbacks)
    textoResposta = resultado.texto
    pesquisouWeb = resultado.pesquisouWeb || false
    log('IA', `${Date.now() - tempoIA}ms${pesquisouWeb ? ' (web)' : ''}: "${textoResposta.substring(0, 100)}${textoResposta.length > 100 ? '...' : ''}"`)
  }

  if (abortado) return

  if (usarTTSStream) {
    await Promise.allSettled(filaTTS)
    if (abortado) return
    const audiosValidos = audioBuffersOrdem.filter(Boolean)
    if (audiosValidos.length === 0) {
      const tempoTTS = Date.now()
      const audioBuffer = await sintetizar(textoResposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
      log('TTS', `Fallback ${Date.now() - tempoTTS}ms (${(audioBuffer.length / 1024).toFixed(1)}KB)`)
      if (!abortado) {
        enviarEvento('audio', { audio: audioBuffer.toString('base64'), textoFinal: textoResposta })
      }
    } else {
      const audioCompleto = Buffer.concat(audiosValidos)
      log('TTS', `Stream completo ${audiosValidos.length} chunks (${(audioCompleto.length / 1024).toFixed(1)}KB)`)
      if (!abortado) {
        enviarEvento('fim-audio', { textoFinal: textoResposta, totalChunks: audiosValidos.length })
      }
    }
  } else {
    const tempoTTS = Date.now()
    const audioBuffer = await sintetizar(textoResposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
    log('TTS', `${Date.now() - tempoTTS}ms (${(audioBuffer.length / 1024).toFixed(1)}KB)`)

    if (usarRobo) {
      // O robo toca PCM (nao decodifica MP3). O navegador recebe o MP3 abaixo.
      const audioPcm = await sintetizarPcm(textoResposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
      const enviados = enviarAudioParaRobo(audioPcm, { textoLength: textoResposta.length })
      log('ESP', `Audio (PCM) enviado para ${enviados} ESP(s)`)
    }

    if (!abortado) {
      enviarEvento('audio', { audio: audioBuffer.toString('base64'), textoFinal: textoResposta })
    }
  }

  log('Pipeline', `Completo em ${Date.now() - tempoInicio}ms`)

  if (!abortado) {
    enviarEvento('fim', { pesquisouWeb })
    res.end()
  }
}

router.post('/reset', (req, res) => {
  const usuarioId = sanitizarTexto(req.body?.usuarioId, 100) || 'default'
  log('Reset', `Limpando contexto (usuario=${usuarioId})`)
  limparConversa(usuarioId)
  res.json({ mensagem: 'Conversa reiniciada' })
})

// Resumo Semanal (Companion): o site chama com ?criancaId=... e recebe o bilhete
// carinhoso da Cogni sobre a semana. Gerado sob demanda (le as conversas dos
// ultimos 7 dias + IA). Passa pelo servidor porque a chave da OpenAI vive so aqui.
router.get('/resumo-semanal', limiteResumo, async (req, res, next) => {
  try {
    const criancaId = typeof req.query?.criancaId === 'string' ? req.query.criancaId.slice(0, 100) : ''
    if (!criancaId) return res.status(400).json({ erro: 'criancaId obrigatorio' })

    // Nome opcional (so pra deixar o bilhete mais pessoal); cai no cache local se houver.
    const usuario = carregarUsuario(criancaId)
    const nomeCrianca = usuario?.nome || (typeof req.query?.nome === 'string' ? req.query.nome.slice(0, 60) : '')

    // forcar=1 ignora o reuso do ultimo salvo e regenera (debug). Por padrao, reusa a
    // ultima carta quando nao houve conversa nova (estavel, sobrevive a robo desligado).
    const forcar = req.query?.forcar === '1' || req.query?.forcar === 'true'
    const resultado = await obterResumoSemanal({ openai, modelo: config.CHAT_MODEL }, criancaId, nomeCrianca, { forcar })
    res.json(resultado)
  } catch (err) {
    next(err)
  }
})

// Dica do Cogni (Companion / tela Inicio): o site chama com ?criancaId=... e recebe
// UMA dica curta pros pais, baseada nas memorias + topicos recentes da crianca.
// Cacheada por 1 dia por crianca (dentro do modulo). Mesma razao do resumo: a chave
// da OpenAI vive so aqui. ?forcar=1 ignora o cache (debug).
router.get('/dica', limiteResumo, async (req, res, next) => {
  try {
    const criancaId = typeof req.query?.criancaId === 'string' ? req.query.criancaId.slice(0, 100) : ''
    if (!criancaId) return res.status(400).json({ erro: 'criancaId obrigatorio' })

    const forcar = req.query?.forcar === '1' || req.query?.forcar === 'true'
    const resultado = await gerarDicaDoCogni({ openai, modelo: config.CHAT_MODEL }, criancaId, { forcar })
    res.json(resultado)
  } catch (err) {
    next(err)
  }
})

// Pareamento — código do perfil (pro painel localhost mostrar / o robô falar).
// Leitura síncrona do cache local: o código é campo fixo do perfil.
router.get('/pareamento/codigo', (req, res) => {
  const usuarioId = typeof req.query?.usuarioId === 'string' ? req.query.usuarioId.slice(0, 100) : ''
  if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatorio' })
  const usuario = carregarUsuario(usuarioId)
  if (!usuario) return res.status(404).json({ erro: 'Usuario nao encontrado' })
  res.json({ codigo: usuario.codigoPareamento || null, nome: usuario.nome })
})

// Pareamento — vincular a criança a um responsável (o site chama no onboarding).
// O servidor valida o código e seta criancas.responsavel_id (service_role).
router.post('/pareamento/vincular', limiteResumo, async (req, res, next) => {
  try {
    const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.slice(0, 20) : ''
    const responsavelId = typeof req.body?.responsavelId === 'string' ? req.body.responsavelId.slice(0, 100) : ''
    if (!codigo || !responsavelId) return res.status(400).json({ erro: 'codigo e responsavelId obrigatorios' })

    const r = await vincularPorCodigo(codigo, responsavelId)
    if (r.ok) return res.json({ ok: true, jaPareado: !!r.jaPareado, criancaId: r.criancaId, nome: r.nome })

    // Traduz o motivo num status/mensagem amigável pro site.
    const mapa = {
      codigo_invalido: [404, 'Código inválido. Confira os 6 caracteres.'],
      ja_pareada: [409, 'Essa criança já está vinculada a outro responsável.'],
      responsavel_invalido: [400, 'Responsável inválido.'],
      supabase_desligado: [503, 'Pareamento indisponível no momento.'],
      erro_interno: [500, 'Erro ao parear. Tente de novo.'],
    }
    const [status, mensagem] = mapa[r.motivo] || [400, 'Não foi possível parear.']
    res.status(status).json({ ok: false, motivo: r.motivo, erro: mensagem })
  } catch (err) {
    next(err)
  }
})

// Pareamento — desvincular (o site chama quando o pai quer desfazer o vínculo, ex:
// parear outro filho). Zera responsavel_id; só funciona se for o dono. O código do
// perfil continua o mesmo, então dá pra reparear depois.
router.post('/pareamento/desvincular', limiteResumo, async (req, res, next) => {
  try {
    const criancaId = typeof req.body?.criancaId === 'string' ? req.body.criancaId.slice(0, 100) : ''
    const responsavelId = typeof req.body?.responsavelId === 'string' ? req.body.responsavelId.slice(0, 100) : ''
    if (!criancaId || !responsavelId) return res.status(400).json({ erro: 'criancaId e responsavelId obrigatorios' })

    const r = await desvincularPorCrianca(criancaId, responsavelId)
    if (r.ok) return res.json({ ok: true, jaDesvinculado: !!r.jaDesvinculado })

    const mapa = {
      crianca_invalida: [404, 'Criança não encontrada.'],
      dados_invalidos: [400, 'Dados inválidos.'],
      supabase_desligado: [503, 'Pareamento indisponível no momento.'],
      erro_interno: [500, 'Erro ao desvincular. Tente de novo.'],
    }
    const [status, mensagem] = mapa[r.motivo] || [400, 'Não foi possível desvincular.']
    res.status(status).json({ ok: false, motivo: r.motivo, erro: mensagem })
  } catch (err) {
    next(err)
  }
})

module.exports = router
