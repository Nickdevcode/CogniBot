const refs = {
  telaUsuarios: document.getElementById('tela-usuarios'),
  telaConversa: document.getElementById('tela-conversa'),
  listaUsuarios: document.getElementById('lista-usuarios'),
  inputNome: document.getElementById('input-nome'),
  formNovoUsuario: document.getElementById('form-novo-usuario'),
  btnVoltar: document.getElementById('btn-voltar'),
  usuarioNomeHeader: document.getElementById('usuario-nome-header'),
  avatar: document.getElementById('avatar'),
  visualizerCanvas: document.getElementById('visualizer-canvas'),
  estadoTexto: document.getElementById('estado-texto'),
  btnMic: document.getElementById('btn-microfone'),
  btnCamera: document.getElementById('btn-camera'),
  btnParar: document.getElementById('btn-parar'),
  btnReset: document.getElementById('btn-reset'),
  legendaContainer: document.getElementById('legenda-container'),
  legendaUsuario: document.getElementById('legenda-usuario'),
  legendaCogni: document.getElementById('legenda-cogni'),
  legendaUsuarioTexto: document.querySelector('#legenda-usuario .legenda-texto'),
  legendaCogniTexto: document.querySelector('#legenda-cogni .legenda-texto'),
  cameraPreview: document.getElementById('camera-preview'),
  cameraVideo: document.getElementById('camera-video'),
  cameraCanvas: document.getElementById('camera-canvas'),
  telaErro: document.getElementById('tela-erro'),
  erroMensagem: document.getElementById('erro-mensagem'),
  btnFecharErro: document.getElementById('btn-fechar-erro'),
  modalConfirmar: document.getElementById('modal-confirmar'),
  modalMensagem: document.getElementById('modal-mensagem'),
  btnModalCancelar: document.getElementById('btn-modal-cancelar'),
  btnModalConfirmar: document.getElementById('btn-modal-confirmar'),
  dica: document.getElementById('dica'),
  statusServidor: document.getElementById('status-servidor'),
  statusEsp: document.getElementById('status-esp'),
  statusCam: document.getElementById('status-cam'),
  toggleRobo: document.getElementById('toggle-robo'),
  toggleCamRobo: document.getElementById('toggle-cam-robo'),
  snapshotCam: document.getElementById('snapshot-cam'),
  grupoPareamento: document.getElementById('grupo-pareamento'),
  painelCodigo: document.getElementById('painel-codigo'),
  painelDica: document.getElementById('painel-dica'),
  painelRobo: document.getElementById('painel-robo'),
  btnPainelMobile: document.getElementById('btn-painel-robo-mobile'),
  btnFecharPainelMobile: document.getElementById('btn-fechar-painel-mobile'),
  badgePainelMobile: document.getElementById('badge-painel-mobile'),
  progressoOnboarding: document.getElementById('progresso-onboarding'),
  progressoOnboardingPreenche: document.getElementById('progresso-onboarding-preenche'),
  progressoOnboardingRotulo: document.getElementById('progresso-onboarding-rotulo'),
}

export function obter(id) { return refs[id] }
export const elementos = refs

const TEXTOS_ESTADO = {
  idleMicOff:   { estado: 'Toque no microfone pra começar', dica: 'Botão central ou tecla Espaço pra ativar' },
  idleMicOn:    { estado: 'Pode falar quando quiser',        dica: 'Microfone ligado — pode mandar' },
  ouvindo:      { estado: 'Te ouvindo',                      dica: 'Estou captando sua voz' },
  pensando:     { estado: 'Pensando',                        dica: 'Organizando uma resposta boa' },
  pesquisando:  { estado: 'Pesquisando na web',              dica: 'Buscando algo atualizado pra você' },
  respondendo:  { estado: 'Quase lá',                        dica: 'Preparando o áudio' },
  falando:      { estado: 'Falando com você',                dica: 'Fale por cima quando quiser me interromper' },
  interrompendo:{ estado: 'Parando',                         dica: 'Pode falar' },
}

const ESTADOS_DOTS = new Set(['pensando', 'pesquisando', 'respondendo'])
const ESTADOS_COM_PARAR = new Set(['pensando', 'pesquisando', 'respondendo', 'falando'])

