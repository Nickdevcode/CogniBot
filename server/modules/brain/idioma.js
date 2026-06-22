const ASSINATURAS = {
  pt: {
    palavras: new Set([
      'que', 'não', 'nao', 'sim', 'é', 'eu', 'voce', 'você', 'com', 'uma', 'isso',
      'pra', 'para', 'tudo', 'também', 'tambem', 'agora', 'depois', 'muito', 'mas',
      'mais', 'são', 'sao', 'foi', 'tem', 'ter', 'estou', 'estava', 'meu', 'minha',
      'esse', 'essa', 'isto', 'aquilo', 'tá', 'ta', 'tô', 'to', 'né', 'ne',
      'porque', 'quando', 'como', 'onde', 'então', 'entao', 'aqui', 'ali', 'lá',
      'fazer', 'falar', 'gente', 'cara', 'coisa', 'bem', 'vai', 'vou', 'sei',
      'me', 'te', 'se', 'nos', 'dos', 'das', 'do', 'da', 'no', 'na', 'pelo', 'pela',
      'um', 'uns', 'umas', 'ele', 'ela', 'eles', 'elas', 'aos', 'às', 'pelos', 'pelas',
      'favor', 'obrigado', 'obrigada', 'oi', 'olá', 'ola', 'tchau', 'beleza',
      'ensina', 'aprende', 'estuda', 'sobre', 'até', 'ate', 'já', 'ja',
      'inglês', 'ingles', 'português', 'portugues', 'espanhol', 'francês', 'frances',
    ]),
    diacriticos: /[ãõçáéíóúâêôà]/i,
    bigramas: ['nh', 'lh', 'ão', 'õe', 'ç'],
    nome: 'português',
    codigo: 'pt',
  },
  en: {
    palavras: new Set([
      'the', 'and', 'i', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may',
      'you', 'your', 'we', 'they', 'them', 'their', 'me', 'my', 'mine', 'our',
      'what', 'when', 'where', 'why', 'how', 'which', 'who', 'whose',
      'but', 'or', 'so', 'because', 'if', 'about', 'just', 'like', 'really',
      'good', 'right', 'yeah', 'no', 'yes', 'okay', 'gonna', 'wanna', 'gotta',
    ]),
    diacriticos: null,
    bigramas: ['th', 'wh', 'ing', 'tion', 'sh '],
    nome: 'inglês',
    codigo: 'en',
  },
  es: {
    palavras: new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero',
      'que', 'qué', 'cómo', 'como', 'cuando', 'cuándo', 'donde', 'dónde', 'por',
      'para', 'con', 'sin', 'sobre', 'es', 'son', 'está', 'están', 'estoy',
      'soy', 'eres', 'eres', 'tengo', 'tienes', 'tiene', 'tenemos', 'hay',
      'yo', 'tú', 'él', 'ella', 'nosotros', 'vosotros', 'ellos', 'ellas',
      'me', 'te', 'se', 'le', 'lo', 'nos', 'os', 'les', 'muy', 'más', 'mas',
      'pues', 'entonces', 'también', 'tambien', 'porque', 'aquí', 'allí',
      'hola', 'gracias', 'adiós', 'amigo', 'amiga', 'sí',
    ]),
    diacriticos: /[ñáéíóúü¿¡]/i,
    bigramas: ['ll', 'rr', 'ñ', 'ción'],
    nome: 'espanhol',
    codigo: 'es',
  },
  fr: {
    palavras: new Set([
      'le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'mais', 'donc', 'car',
      'que', 'qui', 'quoi', 'où', 'quand', 'comment', 'pourquoi', 'avec', 'sans',
      'pour', 'par', 'sur', 'sous', 'dans', 'est', 'sont', 'était', 'sera',
      'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'me', 'te', 'se',
      'mon', 'ton', 'son', 'ma', 'ta', 'sa', 'mes', 'tes', 'ses', 'notre', 'votre',
      'bonjour', 'merci', 'oui', 'non', 'très', 'bien', 'aussi', 'alors',
    ]),
    diacriticos: /[éèêëàâîïôûùçœæ]/i,
    bigramas: ['eau', 'oui', 'ç', 'œ', 'qu '],
    nome: 'francês',
    codigo: 'fr',
  },
  it: {
    palavras: new Set([
      'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'e', 'o', 'ma',
      'che', 'chi', 'cosa', 'come', 'quando', 'dove', 'perché', 'perche', 'con',
      'per', 'da', 'di', 'in', 'su', 'è', 'sono', 'sei', 'siamo', 'siete',
      'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mi', 'ti', 'si', 'ci', 'vi',
      'molto', 'anche', 'allora', 'ciao', 'grazie', 'prego', 'bene', 'più', 'piu',
    ]),
    diacriticos: /[àèéìíîòóùúü]/i,
    bigramas: ['gli', 'gn', 'sci', 'zz'],
    nome: 'italiano',
    codigo: 'it',
  },
}

