import { criarLogger } from './logger.js'
import { atualizarStatusESP, atualizarSnapshotCam } from './ui.js'

const log = criarLogger('ESP')

let intervaloSnapshot = null
let cancelarStream = null
let cancelarAtividade = null
let estadoAtual = null

export function obterEstadoESP() {
  return estadoAtual
}

export function temCameraESPAtiva() {
  if (!estadoAtual) return false
  const ms = estadoAtual.camera?.ultimoFrameMs
  return estadoAtual.camera?.conectados > 0 && ms !== null && ms < 5000
}

export function iniciarMonitoramentoESP({ onMudanca, onAtividade } = {}) {
  pararMonitoramento()

  const onEstado = (estado) => {
    estadoAtual = estado
    atualizarStatusESP(estado)
    onMudanca?.(estado)
  }

  try {
    const source = new EventSource('/api/esp/status/stream')
    source.addEventListener('estado', (ev) => {
      try { onEstado(JSON.parse(ev.data)) } catch { /* ignora */ }
    })
    source.onerror = () => {
      log('SSE de status caiu — fallback para polling')
      try { source.close() } catch { /* ignora */ }
      iniciarPolling(onEstado)
    }
    cancelarStream = () => { try { source.close() } catch { /* ignora */ } }
  } catch (err) {
    log(`Falha ao iniciar SSE: ${err.message} — usando polling`)
    iniciarPolling(onEstado)
  }

  // Segundo SSE: atividade do robo em tempo real (transcricao da crianca,
  // resposta da Cogni, estado ouvindo/pensando/falando). Separado do status
  // porque carrega texto/estado da conversa, nao so o estado de conexao.
  if (onAtividade) {
    try {
      const sa = new EventSource('/api/esp/atividade/stream')
      sa.addEventListener('atividade', (ev) => {
        try { onAtividade(JSON.parse(ev.data)) } catch { /* ignora */ }
      })
      // O EventSource reconecta sozinho; aqui so registramos para depuracao.
      sa.onerror = () => log('SSE de atividade caiu — reconectando automaticamente')
      cancelarAtividade = () => { try { sa.close() } catch { /* ignora */ } }
    } catch (err) {
      log(`Falha ao iniciar SSE de atividade: ${err.message}`)
    }
  }

  iniciarSnapshotPeriodico()
}

function iniciarPolling(onEstado) {
  const tick = async () => {
    try {
      const resp = await fetch('/api/esp/status', { cache: 'no-store' })
      const dados = await resp.json()
      if (dados?.estado) onEstado(dados.estado)
    } catch { /* silencioso */ }
  }
  tick()
  const id = setInterval(tick, 5000)
  cancelarStream = () => clearInterval(id)
}

function iniciarSnapshotPeriodico() {
  pararSnapshot()
  const tick = async () => {
    if (!temCameraESPAtiva()) {
      atualizarSnapshotCam(null)
      return
    }
    try {
      const resp = await fetch('/api/esp/camera/snapshot?t=' + Date.now(), { cache: 'no-store' })
      if (!resp.ok) return
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      atualizarSnapshotCam(url)
      setTimeout(() => URL.revokeObjectURL(url), 6000)
    } catch { /* ignora */ }
  }
  tick()
  intervaloSnapshot = setInterval(tick, 4000)
}

function pararSnapshot() {
  if (intervaloSnapshot) {
    clearInterval(intervaloSnapshot)
    intervaloSnapshot = null
  }
}

export function pararMonitoramento() {
  // Zera o estado em cache: senao, ao trocar de usuario, obterEstadoESP()
  // retornaria o estado antigo (stale) antes do novo SSE chegar, podendo
  // disparar POSTs duplicados de perfil.
  estadoAtual = null
  if (cancelarStream) {
    cancelarStream()
    cancelarStream = null
  }
  if (cancelarAtividade) {
    cancelarAtividade()
    cancelarAtividade = null
  }
  pararSnapshot()
}
