const { WebSocketServer } = require('ws')
const crypto = require('crypto')
const config = require('../config')
const { log } = require('./logger')
const { processarChunkPcm, configurarUsuario, descartarSessao, forcarFimDeFala, interromper } = require('./esp-pipeline')
const { carregarUsuario } = require('./memoria')
const atividade = require('./esp-atividade')

const conexoesControle = new Map()
const ouvintesEstado = new Set()

// Estado de controle do robo, comandado pela interface (painel de controle):
//  - usuarioAtivoRobo: qual perfil o robo usa (memorias, idade, idioma). Comeca
//    no padrao e a interface sobrescreve em tempo real via POST /api/esp/usuario.
//  - micRoboMutado: quando true, o servidor IGNORA o audio que o robo envia (o
//    robo continua captando, mas descartamos). Mute "a prova de falha", sem
//    depender de comando chegar ao firmware.
//  - roboHabilitado: GATE principal. O robo so escuta/responde quando a interface
//    LIGA o controle (toggle "Controlar robo") dentro de um perfil. Sem isso o
//    robo fica MUDO - nao processa audio nenhum, mesmo recebendo do mic. Evita o
//    robo responder "no seco" (sem perfil) e garante que sempre ha um usuario real.
let usuarioAtivoRobo = config.ESP_USUARIO_PADRAO
let micRoboMutado = false
let roboHabilitado = false
// A webcam vive no NAVEGADOR; o servidor so sabe do estado dela porque o dashboard
// avisa (POST /api/esp/camera). Guardamos aqui para poder contar ao robo junto da
// expressao - ele precisa distinguir "ninguem me olha" de "estou sem camera".
let cameraLigada = false

// Ultimo estado da conversa (ouvindo/pensando/pesquisando/falando/idle) espelhado
// para o robo, para os OLHOS na tela OLED reagirem. Alimentado pelo pipeline via
// esp-atividade (ver o ouvinte registrado em configurarServidoresWebSocket) e
// enviado ao ESP no evento "expressao" (junto com o mute).
let ultimoEstadoConversa = 'idle'

function broadcastEstado() {
  const estado = obterEstado()
  for (const ouvinte of ouvintesEstado) {
    try {
      ouvinte(estado)
    } catch (err) {
      log('Aviso', `Falha ao notificar ouvinte ESP: ${err.message}`)
    }
  }
}

function obterEstado() {
  return {
    controle: { conectados: conexoesControle.size },
    mic: { mutado: micRoboMutado },
    usuarioAtivo: usuarioAtivoRobo,
    habilitado: roboHabilitado,
  }
}

