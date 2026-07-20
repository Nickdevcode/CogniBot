// VISAO DO ROBO: o que a webcam ve vira comportamento nos olhos do robo.
//
// A webcam vive aqui no navegador, entao a deteccao tambem. Dois detectores do MediaPipe
// Tasks Vision rodam sobre o <video> que ja existe para a visao da Cogni:
//   - FaceLandmarker: da a POSICAO do rosto (os olhos do robo seguem a crianca) E a
//     EMOCAO dela (sorriso/bravo/triste/surpresa, via blendshapes) - um detector so.
//   - GestureRecognizer: gestos de mao (joinha, tchau, coracao...). Opcional e mais
//     pesado, entao roda em frequencia menor e pode ser desligado (GESTOS_ATIVOS).
//
// O que SAI daqui:
//   - posicao normalizada do rosto (x,y,t), ~10x/s -> onOlhar (os olhos seguem).
//   - percepcao ESTAVEL da emocao/gesto -> onExpressao (o servidor decide a reacao).
// Nenhuma imagem, nenhum vetor facial, nenhum dado biometrico sai do dispositivo: o que
// trafega e equivalente a "ela sorriu" ou "moveu o rosto para a direita".
//
// Decisoes que valem lembrar:
//  - Carregamento PREGUICOSO: os modelos WASM so entram em memoria quando a camera liga.
//  - Degradacao silenciosa: se um modelo nao carregar (pasta vendor ausente), a parte
//    dele desliga sozinha e o resto do painel continua funcionando.

import { criarLogger } from './logger.js'
import { classificarEmocaoFacial, classificarGesto, criarEstabilizador } from './expressao.js'

const log = criarLogger('Visao')

const CAMINHO_VENDOR = '/vendor/mediapipe'
// ~10 Hz para o rosto: o suficiente para o olhar parecer continuo (o firmware ainda
// interpola entre as amostras) sem torrar CPU do navegador, que tambem grava audio.
const INTERVALO_MS = 100
// Gestos a cada N ticks de rosto (2 = ~5 Hz). Sao mais caros e nao precisam ser rapidos.
const GESTO_A_CADA = 2
// TOGGLE dos gestos de mao. Desligue (false) para economizar CPU se a maquina for fraca:
// a emocao facial e o rastreio continuam funcionando normalmente.
const GESTOS_ATIVOS = true
// Sem rosto por este tempo, paramos de mandar posicao e o robo volta ao normal.
const PACIENCIA_SEM_ROSTO_MS = 1000

let faceLandmarker = null
let gestureRecognizer = null
let carregando = null
let timer = null
let videoAtual = null
let aoOlhar = null
let aoExpressar = null
let ultimoRostoMs = 0
let avisouIndisponivel = false

// Estabilizadores: transformam a opiniao "quadro a quadro" do detector em eventos reais.
// Rosto confirma em 500ms e repete no maximo a cada 7s; gesto e mais agil (350ms/4s).
const estabRosto = criarEstabilizador({ confirmarMs: 500, cooldownMs: 7000 })
const estabGesto = criarEstabilizador({ confirmarMs: 350, cooldownMs: 4000 })
// Chegada de gente: quando aparece um 2o rosto de forma sustentada (~800ms), o robo
// "repara" na visita. Cooldown longo (20s) - e uma reacao de acontecimento, nao um tique.
const estabMulti = criarEstabilizador({ confirmarMs: 800, cooldownMs: 20000 })

// SUAVIZACAO TEMPORAL (EMA) dos blendshapes: o detector tremula de um quadro pro outro,
// e classificar o valor cru deixa a emocao "piscando". Uma media exponencial leve
// estabiliza o sinal ANTES de classificar (o estabilizador acima ainda age depois, na
// percepcao ja classificada - as duas camadas se somam). Reiniciada quando o rosto some.
const emaScores = new Map()
const EMA_ALPHA = 0.4
function suavizar(categorias) {
  if (!Array.isArray(categorias)) return categorias
  const out = []
  for (const c of categorias) {
    const anterior = emaScores.get(c.categoryName)
    const s = anterior == null ? c.score : anterior * (1 - EMA_ALPHA) + c.score * EMA_ALPHA
    emaScores.set(c.categoryName, s)
    out.push({ categoryName: c.categoryName, score: s })
  }
  return out
}

