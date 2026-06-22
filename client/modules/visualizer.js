import { criarLogger } from './logger.js'

const log = criarLogger('Visualizer')

const NUM_BARRAS = 48
const SUAVIZACAO_SUBIDA = 0.35
const SUAVIZACAO_DESCIDA = 0.78
const FALLBACK_AMP_MIN = 0.04
const FALLBACK_AMP_MAX = 0.55
const FREQ_MIN = 80
const FREQ_MAX = 8000

const prefereMenosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches

export class VisualizerAvatar {
  constructor(canvas, opcoes = {}) {
    this.canvas = canvas
    this.ctx = canvas?.getContext('2d') || null
    this.numBarras = opcoes.numBarras || NUM_BARRAS
    this.amplitudes = new Float32Array(this.numBarras)
    this.targets = new Float32Array(this.numBarras)
    this.animFrame = null
    this.fonteAtiva = null
    this.analisadorMic = null
    this.audioContextProprio = null
    this.audioCtxRefMic = null
    this.elementoAudioAtual = null
    this.analisadorAudio = null
    this.fonteAudio = null
    this.audioCtxAudio = null
    this.fallbackTickInicio = 0
    this.estadoVisual = 'idle'
    this.escalaCanvas = window.devicePixelRatio || 1

    this.ultimoTamanho = { w: 0, h: 0, dpr: 0 }
    this._lerCorAcento()
    this._configurarCanvas()
    this._observador = null
    this._onResize = null
    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      this._observador = new ResizeObserver(() => this._configurarCanvas())
      this._observador.observe(this.canvas)
    } else {
      // Fallback (navegador sem ResizeObserver): guardamos a referencia do handler
      // para REMOVER em destruir() - senao ele vazaria em window a cada instancia.
      this._onResize = () => this._configurarCanvas()
      window.addEventListener('resize', this._onResize)
    }
  }

  _lerCorAcento() {
    try {
      const styles = getComputedStyle(document.documentElement)
      this.corAcento = styles.getPropertyValue('--acento').trim() || '#D4B896'
      this.corAcentoClaro = styles.getPropertyValue('--acento-claro').trim() || '#E8D4B0'
      this.corOuvindo = styles.getPropertyValue('--ouvindo').trim() || '#8FB89A'
      this.corPensando = styles.getPropertyValue('--pensando').trim() || '#C8B978'
      this.corPesquisa = styles.getPropertyValue('--pesquisa').trim() || '#8AA2B8'
      this.corFalando = styles.getPropertyValue('--falando').trim() || '#B89B7A'
    } catch {
      this.corAcento = '#D4B896'
      this.corAcentoClaro = '#E8D4B0'
    }
  }

  _configurarCanvas() {
    if (!this.canvas) return
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const wCss = rect.width
    const hCss = rect.height

    if (
      this.ultimoTamanho.w === wCss &&
      this.ultimoTamanho.h === hCss &&
      this.ultimoTamanho.dpr === dpr
    ) {
      return
    }

    this.canvas.width = Math.round(wCss * dpr)
    this.canvas.height = Math.round(hCss * dpr)
    this.canvas.style.width = `${wCss}px`
    this.canvas.style.height = `${hCss}px`
    this.escalaCanvas = dpr
    this.larguraCss = wCss
    this.alturaCss = hCss

    if (this.ctx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0)
      this.ctx.scale(dpr, dpr)
    }

    this.ultimoTamanho = { w: wCss, h: hCss, dpr }
  }

  _corPorEstado() {
    switch (this.estadoVisual) {
      case 'ouvindo': return this.corOuvindo
      case 'pensando': return this.corPensando
      case 'pesquisando': return this.corPesquisa
      case 'respondendo': return this.corFalando
      case 'falando': return this.corAcentoClaro
      default: return this.corAcento
    }
  }

  definirEstadoVisual(estado) {
    if (estado !== this.estadoVisual && this.fonteAtiva === 'fallback') {
      // Reinicia a fase da animacao ao trocar de estado em modo fallback, para a
      // transicao entre padroes (idle/ouvindo/pensando/falando) ficar suave.
      this.fallbackTickInicio = performance.now()
    }
    this.estadoVisual = estado
    this._lerCorAcento()
  }

  conectarMicrofone(analyser, audioCtx) {
    this.analisadorMic = analyser
    this.audioCtxRefMic = audioCtx
    this.fonteAtiva = 'mic'
    this._iniciarLoop()
  }

  conectarElementoAudio(elementoAudio) {
    if (!elementoAudio) return
    if (!this.audioCtxAudio) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        this.audioCtxAudio = new Ctx()
        this.analisadorAudio = this.audioCtxAudio.createAnalyser()
        this.analisadorAudio.fftSize = 1024
        this.analisadorAudio.smoothingTimeConstant = 0.5
        this.analisadorAudio.minDecibels = -90
        this.analisadorAudio.maxDecibels = -10
        this.analisadorAudio.connect(this.audioCtxAudio.destination)
      } catch (err) {
        log(`Falha ao criar AudioContext de playback: ${err.message}`)
        this.fonteAtiva = 'fallback'
        this._iniciarLoop()
        return
      }
    }

    if (this.elementoAudioAtual === elementoAudio) {
      this.fonteAtiva = 'audio'
      this._iniciarLoop()
      return
    }

    if (this._elementosConectados && this._elementosConectados.has(elementoAudio)) {
      this.elementoAudioAtual = elementoAudio
      this.fonteAtiva = 'audio'
      this._iniciarLoop()
      return
    }

    try {
      const fonte = this.audioCtxAudio.createMediaElementSource(elementoAudio)
      fonte.connect(this.analisadorAudio)
      if (!this._elementosConectados) this._elementosConectados = new WeakSet()
      this._elementosConectados.add(elementoAudio)
      this.elementoAudioAtual = elementoAudio
      this.fonteAtiva = 'audio'
      this._iniciarLoop()
    } catch (err) {
      log(`Falha ao conectar elemento ao analisador: ${err.message}`)
      this.fonteAtiva = 'fallback'
      this._iniciarLoop()
    }
  }

  desconectarElementoAudio() {
    this.elementoAudioAtual = null
  }

  usarFallbackSuave() {
    this.fonteAtiva = 'fallback'
    this.fallbackTickInicio = performance.now()
    this._iniciarLoop()
  }

  pausar() {
    this.fonteAtiva = null
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame)
      this.animFrame = null
    }
    this.targets.fill(0)
  }

  revalidar() {
    this.ultimoTamanho = { w: 0, h: 0, dpr: 0 }
    this._configurarCanvas()
  }

  _iniciarLoop() {
    if (this.animFrame || !this.ctx) return
    const tick = () => {
      this._atualizarAmplitudes()
      this._desenhar()
      this.animFrame = requestAnimationFrame(tick)
    }
    this.animFrame = requestAnimationFrame(tick)
  }

  _atualizarAmplitudes() {
    if (this.fonteAtiva === 'mic' && this.analisadorMic) {
      this._lerDoAnalisador(this.analisadorMic, this.audioCtxRefMic, 1.6)
    } else if (this.fonteAtiva === 'audio' && this.analisadorAudio) {
      this._lerDoAnalisador(this.analisadorAudio, this.audioCtxAudio, 1.25)
    } else if (this.fonteAtiva === 'fallback') {
      this._gerarFallback()
    } else {
      this.targets.fill(0)
    }

    for (let i = 0; i < this.numBarras; i++) {
      const alvo = this.targets[i]
      const atual = this.amplitudes[i]
      const subindo = alvo > atual
      const k = subindo ? SUAVIZACAO_SUBIDA : SUAVIZACAO_DESCIDA
      this.amplitudes[i] = atual * k + alvo * (1 - k)
    }
  }

  _lerDoAnalisador(analyser, audioCtx, ganho) {
    const bufferLength = analyser.frequencyBinCount
    if (!this._bufferFFT || this._bufferFFT.length !== bufferLength) {
      this._bufferFFT = new Uint8Array(bufferLength)
    }
    analyser.getByteFrequencyData(this._bufferFFT)
    const data = this._bufferFFT

    const sampleRate = (audioCtx && audioCtx.sampleRate) || 48000
    const fftSize = analyser.fftSize
    const binPorHz = fftSize / sampleRate
    const metade = Math.floor(this.numBarras / 2)

    let somaTotal = 0
    let countTotal = 0

    for (let i = 0; i < metade; i++) {
      const t0 = i / metade
      const t1 = (i + 1) / metade
      const fInicio = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t0)
      const fFim = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t1)
      const binInicio = Math.max(0, Math.floor(fInicio * binPorHz))
      const binFim = Math.min(bufferLength - 1, Math.ceil(fFim * binPorHz))

      let soma = 0
      let count = 0
      for (let j = binInicio; j <= binFim; j++) {
        soma += data[j]
        count++
      }

      const media = count > 0 ? (soma / count) / 255 : 0
      const compensacaoAgudos = 1 + (i / metade) * 0.9
      let valor = media * ganho * compensacaoAgudos

      somaTotal += valor
      countTotal++

      const valorFinal = Math.min(1, Math.pow(valor, 0.85))
      const indEsq = metade - 1 - i
      const indDir = metade + i
      this.targets[indEsq] = valorFinal
      if (indDir < this.numBarras) this.targets[indDir] = valorFinal
    }

    const mediaQuadro = countTotal > 0 ? somaTotal / countTotal : 0
    if (mediaQuadro < 0.04) {
      for (let i = 0; i < this.numBarras; i++) this.targets[i] *= 0.5
    }
  }

  _gerarFallback() {
    if (prefereMenosMovimento) {
      this.targets.fill(0.1)
      return
    }
    const t = (performance.now() - this.fallbackTickInicio) / 1000
    const metade = Math.floor(this.numBarras / 2)
    const estado = this.estadoVisual

    for (let i = 0; i < metade; i++) {
      const norm = i / metade           // 0 no centro -> 1 na borda
      let valor

      if (estado === 'idle') {
        // Respiracao lenta e bem sutil, quase parado.
        const resp = (Math.sin(t * 0.9) + 1) / 2
        valor = 0.05 + resp * 0.06 + Math.sin(t * 1.1 + norm * 2) * 0.01

      } else if (estado === 'ouvindo') {
        // Receptivo e atento: pulso suave que "abre" do centro pra fora, como
        // se estivesse captando a voz. Mais vivo no centro.
        const pulso = (Math.sin(t * 3.4 - norm * 3) + 1) / 2
        const env = 1 - norm * 0.55
        valor = 0.08 + pulso * 0.32 * env

      } else if (estado === 'pensando' || estado === 'pesquisando') {
        // Onda que CIRCULA pelas barras (sensacao de processar/girar). Pesquisa
        // gira um pouco mais rapido que pensar.
        const vel = estado === 'pesquisando' ? 4.2 : 2.8
        const onda = (Math.sin(t * vel - i * 0.9) + 1) / 2
        valor = 0.10 + Math.pow(onda, 1.6) * 0.42

      } else if (estado === 'falando' || estado === 'respondendo') {
        // Cadencia de fala: amplitude expressiva e variada, com "silabas".
        const fala = Math.abs(Math.sin(t * 5.2 + norm * 2.3)) * 0.6
                   + Math.abs(Math.sin(t * 8.7 + norm * 4.1)) * 0.3
        const env = 1 - norm * 0.35
        valor = 0.10 + fala * 0.55 * env

      } else {
        // Generico suave (estados intermediarios).
        const fase = norm * Math.PI * 1.5
        const base = (Math.sin(t * 2.1 + fase) + Math.sin(t * 1.3 + fase * 1.7)) / 4 + 0.5
        valor = FALLBACK_AMP_MIN + base * (FALLBACK_AMP_MAX - FALLBACK_AMP_MIN)
      }

      valor = Math.max(0, Math.min(1, valor))
      const indEsq = metade - 1 - i
      const indDir = metade + i
      this.targets[indEsq] = valor
      if (indDir < this.numBarras) this.targets[indDir] = valor
    }
  }

  _desenhar() {
    if (!this.ctx || !this.canvas) return
    const w = this.larguraCss || this.canvas.clientWidth
    const h = this.alturaCss || this.canvas.clientHeight
    if (!w || !h) return

    this.ctx.clearRect(0, 0, w, h)

    const cx = w / 2
    const cy = h / 2
    const tamanho = Math.min(w, h)

    const raioMin = tamanho * 0.40
    const comprimentoMin = tamanho * 0.018
    const comprimentoMax = tamanho * 0.13

    const cor = this._corPorEstado()
    const corBase = this._comAlpha(cor, 0.92)
    const corPonta = this._comAlpha(cor, 0.10)

    this.ctx.lineCap = 'round'
    this.ctx.lineWidth = Math.max(1.5, tamanho * 0.011)

    for (let i = 0; i < this.numBarras; i++) {
      const angulo = (i / this.numBarras) * Math.PI * 2 - Math.PI / 2
      const amp = this.amplitudes[i]
      const comprimento = comprimentoMin + (comprimentoMax - comprimentoMin) * amp
      const cosA = Math.cos(angulo)
      const sinA = Math.sin(angulo)
      const x1 = cx + cosA * raioMin
      const y1 = cy + sinA * raioMin
      const x2 = cx + cosA * (raioMin + comprimento)
      const y2 = cy + sinA * (raioMin + comprimento)

      const grad = this.ctx.createLinearGradient(x1, y1, x2, y2)
      grad.addColorStop(0, corBase)
      grad.addColorStop(1, corPonta)
      this.ctx.strokeStyle = grad
      this.ctx.beginPath()
      this.ctx.moveTo(x1, y1)
      this.ctx.lineTo(x2, y2)
      this.ctx.stroke()
    }
  }

  _comAlpha(cor, alpha) {
    if (!cor) return `rgba(212,184,150,${alpha})`
    if (cor.startsWith('#')) {
      let hex = cor.slice(1)
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${alpha})`
    }
    return cor
  }

  destruir() {
    this.pausar()
    this.desconectarElementoAudio()
    this.analisadorMic = null
    this.audioCtxRefMic = null
    if (this._observador) {
      try { this._observador.disconnect() } catch { /* ignora */ }
      this._observador = null
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize)
      this._onResize = null
    }
  }
}

export function gerarCorPorNome(nome) {
  if (!nome) return { de: '#3a3a45', ate: '#52525B' }
  let hash = 0
  for (let i = 0; i < nome.length; i++) {
    hash = (hash * 31 + nome.charCodeAt(i)) | 0
  }
  const tom = Math.abs(hash) % 360
  const sat = 38 + (Math.abs(hash >> 4) % 18)
  const lumA = 55
  const lumB = 38
  return {
    de: `hsl(${tom} ${sat}% ${lumA}%)`,
    ate: `hsl(${(tom + 24) % 360} ${sat}% ${lumB}%)`,
  }
}