function compararConstante(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function tokenValido(req) {
  if (!config.ESP_TOKEN) return true
  const url = new URL(req.url, 'http://localhost')
  const tokenQuery = url.searchParams.get('token') || ''
  const tokenHeader = typeof req.headers['x-esp-token'] === 'string' ? req.headers['x-esp-token'] : ''
  return compararConstante(tokenQuery, config.ESP_TOKEN) || compararConstante(tokenHeader, config.ESP_TOKEN)
}

function configurarHeartbeat(ws) {
  ws.falhasPong = 0
  ws.on('pong', () => { ws.falhasPong = 0 })
}

// Ping periodico do servidor ao ESP. So derruba (terminate) depois de
// ESP_HEARTBEAT_MAX_FALHAS pings seguidos sem pong - um unico pong atrasado
// (tipico quando o modem-sleep do Wi-Fi do ESP acorda) nao mata mais a conexao.
// Antes era "1 falha = morre", o que, somado ao heartbeat do proprio ESP,
// derrubava o robo "do nada".
function iniciarPing(servidor) {
  const interval = setInterval(() => {
    servidor.clients.forEach(ws => {
      ws.falhasPong = (ws.falhasPong || 0) + 1
      if (ws.falhasPong > config.ESP_HEARTBEAT_MAX_FALHAS) {
        log('ESP', `Sem pong apos ${ws.falhasPong - 1} tentativas - encerrando conexao ${ws.metadata?.id || ''}`)
        ws.terminate()
        return
      }
      try { ws.ping() } catch { /* ignorar erros de ping em socket fechado */ }
    })
  }, config.ESP_HEARTBEAT_MS)

  servidor.on('close', () => clearInterval(interval))
}

function tratarMensagemControle(ws, dados) {
  try {
    if (dados.tipo === 'status') {
      ws.metadata = { ...ws.metadata, ...dados.payload }
      log('ESP', `Status recebido de ${ws.metadata?.id || 'esp'}: ${JSON.stringify(dados.payload).slice(0, 100)}`)
    } else if (dados.tipo === 'buffer') {
      // CONTROLE DE FLUXO: o robo reporta quantos ms de audio ainda tem para tocar.
      // Guardamos na conexao; enviarBinarioEmChunks usa esse valor para regular o
      // ritmo de envio (acelera se esta secando, segura se esta cheio). Tambem
      // registramos o contador de gaps (diagnostico de underrun) so quando muda,
      // para o log nao floodar mas ainda revelar se o robo esta secando o buffer.
      const ms = Number(dados.payload?.ms)
      if (Number.isFinite(ms)) {
        ws.nivelBufferMs = ms
        ws.nivelBufferEm = Date.now()
      }
      const gaps = Number(dados.payload?.gaps)
      if (Number.isFinite(gaps) && gaps !== ws.ultimoGaps) {
        if (gaps > (ws.ultimoGaps || 0)) {
          log('ESP', `Robo ${ws.metadata?.id || 'esp'}: ${gaps} gap(s) de audio (DMA secou) - buffer ~${ms}ms`)
        }
        ws.ultimoGaps = gaps
      }
      // Diagnostico de pressao de heap: o firmware reporta a memoria livre; guardamos
      // o MINIMO por fala (logado ao fim, em bombearFalaStream). Heap baixo na fala e
      // o sinal da fragmentacao que ameaca os buffers do Wi-Fi/WebSocket.
      const heap = Number(dados.payload?.heap)
      if (Number.isFinite(heap) && (ws.heapMinFala == null || heap < ws.heapMinFala)) {
        ws.heapMinFala = heap
      }
      return   // mensagem de fluxo nao precisa de broadcast de estado
    } else if (dados.tipo === 'log') {
      log('ESP', `[${ws.metadata?.id || 'esp'}] ${dados.payload?.mensagem || ''}`)
    } else if (dados.tipo === 'voz-config') {
      // O firmware reenvia voz-config (com o usuario do config.h) a CADA reconexao.
      // Isso apenas compoe a sessao - NAO habilita o robo (o gate e roboHabilitado,
      // ligado so pela interface). Se a interface ja escolheu um perfil, ele MANDA:
      // ignoramos o voz-config do firmware para a reconexao nao reverter o perfil.
      if (usuarioAtivoRobo === config.ESP_USUARIO_PADRAO) {
        configurarUsuario(ws.idConexao, dados.payload?.usuarioId)
      } else {
        configurarUsuario(ws.idConexao, usuarioAtivoRobo)
      }
    } else if (dados.tipo === 'botao') {
      // Botao FISICO do robo: dispara a MESMA acao do painel de controle web.
      tratarBotaoFisico(dados.payload?.acao)
      return   // a propria acao ja faz broadcast/efeitos; nao precisa do broadcast abaixo
    }
    broadcastEstado()
  } catch (err) {
    log('Aviso', `Falha ao tratar mensagem ESP: ${err.message}`)
  }
}

// Mapeia um botao fisico do robo para a acao correspondente do painel web, reusando
// as MESMAS funcoes que os endpoints HTTP usam - assim robo e dashboard ficam em
// sincronia (o estado propaga de volta pela interface via SSE).
function tratarBotaoFisico(acao) {
  switch (acao) {
    case 'mute':
      // Alterna o mute do mic (toggle "cego": o servidor e a fonte da verdade).
      definirMicMutado(!micRoboMutado)
      break
    case 'interromper':
      // Corta a fala do robo agora (parar-audio ao ESP) e aborta o pipeline.
      interromperRobo()
      break
    case 'reset':
      // Reinicia a conversa: cala a fala em curso e limpa o historico da sessao do
      // usuario ativo do robo (memorias de longo prazo sao mantidas). require lazy
      // de ./brain para evitar ciclo de dependencia no carregamento do modulo.
      interromperRobo(false)   // o feedback aqui e o do reset, nao o de "pausa"
      try {
        const { limparConversa } = require('./brain')
        limparConversa(usuarioAtivoRobo)
        reagirResetConversa(usuarioAtivoRobo)
      } catch (err) {
        log('Aviso', `Falha ao limpar conversa pelo botao reset: ${err.message}`)
      }
      break
    case 'camera':
      // A webcam vive no NAVEGADOR: pede ao dashboard para alternar a camera do PC.
      atividade.emitirComando('toggle-camera')
      break
    default:
      log('Aviso', `Botao fisico com acao desconhecida: ${acao}`)
  }
}

function configurarServidoresWebSocket(httpServer) {
  if (!config.ESP_ENABLED) {
    log('ESP', 'Integracao ESP desabilitada via configuracao')
    return null
  }

  // perMessageDeflate: false -> a lib WebSocket do ESP (Links2004) nao suporta
  // compressao permessage-deflate; se o servidor negociar, o ESP nao decodifica
  // e cai. Ja e o padrao do 'ws', mas explicitamos para blindar.
  const wssControle = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  wssControle.on('connection', (ws, req) => {
    const id = crypto.randomBytes(4).toString('hex')
    // idConexao e a chave ESTAVEL desta conexao (usada no Map de conexoes e como
    // wsId da sessao do pipeline). NUNCA muda. Cuidado: ws.metadata.id PODE ser
    // sobrescrito pelo firmware (que manda {id:"robo-cogni-01"} no status), entao
    // NAO use metadata.id como chave de sessao - use sempre ws.idConexao.
    ws.idConexao = id
    ws.metadata = { id }
    // Callbacks amarrados a ESTA conexao. Guardamos na propria conexao para que
    // o mute/interromper/barge-in (acionados via HTTP ou pelo pipeline, que nao
    // tem o `ws` do handler a mao) reusem o mesmo caminho de envio/corte.
    //   - enviarAudio: fala inteira de uma vez (caminho nao-stream / fallback).
    //   - iniciarFala/enfileirarFala/finalizarFala: fala em STREAMING por sentenca
    //     (menor latencia; uma fala continua = um audio-inicio .. varios chunks ..
    //     um audio-fim). Ver as funcoes de fala em streaming acima.
    ws.callbacks = {
      enviarAudio: (audioBuffer, metadata) => enviarAudioParaConexao(ws, audioBuffer, metadata),
      pararAudio: () => pararAudioRobo(ws),
      iniciarFala: (metadata) => iniciarFalaStreamConexao(ws, metadata),
      enfileirarFala: (sessao, pcm) => enfileirarPcmFalaConexao(ws, sessao, pcm),
      finalizarFala: (sessao) => finalizarFalaStreamConexao(ws, sessao),
    }
    conexoesControle.set(id, ws)
    configurarHeartbeat(ws)
    // Reaplica o perfil ativo escolhido pela interface. Cobre o caso de um robo
    // que conecta DEPOIS de o usuario ja ter selecionado a crianca na tela.
    configurarUsuario(id, usuarioAtivoRobo)
    log('ESP', `ESP32 controle conectado (id=${id}, total=${conexoesControle.size}, usuario=${usuarioAtivoRobo})`)
    broadcastEstado()

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        // GATE: so processa audio do mic se a interface LIGOU o controle do robo
        // (toggle "Controlar robo" num perfil) E o mic nao esta mutado. Sem isso o
        // robo fica mudo - nao responde "no seco" e sempre tem um usuario real.
        if (!roboHabilitado || micRoboMutado) return
        processarChunkPcm(id, Buffer.from(raw), ws, ws.callbacks)
        return
      }

      let dados
      try { dados = JSON.parse(raw.toString()) } catch { return }
      tratarMensagemControle(ws, dados)
    })

    ws.on('close', () => {
      conexoesControle.delete(id)
      // Encerra qualquer envio/fala em curso: cancela o token (o consumidor do
      // stream ja para no proximo passo) e solta a sessao de fala para nao deixar a
      // fila crescer numa conexao morta.
      if (ws.envioAtual) ws.envioAtual.cancelado = true
      if (ws.falaStream) { ws.falaStream.finalizada = true; ws.falaStream.fila = []; ws.falaStream = null }
      descartarSessao(id)
      log('ESP', `ESP32 controle desconectado (id=${id}, total=${conexoesControle.size})`)
      broadcastEstado()
    })

    ws.send(JSON.stringify({ tipo: 'bem-vindo', payload: { id, agora: Date.now() } }))
    // Sincroniza o rosto (olhos) assim que o robo conecta, para uma reconexao no
    // meio da conversa nao deixar a expressao defasada.
    enviarExpressaoParaEsp(ws)
    // E a GEOMETRIA dos olhos desenhada pela crianca. Precisa vir na conexao porque o
    // firmware nao guarda isso entre reinicios - ele sobe sempre com o rosto de
    // fabrica e espera o servidor contar como esta crianca gosta dele.
    enviarRostoParaEsp(ws)
  })

  iniciarPing(wssControle)

  // Espelha o estado da conversa (do pipeline, via esp-atividade) para os OLHOS do
  // robo: a cada mudanca de estado, envia "expressao" ao ESP. O emitirEstado ja
  // deduplica estados repetidos, entao isso nao floda o WebSocket.
  atividade.registrarOuvinte((ev) => {
    if (ev && ev.tipo === 'estado') {
      ultimoEstadoConversa = ev.estado
      enviarExpressaoParaEsp()
    } else if (ev && ev.tipo === 'reacao') {
      // Reacao pontual (elogio -> coracoes, piada -> riso...): repassa ao robo, que
      // anima por alguns segundos SOBRE o rosto de estado e depois volta ao normal.
      enviarReacaoParaEsp(ev.emocao)
    }
  })

  httpServer.on('upgrade', (req, socket, head) => {
    if (!tokenValido(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const { pathname } = new URL(req.url, 'http://localhost')

    if (pathname === '/ws/esp') {
      wssControle.handleUpgrade(req, socket, head, (ws) => wssControle.emit('connection', ws, req))
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    }
  })

  return { wssControle }
}

function enviarParaTodos(map, mensagem, opcoes = {}) {
  let enviados = 0
  for (const ws of map.values()) {
    if (ws.readyState !== ws.OPEN) continue
    try {
      ws.send(mensagem, opcoes)
      enviados++
    } catch (err) {
      log('Aviso', `Falha ao enviar para ESP: ${err.message}`)
    }
  }
  return enviados
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// BACKPRESSURE DO SOCKET: espera o buffer de TRANSMISSAO do socket (bufferedAmount)
// drenar antes de injetar mais audio. Complementa o pacing por nivel REPORTADO pelo
// robo, que e cego ao que esta represado no socket TCP a caminho. Sem esta guarda,
// sob jitter de Wi-Fi o pacing despeja chunks a jato (pacingMin) num socket ja
// congestionado -> a fila TCP incha -> o pong do heartbeat atrasa -> a lib do ESP
// (pongTimeout) derruba a conexao "na fala". Ao segurar aqui, o ritmo real de envio
// acompanha a vazao da rede. Registra o pico de bufferedAmount na conexao (diagnostico,
// logado ao fim da fala). Retorna false se a fala foi cancelada/o socket fechou.
async function aguardarSocketDrenar(ws, token) {
  const teto = config.ESP_AUDIO_SOCKET_BACKLOG_MAX_BYTES
  const registrarPico = () => {
    if (ws.bufferedAmount > (ws.picoBufferedAmount || 0)) ws.picoBufferedAmount = ws.bufferedAmount
  }
  registrarPico()
  if (!(teto > 0) || ws.bufferedAmount <= teto) return !token.cancelado
  // Teto de seguranca: num socket patologicamente lento nao travamos o envio para
  // sempre - passado o limite, seguimos (o heartbeat/readyState cuida de conexao morta).
  const inicio = Date.now()
  while (ws.bufferedAmount > teto) {
    if (token.cancelado || ws.readyState !== ws.OPEN) return false
    if (Date.now() - inicio > 1500) break
    await esperar(config.ESP_AUDIO_PACING_MIN_MS)
    registrarPico()
  }
  return !token.cancelado
}

// Envia o audio para UMA conexao em chunks pequenos, com CONTROLE DE FLUXO em
// malha fechada (regulado pelo nivel de buffer que o robo reporta). Detalhes:
//   - Fatiamos em ~4KB: a lib WebSocket do ESP (Links2004) fecha a conexao (1009)
//     se receber uma mensagem maior que 15KB.
//   - BURST INICIAL: os primeiros ESP_AUDIO_BURST_CHUNKS chunks vao em rajada,
//     para encher o colchao do robo antes de qualquer underrun (mata o engasgo de
//     inicio de fala).
//   - DEPOIS DO BURST: em vez de um pacing FIXO "as cegas" (que so acerta o ritmo
//     por sorte e seca o DMA no menor jitter de Wi-Fi -> picote/duplicacao/loop),
//     olhamos quantos ms de audio o robo ainda tem (ws.nivelBufferMs, atualizado
//     ~a cada 40ms pela mensagem 'buffer' do firmware) e regulamos:
//       * buffer ACIMA do alvo (robo bem servido)  -> espera mais (segura o ritmo)
//       * buffer ABAIXO do alvo (robo secando)      -> manda rapido (reabastece)
//     Mantemos a fila do robo perto de ESP_AUDIO_BUFFER_ALVO_MS: nunca seca (sem
//     underrun) e nunca estoura (sem descarte). E o que de fato elimina a gagueira.
// Cancelavel: cada fala tem um token (ws.envioAtual). pararAudioRobo() seta
// token.cancelado = true; este laco aborta antes do proximo chunk.
async function enviarBinarioEmChunks(ws, buffer, token) {
  const tamanho = config.ESP_AUDIO_CHUNK_BYTES
  const burst = config.ESP_AUDIO_BURST_CHUNKS
  const alvoMs = config.ESP_AUDIO_BUFFER_ALVO_MS
  const tetoMs = config.ESP_AUDIO_BUFFER_TETO_MS
  const msPorChunk = (tamanho / config.ESP_AUDIO_BYTES_POR_MS)   // ~85ms para 4KB@24kHz
  const pacingMin = config.ESP_AUDIO_PACING_MIN_MS
  const pacingMax = config.ESP_AUDIO_PACING_MAX_MS

  // Estima o nivel ATUAL do buffer do robo entre relatorios: do ultimo valor
  // reportado, desconta o audio que ja deve ter tocado desde entao. Evita reagir
  // a um numero velho (o relatorio chega a cada ~40ms, mas mandamos chunks mais
  // rapido que isso). Reseta a estimativa a cada nova fala via ws.envioAtual.
  const nivelEstimado = () => {
    if (typeof ws.nivelBufferMs !== 'number' || !ws.nivelBufferEm) return 0
    const decorrido = Date.now() - ws.nivelBufferEm
    return Math.max(0, ws.nivelBufferMs - decorrido)
  }

  let indice = 0
  for (let offset = 0; offset < buffer.length; offset += tamanho, indice++) {
    if (token.cancelado || ws.readyState !== ws.OPEN) return false
    // Antes de mandar o proximo chunk, garante que o socket nao esta congestionado
    // (segura se bufferedAmount passou do teto). Isto tambem impede que o ramo
    // "abaixo do alvo" (pacingMin, mais abaixo) infle o socket sob jitter de rede.
    if (!(await aguardarSocketDrenar(ws, token))) return false
    try {
      ws.send(buffer.subarray(offset, offset + tamanho), { binary: true })
    } catch (err) {
      log('Aviso', `Falha ao enviar chunk de audio: ${err.message}`)
      return false
    }

    const temProximo = offset + tamanho < buffer.length
    if (!temProximo) break

    // Burst inicial: enche o colchao sem pausa.
    if (indice < burst) continue

    // Acabei de injetar ~msPorChunk de audio no robo; o nivel "logico" sobe por isso.
    const nivel = nivelEstimado() + msPorChunk

    if (nivel >= tetoMs) {
      // Buffer cheio (teto): espera o robo drenar ate perto do alvo antes de mandar
      // mais, evitando estourar a fila/pool do firmware. Espera proporcional ao
      // excedente, limitada para nao travar o envio.
      const espera = Math.min(pacingMax, Math.max(msPorChunk, nivel - alvoMs))
      await esperar(espera)
    } else if (nivel >= alvoMs) {
      // Na faixa-alvo: anda UM POUCO mais rapido que o consumo para manter folga
      // positiva contra o jitter. Esperar ~msPorChunk (85ms) andava no limite -
      // qualquer atraso de rede secava o DMA. Mandar a ~60% da duracao do chunk
      // mantem o buffer subindo de leve em direcao ao teto, em vez de raspar o
      // alvo. (O teto acima freia quando enche; nao ha risco de estourar.)
      await esperar(Math.max(pacingMin, Math.round(msPorChunk * 0.6)))
    } else {
      // Abaixo do alvo (secando): manda rapido para reabastecer. Pausa minima so
      // para nao monopolizar o event loop / socket.
      await esperar(pacingMin)
    }
  }
  return !token.cancelado
}

function enviarAudioParaRobo(audioBuffer, metadata = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return 0
  if (conexoesControle.size === 0) return 0

  let enviados = 0
  for (const ws of conexoesControle.values()) {
    if (enviarAudioParaConexao(ws, audioBuffer, metadata)) enviados++
  }
  return enviados
}

// Inicia o envio do audio para a conexao. Retorna true se o envio COMECOU (o
// envio em si roda solto/assincrono e e cancelavel via ws.envioAtual). Nao
// usamos await aqui de proposito: o pipeline nao deve travar esperando a fala
// inteira ser transmitida em ritmo real.
function enviarAudioParaConexao(ws, audioBuffer, metadata = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return false
  if (!ws || ws.readyState !== ws.OPEN) return false

  // Novo token de envio para esta fala. Cancela qualquer envio anterior ainda
  // em curso (nao deveria haver, mas blinda) e vira a referencia atual.
  if (ws.envioAtual) ws.envioAtual.cancelado = true
  const token = { cancelado: false }
  ws.envioAtual = token
  // Zera o nivel de buffer reportado: o robo limpa a fila ao iniciar nova fala
  // (audio-inicio), entao comecamos assumindo buffer vazio. Sem isto, o controle
  // de fluxo herdaria o nivel final da fala anterior e seguraria demais no comeco.
  ws.nivelBufferMs = 0
  ws.nivelBufferEm = Date.now()
  ws.picoBufferedAmount = 0

  try {
    // Informa formato e sample rate para o ESP saber como tocar (PCM vai direto
    // pro I2S). sampleRate so importa para PCM.
    const cabecalho = {
      tipo: 'audio-inicio',
      payload: {
        tamanho: audioBuffer.length,
        formato: config.ESP_AUDIO_FORMATO,
        sampleRate: config.ESP_AUDIO_PCM_SAMPLE_RATE,
        ...metadata,
      },
    }
    ws.send(JSON.stringify(cabecalho))
  } catch (err) {
    log('Aviso', `Falha ao enviar cabecalho de audio: ${err.message}`)
    return false
  }

  // Envio paced roda solto. So manda 'audio-fim' se NAO foi cancelado no meio
  // (se cancelou, o 'parar-audio' ja encerrou a reproducao no robo).
  enviarBinarioEmChunks(ws, audioBuffer, token)
    .then((completou) => {
      if (completou && !token.cancelado && ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ tipo: 'audio-fim' })) } catch { /* socket fechou */ }
      }
    })
    .catch((err) => log('Aviso', `Envio de audio interrompido: ${err.message}`))

  return true
}