function tokenizar(texto) {
  if (!texto || typeof texto !== 'string') return []
  return texto
    .toLowerCase()
    .normalize('NFC')
    .match(/[a-záéíóúâêôãõàçñüäöß'']+/gi) || []
}

function pontuarIdioma(texto, assinatura) {
  const tokens = tokenizar(texto)
  if (tokens.length === 0) return 0

  let acertosPalavras = 0
  for (const t of tokens) {
    if (assinatura.palavras.has(t)) acertosPalavras++
  }

  let bonusDiacriticos = 0
  if (assinatura.diacriticos && assinatura.diacriticos.test(texto)) {
    bonusDiacriticos = 0.15
  }

  let bonusBigramas = 0
  const textoLower = texto.toLowerCase()
  for (const bi of assinatura.bigramas) {
    if (textoLower.includes(bi)) bonusBigramas += 0.03
  }
  bonusBigramas = Math.min(bonusBigramas, 0.18)

  const proporcao = acertosPalavras / tokens.length
  return Math.min(1, proporcao + bonusDiacriticos + bonusBigramas)
}

function detectarIdioma(texto) {
  if (!texto || texto.trim().length < 2) {
    return { idioma: null, confianca: 0, scores: {} }
  }

  const scores = {}
  let melhor = null
  let segundoMelhor = 0

  for (const codigo of Object.keys(ASSINATURAS)) {
    const s = pontuarIdioma(texto, ASSINATURAS[codigo])
    scores[codigo] = s
    if (!melhor || s > scores[melhor.codigo]) {
      if (melhor) segundoMelhor = scores[melhor.codigo]
      melhor = { codigo, score: s }
    } else if (s > segundoMelhor) {
      segundoMelhor = s
    }
  }

  if (!melhor || melhor.score < 0.08) {
    return { idioma: null, confianca: 0, scores }
  }

  const margem = melhor.score - segundoMelhor
  const confianca = Math.min(1, melhor.score * 0.7 + margem * 1.5)

  return {
    idioma: melhor.codigo,
    nome: ASSINATURAS[melhor.codigo].nome,
    confianca,
    scores,
  }
}

