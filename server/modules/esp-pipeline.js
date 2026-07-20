const config = require('../config')
const { transcrever, sintetizarPcm, opcoesTranscricaoPadrao } = require('./speech')
const { conversar, conversarStream, idiomaParaTTS } = require('./brain')
const { verificarEntrada, RESPOSTA_BLOQUEIO, ehTextoLixo } = require('./safety')
const { carregarUsuario } = require('./memoria')
const { obterFrameWebcamBase64 } = require('./webcam')
const { log } = require('./logger')
const { transmitirAudio } = require('./monitor')
const { emitirEstado, emitirTranscricao, emitirResposta, emitirReacao } = require('./esp-atividade')
const { detectarReacao } = require('./esp-reacoes')

const sessoes = new Map()

function criarCabecalhoWav(amostras, sampleRate, bitsPorAmostra = 16, canais = 1) {
  const byteRate = sampleRate * canais * (bitsPorAmostra / 8)
  const blockAlign = canais * (bitsPorAmostra / 8)
  const dataSize = amostras * (bitsPorAmostra / 8) * canais
  const cabecalho = Buffer.alloc(44)

  cabecalho.write('RIFF', 0)
  cabecalho.writeUInt32LE(36 + dataSize, 4)
  cabecalho.write('WAVE', 8)
  cabecalho.write('fmt ', 12)
  cabecalho.writeUInt32LE(16, 16)
  cabecalho.writeUInt16LE(1, 20)
  cabecalho.writeUInt16LE(canais, 22)
  cabecalho.writeUInt32LE(sampleRate, 24)
  cabecalho.writeUInt32LE(byteRate, 28)
  cabecalho.writeUInt16LE(blockAlign, 32)
  cabecalho.writeUInt16LE(bitsPorAmostra, 34)
  cabecalho.write('data', 36)
  cabecalho.writeUInt32LE(dataSize, 40)
  return cabecalho
}

function calcularRms(buffer) {
  if (!buffer || buffer.length < 2) return 0
  const amostras = buffer.length / 2
  let soma = 0
  for (let i = 0; i < buffer.length; i += 2) {
    const amostra = buffer.readInt16LE(i)
    soma += amostra * amostra
  }
  return Math.sqrt(soma / amostras)
}

// --- VAD adaptativo: estima o ruido de fundo e deriva os limiares ---
// O piso e atualizado SO durante o silencio (quando nao esta capturando), com
// EMA assimetrico (sobe devagar, desce rapido) para seguir o ambiente sem que a
// propria fala contamine a estimativa.
function atualizarPisoRuido(sessao, rms) {
  if (sessao.pisoRuido == null) sessao.pisoRuido = config.ESP_MIC_VAD_PISO_INICIAL
  const alpha = rms > sessao.pisoRuido ? config.ESP_MIC_VAD_EMA_SOBE : config.ESP_MIC_VAD_EMA_DESCE
  sessao.pisoRuido = (1 - alpha) * sessao.pisoRuido + alpha * rms
}

// True enquanto o robo ainda esta tocando a ultima resposta (janela anti-eco).
function estaFalando(sessao) {
  return sessao.falandoAteMs != null && Date.now() < sessao.falandoAteMs
}

// Agenda o retorno a 'idle' para quando a fala estimada termina. Garante que a
// interface SEMPRE sai de "falando" no fim da fala, sem depender de chegar mais
// audio do mic. Substitui qualquer timer anterior.
function agendarIdleAposFala(sessao, atrasoMs) {
  cancelarIdleAgendado(sessao)
  sessao.timerIdle = setTimeout(() => {
    sessao.timerIdle = null
    sessao.falandoAteMs = null
    if (!sessao.processando) emitirEstado('idle')
  }, atrasoMs)
}

function cancelarIdleAgendado(sessao) {
  if (sessao.timerIdle) {
    clearTimeout(sessao.timerIdle)
    sessao.timerIdle = null
  }
}