// Carrega os detectores uma unica vez. O rosto e ESSENCIAL (sem ele nao ha visao); o
// gesto e opcional e cai em silencio se faltar. Devolve o FaceLandmarker (ou null quando
// os arquivos nao estao la - caso de quem clonou o repo e ainda nao rodou `npm run vendor`).
async function obterDetectores() {
  if (faceLandmarker) return faceLandmarker
  if (carregando) return carregando

  carregando = (async () => {
    const { FilesetResolver, FaceLandmarker, GestureRecognizer } =
      await import(`${CAMINHO_VENDOR}/vision_bundle.mjs`)
    const visao = await FilesetResolver.forVisionTasks(`${CAMINHO_VENDOR}/wasm`)

    faceLandmarker = await FaceLandmarker.createFromOptions(visao, {
      baseOptions: {
        modelAssetPath: `${CAMINHO_VENDOR}/face_landmarker.task`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      // Dois rostos: seguimos sempre o MAIOR (o mais proximo), mas detectar um 2o
      // rosto deixa o robo "reparar" que chegou gente. Custa um pouco mais de CPU.
      numFaces: 2,
      // Os blendshapes sao a emocao: sem esta flag o modelo so devolveria os pontos.
      outputFaceBlendshapes: true,
      // Limiar alto de proposito: preferimos perder o rosto por um instante a fazer o
      // robo encarar um quadro na parede que o detector achou que era gente.
      minFaceDetectionConfidence: 0.6,
    })
    log('FaceLandmarker pronto (posicao + emocao)')

    // Gesto: opcional. Um try proprio para que a falta do modelo (ou uma maquina sem
    // GPU) desligue SO os gestos, sem derrubar o rosto.
    if (GESTOS_ATIVOS) {
      try {
        gestureRecognizer = await GestureRecognizer.createFromOptions(visao, {
          baseOptions: {
            modelAssetPath: `${CAMINHO_VENDOR}/gesture_recognizer.task`,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
        })
        log('GestureRecognizer pronto (gestos de mao)')
      } catch (err) {
        gestureRecognizer = null
        log(`Gestos indisponiveis (${err.message}) - seguindo so com rosto/emocao`)
      }
    }
    return faceLandmarker
  })()

  try {
    return await carregando
  } catch (err) {
    carregando = null
    if (!avisouIndisponivel) {
      avisouIndisponivel = true
      log(`Visao indisponivel (${err.message}). Rode "npm run vendor" em server/ para habilitar.`)
    }
    return null
  }
}

// A caixa (bounding box) que envolve todos os landmarks de UM rosto, em coordenadas
// normalizadas. Em vez de indices "magicos" de pontos, a caixa da o centro (direcao do
// olhar) e a largura (medida de distancia). Devolve tambem a area, para escolher o maior.
function caixaDoRosto(pontos) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const p of pontos) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  return {
    x: clamp((minX + maxX) / 2),
    y: clamp((minY + maxY) / 2),
    // Largura do rosto como fracao do quadro - a unica medida de DISTANCIA. O robo usa
    // isso para ficar vesgo quando a crianca cola o rosto na camera. Continua nao sendo
    // dado biometrico: e o mesmo tipo de informacao que o tamanho de uma janela na tela.
    t: clamp(maxX - minX),
    area: (maxX - minX) * (maxY - minY),
  }
}

