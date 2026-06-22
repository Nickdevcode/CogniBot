import { criarLogger } from './logger.js'

const log = criarLogger('Audio')
const logMic = criarLogger('Mic')

export const VAD_LIMIAR = 0.12
export const VAD_LIMIAR_INTERRUPCAO = 0.05
export const SILENCIO_MS = 2000
export const CHECK_INTERVAL_MS = 20
export const TAMANHO_MINIMO_BLOB = 6000
export const VAD_FRAMES_CONSECUTIVOS = 3
export const VAD_FRAMES_INTERRUPCAO = 1
export const GRACE_PERIOD_MS = 600
export const NOISE_FLOOR_MARGEM = 3.0

export class GerenciadorAudio {
  constructor() {
    this.micStream = null
    this.micStreamFiltrado = null
    this.audioContext = null
    this.analyser = null
    this.mediaRecorder = null
    this.audioChunks = []
    this.gravando = false
    this.audioAtual = null
    this.audioUrlAtual = null
    this.noiseFloorNivel = 0.05
    this.onAudioElemento = null
    this.audiosAtivos = new Set()
  }

  _registrarAudio(audio, url) {
    this.audiosAtivos.add({ audio, url })
  }

  _silenciarTodosAudios() {
    for (const item of this.audiosAtivos) {
      try {
        item.audio.pause()
        item.audio.muted = true
        item.audio.currentTime = 0
        item.audio.src = ''
        item.audio.load()
      } catch { /* ignora */ }
      try { URL.revokeObjectURL(item.url) } catch { /* ignora */ }
    }
    this.audiosAtivos.clear()
  }

  definirCallbackAudioElemento(callback) {
    this.onAudioElemento = typeof callback === 'function' ? callback : null
  }