function limiarInicio(sessao) {
  let base
  if (!config.ESP_MIC_VAD_ADAPTATIVO) {
    base = config.ESP_MIC_VAD_RMS_INICIO
  } else {
    const piso = sessao.pisoRuido != null ? sessao.pisoRuido : config.ESP_MIC_VAD_PISO_INICIAL
    // Nunca abre abaixo do piso absoluto (rede de seguranca).
    base = Math.max(config.ESP_MIC_VAD_RMS_INICIO, piso * config.ESP_MIC_VAD_FATOR_INICIO)
  }
  // Anti-eco: enquanto o robo fala, exige um limiar MUITO mais alto para abrir.
  // O eco do proprio alto-falante chega fraco no mic e fica abaixo desse teto
  // elevado (e ignorado); so a voz real da crianca, mais forte, ultrapassa - e
  // ai vira barge-in (interrompe a fala e passa a ouvir). Sem isso o robo entra
  // em loop se respondendo. Ver ESP_MIC_ECO_FATOR_LIMIAR em config.js.
  if (estaFalando(sessao)) base *= config.ESP_MIC_ECO_FATOR_LIMIAR
  return base
}

function limiarFim(sessao) {
  if (!config.ESP_MIC_VAD_ADAPTATIVO) return config.ESP_MIC_VAD_RMS_SILENCIO
  const piso = sessao.pisoRuido != null ? sessao.pisoRuido : config.ESP_MIC_VAD_PISO_INICIAL
  return Math.max(config.ESP_MIC_VAD_RMS_SILENCIO, piso * config.ESP_MIC_VAD_FATOR_FIM)
}

// Normalizacao de pico: levanta o nivel do audio ate o alvo (-3 dBFS) antes do
// STT. So amplifica (nunca atenua), com teto de ganho para nao explodir capturas
// quase mudas em ruido. Whisper transcreve melhor com nivel saudavel.
function normalizarPico(pcm) {
  if (!config.ESP_MIC_NORMALIZAR || !pcm || pcm.length < 2) return pcm
  let pico = 1
  for (let i = 0; i < pcm.length; i += 2) {
    const a = Math.abs(pcm.readInt16LE(i))
    if (a > pico) pico = a
  }
  const alvo = 32767 * Math.pow(10, config.ESP_MIC_NORMALIZAR_PICO_DBFS / 20)
  let ganho = alvo / pico
  if (ganho > config.ESP_MIC_NORMALIZAR_GANHO_MAX) ganho = config.ESP_MIC_NORMALIZAR_GANHO_MAX
  if (ganho <= 1) return pcm
  const out = Buffer.alloc(pcm.length)
  for (let i = 0; i < pcm.length; i += 2) {
    let v = Math.round(pcm.readInt16LE(i) * ganho)
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    out.writeInt16LE(v, i)
  }
  return out
}

function obterOuCriarSessao(wsId, contexto = {}) {
  let sessao = sessoes.get(wsId)
  if (!sessao) {
    sessao = {
      buffers: [],
      bytesAcumulados: 0,
      capturando: false,
      inicioMs: 0,
      ultimoSomMs: 0,
      processando: false,
      pisoRuido: config.ESP_MIC_VAD_PISO_INICIAL,
      usuarioId: contexto.usuarioId || config.ESP_USUARIO_PADRAO,
    }
    sessoes.set(wsId, sessao)
  }
  return sessao
}

function descartarSessao(wsId) {
  const sessao = sessoes.get(wsId)
  if (sessao) cancelarIdleAgendado(sessao)
  sessoes.delete(wsId)
}

function reiniciarBuffer(sessao) {
  sessao.buffers = []
  sessao.bytesAcumulados = 0
  sessao.capturando = false
  sessao.inicioMs = 0
  sessao.ultimoSomMs = 0
}

function configurarUsuario(wsId, usuarioId) {
  const sessao = obterOuCriarSessao(wsId)
  if (typeof usuarioId === 'string' && usuarioId.trim()) {
    sessao.usuarioId = usuarioId.trim().slice(0, 100)
    log('ESP', `Sessao ${wsId} associada ao usuario ${sessao.usuarioId}`)
  }
}

