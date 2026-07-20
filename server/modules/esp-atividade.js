const { log } = require('./logger')

// Canal de "atividade do robo" para a INTERFACE principal (localhost), separado
// do monitor.js. Diferenca essencial: aqui trafega SO texto e estado (transcricao
// da crianca, resposta da Cogni, e o estado ouvindo/pensando/falando/idle). NAO
// trafega o audio PCM em base64 - o audio toca no proprio robo, entao mandar os
// centenas de KB para a interface seria desperdicio. O monitor.js (debug) continua
// recebendo o audio para quem quer ouvir no PC; este canal e so para o painel de
// controle do robo refletir o que esta acontecendo em tempo real.
//
// Mesma mecanica de SSE dos outros canais: ouvintes registram um callback e
// recebem cada evento. A rota /api/esp/atividade/stream (routes/esp.js) e quem
// expoe isso via Server-Sent Events para o navegador.

const ouvintes = new Set()

// Guarda o ultimo estado emitido para nao floodar a interface com eventos
// repetidos (o pipeline pode chamar emitirEstado varias vezes seguidas com o
// mesmo valor). So propaga quando o estado realmente muda.
let ultimoEstado = null

function registrarOuvinte(callback) {
  ouvintes.add(callback)
  return () => ouvintes.delete(callback)
}

function emitir(evento) {
  if (ouvintes.size === 0) return
  for (const ouvinte of ouvintes) {
    try {
      ouvinte(evento)
    } catch (err) {
      log('Aviso', `Falha ao notificar ouvinte de atividade: ${err.message}`)
    }
  }
}

// Estado de alto nivel do robo na conversa. A interface mapeia direto para os
// mesmos estados visuais do avatar (ouvindo/pensando/pesquisando/falando/idle).
function emitirEstado(estado) {
  if (estado === ultimoEstado) return
  ultimoEstado = estado
  emitir({ tipo: 'estado', estado, em: Date.now() })
}

// O que a crianca falou (resultado do STT). Vira a legenda "Voce" na interface.
function emitirTranscricao(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return
  emitir({ tipo: 'transcricao', texto, em: Date.now() })
}

// O que a Cogni respondeu (texto). Vira a legenda "Cogni" na interface.
function emitirResposta(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return
  emitir({ tipo: 'resposta', texto, em: Date.now() })
}

// Reacao PONTUAL dos olhos, disparada pelo CONTEUDO da conversa (elogio -> coracoes,
// piada -> riso, etc.). Diferente do estado CONTINUO acima, e um evento efemero: o
// esp.js repassa ao robo (mensagem "reacao") e a tela anima por alguns segundos. Sem
// dedup (cada reacao e um disparo unico). emocao vem de detectarReacao (esp-reacoes).
function emitirReacao(emocao) {
  if (typeof emocao !== 'string' || !emocao) return
  emitir({ tipo: 'reacao', emocao, em: Date.now() })
}

// Comando pontual para a INTERFACE. Usado quando um botao FISICO do robo pede uma
// acao que so o navegador consegue executar - hoje, ligar/desligar a webcam do PC
// (a camera vive no browser). Vai pelo mesmo SSE de atividade; o cliente reage em
// tratarAtividadeRobo (client/app.js).
function emitirComando(acao) {
  if (typeof acao !== 'string' || !acao) return
  emitir({ tipo: 'comando', acao, em: Date.now() })
}

module.exports = {
  registrarOuvinte,
  emitirEstado,
  emitirTranscricao,
  emitirResposta,
  emitirReacao,
  emitirComando,
}
