// A "ALMA" DA RESPOSTA VISUAL: traduz o que a webcam viu na crianca (emocao facial ou
// gesto de mao) na reacao que o robo faz com os olhos. Fica no SERVIDOR de proposito -
// o cliente so PERCEBE ("crianca-triste"); a decisao de como o robo responde e uma
// escolha de produto (espelhar? animar?) que deve poder mudar sem regravar o firmware,
// exatamente como a heuristica de conteudo (detectarReacao, em esp-reacoes.js) ja mora aqui.
//
// POLITICA para emocao NEGATIVA ("espelha 1s, depois anima"): quando a crianca esta
// triste ou brava, o robo reconhece a emocao por um instante (validacao emocional - ele
// "viu" que ela nao esta bem) e logo em seguida puxa pra cima, tentando animar. Robo de
// reforco escolar nao deve afundar junto com a crianca; mas ignorar o que ela sente
// tambem nao cria vinculo. O reconhecer-e-animar e o meio-termo.
//
// As emocoes finais sao os nomes canonicos que o firmware ja entende (enum Reacao no
// esp32-controle.ino) - reusamos o MESMO canal das reacoes de conteudo (emitirReacao ->
// esp.js repassa como "reacao" ao ESP). A unica reacao nova e 'preocupado' (empatia).

const { emitirReacao } = require('./esp-atividade')
const { log } = require('./logger')

// Cada percepcao vira uma SEQUENCIA de passos. `atrasoMs` ausente = agora; com atraso =
// agendado (e a fase "depois anima"). A duracao do passo em si e do firmware (cada reacao
// tem seu tempo de tela); aqui so decidimos o QUE e QUANDO disparar.
const MAPA = {
  // Emocao facial (com INTENSIDADE: um sorriso largo faz o robo rir mais forte) --------
  'crianca-feliz':          [{ emocao: 'riso' }],       // ri junto
  'crianca-muito-feliz':    [{ emocao: 'celebra' }],    // gargalhada: comemora
  'crianca-surpresa':       [{ emocao: 'surpresa' }],   // espelha o espanto
  'crianca-muito-surpresa': [{ emocao: 'susto' }],      // boca de choque: leva um susto junto
  'crianca-triste':   [{ emocao: 'preocupado' }, { emocao: 'amor', atrasoMs: 1200 }],   // empatia -> carinho
  'crianca-brava':    [{ emocao: 'surpresa' }, { emocao: 'piscadela', atrasoMs: 1200 }], // "opa" -> acalma
  // Presenca social ----------------------------------------------------------------
  'chegou-alguem':    [{ emocao: 'interessado' }],   // repara na visita, curioso
  // Gestos de mao ------------------------------------------------------------------
  'gesto-joinha':     [{ emocao: 'celebra' }],   // 👍
  'gesto-amor':       [{ emocao: 'amor' }],      // 🤟 coracoes
  'gesto-vitoria':    [{ emocao: 'celebra' }],   // ✌️
  'gesto-tchau':      [{ emocao: 'ola' }],       // ✋ acena de volta
  'gesto-aponta':     [{ emocao: 'ideia' }],     // ☝️ "ideia!"
  'gesto-forca':      [{ emocao: 'celebra' }],   // ✊ forca!
  'gesto-negativo':   [{ emocao: 'suor' }],      // 👎 ops
}

// Cooldown de SERVIDOR por percepcao (2a camada - o cliente ja filtra com histerese e
// cooldown proprio). Blinda contra um cliente antigo/bugado que mande em rajada e evita
// que o rosto do robo fique preso trocando de reacao.
const COOLDOWN_MS = 4000
const ultimoPorPercepcao = new Map()

/**
 * Devolve a sequencia de reacoes de uma percepcao (ou null se desconhecida).
 * Exportada para inspecao/teste - reagirPercepcao e quem de fato dispara.
 */
function mapearPercepcao(percepcao) {
  return MAPA[percepcao] || null
}

/**
 * Dispara a reacao do robo para uma percepcao vinda da webcam. Aplica o cooldown de
 * servidor e agenda os passos com atraso (a fase "depois anima"). Retorna true se reagiu.
 */
function reagirPercepcao(percepcao) {
  const seq = mapearPercepcao(percepcao)
  if (!seq) return false   // percepcao desconhecida: ignora em silencio (seguro por padrao)

  const agora = Date.now()
  if (agora - (ultimoPorPercepcao.get(percepcao) || 0) < COOLDOWN_MS) return false
  ultimoPorPercepcao.set(percepcao, agora)

  for (const passo of seq) {
    if (passo.atrasoMs) setTimeout(() => emitirReacao(passo.emocao), passo.atrasoMs)
    else emitirReacao(passo.emocao)
  }
  log('ESP', `Visao: "${percepcao}" -> ${seq.map((p) => p.emocao).join(' + ')}`)
  return true
}

module.exports = { mapearPercepcao, reagirPercepcao }