// Duracao (ms) de um PCM 24kHz 16-bit mono: bytes / 2 (16-bit) / 24000 * 1000.
function duracaoPcmMs(pcm) {
  return Math.ceil((pcm.length / 2 / config.ESP_AUDIO_PCM_SAMPLE_RATE) * 1000)
}

// Estende a janela anti-eco e reagenda o retorno a 'idle' conforme novos chunks de
// fala sao enfileirados. Com streaming nao sabemos a duracao total de antemao, entao
// SOMAMOS a duracao de cada chunk ao fim estimado do AUDIO (sessao.falandoAudioAteMs,
// sem a guarda). A janela exposta (sessao.falandoAteMs) e sempre "fim do audio + UMA
// guarda" - a guarda nao se acumula por sentenca. Ver a janela anti-eco/barge-in em
// limiarInicio (enquanto fala, o VAD exige um limiar bem mais alto: so a voz real da
// crianca passa; o eco do alto-falante e barrado).
function estenderJanelaFala(sessao, chunkMs) {
  const agora = Date.now()
  // Fim do audio acumulado ate aqui (nunca no passado), + a duracao deste chunk.
  const baseAudio = sessao.falandoAudioAteMs && sessao.falandoAudioAteMs > agora
    ? sessao.falandoAudioAteMs : agora
  sessao.falandoAudioAteMs = baseAudio + chunkMs
  sessao.falandoAteMs = sessao.falandoAudioAteMs + config.ESP_MIC_ECO_GUARDA_MS
  agendarIdleAposFala(sessao, sessao.falandoAteMs - agora)
}

