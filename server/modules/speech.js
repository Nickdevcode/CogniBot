const OpenAI = require('openai')
const config = require('../config')
const { log } = require('./logger')
const { detectarIdioma } = require('./brain/idioma')

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
})

function inferirExtensaoENome(mimetype = '') {
  if (mimetype.includes('wav')) return { ext: 'wav', mime: 'audio/wav' }
  if (mimetype.includes('mp4') || mimetype.includes('m4a')) return { ext: 'mp4', mime: 'audio/mp4' }
  if (mimetype.includes('ogg')) return { ext: 'ogg', mime: 'audio/ogg' }
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return { ext: 'mp3', mime: 'audio/mpeg' }
  return { ext: 'webm', mime: 'audio/webm' }
}

async function chamarTranscricao(modelo, arquivo, opcoes = {}) {
  const payload = {
    model: modelo,
    file: arquivo,
    response_format: 'text',
    temperature: 0,
  }
  if (opcoes.language) payload.language = opcoes.language
  if (opcoes.prompt) payload.prompt = opcoes.prompt

  const transcricao = await openai.audio.transcriptions.create(payload)
  return typeof transcricao === 'string' ? transcricao.trim() : (transcricao?.text || '').trim()
}

// Monta o prompt de contexto do Whisper a partir do usuario. O Whisper usa esse
// texto como "dica" do vocabulario esperado: melhora MUITO nomes proprios (o nome
// da crianca, "Cogni") e termos do dominio (materias), e da o registro de fala
// infantil em PT-BR. Sem isso, a transcricao erra nomes e palavras tipicas — e o
// modelo acaba "respondendo outra coisa" porque recebeu a pergunta corrompida.
// Mantemos curto: o Whisper so usa ~224 tokens do prompt.
function promptWhisperContexto(usuario) {
  const partes = [
    'Conversa em portugues do Brasil entre uma crianca e a assistente Cogni.',
  ]
  if (usuario && typeof usuario.nome === 'string' && usuario.nome.trim()) {
    partes.push(`A crianca se chama ${usuario.nome.trim()}.`)
  }
  partes.push('Fala do dia a dia, escola, materias (matematica, portugues, ciencias, historia, geografia), jogos, duvidas e curiosidades.')
  return partes.join(' ')
}

// Opcoes de transcricao padrao do projeto: idioma AUTO-detectado (language:null,
// essencial pro multilingue) + prompt de contexto do usuario. Centralizado aqui
// pra interface web (api.js) e robo (esp-pipeline.js) usarem o MESMO contexto.
function opcoesTranscricaoPadrao(usuario) {
  return { language: null, prompt: promptWhisperContexto(usuario) }
}

async function transcrever(audioBuffer, mimetype = 'audio/webm', opcoes = {}) {
  const { ext, mime } = inferirExtensaoENome(mimetype)
  const arquivo = await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: mime })

  const optsBase = {
    language: opcoes.language === null ? null : (opcoes.language || config.WHISPER_LANGUAGE),
    prompt: opcoes.prompt,
  }
  if (optsBase.language === null) delete optsBase.language

  try {
    return await chamarTranscricao(config.STT_MODEL, arquivo, optsBase)
  } catch (err) {
    if (config.STT_FALLBACK_MODEL && config.STT_FALLBACK_MODEL !== config.STT_MODEL) {
      log('Aviso', `STT principal (${config.STT_MODEL}) falhou: ${err.message}. Tentando fallback ${config.STT_FALLBACK_MODEL}.`)
      const arquivoFallback = await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: mime })
      return await chamarTranscricao(config.STT_FALLBACK_MODEL, arquivoFallback, optsBase)
    }
    throw err
  }
}