let ouvinteEstadoVisual = null

export function aoMudarEstado(callback) {
  ouvinteEstadoVisual = typeof callback === 'function' ? callback : null
}

export function definirEstado(estado, micAtivo = false) {
  refs.avatar.className = `avatar estado-${estado}`
  refs.estadoTexto.className = 'estado-texto'

  let textos
  if (estado === 'idle') {
    textos = micAtivo ? TEXTOS_ESTADO.idleMicOn : TEXTOS_ESTADO.idleMicOff
  } else {
    textos = TEXTOS_ESTADO[estado] || TEXTOS_ESTADO.idleMicOff
  }

  refs.estadoTexto.textContent = textos.estado
  refs.dica.textContent = textos.dica

  if (ESTADOS_DOTS.has(estado)) {
    refs.estadoTexto.classList.add(`estado-${estado}`, 'estado-dots')
  } else if (estado !== 'idle') {
    refs.estadoTexto.classList.add(`estado-${estado}`)
  }

  const mostrarParar = ESTADOS_COM_PARAR.has(estado)
  refs.btnParar.classList.toggle('oculto', !mostrarParar)
  refs.btnParar.hidden = !mostrarParar

  if (ouvinteEstadoVisual) {
    try { ouvinteEstadoVisual(estado, micAtivo) } catch { /* ignora */ }
  }
}

export function mostrarTelaUsuarios() {
  refs.telaConversa.classList.add('oculto')
  refs.telaConversa.hidden = true
  refs.telaUsuarios.classList.remove('oculto')
  refs.telaUsuarios.hidden = false
}

export function mostrarTelaConversa(nome) {
  refs.usuarioNomeHeader.textContent = nome
  refs.telaUsuarios.classList.add('oculto')
  refs.telaUsuarios.hidden = true
  refs.telaConversa.classList.remove('oculto')
  refs.telaConversa.hidden = false
  resetarLegendas()
}

// Mostra (ou esconde) o codigo de pareamento do perfil ativo no painel do robo.
// codigo nulo/vazio = esconde o grupo (ex: ao voltar pra tela de selecao).
export function mostrarCodigoPareamento(codigo) {
  if (!refs.grupoPareamento || !refs.painelCodigo) return
  if (codigo) {
    refs.painelCodigo.textContent = codigo
    refs.grupoPareamento.hidden = false
  } else {
    refs.painelCodigo.textContent = '------'
    refs.grupoPareamento.hidden = true
  }
}

export function mostrarLegendaUsuario(texto) {
  refs.legendaContainer.classList.remove('oculto')
  refs.legendaContainer.hidden = false
  refs.legendaUsuarioTexto.textContent = texto
  autoScrollLegendas()
}

export function mostrarLegendaCogni(texto) {
  refs.legendaContainer.classList.remove('oculto')
  refs.legendaContainer.hidden = false
  refs.legendaCogni.classList.remove('legenda-oculta')
  refs.legendaCogniTexto.textContent = texto
  autoScrollLegendas()
}

export function resetarLegendas() {
  refs.legendaContainer.classList.add('oculto')
  refs.legendaContainer.hidden = true
  refs.legendaUsuarioTexto.textContent = ''
  refs.legendaCogniTexto.textContent = ''
  refs.legendaCogni.classList.add('legenda-oculta')
}

export function limparLegendaCogni() {
  refs.legendaCogniTexto.textContent = ''
  refs.legendaCogni.classList.add('legenda-oculta')
}

let legendaSincState = null

export function prepararLegendaSincronizada(texto) {
  refs.legendaContainer.classList.remove('oculto')
  refs.legendaContainer.hidden = false
  refs.legendaCogni.classList.remove('legenda-oculta')
  refs.legendaCogniTexto.textContent = ''

  legendaSincState = {
    texto,
    posicaoExibida: 0,
    duracaoTotal: 0,
  }
}

export function atualizarLegendaPorTempo(atualMs, totalMs) {
  if (!legendaSincState) return
  if (!totalMs || totalMs <= 0) return

  legendaSincState.duracaoTotal = totalMs

  const proporcao = Math.min(1, atualMs / totalMs)
  const totalChars = legendaSincState.texto.length
  const alvo = Math.floor(totalChars * proporcao)

  if (alvo <= legendaSincState.posicaoExibida) return

  legendaSincState.posicaoExibida = alvo
  refs.legendaCogniTexto.textContent = legendaSincState.texto.slice(0, alvo)
  autoScrollLegendas()
}