// Escolhe o MAIOR rosto (o mais proximo) entre os detectados. Devolve sua posicao, o
// INDICE dele (para pegar os blendshapes do rosto certo) e o TOTAL de rostos no quadro
// (o que permite o robo reparar quando chega mais gente). Reproduz o contrato do antigo
// BlazeFace (x,y,t) para o maior rosto.
function analisarRostos(faceLandmarks) {
  const total = faceLandmarks?.length || 0
  if (total === 0) return { pos: null, indice: -1, total: 0 }
  let indice = 0, areaMaior = -1, pos = null
  for (let i = 0; i < total; i++) {
    const caixa = caixaDoRosto(faceLandmarks[i])
    if (caixa.area > areaMaior) { areaMaior = caixa.area; indice = i; pos = caixa }
  }
  return { pos, indice, total }
}

/**
 * Comeca a "ver" a crianca no elemento de video informado.
 * @param {HTMLVideoElement} video video da webcam ja tocando
 * @param {{onOlhar:(pos:{x,y,t}|null)=>void, onExpressao:(percepcao:string)=>void}} callbacks
 *   - onOlhar: posicao normalizada do rosto (0..1) ou null quando ele sai de vista.
 *   - onExpressao: percepcao ESTAVEL da emocao/gesto (ex.: 'crianca-feliz', 'gesto-joinha').
 */
export async function iniciarRastreio(video, callbacks) {
  pararRastreio()
  if (!video) return false
  const { onOlhar, onExpressao } = callbacks || {}

  const face = await obterDetectores()
  if (!face) return false

  videoAtual = video
  aoOlhar = onOlhar
  aoExpressar = onExpressao
  ultimoRostoMs = Date.now()
  let tick = 0

  timer = setInterval(() => {
    if (!videoAtual || videoAtual.readyState < 2 || !faceLandmarker) return
    const tsMs = performance.now()
    tick++

    // --- ROSTO: posicao + emocao (todo tick) ---
    let resultado = null
    try {
      resultado = faceLandmarker.detectForVideo(videoAtual, tsMs)
    } catch {
      return   // quadro ruim (video trocando de resolucao, por exemplo): ignora
    }

    const { pos, indice, total } = analisarRostos(resultado?.faceLandmarks)
    const agora = Date.now()

    if (!pos) {
      // So avisa "perdi o rosto" depois da carencia, para uma virada de cabeca ou uma
      // piscada do detector nao fazer o robo desviar o olhar toda hora. Reinicia a EMA:
      // quando o rosto voltar, a emocao parte do zero em vez de herdar o valor velho.
      if (agora - ultimoRostoMs > PACIENCIA_SEM_ROSTO_MS) { aoOlhar?.(null); emaScores.clear() }
    } else {
      ultimoRostoMs = agora
      aoOlhar?.(pos)

      // Emocao: suaviza os blendshapes do rosto seguido (o maior), classifica e passa
      // pelo estabilizador. So emite quando uma emocao se confirma de verdade.
      const emocao = classificarEmocaoFacial(suavizar(resultado?.faceBlendshapes?.[indice]?.categories))
      const percepcao = estabRosto(emocao, agora)
      if (percepcao) aoExpressar?.(percepcao)

      // Chegou gente: um 2o rosto sustentado faz o robo reparar na visita (uma vez).
      const percMulti = estabMulti(total >= 2 ? 'chegou-alguem' : null, agora)
      if (percMulti) aoExpressar?.(percMulti)
    }

    // --- GESTO: mais caro, roda em frequencia menor ---
    if (gestureRecognizer && tick % GESTO_A_CADA === 0) {
      let gr = null
      try {
        gr = gestureRecognizer.recognizeForVideo(videoAtual, tsMs)
      } catch {
        gr = null
      }
      const nome = gr?.gestures?.[0]?.[0]?.categoryName
      const gesto = classificarGesto(nome)
      const percGesto = estabGesto(gesto, agora)
      if (percGesto) aoExpressar?.(percGesto)
    }
  }, INTERVALO_MS)

  log('Visao ligada (rosto/emocao' + (gestureRecognizer ? ' + gestos' : '') + ')')
  return true
}

export function pararRastreio() {
  if (timer) {
    clearInterval(timer)
    timer = null
    log('Visao desligada')
  }
  videoAtual = null
  aoOlhar = null
  aoExpressar = null
  emaScores.clear()   // proxima sessao comeca a ler emocao do zero
}