// --- Envio de fala em STREAMING (varias sentencas numa unica fala) -----------
// O pipeline do robo sintetiza a resposta por SENTENCA (a primeira sentenca fica
// pronta muito antes da resposta inteira), reduzindo a latencia ate o robo comecar
// a falar. Mas no protocolo isso e UMA fala continua: um unico 'audio-inicio',
// depois os chunks PCM de TODAS as sentencas em ordem, e um unico 'audio-fim'.
// Mandar cada sentenca como uma fala separada (enviarAudioParaConexao) NAO serve:
// cada 'audio-inicio' reseta o buffer do robo e cancela o envio anterior, cortando
// a sentenca em curso. Por isso aqui mantemos UMA sessao de fala por conexao
// (ws.falaStream) com uma fila que cresce enquanto novas sentencas chegam; um
// unico consumidor drena essa fila aplicando o MESMO controle de fluxo do envio
// normal (burst inicial + regulacao pelo nivel de buffer reportado pelo robo).
//
// O firmware nao precisa de mudanca: ele ja toca todo chunk binario que chega
// entre 'audio-inicio' e 'audio-fim' conforme chega (o 'tamanho' do cabecalho e
// so informativo - vai 0 aqui, pois no streaming nao sabemos o total de antemao).

// Envia um lote (= uma sentenca) de chunks da fila com pacing/controle de fluxo.
// CHAVE PARA A FLUIDEZ NAS JUNCOES: o pacing nao depende mais de um "burst so no
// inicio da fala". Em vez disso, sempre que o buffer estimado do robo esta ABAIXO
// do alvo, mandamos em RAJADA (sem espera) ate reabastecer - e isso vale em
// qualquer ponto, inclusive no comeco de cada nova sentenca. Sem isso, entre uma
// sentenca e a proxima (enquanto o TTS da proxima ainda nao ficou pronto) o buffer
// secava e o audio "travava/desacelerava" na junção (o gap "DMA secou"). Agora,
// ao receber a proxima sentenca, despejamos chunks a jato ate o colchao voltar ao
// alvo, e so entao voltamos ao ritmo de cruzeiro. Resultado: fala continua, sem as
// pausas entre frases. Retorna quando o lote acaba (a fala pode ter mais sentencas).
async function enviarLoteComPacing(ws, buffer, sessao) {
  const tamanho = config.ESP_AUDIO_CHUNK_BYTES
  const alvoMs = config.ESP_AUDIO_BUFFER_ALVO_MS
  const tetoMs = config.ESP_AUDIO_BUFFER_TETO_MS
  const msPorChunk = (tamanho / config.ESP_AUDIO_BYTES_POR_MS)
  const pacingMin = config.ESP_AUDIO_PACING_MIN_MS
  const pacingMax = config.ESP_AUDIO_PACING_MAX_MS
  const token = sessao.token

  const nivelEstimado = () => {
    if (typeof ws.nivelBufferMs !== 'number' || !ws.nivelBufferEm) return 0
    const decorrido = Date.now() - ws.nivelBufferEm
    return Math.max(0, ws.nivelBufferMs - decorrido)
  }

  for (let offset = 0; offset < buffer.length; offset += tamanho) {
    if (token.cancelado || ws.readyState !== ws.OPEN) return false
    // Backpressure do socket: segura se a fila de transmissao TCP encheu (rede
    // degradando). Evita que o ramo "abaixo do alvo" (pacingMin) despeje chunks
    // num socket ja congestionado - a causa raiz da queda "na fala".
    if (!(await aguardarSocketDrenar(ws, token))) return false
    try {
      ws.send(buffer.subarray(offset, offset + tamanho), { binary: true })
    } catch (err) {
      log('Aviso', `Falha ao enviar chunk de audio (stream): ${err.message}`)
      return false
    }
    sessao.chunksEnviados++

    // Burst de partida da FALA: os primeiros chunks vao sem espera (enche o colchao
    // inicial de largada, mata o engasgo de inicio).
    if (sessao.chunksEnviados <= config.ESP_AUDIO_BURST_CHUNKS) continue

    const nivel = nivelEstimado() + msPorChunk
    if (nivel < alvoMs) {
      // Buffer ABAIXO do alvo (secando - tipico nas juncoes entre frases): manda a
      // jato para reabastecer. Pausa minima so para nao monopolizar o socket.
      await esperar(pacingMin)
    } else if (nivel >= tetoMs) {
      // Cheio (teto): segura ate drenar perto do alvo (nao estoura a fila do firmware).
      await esperar(Math.min(pacingMax, Math.max(msPorChunk, nivel - alvoMs)))
    } else {
      // Faixa-alvo: anda um pouco mais rapido que o consumo, mantendo folga positiva.
      await esperar(Math.max(pacingMin, Math.round(msPorChunk * 0.6)))
    }
  }
  return !token.cancelado
}