export function fixarLegendaCogni(texto) {
  legendaSincState = null
  refs.legendaCogniTexto.textContent = texto
  if (texto) {
    refs.legendaContainer.classList.remove('oculto')
    refs.legendaContainer.hidden = false
    refs.legendaCogni.classList.remove('legenda-oculta')
  }
  autoScrollLegendas()
}

export function pararLegendaSincronizada() {
  legendaSincState = null
}

function autoScrollLegendas() {
  refs.legendaContainer.scrollTo({
    top: refs.legendaContainer.scrollHeight,
    behavior: 'smooth',
  })
}

let elementoFocoAnterior = null
let acaoErroPendente = null

export function mostrarErro(mensagem, opcoes = {}) {
  refs.erroMensagem.textContent = mensagem
  refs.telaErro.classList.remove('oculto')
  refs.telaErro.hidden = false

  elementoFocoAnterior = document.activeElement
  acaoErroPendente = typeof opcoes.onRetry === 'function' ? opcoes.onRetry : null

  if (refs.btnFecharErro) {
    refs.btnFecharErro.textContent = opcoes.textoBotao || (acaoErroPendente ? 'Tentar de novo' : 'Fechar')
    requestAnimationFrame(() => refs.btnFecharErro.focus())
  }
}

export function fecharErro() {
  refs.telaErro.classList.add('oculto')
  refs.telaErro.hidden = true
  const acao = acaoErroPendente
  acaoErroPendente = null
  if (elementoFocoAnterior && typeof elementoFocoAnterior.focus === 'function') {
    elementoFocoAnterior.focus()
  }
  elementoFocoAnterior = null
  if (acao) {
    try { acao() } catch { /* ignora erro do retry */ }
  }
}

let resolverConfirmacao = null
let elementoFocoConfirmacao = null

export function confirmar(mensagem) {
  return new Promise((resolve) => {
    refs.modalMensagem.textContent = mensagem
    refs.modalConfirmar.classList.remove('oculto')
    refs.modalConfirmar.hidden = false
    elementoFocoConfirmacao = document.activeElement
    resolverConfirmacao = resolve
    if (refs.btnModalCancelar) {
      requestAnimationFrame(() => refs.btnModalCancelar.focus())
    }
  })
}

export function fecharConfirmacao(resultado) {
  refs.modalConfirmar.classList.add('oculto')
  refs.modalConfirmar.hidden = true
  if (resolverConfirmacao) resolverConfirmacao(resultado)
  resolverConfirmacao = null
  if (elementoFocoConfirmacao && typeof elementoFocoConfirmacao.focus === 'function') {
    elementoFocoConfirmacao.focus()
  }
  elementoFocoConfirmacao = null
}

import { gerarCorPorNome } from './visualizer.js'

function criarIcone(nome, extraClasse = '') {
  const span = document.createElement('span')
  span.className = `material-symbols-rounded${extraClasse ? ' ' + extraClasse : ''}`
  span.setAttribute('aria-hidden', 'true')
  span.textContent = nome
  return span
}