// Fala uma resposta CURTA e fixa (ex: bloqueio de seguranca) de uma vez: sintetiza
// o PCM inteiro, abre a janela anti-eco e envia pelo caminho nao-stream. Mais
// simples que streamar uma unica frase.
async function falarRespostaUnica(sessao, texto, resposta, idadeUsuario, idiomaTTS, callbacks) {
  const audioPcm = await sintetizarPcm(resposta, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
  if (sessao.interrompido) {
    sessao.interrompido = false
    emitirEstado('idle')
    return
  }
  emitirEstado('falando')
  emitirResposta(resposta)
  const duracaoFalaMs = duracaoPcmMs(audioPcm)
  sessao.falandoAteMs = Date.now() + duracaoFalaMs + config.ESP_MIC_ECO_GUARDA_MS
  agendarIdleAposFala(sessao, duracaoFalaMs + config.ESP_MIC_ECO_GUARDA_MS)

  if (callbacks?.enviarAudio) callbacks.enviarAudio(audioPcm, { textoLength: resposta.length })
  transmitirAudio(audioPcm, {
    texto: resposta,
    transcricao: texto,
    origem: 'robo-mic',
    formato: config.ESP_AUDIO_FORMATO,
    sampleRate: config.ESP_AUDIO_PCM_SAMPLE_RATE,
  })
}

// Fala a resposta da conversa em STREAMING por sentenca (menor latencia ate o robo
// comecar a falar). Fluxo:
//   - conversarStream emite as sentencas conforme a IA as produz.
//   - cada sentenca dispara um sintetizarPcm (em PARALELO, para nao serializar o
//     TTS), mas o ENVIO ao robo respeita a ORDEM (slots + ponteiro proximoEnviar):
//     a fala e um fluxo continuo, entao a sentenca 2 so vai depois da 1.
//   - a primeira sentenca enviada abre a fala stream no robo (um unico audio-inicio);
//     ao terminar todas, finalizamos (o robo recebe um unico audio-fim).
//   - a janela anti-eco/idle e estendida a cada chunk (estenderJanelaFala).
//   - o monitor (/monitor) recebe o PCM concatenado no fim (uma entrada por resposta).
// Retorna true se houve fala; false se vazio/interrompido (estado ja tratado).
async function falarRespostaStream(sessao, texto, idadeUsuario, callbacks, duracaoFalaMs = null, imagemBase64 = null) {
  const podeStream = !!(callbacks?.iniciarFala && callbacks?.enfileirarFala && callbacks?.finalizarFala)

  const slots = []                 // slots[i] = PCM da sentenca i (ou null se falhou)
  const tarefas = []               // promessas de TTS em voo
  let proximoEnviar = 0            // proximo indice a despachar ao robo (preserva ordem)
  let totalSentencas = 0
  let sessaoStream = null         // sessao de fala no esp.js (1o despacho abre)
  let comecouFalar = false
  let idiomaTTS = 'pt'
  const pcmParaMonitor = []
  let abortou = false
  let textoFinalizado = false      // true quando a IA terminou de mandar TODAS as sentencas

  // LOOK-AHEAD DE SINTESE (anti "DMA secou"): o despacho ao robo e ORDENADO (a
  // sentenca N so vai depois da N-1). Antes, drenavamos a sentenca N assim que ela
  // ficava pronta - mas se a sintese da N+1 desse um soluço, o buffer do robo secava
  // na juncao (a fila ficava sem o proximo PCM). Agora so liberamos a sentenca N
  // quando a N+1 JA esta sintetizada (slots[N+1] !== undefined) OU quando a fala ja
  // acabou (textoFinalizado e N e a ultima). Assim, enquanto o robo toca a sentenca
  // N (~5s de audio), a N+1 ja esta na fila pronta - um soluço de sintese e absorvido
  // pelo audio que esta tocando, nao pelo colchao. E a mesma ideia do preload de
  // largada, agora aplicada a CADA juncao da fala.
  const proximaProntaOuFim = (indice) => {
    if (textoFinalizado && indice >= totalSentencas - 1) return true  // ultima sentenca
    return slots[indice + 1] !== undefined                            // proxima ja sintetizada
  }

  const drenarSlots = () => {
    if (abortou) return
    while (proximoEnviar < slots.length && slots[proximoEnviar] !== undefined) {
      // Look-ahead: so libera esta sentenca se a PROXIMA ja estiver pronta (ou for o
      // fim da fala). Senao para e espera - o proximo .then() de TTS chama drenarSlots
      // de novo e ai a condicao passa.
      if (!proximaProntaOuFim(proximoEnviar)) break

      const pcm = slots[proximoEnviar]
      proximoEnviar++
      if (!pcm) continue   // TTS daquela sentenca falhou: pula
      if (sessao.interrompido) { abortou = true; return }

      if (!comecouFalar) {
        comecouFalar = true
        sessao.falandoAudioAteMs = null   // fala nova: nao herda o fim de audio anterior
        emitirEstado('falando')
        if (podeStream) sessaoStream = callbacks.iniciarFala({ origem: 'robo-mic' })
      }
      if (podeStream && sessaoStream) callbacks.enfileirarFala(sessaoStream, pcm)
      pcmParaMonitor.push(pcm)
      estenderJanelaFala(sessao, duracaoPcmMs(pcm))
    }
  }

  const despacharSentenca = (sentenca) => {
    if (abortou || sessao.interrompido) return
    const indice = totalSentencas++
    const tarefa = sintetizarPcm(sentenca, { idade: idadeUsuario, idiomaForcado: idiomaTTS })
      .then((pcm) => { slots[indice] = pcm; drenarSlots() })
      .catch((err) => { log('Erro', `TTS sentenca (robo) falhou: ${err.message}`); slots[indice] = null; drenarSlots() })
    tarefas.push(tarefa)
  }

  const resultado = await conversarStream(sessao.usuarioId, texto, imagemBase64, {
    // Marca a origem do turno pro Diario de Conversas (este caminho e o robo).
    origem: 'robo',
    // Duracao REAL da fala da crianca (medida pelo VAD do mic). Vira o duracao_ms
    // do turno no Painel de Aprendizado — tempo de uso de quem fala com o robo.
    duracaoMs: duracaoFalaMs,
    // Idioma do TTS: o callback chega ANTES da primeira sentenca, entao o PCM ja
    // sai no idioma certo (sem aplicar conversoes de PT a uma resposta em outro
    // idioma). Mesma paridade da interface web.
    onIdioma: (ctx) => { idiomaTTS = idiomaParaTTS(ctx) || 'pt' },
    // Reflete a busca na web na interface (tela roxa), igual ao caminho antigo.
    onPesquisa: () => emitirEstado('pesquisando'),
    onSentenca: (s) => despacharSentenca(s),
  })

  const resposta = resultado.texto
  if (!resposta) {
    emitirEstado('idle')
    return false
  }

  // A IA terminou de mandar TODAS as sentencas: libera o look-ahead a despachar a
  // ULTIMA (que ele segurava esperando uma "proxima" que nao existe). Drena o que ja
  // estiver pronto ate aqui.
  textoFinalizado = true
  drenarSlots()

  // Legenda "Cogni" na interface assim que o TEXTO esta pronto (nao espera o TTS
  // das ultimas sentencas) - aparece mais cedo. Se o usuario ja interrompeu, nao
  // mostra (a fala foi cancelada).
  if (!sessao.interrompido) {
    emitirResposta(resposta)
    // Reacao dos olhos pelo CONTEUDO (elogio -> coracoes, piada -> riso, "nao entendi"
    // -> confuso...). Uma unica deteccao com os dois lados da conversa; a prioridade
    // (amor da crianca vence celebra da Cogni) vive em detectarReacao. E pontual: a
    // tela anima alguns segundos SOBRE o rosto de estado e volta sozinha ao normal.
    const emocao = detectarReacao(resposta, texto)
    if (emocao) emitirReacao(emocao)
  }

  // Espera todos os TTS em voo e despacha o que faltou, na ordem.
  await Promise.allSettled(tarefas)
  drenarSlots()

  if (sessao.interrompido) {
    sessao.interrompido = false
    if (podeStream && sessaoStream) callbacks.finalizarFala(sessaoStream)
    emitirEstado('idle')
    return false
  }

  // Nada tocou (ex: todas as sentencas falharam no TTS): trata como vazio.
  if (!comecouFalar) {
    emitirEstado('idle')
    return false
  }

  if (podeStream && sessaoStream) callbacks.finalizarFala(sessaoStream)

  // Monitor: uma entrada por resposta com o PCM completo concatenado.
  if (pcmParaMonitor.length > 0) {
    transmitirAudio(Buffer.concat(pcmParaMonitor), {
      texto: resposta,
      transcricao: texto,
      origem: 'robo-mic',
      formato: config.ESP_AUDIO_FORMATO,
      sampleRate: config.ESP_AUDIO_PCM_SAMPLE_RATE,
    })
  }

  log('ESP', `Pipeline ESP (stream) completo: "${resposta.slice(0, 80)}${resposta.length > 80 ? '...' : ''}"`)
  return true
}

async function processarFimDeFala(sessao, ws, callbacks) {
  if (sessao.processando) return
  if (sessao.buffers.length === 0) return

  const duracaoMs = Date.now() - sessao.inicioMs
  if (duracaoMs < config.ESP_MIC_MIN_DURACAO_MS) {
    reiniciarBuffer(sessao)
    return
  }

  sessao.processando = true
  emitirEstado('pensando')   // a interface ja mostra "Pensando" enquanto roda STT+IA
  const pcmBruto = Buffer.concat(sessao.buffers, sessao.bytesAcumulados)
  reiniciarBuffer(sessao)

  // Normaliza o volume antes do STT (ajuda o Whisper com fala baixa).
  const pcm = normalizarPico(pcmBruto)
  const amostras = Math.floor(pcm.length / 2)

  const cabecalho = criarCabecalhoWav(amostras, config.ESP_MIC_SAMPLE_RATE)
  const wav = Buffer.concat([cabecalho, pcm])
  log('ESP', `Fim de fala detectado (${duracaoMs}ms, ${(wav.length / 1024).toFixed(1)}KB, piso ruido ~${Math.round(sessao.pisoRuido)}) - iniciando pipeline`)

  try {
    const usuario = carregarUsuario(sessao.usuarioId)

    // Defesa: sem um usuario REAL nao processamos (evita o robo virar uma IA
    // generica sem perfil/memorias quando o usuarioId e invalido ou "default"
    // inexistente). O gate roboHabilitado ja garante que a interface escolheu um
    // perfil, mas isto blinda contra perfil removido/ inconsistente.
    if (!usuario) {
      log('ESP', `Sem usuario valido para a sessao (id=${sessao.usuarioId}) - ignorando fala`)
      emitirEstado('idle')
      sessao.processando = false
      return
    }
    const ehDev = usuario.role === 'desenvolvedor'

    // Passa o contexto do usuario (nome, dominio) ao Whisper: melhora a
    // transcricao de nomes/termos e reduz o "respondeu outra coisa" por STT errado.
    const texto = await transcrever(wav, 'audio/wav', opcoesTranscricaoPadrao(usuario))
    log('ESP', `STT: "${texto || '(vazio)'}"`)

    if (!texto || ehTextoLixo(texto)) {
      emitirEstado('idle')
      sessao.processando = false
      return
    }

    emitirTranscricao(texto)   // legenda "Voce" na interface

    // Visao: frame da webcam do PC capturado pela interface no inicio desta fala
    // (POST /api/esp/webcam/frame). null se a camera estava desligada ou o TTL
    // expirou. Lido UMA vez por turno aqui; vai pra IA via falarRespostaStream.
    const imagemWebcam = obterFrameWebcamBase64()
    if (imagemWebcam) log('Visao', 'Frame da webcam incluido na fala do robo')

    const idadeUsuario = typeof usuario?.idade === 'number' ? usuario.idade : null

    // Entrada bloqueada: resposta curta e fixa (sempre PT). Nao vale streamar uma
    // frase - sintetiza e envia de uma vez pelo caminho simples.
    if (!ehDev) {
      const verificacao = verificarEntrada(texto)
      if (!verificacao.seguro) {
        log('Seguranca', `Entrada do robo bloqueada: "${texto.slice(0, 60)}"`)
        await falarRespostaUnica(sessao, texto, RESPOSTA_BLOQUEIO, idadeUsuario, 'pt', callbacks)
        sessao.processando = false
        return
      }
    }

    // Conversa normal: STREAMING por sentenca. A resposta da IA sai aos poucos; a
    // cada sentenca pronta, sintetizamos o PCM e enviamos ao robo. Assim o robo
    // comeca a falar logo na PRIMEIRA sentenca, em vez de esperar a resposta E o
    // TTS inteiros (latencia ate o primeiro som cai de "IA+TTS completos" para
    // "1a sentenca + TTS dela"). E a mesma estrategia que a interface web ja usa.
    const ok = await falarRespostaStream(sessao, texto, idadeUsuario, callbacks, duracaoMs, imagemWebcam)
    if (!ok) {
      // Sem resposta, ou interrompido no meio: falarRespostaStream ja tratou o
      // estado (idle / janela de fala). Nada a fazer aqui.
      sessao.processando = false
      return
    }
  } catch (err) {
    log('Erro', `Pipeline ESP: ${err.message}`)
    // Em caso de erro (ex: falha ao enviar audio), cancela a janela de fala para
    // o finally voltar a interface para idle - senao ela ficaria presa em
    // "falando" ate a janela expirar, sem nenhum chunk de audio para destravar.
    sessao.falandoAteMs = null
    sessao.falandoAudioAteMs = null
  } finally {
    sessao.processando = false
    // Volta para "idle" so quando NAO ha mais fala tocando. Se ainda estamos na
    // janela de fala, a interface continua em "falando"; o retorno a idle
    // acontece no proximo chunk apos a janela fechar (ver processarChunkPcm).
    if (!estaFalando(sessao)) {
      emitirEstado('idle')
    }
  }
}

function processarChunkPcm(wsId, chunk, ws, callbacks) {
  if (!config.ESP_PIPELINE_HABILITADO) return
  if (!Buffer.isBuffer(chunk) || chunk.length < 2) return

  const sessao = obterOuCriarSessao(wsId)
  if (sessao.processando) return

  // Anti-eco: enquanto o robo fala (janela), o firmware NAO capta o mic, entao
  // nao deveria chegar audio. Mesmo assim, ignoramos qualquer residuo aqui (nao
  // abre captura, nao aprende o piso de ruido - o eco contaminaria a estimativa).
  if (estaFalando(sessao)) return

  const rms = calcularRms(chunk)
  const agora = Date.now()

  if (!sessao.capturando) {
    // Durante o silencio o piso de ruido "aprende" o ambiente (ventoinha etc.).
    atualizarPisoRuido(sessao, rms)

    if (rms >= limiarInicio(sessao)) {
      sessao.capturando = true
      sessao.inicioMs = agora
      sessao.ultimoSomMs = agora
      sessao.buffers.push(chunk)
      sessao.bytesAcumulados += chunk.length
      emitirEstado('ouvindo')
    }
    return
  }

  if (sessao.bytesAcumulados + chunk.length > config.ESP_MIC_MAX_BUFFER_BYTES) {
    log('Aviso', `Captura ESP excedeu limite (${config.ESP_MIC_MAX_BUFFER_BYTES} bytes), processando agora`)
    processarFimDeFala(sessao, ws, callbacks).catch(() => {})
    return
  }

  sessao.buffers.push(chunk)
  sessao.bytesAcumulados += chunk.length

  // Enquanto captura, NAO atualiza o piso (a fala contaminaria a estimativa).
  if (rms >= limiarFim(sessao)) {
    sessao.ultimoSomMs = agora
  }

  const tempoTotal = agora - sessao.inicioMs
  const tempoSilencio = agora - sessao.ultimoSomMs

  if (tempoTotal >= config.ESP_MIC_MAX_DURACAO_MS) {
    log('ESP', `Captura ESP atingiu duracao maxima (${config.ESP_MIC_MAX_DURACAO_MS}ms), processando`)
    processarFimDeFala(sessao, ws, callbacks).catch(() => {})
    return
  }

  if (tempoSilencio >= config.ESP_MIC_SILENCIO_MS_FIM) {
    processarFimDeFala(sessao, ws, callbacks).catch(() => {})
  }
}

// Forca o fim da fala AGORA, sem esperar o silencio. Usado quando o usuario muta
// o mic do robo pela interface no meio de uma fala: a intencao e "terminei, pode
// pensar". Se estiver capturando algo valido, dispara o pipeline na hora; senao,
// e no-op. Espelha o comportamento do navegador (mutar enquanto fala -> processa).
function forcarFimDeFala(wsId, callbacks) {
  const sessao = sessoes.get(wsId)
  if (!sessao || !sessao.capturando || sessao.processando) return false
  // processarFimDeFala recebe um `ws` por assinatura mas nunca o usa - o envio do
  // audio e feito via callbacks.enviarAudio. Por isso passamos null aqui.
  processarFimDeFala(sessao, null, callbacks).catch(() => {})
  return true
}

// Interrompe o robo: zera a janela de fala e descarta qualquer captura em
// andamento, voltando para idle. Usado pelo botao "Parar" da interface.
function interromper(wsId) {
  const sessao = sessoes.get(wsId)
  if (!sessao) return false
  sessao.falandoAteMs = null
  sessao.falandoAudioAteMs = null
  cancelarIdleAgendado(sessao)
  if (sessao.processando) {
    // Pipeline em andamento (STT/IA/TTS): sinaliza para ele abortar o envio do
    // audio quando voltar do await. O proprio pipeline emitira 'idle'.
    sessao.interrompido = true
  } else {
    if (sessao.capturando) reiniciarBuffer(sessao)
    emitirEstado('idle')
  }
  return true
}

module.exports = {
  processarChunkPcm,
  configurarUsuario,
  descartarSessao,
  forcarFimDeFala,
  interromper,
}