// Duracao (ms) de um buffer PCM da saida (24kHz 16-bit mono): bytes / 48.
function duracaoBufferMs(buffer) {
  return buffer.length / config.ESP_AUDIO_BYTES_POR_MS
}

// PRELOAD DE LARGADA: segura o INICIO da fala ate juntar um colchao inicial robusto
// (ESP_AUDIO_PRELOAD_MIN_MS de audio) e ai despeja tudo de uma vez. Por que: a 1a
// frase comeca a tocar assim que o 1o chunk chega no robo; se ela for CURTA (toca
// rapido) e a 2a ainda estiver sintetizando no TTS (~500-700ms), o buffer secava
// na juncao (os gaps de ~96-149ms). Acumulando ~700ms antes de largar, o robo ja
// comeca com folga suficiente para cobrir a sintese da proxima frase.
//
// Espera ATIVA pela fila crescer: a cada sentenca que o pipeline enfileira, somamos
// sua duracao; quando o acumulado atinge o alvo de preload, paramos de segurar. Se
// a fala TODA for curta e finalizar antes de atingir o alvo (ex: resposta de uma
// frase so), tambem largamos - nao ha mais audio para esperar. Os buffers coletados
// sao concatenados num unico lote e enviados em rajada (enviarLoteComPacing + o
// BURST_CHUNKS leva os primeiros chunks sem espera). Retorna false se cancelado.
async function preloadLargada(ws, sessao) {
  const alvoPreloadMs = config.ESP_AUDIO_PRELOAD_MIN_MS
  // Preload desligado (0) ou alvo trivial: nada a segurar.
  if (!(alvoPreloadMs > 0)) return true

  const lotes = []
  let acumuladoMs = 0
  while (acumuladoMs < alvoPreloadMs) {
    if (sessao.token.cancelado || ws.readyState !== ws.OPEN) return false
    const buffer = sessao.fila.shift()
    if (buffer) {
      lotes.push(buffer)
      acumuladoMs += duracaoBufferMs(buffer)
      continue
    }
    // Fila vazia: se a fala ja acabou, larga com o que tem (fala curta). Senao,
    // aguarda a proxima sentenca chegar (o gargalo aqui e o TTS, nao a rede).
    if (sessao.finalizada) break
    await esperar(config.ESP_AUDIO_PACING_MIN_MS)
  }

  if (lotes.length === 0) return true   // nada coletado (ex: fala vazia)

  // Despeja o colchao inteiro de uma vez. enviarLoteComPacing conta os chunks na
  // sessao, entao o BURST_CHUNKS (rajada de partida) se aplica a este 1o lote.
  const colchao = lotes.length === 1 ? lotes[0] : Buffer.concat(lotes)
  log('ESP', `Preload de largada: ${Math.round(acumuladoMs)}ms (${lotes.length} sentenca(s)) antes de iniciar a fala`)
  return await enviarLoteComPacing(ws, colchao, sessao)
}

