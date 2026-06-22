const el = {
  ponto: document.getElementById('ponto-status'),
  textoStatus: document.getElementById('texto-status'),
  ativarArea: document.getElementById('ativar-area'),
  btnAtivar: document.getElementById('btn-ativar'),
  playerArea: document.getElementById('player-area'),
  visualizador: document.getElementById('visualizador'),
  textoFala: document.getElementById('texto-fala'),
  textoTranscricao: document.getElementById('texto-transcricao'),
  btnReplay: document.getElementById('btn-replay'),
  toggleAuto: document.getElementById('toggle-auto'),
  listaHistorico: document.getElementById('lista-historico'),
}

let audioAtivado = false
let ultimoAudioUrl = null
const audioEl = new Audio()
let primeiroItem = true

function definirStatus(estado, texto) {
  el.ponto.className = 'ponto' + (estado ? ' ' + estado : '')
  el.textoStatus.textContent = texto
}

function base64ParaBytes(base64) {
  const bin = atob(base64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// Monta um cabecalho WAV (44 bytes) na frente do PCM para o navegador tocar.
// O robo recebe o PCM cru; aqui no navegador envelopamos em WAV.
function pcmParaWavBlob(pcmBytes, sampleRate) {
  const numCanais = 1
  const bitsPorAmostra = 16
  const byteRate = sampleRate * numCanais * (bitsPorAmostra / 8)
  const blockAlign = numCanais * (bitsPorAmostra / 8)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const escreverTexto = (offset, txt) => { for (let i = 0; i < txt.length; i++) view.setUint8(offset + i, txt.charCodeAt(i)) }

  escreverTexto(0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.length, true)
  escreverTexto(8, 'WAVE')
  escreverTexto(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)            // PCM
  view.setUint16(22, numCanais, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPorAmostra, true)
  escreverTexto(36, 'data')
  view.setUint32(40, pcmBytes.length, true)

  return new Blob([header, pcmBytes], { type: 'audio/wav' })
}

// Converte o evento (audio em base64) numa URL tocavel. Suporta PCM (envelopa em
// WAV) e mp3 (legado).
function eventoParaBlobUrl(evento) {
  const bytes = base64ParaBytes(evento.audioBase64)
  let blob
  if (evento.formato === 'pcm') {
    blob = pcmParaWavBlob(bytes, evento.sampleRate || 24000)
  } else {
    blob = new Blob([bytes], { type: 'audio/mpeg' })
  }
  return URL.createObjectURL(blob)
}

function animarVisualizador(ligado) {
  el.visualizador.classList.toggle('tocando', ligado)
  const barras = el.visualizador.querySelectorAll('.barra-viz')
  if (!ligado) {
    barras.forEach(b => { b.style.height = '8px' })
  }
}

let rafViz = null
function loopVisualizador() {
  const barras = el.visualizador.querySelectorAll('.barra-viz')
  if (audioEl.paused || audioEl.ended) {
    barras.forEach(b => { b.style.height = '8px' })
    animarVisualizador(false)
    return
  }
  barras.forEach((b, i) => {
    const altura = 8 + Math.abs(Math.sin(Date.now() / 140 + i * 0.7)) * 48
    b.style.height = altura.toFixed(0) + 'px'
  })
  rafViz = requestAnimationFrame(loopVisualizador)
}

function tocar(url) {
  if (ultimoAudioUrl && ultimoAudioUrl !== url) {
    try { URL.revokeObjectURL(ultimoAudioUrl) } catch { /* ignora */ }
  }
  ultimoAudioUrl = url
  audioEl.src = url
  audioEl.play().then(() => {
    animarVisualizador(true)
    cancelAnimationFrame(rafViz)
    loopVisualizador()
  }).catch(err => {
    console.warn('Falha ao tocar:', err.message)
  })
  el.btnReplay.disabled = false
}

function formatarHora(ts) {
  const d = new Date(ts || Date.now())
  return d.toLocaleTimeString('pt-BR', { hour12: false })
}

function rotuloOrigem(origem) {
  if (origem === 'robo-mic') return 'mic do robô'
  if (origem === 'falar') return 'comando falar'
  return origem || 'robô'
}

// Cria um <elemento> com classe e texto de forma segura (sempre textContent,
// nunca innerHTML com dados dinamicos — evita XSS vindo da transcricao/resposta).
function criarEl(tag, classe, texto) {
  const e = document.createElement(tag)
  if (classe) e.className = classe
  if (texto != null) e.textContent = texto
  return e
}

function adicionarHistorico(evento, url) {
  if (primeiroItem) { el.listaHistorico.textContent = ''; primeiroItem = false }
  const item = criarEl('div', 'item-hist')

  const topo = criarEl('div', 'item-hist-topo')
  topo.append(
    criarEl('span', 'item-hist-origem', rotuloOrigem(evento.origem)),
    criarEl('span', 'item-hist-hora', formatarHora(evento.em)),
  )
  item.append(topo)

  item.append(criarEl('div', 'item-hist-texto', evento.texto || '(sem texto)'))

  if (evento.transcricao) {
    item.append(criarEl('div', 'item-hist-transc', 'você disse: "' + evento.transcricao + '"'))
  }

  const btn = criarEl('button', 'item-hist-btn', '▶ Tocar')
  btn.addEventListener('click', () => tocar(url))
  item.append(btn)

  el.listaHistorico.prepend(item)
  while (el.listaHistorico.children.length > 15) {
    el.listaHistorico.removeChild(el.listaHistorico.lastChild)
  }
}

function aoReceberAudio(evento) {
  const url = eventoParaBlobUrl(evento)

  el.textoFala.textContent = evento.texto || '(resposta sem texto)'
  el.textoFala.classList.toggle('vazio', !evento.texto)

  if (evento.transcricao) {
    el.textoTranscricao.textContent = 'você disse: "' + evento.transcricao + '"'
    el.textoTranscricao.classList.remove('escondido')
  } else {
    el.textoTranscricao.classList.add('escondido')
  }

  adicionarHistorico(evento, url)

  if (audioAtivado && el.toggleAuto.checked) {
    tocar(url)
  } else {
    el.btnReplay.disabled = false
    ultimoAudioUrl = url
  }
}

el.btnAtivar.addEventListener('click', () => {
  // "Desbloqueia" o autoplay tocando um silêncio curtinho no gesto do usuário.
  audioEl.play().catch(() => {})
  audioEl.pause()
  audioAtivado = true
  el.ativarArea.style.display = 'none'
  el.playerArea.classList.add('visivel')
})

el.btnReplay.addEventListener('click', () => {
  if (ultimoAudioUrl) tocar(ultimoAudioUrl)
})

audioEl.addEventListener('ended', () => animarVisualizador(false))
audioEl.addEventListener('pause', () => animarVisualizador(false))

// --- Botão de teste: faz o robô falar um texto (rota /falar, sem microfone) ---
const elTeste = {
  texto: document.getElementById('teste-texto'),
  botao: document.getElementById('btn-falar'),
  status: document.getElementById('teste-status'),
}

function definirStatusTeste(msg, tipo) {
  elTeste.status.textContent = msg
  elTeste.status.className = 'teste-status' + (tipo ? ' ' + tipo : '')
}

async function fazerRoboFalar() {
  const texto = (elTeste.texto.value || '').trim()
  if (!texto) {
    definirStatusTeste('Digite um texto primeiro.', 'erro')
    return
  }
  elTeste.botao.disabled = true
  definirStatusTeste('Enviando para o robô…')
  try {
    const resp = await fetch('/api/esp/falar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    })
    const dados = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      throw new Error(dados?.erro || ('Erro ' + resp.status))
    }
    if (dados.enviados > 0) {
      definirStatusTeste('Enviado! O robô deve estar falando agora. 🔊', 'ok')
    } else {
      definirStatusTeste('Áudio gerado, mas nenhum robô conectado (enviados: 0). O ESP está ligado e conectado?', 'erro')
    }
  } catch (err) {
    definirStatusTeste('Falha: ' + err.message, 'erro')
  } finally {
    elTeste.botao.disabled = false
  }
}

if (elTeste.botao) {
  elTeste.botao.addEventListener('click', fazerRoboFalar)
  elTeste.texto.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') fazerRoboFalar()
  })
}

function conectar() {
  const source = new EventSource('/api/esp/monitor/stream')
  source.addEventListener('pronto', () => definirStatus('online', 'conectado'))
  source.addEventListener('audio', (ev) => {
    try { aoReceberAudio(JSON.parse(ev.data)) } catch (e) { console.warn('evento inválido', e) }
  })
  source.onerror = () => {
    definirStatus('offline', 'reconectando…')
    // O próprio EventSource tenta reconectar sozinho.
  }
}

definirStatus('', 'conectando…')
conectar()