  async ativar() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    })

    const Ctx = window.AudioContext || window.webkitAudioContext
    this.audioContext = new Ctx()
    const source = this.audioContext.createMediaStreamSource(this.micStream)

    const highpass = this.audioContext.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 85
    highpass.Q.value = 0.7

    const lowpass = this.audioContext.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 3500
    lowpass.Q.value = 0.7

    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.3

    this.analyserVisual = this.audioContext.createAnalyser()
    this.analyserVisual.fftSize = 1024
    this.analyserVisual.smoothingTimeConstant = 0.55
    this.analyserVisual.minDecibels = -90
    this.analyserVisual.maxDecibels = -10

    this.analyserInterrupcao = this.audioContext.createAnalyser()
    this.analyserInterrupcao.fftSize = 512
    this.analyserInterrupcao.smoothingTimeConstant = 0.0
    this.analyserInterrupcao.minDecibels = -85
    this.analyserInterrupcao.maxDecibels = -10

    const destination = this.audioContext.createMediaStreamDestination()
    source.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(this.analyser)
    lowpass.connect(destination)
    source.connect(this.analyserVisual)
    source.connect(this.analyserInterrupcao)

    this.micStreamFiltrado = destination.stream
    this.noiseFloorNivel = 0.05

    logMic('Microfone ativado (highpass 85Hz, lowpass 3500Hz, analyser visual em paralelo)')
  }

  desativar({ enviarBlobAtual = false } = {}) {
    if (this.gravando && this.mediaRecorder?.state === 'recording') {
      if (!enviarBlobAtual) this.abortarProximoBlob = true
      try { this.mediaRecorder.stop() } catch { /* já parado */ }
      this.gravando = false
    }
    if (this.audioContext) {
      try { this.audioContext.close() } catch { /* já fechado */ }
      this.audioContext = null
      this.analyser = null
      this.analyserVisual = null
      this.analyserInterrupcao = null
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop())
      this.micStream = null
    }
    this.micStreamFiltrado = null
    this.noiseFloorNivel = 0.05
    logMic(`Microfone desativado (audio playback nao foi afetado${enviarBlobAtual ? ', blob atual sera enviado' : ''})`)
  }

  obterNivel() {
    if (!this.analyser) return 0
    const bufferLength = this.analyser.frequencyBinCount
    const data = new Uint8Array(bufferLength)
    this.analyser.getByteFrequencyData(data)

    const sampleRate = this.audioContext.sampleRate
    const binSize = sampleRate / this.analyser.fftSize

    const minVoz = Math.floor(100 / binSize)
    const maxVoz = Math.ceil(3000 / binSize)
    const minFund = Math.floor(85 / binSize)
    const maxFund = Math.ceil(300 / binSize)

    let somaVoz = 0, countVoz = 0
    let somaFund = 0, countFund = 0

    for (let i = minVoz; i <= maxVoz && i < bufferLength; i++) {
      const n = data[i] / 255
      somaVoz += n * n
      countVoz++
    }
    for (let i = minFund; i <= maxFund && i < bufferLength; i++) {
      const n = data[i] / 255
      somaFund += n * n
      countFund++
    }

    if (countVoz === 0) return 0

    const rmsVoz = Math.sqrt(somaVoz / countVoz)
    const rmsFund = countFund > 0 ? Math.sqrt(somaFund / countFund) : 0
    const peso = rmsFund > 0.05 ? 1.3 : 0.7
    const nivel = rmsVoz * peso

    if (!this.gravando) {
      this.noiseFloorNivel = this.noiseFloorNivel * 0.99 + rmsVoz * 0.01
    }

    const limiarDinamico = this.noiseFloorNivel * NOISE_FLOOR_MARGEM
    return Math.max(0, nivel - limiarDinamico)
  }

  obterNivelInterrupcao() {
    const analisador = this.analyserInterrupcao || this.analyserVisual || this.analyser
    if (!analisador) return 0
    const bufferLength = analisador.frequencyBinCount
    const data = new Uint8Array(bufferLength)
    analisador.getByteFrequencyData(data)

    const sampleRate = this.audioContext.sampleRate
    const binSize = sampleRate / analisador.fftSize

    const minFund = Math.floor(85 / binSize)
    const maxFund = Math.ceil(255 / binSize)
    const minVoz = Math.floor(300 / binSize)
    const maxVoz = Math.ceil(4000 / binSize)

    let somaFund = 0, countFund = 0
    let somaVoz = 0, countVoz = 0

    for (let i = minFund; i <= maxFund && i < bufferLength; i++) {
      const n = data[i] / 255
      somaFund += n * n
      countFund++
    }
    for (let i = minVoz; i <= maxVoz && i < bufferLength; i++) {
      const n = data[i] / 255
      somaVoz += n * n
      countVoz++
    }

    const rmsFund = countFund > 0 ? Math.sqrt(somaFund / countFund) : 0
    const rmsVoz = countVoz > 0 ? Math.sqrt(somaVoz / countVoz) : 0

    return rmsFund * 0.55 + rmsVoz * 0.45
  }

  iniciarGravacao(onCompleta) {
    if (!this.micStream || this.gravando) return false
    const stream = this.micStreamFiltrado || this.micStream
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    this.audioChunks = []

    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.audioChunks.push(ev.data)
    }

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.audioChunks, { type: 'audio/webm' })
      log(`Gravacao finalizada (${(blob.size / 1024).toFixed(1)}KB)`)
      if (this.abortarProximoBlob) {
        log('Audio abortado (mic foi desativado durante gravacao)')
        this.abortarProximoBlob = false
        return
      }
      if (blob.size > TAMANHO_MINIMO_BLOB) {
        onCompleta(blob)
      } else {
        log('Audio descartado (muito curto)')
      }
    }

    this.mediaRecorder.start()
    this.gravando = true
    return true
  }

  pararGravacao() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop() } catch { /* ignora */ }
      this.gravando = false
    }
  }

  reproduzirBase64Mp3(audioBase64, callbacks = {}) {
    const { onMetadata, onProgresso, onFim } = callbacks
    return new Promise((resolve) => {
      const bytes = atob(audioBase64)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      const blob = new Blob([arr], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)

      this.parar()

      const audio = new Audio(url)
      audio.crossOrigin = 'anonymous'
      this.audioAtual = audio
      this.audioUrlAtual = url
      this._registrarAudio(audio, url)
      if (this.onAudioElemento) {
        try { this.onAudioElemento(audio) } catch { /* ignora */ }
      }

      let finalizado = false
      const finalizar = (motivo) => {
        if (finalizado) return
        finalizado = true
        URL.revokeObjectURL(url)
        if (this.audioAtual === audio) {
          this.audioAtual = null
          this.audioUrlAtual = null
        }
        if (typeof onFim === 'function') onFim({ motivo })
        resolve({ interrompido: motivo === 'interrompido', erro: motivo === 'erro' })
      }

      audio.addEventListener('loadedmetadata', () => {
        if (typeof onMetadata === 'function') {
          onMetadata({ duracaoMs: audio.duration * 1000 })
        }
      })

      if (typeof onProgresso === 'function') {
        audio.addEventListener('timeupdate', () => {
          if (finalizado) return
          const total = audio.duration
          if (!isFinite(total) || total <= 0) return
          onProgresso({ atualMs: audio.currentTime * 1000, totalMs: total * 1000 })
        })
      }

      audio.addEventListener('ended', () => finalizar('fim'))
      audio.addEventListener('error', () => finalizar('erro'))
      audio.addEventListener('pause', () => {
        if (audio.currentTime < (audio.duration || 0) - 0.05) {
          finalizar('interrompido')
        }
      })

      audio.play().catch((err) => {
        log(`Falha ao iniciar reproducao: ${err.message}`)
        finalizar('erro')
      })
    })
  }

  parar() {
    if (this.filaAtual) {
      try { this.filaAtual.cancelar() } catch { /* ignora */ }
      this.filaAtual = null
    }

    this._silenciarTodosAudios()

    this.audioAtual = null
    this.audioUrlAtual = null
  }

  criarFilaReproducao(callbacks = {}) {
    const { onPrimeiroChunk, onFim } = callbacks
    const pendentes = new Map()
    let proximoIndice = 0
    let cancelado = false
    let tocando = false
    let reproducaoAtual = null
    let primeiroTocou = false
    let resolverPromise = null
    let totalEsperado = null
    let chunksTocados = 0
    const promiseFim = new Promise((resolve) => { resolverPromise = resolve })

    this.parar()
    this.filaAtual = {
      cancelar: () => {
        cancelado = true
        if (reproducaoAtual) {
          try {
            reproducaoAtual.pause()
            reproducaoAtual.muted = true
            reproducaoAtual.currentTime = 0
            reproducaoAtual.src = ''
            reproducaoAtual.load()
          } catch { /* ignora */ }
        }
        pendentes.clear()
        if (resolverPromise) {
          resolverPromise({ motivo: 'interrompido' })
          resolverPromise = null
        }
      },
    }

    const playNext = () => {
      if (cancelado) return
      if (!pendentes.has(proximoIndice)) {
        if (totalEsperado !== null && chunksTocados >= totalEsperado) {
          finalizar('fim')
        }
        return
      }
      const item = pendentes.get(proximoIndice)
      pendentes.delete(proximoIndice)
      proximoIndice++
      tocando = true
      tocarBuffer(item.audioBase64, item.texto)
    }

    const tocarBuffer = (audioBase64, _texto) => {
      const bytes = atob(audioBase64)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      const blob = new Blob([arr], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)

      const audio = new Audio(url)
      audio.preload = 'auto'
      audio.crossOrigin = 'anonymous'
      this.audioAtual = audio
      this.audioUrlAtual = url
      reproducaoAtual = audio
      this._registrarAudio(audio, url)
      if (this.onAudioElemento) {
        try { this.onAudioElemento(audio) } catch { /* ignora */ }
      }

      const cleanup = () => {
        URL.revokeObjectURL(url)
        if (this.audioAtual === audio) {
          this.audioAtual = null
          this.audioUrlAtual = null
        }
        if (reproducaoAtual === audio) reproducaoAtual = null
      }

      audio.addEventListener('ended', () => {
        cleanup()
        chunksTocados++
        tocando = false
        if (cancelado) return
        playNext()
      })
      audio.addEventListener('error', () => {
        cleanup()
        chunksTocados++
        tocando = false
        if (cancelado) return
        playNext()
      })
      audio.addEventListener('pause', () => {
        if (audio.currentTime < (audio.duration || 0) - 0.05 && !cancelado) {
          finalizar('interrompido')
        }
      })

      audio.play().then(() => {
        if (!primeiroTocou) {
          primeiroTocou = true
          if (typeof onPrimeiroChunk === 'function') onPrimeiroChunk()
        }
      }).catch(() => {
        cleanup()
        tocando = false
        if (!cancelado) playNext()
      })
    }

    const finalizar = (motivo) => {
      if (!resolverPromise) return
      const r = resolverPromise
      resolverPromise = null
      if (typeof onFim === 'function') onFim({ motivo })
      r({ motivo })
    }

    return {
      adicionar: (indice, audioBase64, texto) => {
        if (cancelado) return
        pendentes.set(indice, { audioBase64, texto })
        if (!tocando) playNext()
      },
      finalizar: (totalChunks) => {
        totalEsperado = totalChunks
        if (!tocando && chunksTocados >= totalEsperado) {
          finalizar('fim')
        }
      },
      promise: promiseFim,
    }
  }
}