// Consumidor da fila de fala: faz o PRELOAD de largada (colchao inicial) e depois
// drena os buffers pendentes na ordem; quando a fila esvazia mas a fala ainda nao
// foi finalizada, espera por mais sentencas. Ao terminar (fila vazia + finalizada),
// envia 'audio-fim'. Um por sessao de fala.
async function bombearFalaStream(ws, sessao) {
  const token = sessao.token
  try {
    // Largada: segura ate ter colchao robusto, ai despeja em rajada (mata a secada
    // de buffer quando a 1a frase e curta e a 2a ainda esta sintetizando).
    const preloadOk = await preloadLargada(ws, sessao)
    if (!preloadOk) return

    while (true) {
      if (token.cancelado || ws.readyState !== ws.OPEN) return
      const buffer = sessao.fila.shift()
      if (buffer) {
        const ok = await enviarLoteComPacing(ws, buffer, sessao)
        if (!ok) return
        continue
      }
      // Fila vazia: se a fala acabou, encerra; senao, aguarda a proxima sentenca.
      if (sessao.finalizada) break
      await esperar(config.ESP_AUDIO_PACING_MIN_MS)
    }
    if (!token.cancelado && ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ tipo: 'audio-fim' })) } catch { /* socket fechou */ }
    }
    // Diagnostico: se o socket chegou a congestionar (pico > teto), registra. Em rede
    // saudavel o pico fica ~0; picos altos apontam o jitter que ameacava a conexao.
    // Inclui o heap minimo reportado na fala (pressao de memoria no firmware).
    if (ws.picoBufferedAmount > config.ESP_AUDIO_SOCKET_BACKLOG_MAX_BYTES) {
      const heapInfo = ws.heapMinFala != null ? `, heap min ${ws.heapMinFala}B` : ''
      log('ESP', `Backpressure na fala de ${ws.metadata?.id || 'esp'}: pico de socket ${ws.picoBufferedAmount} bytes (segurou o envio)${heapInfo}`)
    }
  } catch (err) {
    log('Aviso', `Bombeamento de fala (stream) interrompido: ${err.message}`)
  } finally {
    if (ws.falaStream === sessao) ws.falaStream = null
  }
}