const MAPA_NUMEROS_EXTENSO = {
  '0': 'zero', '1': 'um', '2': 'dois', '3': 'três', '4': 'quatro',
  '5': 'cinco', '6': 'seis', '7': 'sete', '8': 'oito', '9': 'nove',
  '10': 'dez', '11': 'onze', '12': 'doze', '13': 'treze', '14': 'quatorze',
  '15': 'quinze', '16': 'dezesseis', '17': 'dezessete', '18': 'dezoito',
  '19': 'dezenove', '20': 'vinte', '30': 'trinta', '40': 'quarenta',
  '50': 'cinquenta', '60': 'sessenta', '70': 'setenta', '80': 'oitenta',
  '90': 'noventa', '100': 'cem',
}

const ORDINAIS_UNIDADE = {
  '1': 'primeir', '2': 'segund', '3': 'terceir', '4': 'quart', '5': 'quint',
  '6': 'sext', '7': 'sétim', '8': 'oitav', '9': 'non',
}

const ORDINAIS_DEZENA = {
  '10': 'décim', '20': 'vigésim', '30': 'trigésim', '40': 'quadragésim',
  '50': 'quinquagésim', '60': 'sexagésim', '70': 'septuagésim',
  '80': 'octogésim', '90': 'nonagésim',
}

const ORDINAIS_CENTENA = {
  '100': 'centésim', '200': 'ducentésim', '300': 'trecentésim',
  '400': 'quadringentésim', '500': 'quingentésim', '600': 'seiscentésim',
  '700': 'septingentésim', '800': 'octingentésim', '900': 'noningentésim',
}

