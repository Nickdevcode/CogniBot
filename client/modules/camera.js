import { criarLogger } from './logger.js'

const log = criarLogger('Camera')

const TENTATIVAS_CAMERA = [
  { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } },
  { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } },
  { video: true },
]

export class GerenciadorCamera {
  constructor(elementoVideo, elementoCanvas) {
    this.video = elementoVideo
    this.canvas = elementoCanvas
    this.stream = null
    this.ativa = false
  }

  async ligar() {
    if (this.ativa) return true
    let ultimoErro = null

    for (const constraints of TENTATIVAS_CAMERA) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints)
        this.video.srcObject = this.stream
        this.ativa = true
        log('Camera ligada')
        return true
      } catch (err) {
        ultimoErro = err
      }
    }

    throw ultimoErro || new Error('Nao foi possivel acessar a camera')
  }

  desligar() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop())
      this.stream = null
    }
    this.video.srcObject = null
    this.ativa = false
    log('Camera desligada')
  }

  capturarFrame() {
    if (!this.ativa || !this.video.videoWidth) return null

    const canvas = this.canvas
    canvas.width = 640
    canvas.height = 480

    const ctx = canvas.getContext('2d')
    const videoRatio = this.video.videoWidth / this.video.videoHeight
    const canvasRatio = canvas.width / canvas.height

    let sx, sy, sw, sh
    if (videoRatio > canvasRatio) {
      sh = this.video.videoHeight
      sw = sh * canvasRatio
      sx = (this.video.videoWidth - sw) / 2
      sy = 0
    } else {
      sw = this.video.videoWidth
      sh = sw / canvasRatio
      sx = 0
      sy = (this.video.videoHeight - sh) / 2
    }

    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    return dataUrl.split(',')[1]
  }
}

export function mensagemErroCamera(erro) {
  if (erro?.name === 'NotReadableError') {
    return 'A câmera está sendo usada por outro aplicativo. Feche outros apps que usam câmera e tente novamente.'
  }
  if (erro?.name === 'NotFoundError') {
    return 'Nenhuma câmera encontrada neste dispositivo.'
  }
  if (erro?.name === 'NotAllowedError') {
    return 'Permissão da câmera negada. Permita o acesso nas configurações do navegador.'
  }
  return `Erro ao acessar a câmera: ${erro?.message || 'erro desconhecido'}`
}