// Inicia uma fala em streaming nesta conexao: envia 'audio-inicio' e arma o
// consumidor. Cancela qualquer fala/envio anterior (token unico em ws.envioAtual,
// compartilhado com o caminho nao-stream para que interromper()/pararAudioRobo()
// cancelem os dois). Retorna a sessao (ou null se a conexao nao esta apta).
function iniciarFalaStreamConexao(ws, metadata = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return null

  if (ws.envioAtual) ws.envioAtual.cancelado = true
  const token = { cancelado: false }
  ws.envioAtual = token

  // Robo zera a fila ao receber 'audio-inicio': comecamos assumindo buffer vazio.
  ws.nivelBufferMs = 0
  ws.nivelBufferEm = Date.now()
  ws.picoBufferedAmount = 0   // diagnostico de backpressure: pico por fala
  ws.heapMinFala = null       // diagnostico: heap minimo do firmware nesta fala



  try {
    ws.send(JSON.stringify({
      tipo: 'audio-inicio',
      payload: {
        tamanho: 0,   // streaming: total desconhecido de antemao (campo so informativo)
        formato: config.ESP_AUDIO_FORMATO,
        sampleRate: config.ESP_AUDIO_PCM_SAMPLE_RATE,
        ...metadata,
      },
    }))
  } catch (err) {
    log('Aviso', `Falha ao enviar cabecalho de audio (stream): ${err.message}`)
    return null
  }

  const sessao = { token, fila: [], finalizada: false, chunksEnviados: 0 }
  ws.falaStream = sessao
  bombearFalaStream(ws, sessao)   // roda solto
  return sessao
}

// Enfileira o PCM de uma sentenca na fala em andamento. Ignora se a sessao mudou
// (interrupcao/nova fala) ou ja foi finalizada.
function enfileirarPcmFalaConexao(ws, sessao, pcmBuffer) {
  if (!sessao || ws.falaStream !== sessao || sessao.finalizada) return false
  if (sessao.token.cancelado) return false
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) return false
  sessao.fila.push(pcmBuffer)
  return true
}