function numeroParaOrdinalExtenso(num, sufixo) {
  const n = parseInt(num, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const term = sufixo === 'ª' ? 'a' : 'o'

  if (n <= 9) return ORDINAIS_UNIDADE[String(n)] ? ORDINAIS_UNIDADE[String(n)] + term : null
  if (n === 1000) return 'milésim' + term

  const partes = []
  let resto = n

  const centena = Math.floor(resto / 100) * 100
  if (centena > 0 && ORDINAIS_CENTENA[String(centena)]) {
    partes.push(ORDINAIS_CENTENA[String(centena)] + term)
    resto -= centena
  }

  const dezena = Math.floor(resto / 10) * 10
  if (dezena > 0 && ORDINAIS_DEZENA[String(dezena)]) {
    partes.push(ORDINAIS_DEZENA[String(dezena)] + term)
    resto -= dezena
  }

  if (resto > 0 && ORDINAIS_UNIDADE[String(resto)]) {
    partes.push(ORDINAIS_UNIDADE[String(resto)] + term)
  }

  return partes.length > 0 ? partes.join(' ') : null
}

function expandirOrdinais(texto) {
  return texto.replace(/(\d+)\s*([ºª°])/g, (match, num, sufixo) => {
    const extenso = numeroParaOrdinalExtenso(num, sufixo === '°' ? 'º' : sufixo)
    return extenso || match
  })
}

const MAPA_SIGLAS = {
  'TCC': 'tê cê cê',
  'IA': 'i a',
  'AI': 'ei ai',
  'API': 'a pê i',
  'OK': 'okêi',
  'TV': 'tê vê',
  'PC': 'pê cê',
  'CPU': 'cê pê u',
  'EUA': 'estados unidos',
  'UNASP': 'unasp',
  'PDF': 'pê dê efe',
  'URL': 'u erre ele',
  'WIFI': 'uái fái',
  'WI-FI': 'uái fái',
  'WHATSAPP': 'uatzap',
  'YOUTUBE': 'iutubi',
  'GPS': 'gê pê esse',
  'ETC': 'etcétera',
  'HTTPS': 'agá tê tê pê esse',
  'HTTP': 'agá tê tê pê',
  'KM': 'quilômetros',
  'CM': 'centímetros',
  'MM': 'milímetros',
  'KG': 'quilos',
  'MB': 'megabaites',
  'GB': 'gigabaites',
  'CEP': 'cêp',
}

function expandirNumerosCurtos(texto) {
  return texto.replace(/\b(\d{1,3})\b/g, (match, num) => {
    const n = parseInt(num, 10)
    if (n <= 20 || MAPA_NUMEROS_EXTENSO[num]) return MAPA_NUMEROS_EXTENSO[num] || match
    if (n < 100) {
      const dezena = Math.floor(n / 10) * 10
      const unidade = n % 10
      const partDezena = MAPA_NUMEROS_EXTENSO[String(dezena)]
      if (partDezena && unidade === 0) return partDezena
      if (partDezena && unidade > 0) return `${partDezena} e ${MAPA_NUMEROS_EXTENSO[String(unidade)]}`
    }
    return match
  })
}

function expandirSiglas(texto) {
  let resultado = texto
  for (const [sigla, expansao] of Object.entries(MAPA_SIGLAS)) {
    const regex = new RegExp(`\\b${sigla}\\b`, 'gi')
    resultado = resultado.replace(regex, expansao)
  }
  return resultado
}

function normalizarPontuacaoParaProsodia(texto) {
  let r = texto
  r = r.replace(/\s*\.{3,}\s*/g, '… ')
  r = r.replace(/([!?])\1+/g, '$1')
  r = r.replace(/\.{2}(?!\.)/g, '.')
  r = r.replace(/\s+([,.;:!?…])/g, '$1')
  r = r.replace(/([,.;:!?…])([^\s"'\-—)\]…])/g, '$1 $2')
  r = r.replace(/--+/g, '—')
  r = r.replace(/\s*—\s*/g, ' — ')
  r = r.replace(/[ \t]{2,}/g, ' ')
  r = r.replace(/\n{2,}/g, '. ')
  r = r.replace(/\n/g, ' ')
  return r.trim()
}

function removerEmojisEAsteriscos(texto) {
  let r = texto
  r = r.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu, '')
  r = r.replace(/\*+/g, '')
  r = r.replace(/_{2,}/g, '')
  r = r.replace(/`+/g, '')
  r = r.replace(/#+\s*/g, '')
  return r
}

function adicionarContracaoNatural(texto) {
  let r = texto
  r = r.replace(/\bestá\b/gi, 'tá')
  r = r.replace(/\bestou\b/gi, 'tô')
  r = r.replace(/\bestamos\b/gi, 'tamos')
  r = r.replace(/\bestão\b/gi, 'tão')
  r = r.replace(/\bestava\b/gi, 'tava')
  r = r.replace(/\bestavam\b/gi, 'tavam')
  r = r.replace(/\bpara\s+([aoeu])/gi, 'pra $1')
  r = r.replace(/\bpara\s+/gi, 'pra ')
  r = r.replace(/\bvocê\b/gi, 'cê')
  return r
}

const REGEX_TEM_DIACRITICO_PT = /[ãõçáéíóúâêôà]/i
const PALAVRAS_PT = new Set([
  'que', 'voce', 'você', 'eu', 'nao', 'não', 'sim', 'pra', 'para', 'com', 'uma', 'isso',
  'aqui', 'ali', 'tudo', 'bem', 'esta', 'está', 'tá', 'tô', 'né', 'agora', 'depois',
  'muito', 'tambem', 'também', 'mas', 'mais', 'sou', 'é', 'são', 'foi', 'tem', 'tenho',
  'anos', 'idade', 'de', 'do', 'da', 'no', 'na', 'um', 'os', 'as', 'meu', 'minha',
])

// Heuristico de PORTUGUES (piso seguro): diacritico PT OU densidade de palavras-funcao
// PT. Bom justamente para PT curto sem muito sinal (ex: "Tenho 7 anos"), onde o
// detector multilingue pontua baixo por nao ter essas palavras na assinatura dele.
function ehProvavelmentePortugues(texto) {
  if (!texto) return false
  if (REGEX_TEM_DIACRITICO_PT.test(texto)) return true

  const palavras = texto.toLowerCase().match(/[a-záéíóúâêôãõàç]+/gi)
  if (!palavras || palavras.length === 0) return false

  let acertos = 0
  for (const p of palavras) {
    if (PALAVRAS_PT.has(p)) acertos++
  }
  return acertos / palavras.length > 0.18
}

// Confianca minima do detector multilingue para VETAR o portugues quando aponta
// OUTRO idioma. Acima disso, se o vencedor nao e pt, confiamos que o texto NAO e
// portugues e nao aplicamos as transformacoes PT.
const LIMIAR_VETO_OUTRO_IDIOMA = 0.45
// Score de PT abaixo do qual o consideramos "zerado" para fins de veto: se outro
// idioma pontua e o PT esta praticamente nulo, o texto nao e portugues mesmo que a
// confianca do vencedor seja so mediana (caso de frase com muitos nomes proprios,
// ex: "Kimi Antonelli leads with 131 points" da conf ~0.42 em en, pt = 0).
const SCORE_PT_DESPREZIVEL = 0.05

// Decide se as transformacoes de PORTUGUES (numeros/siglas/ordinais/contracoes por
// extenso) devem ser aplicadas. REGRA CENTRAL: quem manda e o IDIOMA DO TEXTO QUE
// VAI SER FALADO (a resposta), NAO o idioma da pergunta. Sem isso, uma pergunta em
// PT que a IA responde em INGLES (tipico quando a busca web traz conteudo em ingles)
// levava os numeros expandidos em portugues ("131" -> "cento e trinta e um") no meio
// de uma frase inglesa - exatamente o bug dos numeros falados em PT no ingles.
//
// Estrategia em duas camadas (o detector VETA; o heuristico/forcado CONFIRMA):
//   1. VETO: o texto e claramente de OUTRO idioma -> nao aplica PT, mesmo que
//      idiomaForcado='pt' (a pergunta era PT mas a resposta saiu em ingles). Veta
//      quando o detector tem boa confianca num idioma nao-pt OU quando o PT esta
//      zerado e outro idioma pontua (cobre frases com muitos nomes proprios, onde a
//      confianca cai mas o PT segue nulo). Isso mata o bug dos numeros.
//   2. CONFIRMACAO (caminho seguro de sempre): sem veto, aplica PT se idiomaForcado
//      ='pt' OU se o heuristico de PT reconhece o texto. O heuristico cobre o PT
//      curto sem diacritico que o detector multilingue pontua baixo ("Tenho 7 anos").
function deveAplicarTransformacoesPt(texto, idiomaForcado) {
  const deteccao = detectarIdioma(texto)
  const scores = deteccao.scores || {}
  const scorePt = scores.pt || 0
  let melhorOutro = 0
  for (const [cod, s] of Object.entries(scores)) {
    if (cod !== 'pt' && s > melhorOutro) melhorOutro = s
  }

  // (1) VETO: outro idioma com boa confianca, OU PT zerado enquanto outro pontua.
  const vencedorNaoPt = deteccao.idioma && deteccao.idioma !== 'pt'
  if (vencedorNaoPt && deteccao.confianca >= LIMIAR_VETO_OUTRO_IDIOMA) return false
  if (scorePt < SCORE_PT_DESPREZIVEL && melhorOutro > scorePt) return false

  // (2) Sem veto: caminho seguro. idiomaForcado nao-pt tambem veta (a conversa nao
  // e PT); 'pt' ou heuristico positivo confirmam.
  if (idiomaForcado && idiomaForcado !== 'pt') return false
  if (idiomaForcado === 'pt') return true
  return ehProvavelmentePortugues(texto)
}

function prepararTextoParaFala(texto, opcoes = {}) {
  if (!texto) return ''
  let r = String(texto)
  r = removerEmojisEAsteriscos(r)

  const ehPt = deveAplicarTransformacoesPt(r, opcoes.idiomaForcado)

  if (ehPt) {
    r = expandirSiglas(r)
    r = expandirOrdinais(r)
    r = expandirNumerosCurtos(r)
    if (opcoes.contracoes !== false) r = adicionarContracaoNatural(r)
  }

  r = normalizarPontuacaoParaProsodia(r)
  return r
}

async function sintetizar(texto, opcoes = {}) {
  const idade = typeof opcoes.idade === 'number' ? opcoes.idade : null
  const voice = opcoes.voice || config.obterVozPorIdade(idade)
  const instructions = opcoes.instructions || config.obterInstrucoesPorIdade(idade)
  const speed = typeof opcoes.speed === 'number' ? opcoes.speed : config.TTS_SPEED
  const modelo = opcoes.modelo || config.TTS_MODEL_SNAPSHOT || config.TTS_MODEL

  const textoPreparado = opcoes.preProcessar === false ? texto : prepararTextoParaFala(texto, opcoes)

  const resposta = await openai.audio.speech.create({
    model: modelo,
    voice,
    input: textoPreparado,
    instructions,
    speed,
    response_format: 'mp3',
  })

  const arrayBuffer = await resposta.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// Aplica ganho de volume ao PCM (16-bit signed LE) com LIMITADOR suave, evitando
// a distorcao do corte reto (hard clip). Abaixo de um joelho (knee ~85% do
// full-scale) o ganho e LINEAR (fiel); acima dele, o excedente e comprimido por
// uma curva tanh que satura suavemente em direcao a +/-32767. Resultado: a voz
// fica mais alta sem "estourar" nos picos. Ganho <= 1.0 retorna o buffer original
// (sem custo). Opera in-place num buffer novo para nao mexer no original.
function aplicarGanhoPcm(pcm, ganho) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || !(ganho > 1.0)) return pcm

  const LIMITE = 32767
  const KNEE = LIMITE * 0.85          // abaixo disso: ganho linear puro
  const margem = LIMITE - KNEE         // faixa de compressao acima do joelho
  const out = Buffer.alloc(pcm.length)

  for (let i = 0; i + 1 < pcm.length; i += 2) {
    let v = pcm.readInt16LE(i) * ganho
    const mag = Math.abs(v)
    if (mag > KNEE) {
      // Comprime so o que passou do joelho, saturando suave (tanh) ate o teto.
      const excedente = (mag - KNEE) / margem
      const comprimido = KNEE + margem * Math.tanh(excedente)
      v = v < 0 ? -comprimido : comprimido
    }
    // Seguranca final (arredondamento pode passar 1 unidade): trava na faixa int16.
    if (v > LIMITE) v = LIMITE
    else if (v < -32768) v = -32768
    out.writeInt16LE(v | 0, i)
  }
  return out
}

// Sintetiza em PCM raw (24kHz, 16-bit signed, mono, little-endian, SEM header),
// que e o formato nativo da OpenAI TTS. Usado pelo robo: o ESP32 toca esse PCM
// direto no I2S, sem precisar decodificar MP3 (decodificar MP3 exige PSRAM, que
// o ESP32 DevKit nao tem). Mesma voz/instrucoes do sintetizar() normal.
// O ganho de volume (ESP_AUDIO_GANHO) e aplicado aqui, ja com limitador suave.
async function sintetizarPcm(texto, opcoes = {}) {
  const idade = typeof opcoes.idade === 'number' ? opcoes.idade : null
  const voice = opcoes.voice || config.obterVozPorIdade(idade)
  const instructions = opcoes.instructions || config.obterInstrucoesPorIdade(idade)
  const speed = typeof opcoes.speed === 'number' ? opcoes.speed : config.TTS_SPEED
  const modelo = opcoes.modelo || config.TTS_MODEL_SNAPSHOT || config.TTS_MODEL

  const textoPreparado = opcoes.preProcessar === false ? texto : prepararTextoParaFala(texto, opcoes)

  const resposta = await openai.audio.speech.create({
    model: modelo,
    voice,
    input: textoPreparado,
    instructions,
    speed,
    response_format: 'pcm',
  })

  const arrayBuffer = await resposta.arrayBuffer()
  const pcm = Buffer.from(arrayBuffer)
  const ganho = typeof opcoes.ganho === 'number' ? opcoes.ganho : config.ESP_AUDIO_GANHO
  return aplicarGanhoPcm(pcm, ganho)
}

module.exports = { transcrever, sintetizar, sintetizarPcm, prepararTextoParaFala, openai, promptWhisperContexto, opcoesTranscricaoPadrao }
