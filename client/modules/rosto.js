// RASTREIO DE ROSTO: faz os olhos do robô acompanharem a criança.
//
// A webcam vive aqui no navegador, então a detecção também: rodamos o BlazeFace
// (MediaPipe Tasks Vision) sobre o <video> que já existe para a visão da Cogni e
// mandamos ao servidor apenas a posição normalizada do rosto — dois números por
// envio, ~10x por segundo. O servidor repassa ao robô, que move os olhos.
//
// Decisões que valem lembrar:
//  - Carregamento PREGUIÇOSO: o WASM só entra em memória quando a câmera liga de
//    fato. Quem nunca usa a câmera não paga nada por isso.
//  - Degradação silenciosa: se o modelo não carregar (pasta vendor ausente, WASM
//    bloqueado), o rastreio simplesmente não acontece. Nada mais do painel quebra.
//  - Só a POSIÇÃO sai daqui. Nenhuma imagem, nenhum vetor facial, nenhum dado
//    biométrico é enviado ou guardado — a câmera continua sendo processada só no
//    dispositivo, e o que trafega é equivalente a um movimento de mouse.

import { criarLogger } from './logger.js'

const log = criarLogger('Rosto')

const CAMINHO_VENDOR = '/vendor/mediapipe'
// ~10 Hz: o suficiente para o olhar parecer contínuo (o firmware ainda interpola
// entre as amostras) sem torrar CPU do navegador, que também está gravando áudio.
const INTERVALO_MS = 100
// Sem rosto por este tempo, paramos de mandar posição e o robô volta ao normal.
const PACIENCIA_SEM_ROSTO_MS = 1000

let detector = null
let carregando = null
let timer = null
let videoAtual = null
let aoDetectar = null
let ultimoRostoMs = 0
let avisouIndisponivel = false

// Carrega o detector uma única vez. Devolve null (sem lançar) quando os arquivos
// não estão lá — é o caso de quem clonou o repo e ainda não rodou `npm run vendor`.
async function obterDetector() {
  if (detector) return detector
  if (carregando) return carregando

  carregando = (async () => {
    const { FilesetResolver, FaceDetector } = await import(`${CAMINHO_VENDOR}/vision_bundle.mjs`)
    const visao = await FilesetResolver.forVisionTasks(`${CAMINHO_VENDOR}/wasm`)
    detector = await FaceDetector.createFromOptions(visao, {
      baseOptions: {
        modelAssetPath: `${CAMINHO_VENDOR}/blaze_face_short_range.tflite`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      // Limiar alto de propósito: preferimos perder o rosto por um instante a fazer
      // o robô encarar um quadro na parede que o detector achou que era gente.
      minDetectionConfidence: 0.6,
    })
    log('Detector de rosto pronto')
    return detector
  })()

  try {
    return await carregando
  } catch (err) {
    carregando = null
    if (!avisouIndisponivel) {
      avisouIndisponivel = true
      log(`Rastreio indisponível (${err.message}). Rode "npm run vendor" em server/ para habilitar.`)
    }
    return null
  }
}

// Converte a detecção em coordenadas normalizadas (0..1) do CENTRO do maior rosto.
// O maior costuma ser o mais próximo — se houver duas crianças, o robô olha para
// quem está mais perto dele, que é o comportamento intuitivo.
function centroDoMaiorRosto(deteccoes) {
  let maior = null
  for (const d of deteccoes) {
    const c = d.boundingBox
    if (!c) continue
    if (!maior || c.width * c.height > maior.width * maior.height) maior = c
  }
  return maior
}

/**
 * Começa a acompanhar o rosto no elemento de vídeo informado.
 * @param {HTMLVideoElement} video vídeo da webcam já tocando
 * @param {(pos: {x: number, y: number}|null) => void} callback recebe a posição
 *        normalizada (0..1, origem no canto superior esquerdo) ou null quando o
 *        rosto sai de vista. Só é chamado quando há mudança relevante.
 */
export async function iniciarRastreio(video, callback) {
  pararRastreio()
  if (!video) return false

  const det = await obterDetector()
  if (!det) return false

  videoAtual = video
  aoDetectar = callback
  ultimoRostoMs = Date.now()

  timer = setInterval(() => {
    if (!videoAtual || videoAtual.readyState < 2 || !detector) return
    let resultado = null
    try {
      resultado = detector.detectForVideo(videoAtual, performance.now())
    } catch {
      return   // quadro ruim (vídeo trocando de resolução, por exemplo): ignora
    }

    const caixa = centroDoMaiorRosto(resultado?.detections || [])
    const agora = Date.now()

    if (!caixa) {
      // Só avisa "perdi o rosto" depois da carência — assim uma virada de cabeça
      // ou uma piscada do detector não faz o robô desviar o olhar toda hora.
      if (agora - ultimoRostoMs > PACIENCIA_SEM_ROSTO_MS) aoDetectar?.(null)
      return
    }

    ultimoRostoMs = agora
    const larguraVideo = videoAtual.videoWidth || 1
    const alturaVideo = videoAtual.videoHeight || 1
    aoDetectar?.({
      x: (caixa.originX + caixa.width / 2) / larguraVideo,
      y: (caixa.originY + caixa.height / 2) / alturaVideo,
    })
  }, INTERVALO_MS)

  log('Rastreio de rosto ligado')
  return true
}

export function pararRastreio() {
  if (timer) {
    clearInterval(timer)
    timer = null
    log('Rastreio de rosto desligado')
  }
  videoAtual = null
  aoDetectar = null
}
