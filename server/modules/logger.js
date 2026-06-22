const CORES = {
  reset: '\x1b[0m',
  cinza: '\x1b[90m',
  vermelho: '\x1b[31m',
  verde: '\x1b[32m',
  amarelo: '\x1b[33m',
  azul: '\x1b[34m',
  magenta: '\x1b[35m',
  ciano: '\x1b[36m',
  branco: '\x1b[37m',
  vermelhoBold: '\x1b[1;31m',
}

const CORES_CATEGORIA = {
  Servidor: CORES.ciano,
  Pipeline: CORES.azul,
  STT: CORES.verde,
  IA: CORES.magenta,
  TTS: CORES.amarelo,
  SSE: CORES.cinza,
  Visao: CORES.magenta,
  Reset: CORES.azul,
  Seguranca: CORES.vermelho,
  WebSearch: CORES.ciano,
  Triagem: CORES.cinza,
  Memoria: CORES.amarelo,
  ESP: CORES.verde,
  WebSocket: CORES.ciano,
  Erro: CORES.vermelhoBold,
  Aviso: CORES.amarelo,
}

const TTY = process.stdout.isTTY

function pintar(texto, cor) {
  if (!TTY || !cor) return texto
  return `${cor}${texto}${CORES.reset}`
}

function timestamp() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false })
}

function formatar(categoria, mensagem) {
  const cor = CORES_CATEGORIA[categoria] || CORES.cinza
  const tag = pintar(`[Cogni][${categoria}]`, cor)
  const ts = pintar(timestamp(), CORES.cinza)
  return `${tag} ${ts} ${mensagem}`
}

function log(categoria, mensagem, ...extras) {
  const stream = categoria === 'Erro' ? console.error : categoria === 'Aviso' ? console.warn : console.log
  stream(formatar(categoria, mensagem), ...extras)
}

function criarLogger(categoriaPadrao) {
  return (mensagem, ...extras) => log(categoriaPadrao, mensagem, ...extras)
}

module.exports = { log, criarLogger }