function formatarAtividade(iso) {
  if (!iso) return ''
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return ''
  const diff = Date.now() - data.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min atrás`
  const horas = Math.floor(min / 60)
  if (horas < 24) return `${horas}h atrás`
  const dias = Math.floor(horas / 24)
  if (dias < 7) return `${dias}d atrás`
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

export function renderizarUsuarios(usuarios, { onSelecionar, onExcluir }) {
  refs.listaUsuarios.removeAttribute('aria-busy')
  refs.listaUsuarios.replaceChildren()

  if (!usuarios || usuarios.length === 0) {
    const li = document.createElement('li')
    li.className = 'lista-vazia'

    const icone = criarIcone('school', 'ico-vazia')
    const titulo = document.createElement('p')
    titulo.className = 'lista-vazia-titulo'
    titulo.textContent = 'Nada por aqui ainda'
    const subtitulo = document.createElement('p')
    subtitulo.className = 'lista-vazia-subtitulo'
    subtitulo.textContent = 'Crie o primeiro usuário pra começar.'

    li.append(icone, titulo, subtitulo)
    refs.listaUsuarios.appendChild(li)
    return
  }

  const ordenados = [...usuarios].sort((a, b) => new Date(b.ultimoAcesso) - new Date(a.ultimoAcesso))

  for (const u of ordenados) {
    const li = document.createElement('li')
    li.className = 'usuario-card'
    li.dataset.id = u.id
    li.tabIndex = 0
    li.setAttribute('role', 'button')
    li.setAttribute('aria-label', `Selecionar ${u.nome}`)

    const inicial = (u.nome || '?').charAt(0).toUpperCase()
    const info = u.idade ? `${u.idade} anos` : 'Estudante'
    const ultimoAcesso = formatarAtividade(u.ultimoAcesso)
    const cores = gerarCorPorNome(u.nome || '?')

    const avatar = document.createElement('div')
    avatar.className = 'usuario-avatar usuario-avatar--gradiente'
    avatar.style.backgroundImage = `linear-gradient(135deg, ${cores.de}, ${cores.ate})`
    avatar.textContent = inicial

    const dados = document.createElement('div')
    dados.className = 'usuario-dados'
    const nome = document.createElement('div')
    nome.className = 'nome'
    nome.textContent = u.nome
    const meta = document.createElement('div')
    meta.className = 'info'
    meta.textContent = ultimoAcesso ? `${info} · ${ultimoAcesso}` : info
    dados.append(nome, meta)

    const btnExcluir = document.createElement('button')
    btnExcluir.type = 'button'
    btnExcluir.className = 'btn-excluir'
    btnExcluir.title = 'Remover usuário'
    btnExcluir.setAttribute('aria-label', `Remover ${u.nome}`)
    btnExcluir.appendChild(criarIcone('close'))

    btnExcluir.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onExcluir(u)
    })

    li.append(avatar, dados, btnExcluir)

    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.btn-excluir')) return
      onSelecionar(u)
    })

    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        onSelecionar(u)
      }
    })

    refs.listaUsuarios.appendChild(li)
  }
}

export function listaUsuariosErro(mensagem) {
  refs.listaUsuarios.removeAttribute('aria-busy')
  refs.listaUsuarios.replaceChildren()
  const li = document.createElement('li')
  li.className = 'lista-vazia'
  li.append(criarIcone('cloud_off', 'ico-vazia'))
  const titulo = document.createElement('p')
  titulo.className = 'lista-vazia-titulo'
  titulo.textContent = 'Servidor indisponível'
  const subtitulo = document.createElement('p')
  subtitulo.className = 'lista-vazia-subtitulo'
  subtitulo.textContent = mensagem || 'Tente novamente em instantes.'
  li.append(titulo, subtitulo)
  refs.listaUsuarios.appendChild(li)
}

export function atualizarStatusServidor(ok, mensagem) {
  const el = refs.statusServidor
  if (!el) return
  el.dataset.status = ok ? 'ok' : 'off'
  const texto = el.querySelector('.painel-pill-texto')
  if (texto) texto.textContent = mensagem || (ok ? 'Conectado' : 'Sem conexão')
}

export function atualizarStatusESP(estado) {
  const elEsp = refs.statusEsp
  const elCam = refs.statusCam
  const toggleRobo = refs.toggleRobo
  const toggleCam = refs.toggleCamRobo

  if (elEsp) {
    const conectados = estado?.controle?.conectados || 0
    elEsp.dataset.status = conectados > 0 ? 'ok' : 'off'
    const texto = elEsp.querySelector('.painel-pill-texto')
    if (texto) texto.textContent = conectados > 0 ? `${conectados} online` : 'Aguardando'
  }

  if (elCam) {
    const conectados = estado?.camera?.conectados || 0
    const ultimoMs = estado?.camera?.ultimoFrameMs
    let status = 'off'
    let texto = 'Aguardando'
    if (conectados > 0 && ultimoMs !== null && ultimoMs < 5000) {
      status = 'ok'
      texto = 'Transmitindo'
    } else if (conectados > 0) {
      status = 'aguardando'
      texto = 'Conectada'
    }
    elCam.dataset.status = status
    const t = elCam.querySelector('.painel-pill-texto')
    if (t) t.textContent = texto
  }

  if (toggleRobo) toggleRobo.disabled = !(estado?.controle?.conectados > 0)
  // Camera do robo e fase futura (ESP-CAM): o toggle permanece desabilitado
  // ("em breve" no HTML). Nao reabilitamos aqui mesmo que algo conecte.
  if (toggleCam) toggleCam.disabled = true

  if (refs.badgePainelMobile) {
    const total = (estado?.controle?.conectados || 0) + (estado?.camera?.conectados || 0)
    if (total > 0) {
      refs.badgePainelMobile.textContent = String(total)
      refs.badgePainelMobile.hidden = false
    } else {
      refs.badgePainelMobile.hidden = true
    }
  }
}

export function atualizarSnapshotCam(url) {
  const el = refs.snapshotCam
  if (!el) return
  el.replaceChildren()
  if (url) {
    const img = document.createElement('img')
    img.src = url
    img.alt = 'Último frame da ESP-CAM'
    img.loading = 'lazy'
    el.appendChild(img)
  } else {
    const span = document.createElement('span')
    span.className = 'snapshot-placeholder'
    span.textContent = 'Sem imagem recente'
    el.appendChild(span)
  }
}

// Total de perguntas do onboarding (fallback quando o objeto nao traz `total`).
// Mantido em paridade com ONBOARDING_TOTAL_PERGUNTAS do app.js.
const ONBOARDING_TOTAL_PERGUNTAS = 5

// Maior passo ja exibido nesta sessao de onboarding: a barra NUNCA REGRIDE (o
// preenchimento dos campos pode parecer "voltar" um turno se uma extracao do
// servidor falhar e so completar na resposta seguinte). Resetado ao trocar de
// usuario (definirProgressoOnboarding com passo 0 e completo falso).
let maiorPassoOnboarding = 0

// Aceita um objeto { passo, total, completo } OU os argumentos legados (passo, total).
// completo=true mostra "Tudo pronto!" (verde/cheio) em vez de SUMIR - corrige o bug
// da barra que desaparecia ao terminar o onboarding.
export function definirProgressoOnboarding(progresso, totalLegado) {
  const el = refs.progressoOnboarding
  const preenche = refs.progressoOnboardingPreenche
  const rotulo = refs.progressoOnboardingRotulo
  if (!el || !preenche || !rotulo) return

  // Normaliza: aceita objeto novo ou (passo, total) antigo.
  const dados = (progresso && typeof progresso === 'object')
    ? progresso
    : { passo: progresso || 0, total: totalLegado || 0, completo: false }
  const total = dados.total || ONBOARDING_TOTAL_PERGUNTAS
  const completo = !!dados.completo

  // Sem onboarding ativo (passo 0 e nao completo): oculta e RESETA o trava-regressao.
  if (!completo && (!dados.passo || dados.passo <= 0)) {
    maiorPassoOnboarding = 0
    el.classList.add('oculto')
    el.hidden = true
    return
  }

  // Nunca regride: usa o maior passo ja visto.
  const passo = completo ? total : Math.max(maiorPassoOnboarding, dados.passo)
  maiorPassoOnboarding = passo

  el.classList.remove('oculto')
  el.hidden = false
  const pct = Math.max(0, Math.min(100, (passo / total) * 100))
  preenche.style.width = `${pct}%`
  el.classList.toggle('onboarding-completo', completo)
  rotulo.textContent = completo ? 'Tudo pronto! 🎉' : `Pergunta ${passo} de ${total}`
}

export function abrirPainelRoboMobile() {
  if (!refs.painelRobo) return
  refs.painelRobo.classList.add('painel-robo--aberto-mobile')
  if (refs.btnPainelMobile) refs.btnPainelMobile.setAttribute('aria-expanded', 'true')
}

export function fecharPainelRoboMobile() {
  if (!refs.painelRobo) return
  refs.painelRobo.classList.remove('painel-robo--aberto-mobile')
  if (refs.btnPainelMobile) refs.btnPainelMobile.setAttribute('aria-expanded', 'false')
}