// Marca a fala como completa: quando a fila esvaziar, o consumidor envia 'audio-fim'.
function finalizarFalaStreamConexao(_ws, sessao) {
  if (sessao) sessao.finalizada = true
}

// Versoes "broadcast" (no MVP ha 1 robo). Iniciam/alimentam/finalizam a fala em
// TODAS as conexoes de controle, devolvendo um mapa ws->sessao para o pipeline
// alimentar cada uma. O pipeline do robo usa estas.
function iniciarFalaStreamRobo(metadata = {}) {
  const sessoes = new Map()
  for (const ws of conexoesControle.values()) {
    const s = iniciarFalaStreamConexao(ws, metadata)
    if (s) sessoes.set(ws, s)
  }
  return sessoes
}

function enfileirarPcmFalaRobo(sessoes, pcmBuffer) {
  if (!sessoes || sessoes.size === 0) return 0
  let n = 0
  for (const [ws, sessao] of sessoes) {
    if (enfileirarPcmFalaConexao(ws, sessao, pcmBuffer)) n++
  }
  return n
}

function finalizarFalaStreamRobo(sessoes) {
  if (!sessoes) return
  for (const [ws, sessao] of sessoes) finalizarFalaStreamConexao(ws, sessao)
}

// Envia um comando JSON para UMA conexao especifica (nao broadcast).
function enviarComandoParaConexao(ws, comando, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return false
  try {
    ws.send(JSON.stringify({ tipo: comando, payload }))
    return true
  } catch (err) {
    log('Aviso', `Falha ao enviar comando "${comando}" para conexao ESP: ${err.message}`)
    return false
  }
}

// Corta a fala do robo NESTA conexao AGORA: cancela o envio de chunks ainda
// pendente e manda 'parar-audio' para o firmware zerar o I2S na hora.
function pararAudioRobo(ws) {
  const tinhaEnvio = ws.envioAtual && !ws.envioAtual.cancelado
  if (ws.envioAtual) ws.envioAtual.cancelado = true
  // Encerra tambem a fala em streaming (se houver): o token cancelado ja faz o
  // consumidor parar; aqui descartamos a fila e soltamos a referencia para nao
  // vazar nem deixar um 'audio-fim' tardio escapar de uma fala ja cortada.
  if (ws.falaStream) {
    ws.falaStream.finalizada = true
    ws.falaStream.fila = []
    ws.falaStream = null
  }
  const ok = enviarComandoParaConexao(ws, 'parar-audio')
  if (ok) log('ESP', `parar-audio enviado para ${ws.metadata?.id || 'esp'}${tinhaEnvio ? ' (envio em curso cancelado)' : ''}`)
  return ok
}

function enviarComando(comando, payload = {}) {
  if (conexoesControle.size === 0) return 0
  return enviarParaTodos(conexoesControle, JSON.stringify({ tipo: comando, payload }))
}

// --- Controle do robo pela interface (painel de controle) ---

// Define qual perfil/usuario o robo passa a usar, em tempo real. Aplica a TODAS
// as conexoes de controle (no MVP ha 1 robo) e guarda como ativo para reaplicar
// em futuras reconexoes. NAO habilita o robo (isso e explicito via toggle).
function definirUsuarioAtivo(usuarioId) {
  usuarioAtivoRobo = usuarioId
  let aplicados = 0
  for (const ws of conexoesControle.values()) {
    configurarUsuario(ws.idConexao, usuarioId)
    aplicados++
  }
  // Cada crianca tem o SEU rosto: trocar de perfil troca a cara do robo na hora. E o
  // que faz o rosto customizado valer a pena numa casa com mais de um filho - senao o
  // desenho de um viraria o robo do outro.
  enviarRostoParaEsp()
  broadcastEstado()
  return aplicados
}

// Liga/desliga o GATE do robo. Quando false, o servidor descarta todo o audio do
// mic do robo (robo mudo). A interface liga (toggle "Controlar robo") dentro de um
// perfil e desliga ao sair do perfil. Ao desligar, corta qualquer fala em curso.
function definirRoboHabilitado(valor) {
  const anterior = roboHabilitado
  roboHabilitado = !!valor
  if (!roboHabilitado) {
    for (const ws of conexoesControle.values()) pararAudioRobo(ws)
  }
  // Entrar/sair do modo robo e o "oi"/"tchau" da sessao. So na MUDANCA: a interface
  // reenvia o estado ao trocar de perfil e o robo nao deve piscar o rosto a toa.
  if (roboHabilitado !== anterior) atividade.emitirReacao(roboHabilitado ? 'ola' : 'tchau')
  broadcastEstado()
  return roboHabilitado
}

// Muta/desmuta o mic do robo (servidor descarta o audio recebido). Ao MUTAR no
// meio de uma fala, forca o fim-de-fala (intencao "terminei, pode pensar"),
// espelhando o comportamento do mic do navegador.
function definirMicMutado(valor) {
  const anterior = micRoboMutado
  micRoboMutado = !!valor
  if (micRoboMutado) {
    for (const ws of conexoesControle.values()) {
      forcarFimDeFala(ws.idConexao, ws.callbacks)
    }
  }
  // Feedback nos olhos (icone de mic riscado/com ondas). Este e o ponto UNICO por
  // onde passam o botao web (POST /api/esp/mic) e o botao fisico (tratarBotaoFisico),
  // entao a animacao sai igual nos dois. So na MUDANCA, para nao repetir a cada
  // sincronizacao de estado da interface.
  if (micRoboMutado !== anterior) atividade.emitirReacao(micRoboMutado ? 'mic-off' : 'mic-on')
  broadcastEstado()
  enviarExpressaoParaEsp()   // reflete o mute nos olhos do robo na hora
  return micRoboMutado
}

