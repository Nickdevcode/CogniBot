const API_URL = window.location.origin + '/api'

async function jsonOk(resposta) {
  const dados = await resposta.json().catch(() => ({}))
  if (!resposta.ok) {
    const msg = dados?.erro || `Erro ${resposta.status}`
    throw new Error(msg)
  }
  return dados
}

export async function listarUsuarios() {
  const resp = await fetch(`${API_URL}/usuarios`)
  return jsonOk(resp)
}

export async function criarUsuario(nome) {
  const resp = await fetch(`${API_URL}/usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome }),
  })
  return jsonOk(resp)
}

export async function excluirUsuario(id) {
  const resp = await fetch(`${API_URL}/usuarios/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return jsonOk(resp)
}

export async function obterUsuario(id) {
  const resp = await fetch(`${API_URL}/usuarios/${encodeURIComponent(id)}`)
  return jsonOk(resp)
}

export async function resetarConversa(usuarioId) {
  const resp = await fetch(`${API_URL}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuarioId }),
  })
  return jsonOk(resp)
}

export async function verificarSaude() {
  const resp = await fetch(`${API_URL}/health`)
  return jsonOk(resp)
}

export function enviarConversa({ audioBlob, usuarioId, imagem, usarRobo, signal }) {
  const formData = new FormData()
  formData.append('audio', audioBlob, 'audio.webm')
  formData.append('usuarioId', usuarioId)
  if (imagem) formData.append('imagem', imagem)
  if (usarRobo) formData.append('usarRobo', 'true')

  return fetch(`${API_URL}/conversation`, {
    method: 'POST',
    body: formData,
    signal,
  })
}

export function streamStatusESP(onEstado) {
  const url = `${API_URL}/esp/status/stream`
  const source = new EventSource(url)
  source.addEventListener('estado', (ev) => {
    try {
      onEstado(JSON.parse(ev.data))
    } catch { /* ignora json invalido */ }
  })
  return () => source.close()
}

// --- Controle do robo pela interface (painel de controle) ---

// Define qual perfil/usuario o robo passa a usar (memorias, idade, idioma).
export async function definirUsuarioRobo(usuarioId) {
  const resp = await fetch(`${API_URL}/esp/usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuarioId }),
  })
  return jsonOk(resp)
}

// Muta/desmuta o mic do robo (servidor descarta o audio quando mutado).
export async function definirMicRobo(mutado) {
  const resp = await fetch(`${API_URL}/esp/mic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutado }),
  })
  return jsonOk(resp)
}

// Liga/desliga o robo (gate). Desligado = robo mudo (nao escuta nada).
export async function definirRoboHabilitado(habilitado) {
  const resp = await fetch(`${API_URL}/esp/habilitar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ habilitado }),
  })
  return jsonOk(resp)
}

// Interrompe o robo (encerra a fala/captura atual). `comFeedback=false` quando o
// interromper e so uma etapa de outra acao (o reset, que ja mostra o proprio icone
// no rosto do robo) — evita duas animacoes brigando no mesmo segundo.
export async function interromperRobo(comFeedback = true) {
  const resp = await fetch(`${API_URL}/esp/interromper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback: comFeedback }),
  })
  return jsonOk(resp)
}

// Posição do rosto da criança (0..1) para os olhos do robô acompanharem. Vai a
// ~10Hz, então é deliberadamente leve: sem await, sem tratamento de resposta, e
// `keepalive` pra requisição não morrer se a página estiver ocupada. Perder uma
// amostra não tem consequência — a próxima chega em 100ms.
export function enviarOlhar(x, y, t) {
  return fetch(`${API_URL}/esp/olhar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, t }),
    keepalive: true,
  }).catch(() => {})
}

// PERCEPCAO da crianca vista pela webcam (emocao facial ou gesto de mao), ex.:
// 'crianca-feliz', 'gesto-joinha'. O SERVIDOR e quem decide qual reacao o robo faz (a
// "alma" mora la, em esp-visao.js). Fire-and-forget, igual ao enviarOlhar: o cliente ja
// filtra (histerese/cooldown), entao isto sai raramente e perder um envio nao tem
// consequencia - a proxima percepcao chega logo.
export function enviarReacaoVisual(percepcao) {
  return fetch(`${API_URL}/esp/reacao-visual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ percepcao }),
    keepalive: true,
  }).catch(() => {})
}

// Avisa o servidor que a webcam do PC ligou/desligou. A camera vive aqui no
// navegador, entao sem este aviso o robo nao teria como reagir ao botao de camera.
export function notificarCameraRobo(ativa) {
  return fetch(`${API_URL}/esp/camera`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ativa }),
  }).catch(() => {})   // feedback visual e enfeite: nunca quebra o toggle da camera
}

// Envia um frame da webcam do PC pro servidor (visao da Cogni no caminho do robo
// fisico). Fire-and-forget: o pipeline do robo nao espera por isto — o frame e
// capturado no inicio da fala e fica disponivel quando a IA roda, segundos depois.
// Sem jsonOk pra nao lancar em rede ruim (a falha de um frame nao deve quebrar nada).
export function enviarFrameWebcam(imagem) {
  return fetch(`${API_URL}/esp/webcam/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imagem }),
  })
}

export const api = {
  url: API_URL,
  listarUsuarios,
  criarUsuario,
  excluirUsuario,
  obterUsuario,
  resetarConversa,
  verificarSaude,
  enviarConversa,
  streamStatusESP,
  definirUsuarioRobo,
  definirMicRobo,
  definirRoboHabilitado,
  interromperRobo,
  notificarCameraRobo,
  enviarOlhar,
  enviarReacaoVisual,
  enviarFrameWebcam,
}