const PADROES_TROCA_IDIOMA = [
  { regex: /\b(fala|falar?|fale|responde|responder|me responda|switch to|let'?s speak|hablemos|parlons)\s+(em\s+)?(ingl[êe]s|english|en|in english)\b/i, alvo: 'en' },
  { regex: /\b(fala|falar?|fale|responde|responder|me responda|switch to|let'?s speak|hablemos)\s+(em\s+)?(portugu[êe]s|portuguese|pt)\b/i, alvo: 'pt' },
  { regex: /\b(fala|falar?|fale|responde|switch to|hablemos)\s+(em\s+)?(espanhol|spanish|es|en espa[ñn]ol)\b/i, alvo: 'es' },
  { regex: /\b(fala|falar?|fale|switch to|parlons)\s+(em\s+)?(franc[êe]s|french|fr)\b/i, alvo: 'fr' },
  { regex: /\b(fala|falar?|fale|switch to)\s+(em\s+)?(italiano|italian|it)\b/i, alvo: 'it' },
  { regex: /\b(volta|voltar?|back to)\s+(o\s+|the\s+|pro\s+|para\s+o\s+|ao\s+)?(portugu[êe]s|portuguese|pt)\b/i, alvo: 'pt' },
  { regex: /\b(volta|voltar?)\s+(pro|para o|ao)\s+(ingl[êe]s|english)\b/i, alvo: 'en' },
  { regex: /\b(volta|voltar?)\s+(pro|para o|ao)\s+(espanhol|spanish)\b/i, alvo: 'es' },
  { regex: /\bin english\s+please\b/i, alvo: 'en' },
  { regex: /\bem portugu[êe]s\s+(de novo|por favor|please)\b/i, alvo: 'pt' },
]

function detectarComandoTroca(texto) {
  if (!texto) return null
  for (const padrao of PADROES_TROCA_IDIOMA) {
    if (padrao.regex.test(texto)) return padrao.alvo
  }
  return null
}

const PADROES_PEDIDO_ENSINO = [
  /\b(me\s+ensin[ae]|ensina\s+me|quero\s+aprender|quero\s+praticar|quero\s+falar|gostaria\s+de\s+aprender|posso\s+aprender|pode\s+me\s+ensinar|me\s+ajuda\s+a\s+aprender)\b/i,
  /\b(teach\s+me|i\s+wanna\s+learn|i\s+want\s+to\s+learn|let'?s\s+practice|help\s+me\s+with\s+my)\b/i,
  /\b(ens[eé]ñame|quiero\s+aprender|qu[eé]\s+aprenda)\b/i,
]

const IDIOMA_NO_TEXTO = [
  { regex: /\b(ingl[êe]s|english|en|in english)\b/i, idioma: 'en' },
  { regex: /\b(portugu[êe]s|portuguese|pt)\b/i, idioma: 'pt' },
  { regex: /\b(espanhol|spanish|espa[ñn]ol)\b/i, idioma: 'es' },
  { regex: /\b(franc[êe]s|french|fran[çc]ais)\b/i, idioma: 'fr' },
  { regex: /\b(italiano|italian)\b/i, idioma: 'it' },
]

// Pedidos EXPLICITOS de SAIR do modo ensino (parar a "aula" e so conversar). Sem
// isso o modo ensino so desligava com reset/restart do servidor - ficava preso.
const PADROES_SAIR_ENSINO = [
  /\b(chega\s+de\s+aula|para\s+de\s+ensinar|parar?\s+a\s+aula|sem\s+aula|n[aã]o\s+quero\s+(mais\s+)?(aprender|aula|praticar)|cansei\s+de\s+aprender|chega\s+de\s+ingl[êe]s|chega\s+de\s+praticar)\b/i,
  /\b(stop\s+teaching|no\s+more\s+(lessons?|teaching|practice)|stop\s+the\s+lesson|i\s+don'?t\s+want\s+to\s+(learn|practice))\b/i,
]

function pediuEnsino(texto) {
  if (!texto) return false
  return PADROES_PEDIDO_ENSINO.some(r => r.test(texto))
}

function pediuSairEnsino(texto) {
  if (!texto) return false
  return PADROES_SAIR_ENSINO.some(r => r.test(texto))
}

function idiomaMencionadoNoTexto(texto) {
  if (!texto) return null
  for (const { regex, idioma } of IDIOMA_NO_TEXTO) {
    if (regex.test(texto)) return idioma
  }
  return null
}

const estadosPorSessao = new Map()
const MAX_HISTORICO = 4
const LIMIAR_TROCA_AUTO = 0.45
const TROCAS_CONSECUTIVAS_NECESSARIAS = 2
// Abaixo deste numero de tokens, a deteccao automatica nao troca o idioma (palavras
// curtas sao ambiguas demais). Comando explicito de troca ignora este limite.
const MIN_TOKENS_TROCA_AUTO = 3
// Turnos seguidos no idioma nativo apos os quais o modo ensino se desliga sozinho
// (a crianca claramente voltou a so conversar). Ver atualizarIdiomaPorMensagem.
const TURNOS_NATIVO_PARA_SAIR_ENSINO = 2

function obterEstadoSessao(sessionId, defaultNativo = 'pt') {
  if (!estadosPorSessao.has(sessionId)) {
    estadosPorSessao.set(sessionId, {
      idiomaAtivo: defaultNativo,
      historicoIdiomas: [],
      idiomaForcadoPorComando: null,
      ultimoModoEnsino: false,
      // Ciclo de vida do modo ensino (antes vivia espalhado no brain.js e nunca
      // desligava). Agora e estado explicito da sessao: liga por pedido, desliga
      // por pedido de saida OU apos N turnos no idioma nativo.
      modoEnsino: false,
      turnosNoNativo: 0,
    })
  }
  return estadosPorSessao.get(sessionId)
}

// Atualiza o ciclo de vida do modo ensino no estado da sessao e devolve o valor
// atual. `gatilhoLigar` vem dos caminhos que ja sabem que e para ligar (pedido de
// ensino, troca por comando para idioma nao-nativo). O desligamento e por pedido
// explicito de saida OU por a CRIANCA falar varios turnos seguidos no idioma
// nativo (olhamos o idioma DA MENSAGEM, nao o idiomaAtivo - o ativo pode demorar a
// voltar pro nativo pela inercia da troca, e ai o contador nunca avancaria).
function atualizarCicloEnsino(estado, texto, idiomaNativo, gatilhoLigar, idiomaMensagem) {
  if (gatilhoLigar) {
    estado.modoEnsino = true
    estado.turnosNoNativo = 0
  } else if (pediuSairEnsino(texto)) {
    estado.modoEnsino = false
    estado.turnosNoNativo = 0
  } else if (idiomaMensagem === idiomaNativo) {
    estado.turnosNoNativo = (estado.turnosNoNativo || 0) + 1
    if (estado.turnosNoNativo >= TURNOS_NATIVO_PARA_SAIR_ENSINO) {
      estado.modoEnsino = false
    }
  } else if (idiomaMensagem && idiomaMensagem !== idiomaNativo) {
    // Crianca falou claramente num idioma nao-nativo: zera o contador de "voltou".
    estado.turnosNoNativo = 0
  }
  // idiomaMensagem null (indetectavel/curto): nao mexe no contador.
  return estado.modoEnsino
}

function atualizarIdiomaPorMensagem(sessionId, texto, opcoes = {}) {
  const idiomaNativo = opcoes.idiomaNativo || 'pt'
  const estado = obterEstadoSessao(sessionId, idiomaNativo)
  const queroEnsino = pediuEnsino(texto)

  const comando = detectarComandoTroca(texto)
  if (comando) {
    estado.idiomaAtivo = comando
    estado.idiomaForcadoPorComando = comando
    estado.historicoIdiomas = [comando]
    // Trocar POR COMANDO para um idioma nao-nativo liga o ensino; voltar ao nativo
    // ("fala em portugues") deixa o ciclo abaixo desligar naturalmente. O comando
    // tambem conta como "idioma da mensagem" para o contador de turnos no nativo.
    const modoEnsino = atualizarCicloEnsino(estado, texto, idiomaNativo, comando !== idiomaNativo, comando)
    return {
      idiomaAtivo: comando,
      idiomaMensagem: comando,
      confianca: 1,
      mudou: true,
      motivo: 'comando',
      pediuEnsino: queroEnsino,
      modoEnsino,
    }
  }

  if (queroEnsino) {
    const idiomaAlvo = idiomaMencionadoNoTexto(texto)
    if (idiomaAlvo && idiomaAlvo !== idiomaNativo && idiomaAlvo !== estado.idiomaAtivo) {
      estado.idiomaAtivo = idiomaAlvo
      estado.idiomaForcadoPorComando = idiomaAlvo
      estado.historicoIdiomas = [idiomaAlvo]
      const modoEnsino = atualizarCicloEnsino(estado, texto, idiomaNativo, true, idiomaAlvo)
      return {
        idiomaAtivo: idiomaAlvo,
        idiomaMensagem: idiomaMencionadoNoTexto(texto) || detectarIdioma(texto).idioma,
        confianca: 1,
        mudou: true,
        motivo: 'pedido-ensino',
        pediuEnsino: true,
        modoEnsino,
      }
    }
  }

  const deteccao = detectarIdioma(texto)
  const idiomaMsg = deteccao.idioma

  // Anti-troca-acidental em frases curtas: palavras-funcao curtas sao ambiguas
  // entre idiomas ("no" e "ok" pontuam ingles e portugues; "sim"/"si"; etc).
  // Uma crianca dizendo "no" ou "ok" em portugues nao deve jogar a conversa pro
  // ingles. Mensagens com menos de 3 tokens NAO disparam troca automatica - so a
  // troca por comando explicito ("fala em ingles"), ja tratada acima, vale aqui.
  // Empurramos null no historico para essas mensagens nao "contarem" como evidencia.
  const numTokens = tokenizar(texto).length
  const curtoDemaisParaTroca = numTokens < MIN_TOKENS_TROCA_AUTO

  estado.historicoIdiomas.push(curtoDemaisParaTroca ? null : idiomaMsg)
  if (estado.historicoIdiomas.length > MAX_HISTORICO) {
    estado.historicoIdiomas.shift()
  }

  let mudou = false
  let motivo = 'estavel'

  if (!curtoDemaisParaTroca && idiomaMsg && idiomaMsg !== estado.idiomaAtivo && deteccao.confianca >= LIMIAR_TROCA_AUTO) {
    const ultimas = estado.historicoIdiomas.slice(-TROCAS_CONSECUTIVAS_NECESSARIAS)
    const todasNoNovoIdioma = ultimas.length >= TROCAS_CONSECUTIVAS_NECESSARIAS && ultimas.every(i => i === idiomaMsg)

    if (todasNoNovoIdioma || estado.idiomaForcadoPorComando === null) {
      if (todasNoNovoIdioma || deteccao.confianca > 0.7) {
        estado.idiomaAtivo = idiomaMsg
        mudou = true
        motivo = todasNoNovoIdioma ? 'troca-consecutiva' : 'alta-confianca'
      }
    }
  }

  // Pediu ensino sem mencionar idioma (ex: "quero praticar") com um idioma
  // nao-nativo ja ativo -> liga o ensino naquele idioma. Senao, deixa o ciclo
  // (saida explicita / turnos no nativo) decidir.
  const gatilhoLigar = queroEnsino && estado.idiomaAtivo !== idiomaNativo
  // Para o contador de turnos no nativo usamos o idioma DETECTADO da mensagem (mesmo
  // quando foi curto demais para TROCAR o idiomaAtivo, ele indica em que lingua a
  // crianca falou). idiomaMsg pode ser null (indetectavel) - o ciclo ignora.
  const modoEnsino = atualizarCicloEnsino(estado, texto, idiomaNativo, gatilhoLigar, idiomaMsg)

  return {
    idiomaAtivo: estado.idiomaAtivo,
    idiomaMensagem: idiomaMsg,
    confianca: deteccao.confianca,
    mudou,
    motivo,
    pediuEnsino: queroEnsino,
    modoEnsino,
  }
}

function limparEstadoSessao(sessionId) {
  estadosPorSessao.delete(sessionId)
}

function nomeIdioma(codigo) {
  return ASSINATURAS[codigo]?.nome || codigo
}

module.exports = {
  detectarIdioma,
  detectarComandoTroca,
  pediuEnsino,
  pediuSairEnsino,
  idiomaMencionadoNoTexto,
  atualizarIdiomaPorMensagem,
  obterEstadoSessao,
  limparEstadoSessao,
  nomeIdioma,
  ASSINATURAS,
}