// Interrompe o robo (botao "Parar" / Reset da interface): CORTA a fala fisica
// na hora (cancela envio + parar-audio) e encerra a janela de fala/captura no
// pipeline, em todas as conexoes de controle.
// `comFeedback=false` para quem ja vai mostrar a propria animacao logo em seguida
// (o reset interrompe ANTES de limpar o contexto - sem isso o rosto piscaria "pausa"
// e trocaria pra "recomecar" no mesmo segundo).
function interromperRobo(comFeedback = true) {
  let total = 0
  for (const ws of conexoesControle.values()) {
    pararAudioRobo(ws)                 // cala o alto-falante do robo agora
    if (interromper(ws.idConexao)) total++   // aborta pipeline/captura
  }
  if (comFeedback) atividade.emitirReacao('parar')
  return total
}

// Feedback do "limpar contexto". Fica aqui (e nao dentro de limparConversa, no brain)
// porque a conversa e limpavel por qualquer perfil da interface: o robo so deve
// reagir quando quem foi resetado e o perfil que ELE esta usando agora.
function reagirResetConversa(usuarioId) {
  if (usuarioId && usuarioId !== usuarioAtivoRobo) return false
  atividade.emitirReacao('reset')
  return true
}

// Feedback da webcam (que vive no NAVEGADOR - o servidor nao tem como saber sozinho
// se ela ligou). O dashboard avisa por POST /api/esp/camera, tanto no clique do botao
// da interface quanto quando o botao FISICO manda ele alternar a camera.
// Fatia o dia em quatro periodos. Usa a hora LOCAL do servidor de proposito: o robo
// fica na mesma casa que a crianca, entao a hora da maquina e a hora dela.
function periodoDoDia() {
  const h = new Date().getHours()
  if (h < 6)  return 'madrugada'
  if (h < 12) return 'manha'
  if (h < 18) return 'tarde'
  return 'noite'
}

function reagirCamera(ativa) {
  cameraLigada = !!ativa
  atividade.emitirReacao(ativa ? 'camera-on' : 'camera-off')
  // O robo precisa saber que a camera esta no ar, e nao so ver o icone passar: e isso
  // que permite a ele se sentir IGNORADO (camera ligada + nenhum rosto a vista por um
  // bom tempo) sem confundir isso com "a camera simplesmente esta desligada".
  enviarExpressaoParaEsp()
  return cameraLigada
}

// Envia ao robo a expressao atual (estado da conversa + mute + camera) para os OLHOS
// da tela OLED reagirem. Se `ws` for informado, manda so para aquela conexao (ex.: logo
// apos o robo conectar, para sincronizar o rosto); sem `ws`, faz broadcast para todas.
function enviarExpressaoParaEsp(ws = null) {
  const payload = {
    estado: ultimoEstadoConversa,
    mutado: micRoboMutado,
    camera: cameraLigada,
    // Periodo do dia. O ESP nao tem relogio de parede (nao usamos NTP), entao quem
    // sabe a hora e o servidor. Serve para o robo ficar naturalmente mais sonolento a
    // noite - um detalhe pequeno que faz muita diferenca na sensacao de que ele vive
    // no mesmo mundo que a crianca, em vez de ser sempre o mesmo o dia inteiro.
    periodo: periodoDoDia(),
  }
  if (ws) return enviarComandoParaConexao(ws, 'expressao', payload)
  return enviarComando('expressao', payload)
}

// Geometria PADRAO dos olhos: os mesmos numeros de fabrica da RoboEyes. Um perfil sem
// rosto salvo cai aqui, e o robo fica com a cara original.
const ROSTO_PADRAO = { largura: 36, altura: 36, raio: 8, espaco: 10, sobrancelhas: false }

// Envia ao robo a geometria dos olhos que a crianca desenhou no Companion. Fica no
// perfil (campo `rostoRobo`), que ja e hidratado do Supabase pelo caminho normal de
// perfil - entao nao ha nada de especial a sincronizar aqui.
//
// A validacao de faixa NAO e feita aqui de proposito: quem garante que o valor cabe na
// tela e o firmware, que e quem conhece a tela. Aqui so garantimos que sao numeros.
function enviarRostoParaEsp(ws = null) {
  let rosto = ROSTO_PADRAO
  try {
    const usuario = carregarUsuario(usuarioAtivoRobo)
    if (usuario?.rostoRobo && typeof usuario.rostoRobo === 'object') {
      rosto = { ...ROSTO_PADRAO, ...usuario.rostoRobo }
    }
  } catch {
    // Perfil ilegivel nao pode impedir o robo de ter rosto: segue com o padrao.
  }
  const payload = {
    largura: Number(rosto.largura) || ROSTO_PADRAO.largura,
    altura: Number(rosto.altura) || ROSTO_PADRAO.altura,
    raio: Number.isFinite(Number(rosto.raio)) ? Number(rosto.raio) : ROSTO_PADRAO.raio,
    espaco: Number.isFinite(Number(rosto.espaco)) ? Number(rosto.espaco) : ROSTO_PADRAO.espaco,
    sobrancelhas: rosto.sobrancelhas === true,
  }
  if (ws) return enviarComandoParaConexao(ws, 'rosto', payload)
  return enviarComando('rosto', payload)
}

// Envia uma REACAO pontual (emocao) ao robo para os olhos animarem por alguns
// segundos. Broadcast para todas as conexoes de controle (no MVP ha 1 robo). O
// firmware mapeia a emocao no enum Reacao e sobrepoe a animacao ao rosto de estado.
function enviarReacaoParaEsp(emocao) {
  if (!emocao) return 0
  return enviarComando('reacao', { emocao })
}

function registrarOuvinteEstado(callback) {
  ouvintesEstado.add(callback)
  return () => ouvintesEstado.delete(callback)
}

module.exports = {
  configurarServidoresWebSocket,
  obterEstado,
  enviarAudioParaRobo,
  iniciarFalaStreamRobo,
  enfileirarPcmFalaRobo,
  finalizarFalaStreamRobo,
  enviarComando,
  registrarOuvinteEstado,
  definirUsuarioAtivo,
  definirMicMutado,
  definirRoboHabilitado,
  interromperRobo,
  reagirResetConversa,
  reagirCamera,
  enviarRostoParaEsp,
  ROSTO_PADRAO,
}
