import { criarLogger } from './modules/logger.js'
import { toast } from './modules/toast.js'
import { api } from './modules/api.js'
import {
  GerenciadorAudio,
  VAD_LIMIAR, VAD_LIMIAR_INTERRUPCAO, SILENCIO_MS, CHECK_INTERVAL_MS,
  VAD_FRAMES_CONSECUTIVOS, VAD_FRAMES_INTERRUPCAO, GRACE_PERIOD_MS,
} from './modules/audio.js'
import { GerenciadorCamera, mensagemErroCamera } from './modules/camera.js'
import { lerStreamSSE } from './modules/sse.js'
import {
  elementos, definirEstado, mostrarTelaUsuarios, mostrarTelaConversa,
  mostrarLegendaUsuario, mostrarLegendaCogni, resetarLegendas, limparLegendaCogni,
  prepararLegendaSincronizada, atualizarLegendaPorTempo,
  fixarLegendaCogni, pararLegendaSincronizada,
  mostrarErro, fecharErro, confirmar, fecharConfirmacao,
  renderizarUsuarios, listaUsuariosErro, atualizarStatusServidor,
  aoMudarEstado, abrirPainelRoboMobile, fecharPainelRoboMobile,
  definirProgressoOnboarding, mostrarCodigoPareamento,
} from './modules/ui.js'
import { iniciarMonitoramentoESP, pararMonitoramento, obterEstadoESP } from './modules/esp.js'
import { VisualizerAvatar } from './modules/visualizer.js'
import { iniciarTema } from './modules/theme.js'

const log = criarLogger('Estado')
const logServidor = criarLogger('Servidor')
const logVAD = criarLogger('VAD')
const logGrav = criarLogger('Gravacao')
const logMic = criarLogger('Mic')
const logReset = criarLogger('Reset')

const audio = new GerenciadorAudio()
const camera = new GerenciadorCamera(elementos.cameraVideo, elementos.cameraCanvas)
const visualizer = new VisualizerAvatar(elementos.visualizerCanvas)

audio.definirCallbackAudioElemento((elemento) => {
  visualizer.conectarElementoAudio(elemento)
})

aoMudarEstado((novoEstado, micAtivo) => {
  visualizer.definirEstadoVisual(novoEstado)
  const analisadorMic = audio.analyserVisual || audio.analyser

  if (novoEstado === 'falando' || novoEstado === 'respondendo') {
    if (audio.audioAtual) {
      visualizer.conectarElementoAudio(audio.audioAtual)
    } else {
      visualizer.usarFallbackSuave()
    }
  } else if (novoEstado === 'pensando' || novoEstado === 'pesquisando') {
    visualizer.usarFallbackSuave()
  } else if (novoEstado === 'ouvindo') {
    if (micAtivo && analisadorMic) {
      visualizer.conectarMicrofone(analisadorMic, audio.audioContext)
    } else {
      visualizer.usarFallbackSuave()
    }
  } else {
    // idle e demais: com mic, reage ao mic; em modo robo (sem mic/audio local),
    // usa o fallback animado (respiracao sutil no idle) em vez de parar.
    if (micAtivo && analisadorMic) {
      visualizer.conectarMicrofone(analisadorMic, audio.audioContext)
    } else if (estaEmModoRobo()) {
      visualizer.usarFallbackSuave()
    } else {
      visualizer.pausar()
    }
  }
})

const estado = {
  usuarioAtual: null,
  micAtivo: false,
  detectandoVoz: false,
  silencioTimer: null,
  framesAcimaLimiar: 0,
  framesAcimaInterrupcao: 0,
  micGracePeriod: false,
  processando: false,
  abortController: null,
  estadoAtual: 'idle',
  legendaBuffer: '',
  loopVAD: null,
  // Modo robo: quando o toggle "Controlar robo" esta ligado e ha robo conectado,
  // a interface vira painel de controle do robo fisico. micRoboMutado reflete o
  // estado do mic do robo (fonte da verdade vem do SSE de status do servidor).
  micRoboMutado: false,
}

function aplicarEstado(novo) {
  if (estado.estadoAtual !== novo) log(`${estado.estadoAtual} -> ${novo}`)
  estado.estadoAtual = novo
  definirEstado(novo, estado.micAtivo)
}

async function carregar() {
  try {
    const dados = await api.listarUsuarios()
    renderizarUsuarios(dados.usuarios, {
      onSelecionar: (u) => selecionarUsuario(u.id, u.nome),
      onExcluir: async (u) => {
        const ok = await confirmar(`Remover "${u.nome}"? As memórias serão perdidas.`)
        if (!ok) return
        try {
          await api.excluirUsuario(u.id)
          toast(`"${u.nome}" removido`, 'ok')
          carregar()
        } catch (err) {
          toast(`Erro: ${err.message}`, 'erro')
        }
      },
    })
  } catch (err) {
    listaUsuariosErro('Servidor não encontrado')
    logServidor(`Falha ao listar usuarios: ${err.message}`)
  }
}

async function criarNovoUsuario(ev) {
  ev?.preventDefault()
  const nome = elementos.inputNome.value.trim()
  if (!nome) {
    elementos.inputNome.focus()
    return
  }

  try {
    const dados = await api.criarUsuario(nome)
    elementos.inputNome.value = ''
    selecionarUsuario(dados.usuario.id, dados.usuario.nome)
  } catch (err) {
    toast(`Erro: ${err.message}`, 'erro')
  }
}

const ONBOARDING_TOTAL_PERGUNTAS = 5

// Calcula o progresso do onboarding. Retorna { passo, total, completo }.
//   - completo=true quando o servidor marcou onboardingCompleto (a barra mostra
//     "pronto!" em vez de SUMIR - era o bug de "quando acaba some/buga").
//   - passo conta os campos ja preenchidos (idade/serie/hobbies/comoAprende/idioma).
//     Como o preenchimento depende de extracao no servidor (as vezes falha numa
//     resposta e preenche na seguinte), o passo pode parecer "travar" um turno - por
//     isso a barra tambem NUNCA REGRIDE (ver definirProgressoOnboarding, que guarda
//     o maior passo ja visto). Dev: sem onboarding (passo 0, oculto).
function calcularProgressoOnboarding(usuario) {
  if (!usuario || usuario.role === 'desenvolvedor') return { passo: 0, total: ONBOARDING_TOTAL_PERGUNTAS, completo: false }
  if (usuario.onboardingCompleto) return { passo: ONBOARDING_TOTAL_PERGUNTAS, total: ONBOARDING_TOTAL_PERGUNTAS, completo: true }
  let passo = 1
  if (usuario.idade) passo++
  if (usuario.serie) passo++
  if (usuario.hobbies) passo++
  if (usuario.comoAprende) passo++
  if (Array.isArray(usuario.idiomasEstudando) && usuario.idiomasEstudando.length > 0) passo++
  return { passo: Math.min(passo, ONBOARDING_TOTAL_PERGUNTAS), total: ONBOARDING_TOTAL_PERGUNTAS, completo: false }
}

async function selecionarUsuario(id, nome) {
  log(`Usuario: ${nome} (${id})`)
  estado.usuarioAtual = { id, nome }
  mostrarTelaConversa(nome)
  requestAnimationFrame(() => visualizer.revalidar())
  aplicarEstado('idle')

  try {
    const saude = await api.verificarSaude()
    atualizarStatusServidor(true, 'Conectado')
    if (!saude.apiConfigurada) {
      mostrarErro('A chave de API do OpenAI não está configurada no servidor.')
    }
  } catch {
    atualizarStatusServidor(false, 'Sem conexão')
  }

  try {
    const dados = await api.obterUsuario(id)
    const u = dados?.usuario
    estado.usuarioAtual = { id, nome, usuario: u }
    definirProgressoOnboarding(calcularProgressoOnboarding(u))
    mostrarCodigoPareamento(u?.codigoPareamento)
  } catch (err) {
    log(`Falha ao carregar detalhes do usuario: ${err.message}`)
    definirProgressoOnboarding({ passo: 0, total: ONBOARDING_TOTAL_PERGUNTAS, completo: false })
  }

  iniciarMonitoramentoESP({
    onMudanca: reconciliarEstadoRobo,
    onAtividade: tratarAtividadeRobo,
  })

  // Se ja ha robo conectado, define o perfil dele como o usuario selecionado
  // (perfil em tempo real, sem regravar firmware). Se nenhum robo estiver
  // conectado, o servidor guarda a escolha e aplica quando o robo conectar.
  if ((obterEstadoESP()?.controle?.conectados || 0) > 0) {
    api.definirUsuarioRobo(id).catch((err) => logRobo(`Falha ao definir perfil do robô: ${err.message}`))
  }
}

// Reconcilia o estado local do robo com o que o servidor reporta via SSE de
// status. O servidor e a fonte da verdade do mute (estado.mic.mutado): se outro
// cliente mutou, ou se o clique otimista divergiu, isto corrige a UI.
function reconciliarEstadoRobo(estadoEsp) {
  const mutado = !!estadoEsp?.mic?.mutado
  if (mutado !== estado.micRoboMutado) {
    estado.micRoboMutado = mutado
    if (estaEmModoRobo()) sincronizarBotaoMicRobo()
  }
  // Quando o robo conecta depois de o usuario ja estar na tela, garante que o
  // perfil do robo seja o usuario atual. O guard evita reenvios concorrentes a
  // cada evento SSE enquanto a requisicao anterior ainda nao respondeu.
  if ((estadoEsp?.controle?.conectados || 0) > 0 && estado.usuarioAtual?.id) {
    if (estadoEsp.usuarioAtual && estadoEsp.usuarioAtual !== estado.usuarioAtual.id && !estado.definindoPerfilRobo) {
      estado.definindoPerfilRobo = true
      api.definirUsuarioRobo(estado.usuarioAtual.id)
        .catch(() => {})
        .finally(() => { estado.definindoPerfilRobo = false })
    }
  }

  // Se o toggle "Controlar robo" esta ligado mas o servidor reporta o robo como
  // desabilitado (ex: servidor reiniciou e perdeu o estado), re-habilita para
  // manter a UI coerente com o que o usuario pediu.
  if (elementos.toggleRobo?.checked && estadoEsp?.habilitado === false
      && (estadoEsp?.controle?.conectados || 0) > 0 && !estado.reabilitandoRobo) {
    estado.reabilitandoRobo = true
    api.definirRoboHabilitado(true)
      .catch(() => {})
      .finally(() => { estado.reabilitandoRobo = false })
  }
}

async function atualizarProgressoOnboarding() {
  if (!estado.usuarioAtual?.id) return
  try {
    const dados = await api.obterUsuario(estado.usuarioAtual.id)
    const u = dados?.usuario
    if (!u) return
    estado.usuarioAtual.usuario = u
    definirProgressoOnboarding(calcularProgressoOnboarding(u))
  } catch {
    /* silencioso */
  }
}

function voltarParaUsuarios() {
  log('Voltando para selecao')
  // Sair do perfil DESABILITA o robo (ele dorme e cala qualquer fala) - sem
  // perfil ativo o robo nunca escuta/responde "no seco".
  api.definirRoboHabilitado(false).catch(() => {})
  // Reseta o toggle "Controlar robo" visualmente (proximo perfil comeca desligado).
  if (elementos.toggleRobo) elementos.toggleRobo.checked = false

  interromper()
  if (estado.micAtivo) desativarMic()
  if (camera.ativa) toggleCamera().catch(() => {})

  estado.usuarioAtual = null
  pararMonitoramento()
  fecharPainelRoboMobile()
  // Reseta a barra (oculta + zera o trava-regressao pro proximo perfil).
  definirProgressoOnboarding({ passo: 0, total: ONBOARDING_TOTAL_PERGUNTAS, completo: false })
  mostrarCodigoPareamento(null) // esconde o codigo ao sair do perfil
  mostrarTelaUsuarios()
  carregar()
}

function interromper({ origem = 'manual' } = {}) {
  log(`Interrompendo (estado=${estado.estadoAtual}, processando=${estado.processando}, origem=${origem})`)

  const estadoAnterior = estado.estadoAtual
  audio.parar()

  if (estado.abortController) {
    try { estado.abortController.abort() } catch { /* ignora */ }
    estado.abortController = null
  }

  pararLegendaSincronizada()
  if (estado.legendaBuffer) {
    fixarLegendaCogni(estado.legendaBuffer)
  }
  estado.legendaBuffer = ''
  estado.processando = false
  estado.framesAcimaLimiar = 0
  estado.framesAcimaInterrupcao = 0
  if (estado.silencioTimer) {
    clearTimeout(estado.silencioTimer)
    estado.silencioTimer = null
  }

  if (origem === 'voz' && estado.micAtivo) {
    aplicarEstado('ouvindo')
    estado.micGracePeriod = true
    setTimeout(() => { estado.micGracePeriod = false }, GRACE_PERIOD_MS)
    if (!audio.gravando) iniciarGravacao()
  } else {
    const eraEstadoAtivo = ['falando', 'pensando', 'pesquisando', 'respondendo'].includes(estadoAnterior)
    if (origem === 'manual' && eraEstadoAtivo) {
      aplicarEstado('interrompendo')
      setTimeout(() => {
        if (estado.estadoAtual === 'interrompendo') aplicarEstado('idle')
      }, 350)
    } else {
      aplicarEstado('idle')
    }
  }
}

// ---------------------------------------------------------------------
// Modo robo: a interface como painel de controle do robo fisico
// ---------------------------------------------------------------------

const logRobo = criarLogger('Robo')

// True quando o toggle "Controlar robo" esta ligado E ha robo conectado. Nesse
// modo, o mic/alto-falante sao os do ROBO; a interface so comanda e acompanha.
function estaEmModoRobo() {
  return !!elementos.toggleRobo?.checked && (obterEstadoESP()?.controle?.conectados || 0) > 0
}

// Recebe a atividade do robo em tempo real (SSE /api/esp/atividade/stream) e
// reflete na interface: legendas (o que a crianca falou / o que a Cogni
// respondeu) e estado visual do avatar (ouvindo/pensando/falando/idle).
// Textos de estado especificos do modo robo (deixam claro que e o ROBO, nao o PC).
const TEXTOS_ESTADO_ROBO = {
  ouvindo: 'Te ouvindo pelo robô',
  pensando: 'O robô está pensando',
  pesquisando: 'O robô está pesquisando na web',
  falando: 'O robô está falando',
  idle: 'Fale com o robô — ele está ouvindo',
}

function tratarAtividadeRobo(ev) {
  if (!ev || !estaEmModoRobo()) return

  if (ev.tipo === 'transcricao') {
    mostrarLegendaUsuario(ev.texto || '')
  } else if (ev.tipo === 'resposta') {
    mostrarLegendaCogni(ev.texto || '')
    // SYNC do onboarding quando a conversa e pelo ROBO (nao pela interface): a cada
    // resposta da Cogni, a memoria do usuario pode ter sido atualizada no servidor
    // (extracao assincrona). Pequeno atraso pra dar tempo da extracao persistir antes
    // de reler o progresso. Sem isso, a barra so avancava em conversa pela interface.
    setTimeout(() => atualizarProgressoOnboarding(), 1200)
  } else if (ev.tipo === 'estado') {
    // Visao no caminho do robo: quando o robo COMECA a ouvir e a camera do PC esta
    // ligada, captura UM frame e manda pro servidor. O frame viaja enquanto a crianca
    // fala (1-5s) e ja esta la quando a IA roda — assim a Cogni "ve" pela webcam mesmo
    // falando pelo fisico. Fire-and-forget; 'ouvindo' dispara 1x por fala (o servidor
    // deduplica estados repetidos). So acontece com a camera ligada.
    if (ev.estado === 'ouvindo' && camera.ativa) {
      const frame = camera.capturarFrame()
      if (frame) api.enviarFrameWebcam(frame).catch(() => {})
    }
    // Em modo robo o estado do ROBO e a fonte da verdade (o mic do PC esta
    // desligado, entao nao ha fluxo local competindo). 'pesquisando' aparece
    // quando a Cogni vai buscar algo atualizado na web (tela roxa de busca).
    const mapa = { ouvindo: 'ouvindo', pensando: 'pensando', pesquisando: 'pesquisando', falando: 'falando', idle: 'idle' }
    const novo = mapa[ev.estado]
    if (novo) {
      aplicarEstado(novo)
      if (TEXTOS_ESTADO_ROBO[novo] && elementos.estadoTexto) {
        elementos.estadoTexto.textContent = TEXTOS_ESTADO_ROBO[novo]
      }
    }
  }
}

// Atualiza o botao de mic e a dica para refletir o estado do MIC DO ROBO. A
// fonte da verdade e o estado vindo do SSE de status (estado.micRoboMutado).
function sincronizarBotaoMicRobo() {
  if (!elementos.btnMic) return
  const mutado = estado.micRoboMutado
  const icone = elementos.btnMic.querySelector('.material-symbols-rounded')
  if (icone) icone.textContent = mutado ? 'mic_off' : 'mic'
  elementos.btnMic.classList.toggle('ativo', !mutado)
  elementos.btnMic.setAttribute('aria-pressed', mutado ? 'false' : 'true')
  const titulo = mutado ? 'Desmutar o microfone do robô' : 'Mutar o microfone do robô'
  elementos.btnMic.setAttribute('title', titulo)
  elementos.btnMic.setAttribute('aria-label', titulo)
}

// Alterna o mute do mic do robo (clique no botao de mic em modo robo). Otimista:
// atualiza a UI na hora; o SSE de status reconcilia o valor real logo em seguida.
async function alternarMuteRobo() {
  const novo = !estado.micRoboMutado
  estado.micRoboMutado = novo
  sincronizarBotaoMicRobo()
  try {
    await api.definirMicRobo(novo)
    logRobo(`Mic do robô ${novo ? 'mutado' : 'ativo'}`)
  } catch (err) {
    logRobo(`Falha ao ${novo ? 'mutar' : 'desmutar'}: ${err.message}`)
    toast('Não consegui falar com o robô', 'erro')
  }
}

// Liga/desliga o modo robo (handler do toggle "Controlar robo"). LIGAR habilita
// o robo (gate) com o perfil atual; DESLIGAR desabilita (robo dorme/fica mudo).
async function alternarModoRobo() {
  if (estaEmModoRobo()) {
    // Entrou no modo robo: desliga o mic do PC (os dois fluxos nao competem),
    // garante o perfil atual no robo, desmuta e HABILITA (acorda o robo).
    if (estado.micAtivo) desativarMic()
    estado.micRoboMutado = false
    if (estado.usuarioAtual?.id) {
      try { await api.definirUsuarioRobo(estado.usuarioAtual.id) } catch { /* SSE reconcilia */ }
    }
    sincronizarBotaoMicRobo()
    try {
      await api.definirMicRobo(false)
      await api.definirRoboHabilitado(true)
    } catch { /* o status SSE reconcilia */ }
    aplicarEstado('idle')
    elementos.estadoTexto.textContent = 'Fale com o robô — ele está ouvindo'
    toast('Controlando o robô 🤖 — fale com ele', 'ok')
    logRobo('Modo robô LIGADO — robô acordado com o perfil atual')
  } else {
    // Saiu do modo robo: DESABILITA o robo (ele dorme, para de escutar e cala
    // qualquer fala em curso), restaura o botao de mic para o fluxo do navegador.
    try { await api.definirRoboHabilitado(false) } catch { /* ignora */ }
    estado.micRoboMutado = false
    restaurarBotaoMicNavegador()
    aplicarEstado('idle')
    logRobo('Modo robô DESLIGADO — robô dormindo, voltando ao microfone do navegador')
  }
}

// Restaura o botao de mic para o visual/ comportamento do fluxo do navegador
// (mic do PC desligado).
function restaurarBotaoMicNavegador() {
  if (!elementos.btnMic) return
  const icone = elementos.btnMic.querySelector('.material-symbols-rounded')
  if (icone) icone.textContent = 'mic_off'
  elementos.btnMic.classList.remove('ativo')
  elementos.btnMic.setAttribute('aria-pressed', 'false')
  elementos.btnMic.setAttribute('title', 'Ativar microfone')
  elementos.btnMic.setAttribute('aria-label', 'Ativar microfone')
}

async function ativarMic() {
  // Blindagem: em modo robo o mic do PC NUNCA e ativado (o robo escuta por nos).
  // Qualquer caminho que tente ativar o mic do PC em modo robo e ignorado aqui.
  if (estaEmModoRobo()) return
  if (estado.micAtivo) return
  if (estado.ativandoMic) return
  estado.ativandoMic = true
  logMic('Ativando microfone...')
  try {
    await audio.ativar()
    estado.micAtivo = true
    estado.framesAcimaLimiar = 0
    estado.framesAcimaInterrupcao = 0
    estado.detectandoVoz = false

    elementos.btnMic.classList.add('ativo')
    elementos.btnMic.setAttribute('aria-pressed', 'true')
    elementos.btnMic.setAttribute('title', 'Mutar microfone (envia o áudio se estiver falando)')
    elementos.btnMic.setAttribute('aria-label', 'Mutar microfone (envia o áudio se estiver falando)')
    elementos.btnMic.querySelector('.material-symbols-rounded').textContent = 'mic'

    estado.micGracePeriod = true
    setTimeout(() => { estado.micGracePeriod = false }, GRACE_PERIOD_MS)

    if (estado.estadoAtual === 'idle') aplicarEstado('idle')

    iniciarLoopVAD()
  } catch (err) {
    logMic(`Falha ao ativar: ${err.message}`)
    mostrarErro('Não foi possível acessar o microfone. Verifique as permissões do navegador.')
  } finally {
    estado.ativandoMic = false
  }
}

function desativarMic() {
  if (!estado.micAtivo) return
  const enviarBlobAtual = audio.gravando && estado.detectandoVoz && !estado.processando
  logMic(`Desativando (estado=${estado.estadoAtual}, gravando=${audio.gravando}, enviar=${enviarBlobAtual})`)
  estado.micAtivo = false
  estado.framesAcimaLimiar = 0
  estado.framesAcimaInterrupcao = 0
  estado.detectandoVoz = false

  if (estado.silencioTimer) {
    clearTimeout(estado.silencioTimer)
    estado.silencioTimer = null
  }
  if (estado.loopVAD) {
    clearTimeout(estado.loopVAD)
    estado.loopVAD = null
  }

  audio.desativar({ enviarBlobAtual })

  elementos.btnMic.classList.remove('ativo')
  elementos.btnMic.setAttribute('aria-pressed', 'false')
  elementos.btnMic.setAttribute('title', 'Ativar microfone')
  elementos.btnMic.setAttribute('aria-label', 'Ativar microfone')
  elementos.btnMic.querySelector('.material-symbols-rounded').textContent = 'mic_off'

  if (enviarBlobAtual) {
    aplicarEstado('pensando')
  } else if (estado.estadoAtual === 'idle') {
    aplicarEstado('idle')
  }
}

function iniciarLoopVAD() {
  if (!estado.micAtivo) return

  const ehEstadoOcupado = ['falando', 'pensando', 'pesquisando', 'respondendo'].includes(estado.estadoAtual)
  const nivelInterrupcao = ehEstadoOcupado ? audio.obterNivelInterrupcao() : 0
  const nivel = audio.obterNivel()

  if (ehEstadoOcupado && !estado.micGracePeriod) {
    if (nivelInterrupcao > VAD_LIMIAR_INTERRUPCAO) {
      estado.framesAcimaInterrupcao++
      if (estado.framesAcimaInterrupcao >= VAD_FRAMES_INTERRUPCAO) {
        logVAD(`Interrupcao por voz (nivel=${nivelInterrupcao.toFixed(4)}, estado=${estado.estadoAtual})`)
        estado.framesAcimaInterrupcao = 0
        estado.framesAcimaLimiar = VAD_FRAMES_CONSECUTIVOS
        estado.detectandoVoz = true
        interromper({ origem: 'voz' })
        estado.loopVAD = setTimeout(iniciarLoopVAD, CHECK_INTERVAL_MS)
        return
      }
    } else {
      estado.framesAcimaInterrupcao = 0
    }
  } else {
    estado.framesAcimaInterrupcao = 0
  }

  if (estado.processando) {
    estado.loopVAD = setTimeout(iniciarLoopVAD, CHECK_INTERVAL_MS)
    return
  }

  if (nivel > VAD_LIMIAR) {
    estado.framesAcimaLimiar++
    if (!audio.gravando && estado.framesAcimaLimiar >= VAD_FRAMES_CONSECUTIVOS) {
      iniciarGravacao()
    }
    if (estado.silencioTimer) {
      clearTimeout(estado.silencioTimer)
      estado.silencioTimer = null
    }
    if (audio.gravando) estado.detectandoVoz = true
  } else {
    estado.framesAcimaLimiar = 0
    if (estado.detectandoVoz && audio.gravando && !estado.silencioTimer) {
      estado.silencioTimer = setTimeout(() => {
        estado.detectandoVoz = false
        estado.silencioTimer = null
        audio.pararGravacao()
      }, SILENCIO_MS)
    }
  }

  estado.loopVAD = setTimeout(iniciarLoopVAD, CHECK_INTERVAL_MS)
}

function iniciarGravacao() {
  // Defesa em profundidade: em modo robo nunca gravamos pelo mic do PC.
  if (estaEmModoRobo()) return
  logGrav('Iniciando gravacao')
  audio.iniciarGravacao((blob) => enviarAudio(blob))
  aplicarEstado('ouvindo')
}

async function enviarAudio(blob) {
  if (estado.processando || !estado.usuarioAtual) return
  estado.processando = true
  aplicarEstado('pensando')

  estado.abortController = new AbortController()
  const inicio = Date.now()

  const usarRobo = elementos.toggleRobo?.checked || false
  const usarCamRobo = elementos.toggleCamRobo?.checked || false
  const imagemFrame = !usarCamRobo && camera.ativa ? camera.capturarFrame() : null

  try {
    const resposta = await api.enviarConversa({
      audioBlob: blob,
      usuarioId: estado.usuarioAtual.id,
      imagem: imagemFrame,
      usarRobo,
      signal: estado.abortController.signal,
    })

    if (!resposta.ok) throw new Error(`Erro do servidor: ${resposta.status}`)

    const contentType = resposta.headers.get('Content-Type') || ''
    if (contentType.includes('text/event-stream')) {
      await processarStream(resposta, inicio)
    } else {
      await processarRespostaJson(resposta, inicio)
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      logServidor('Requisicao abortada pelo usuario')
      return
    }
    logServidor(`Falha: ${err.message}`)
    mostrarErro(
      'Erro ao se comunicar com o servidor. Verifique se o servidor está rodando e se a chave da API está configurada.',
      {
        textoBotao: 'Tentar de novo',
        onRetry: () => enviarAudio(blob),
      }
    )
    estado.processando = false
    estado.abortController = null
    aplicarEstado('idle')
  }
}

async function processarRespostaJson(resposta, inicio) {
  const dados = await resposta.json()
  const total = Date.now() - inicio
  if (dados.erro) throw new Error(dados.erro)

  if (!dados.transcricao && !dados.resposta) {
    logServidor(`Resposta vazia (sem fala) em ${total}ms`)
    estado.processando = false
    aplicarEstado('idle')
    return
  }

  logServidor(`Resposta recebida em ${total}ms`)
  mostrarLegendaUsuario(dados.transcricao || '')
  mostrarLegendaCogni(dados.resposta || '')

  if (dados.audio) {
    aplicarEstado('falando')
    await audio.reproduzirBase64Mp3(dados.audio, {
      onFim: ({ motivo } = {}) => {
        if (motivo !== 'interrompido' && estado.estadoAtual === 'falando') {
          aplicarEstado('idle')
        }
      },
    })
  }

  estado.processando = false
  estado.abortController = null
  if (!['ouvindo', 'falando', 'idle'].includes(estado.estadoAtual)) {
    aplicarEstado('idle')
  }
  atualizarProgressoOnboarding()
}

async function processarStream(resposta, inicio) {
  let pesquisouWeb = false
  let fila = null
  let totalChunks = null
  estado.legendaBuffer = ''
  limparLegendaCogni()

  try {
    await lerStreamSSE(resposta, {
      transcricao: (dados) => {
        logServidor(`Transcricao: "${dados.texto}"`)
        mostrarLegendaUsuario(dados.texto)
        aplicarEstado('pensando')
      },
      pesquisa: () => {
        logServidor('Pesquisando na web...')
        aplicarEstado('pesquisando')
      },
      texto: (dados) => {
        estado.legendaBuffer += dados.chunk || ''
      },
      'audio-chunk': (dados) => {
        if (!fila) {
          const t = Date.now() - inicio
          logServidor(`Primeiro chunk de audio em ${t}ms${pesquisouWeb ? ' (web)' : ''}`)
          fila = audio.criarFilaReproducao({
            onPrimeiroChunk: () => aplicarEstado('falando'),
            onFim: ({ motivo } = {}) => {
              fixarLegendaCogni(estado.legendaBuffer)
              if (motivo !== 'interrompido' && estado.estadoAtual === 'falando') {
                aplicarEstado('idle')
              }
            },
          })
        }
        fila.adicionar(dados.indice, dados.audio, dados.texto || '')
      },
      'fim-audio': (dados) => {
        const total = Date.now() - inicio
        logServidor(`Stream audio completo em ${total}ms (${dados.totalChunks || 0} chunks)`)
        const textoCompleto = (typeof dados.textoFinal === 'string' && dados.textoFinal.trim())
          ? dados.textoFinal
          : estado.legendaBuffer
        estado.legendaBuffer = textoCompleto
        if (fila) {
          totalChunks = dados.totalChunks
          fila.finalizar(totalChunks)
        }
      },
      fim: (dados) => {
        pesquisouWeb = !!dados.pesquisouWeb
        if (dados.vazio) {
          logServidor('Resposta vazia')
          estado.processando = false
          estado.abortController = null
          aplicarEstado('idle')
          return false
        }
      },
      audio: async (dados) => {
        const total = Date.now() - inicio
        logServidor(`Stream completo (modo legado) em ${total}ms${pesquisouWeb ? ' (web)' : ''}`)
        const textoCompleto = (typeof dados.textoFinal === 'string' && dados.textoFinal.trim())
          ? dados.textoFinal
          : estado.legendaBuffer
        aplicarEstado('falando')
        prepararLegendaSincronizada(textoCompleto)
        await audio.reproduzirBase64Mp3(dados.audio, {
          onProgresso: ({ atualMs, totalMs }) => atualizarLegendaPorTempo(atualMs, totalMs),
          onFim: ({ motivo } = {}) => {
            fixarLegendaCogni(textoCompleto)
            if (motivo !== 'interrompido' && estado.estadoAtual === 'falando') {
              aplicarEstado('idle')
            }
          },
        })
      },
      erro: (dados) => {
        throw new Error(dados.erro || 'Erro no servidor')
      },
    })

    if (fila) {
      await fila.promise
    }
  } finally {
    estado.processando = false
    estado.abortController = null
    if (!['ouvindo', 'falando', 'idle'].includes(estado.estadoAtual)) {
      aplicarEstado('idle')
    }
    atualizarProgressoOnboarding()
  }
}

async function toggleCamera() {
  if (camera.ativa) {
    camera.desligar()
    elementos.cameraPreview.classList.add('oculto')
    elementos.cameraPreview.hidden = true
    elementos.btnCamera.classList.remove('ativo')
    elementos.btnCamera.setAttribute('aria-pressed', 'false')
    elementos.btnCamera.querySelector('.material-symbols-rounded').textContent = 'videocam_off'
    return
  }

  try {
    await camera.ligar()
    elementos.cameraPreview.classList.remove('oculto')
    elementos.cameraPreview.hidden = false
    elementos.btnCamera.classList.add('ativo')
    elementos.btnCamera.setAttribute('aria-pressed', 'true')
    elementos.btnCamera.querySelector('.material-symbols-rounded').textContent = 'videocam'
  } catch (err) {
    mostrarErro(mensagemErroCamera(err))
  }
}

async function resetarConversa() {
  logReset(`Reiniciando (usuario=${estado.usuarioAtual?.nome || 'nenhum'})`)
  interromper()

  // Em modo robo, tambem encerra a fala do robo no servidor. O contexto da
  // conversa ja e compartilhado (o robo usa o mesmo usuarioId), entao o
  // api.resetarConversa abaixo zera o historico para os dois.
  if (estaEmModoRobo()) {
    api.interromperRobo().catch(() => {})
  }

  try {
    await api.resetarConversa(estado.usuarioAtual?.id)
    resetarLegendas()
    aplicarEstado('idle')
    elementos.estadoTexto.textContent = 'Conversa reiniciada! Fale com a Cogni'
    toast('Conversa reiniciada — memórias mantidas', 'ok')
  } catch (err) {
    logReset(`Falha: ${err.message}`)
    toast('Erro ao reiniciar conversa', 'erro')
  }
}

function configurarEventos() {
  elementos.formNovoUsuario?.addEventListener('submit', criarNovoUsuario)
  elementos.btnVoltar?.addEventListener('click', voltarParaUsuarios)

  elementos.btnMic?.addEventListener('click', () => {
    // Em modo robo, o botao de mic muta/desmuta o MIC DO ROBO (nao o do PC).
    if (estaEmModoRobo()) { alternarMuteRobo(); return }
    if (estado.ativandoMic) return
    if (estado.micAtivo) desativarMic()
    else ativarMic()
  })

  elementos.btnCamera?.addEventListener('click', () => toggleCamera().catch(() => {}))
  elementos.btnParar?.addEventListener('click', () => {
    // Em modo robo, "Parar" interrompe a fala/captura do ROBO no servidor.
    if (estaEmModoRobo()) {
      api.interromperRobo().catch((err) => logRobo(`Falha ao interromper robô: ${err.message}`))
      aplicarEstado('idle')
      return
    }
    interromper({ origem: 'manual' })
  })
  elementos.btnReset?.addEventListener('click', () => resetarConversa())
  elementos.btnFecharErro?.addEventListener('click', fecharErro)
  elementos.btnModalConfirmar?.addEventListener('click', () => fecharConfirmacao(true))
  elementos.btnModalCancelar?.addEventListener('click', () => fecharConfirmacao(false))

  elementos.toggleRobo?.addEventListener('change', () => {
    alternarModoRobo().catch((err) => logRobo(`Falha ao alternar modo robô: ${err.message}`))
  })

  elementos.toggleCamRobo?.addEventListener('change', (ev) => {
    if (ev.target.checked && camera.ativa) {
      toggleCamera().catch(() => {})
    }
  })

  elementos.btnPainelMobile?.addEventListener('click', () => {
    if (elementos.painelRobo?.classList.contains('painel-robo--aberto-mobile')) {
      fecharPainelRoboMobile()
    } else {
      abrirPainelRoboMobile()
    }
  })

  elementos.btnFecharPainelMobile?.addEventListener('click', fecharPainelRoboMobile)

  // Tema claro/escuro: há um botão em cada tela (conversa + seleção). O ícone
  // reflete pra qual tema ele LEVA (lua quando está claro = "ir pro escuro"; sol
  // quando está escuro). O visualizer lê as cores via getComputedStyle, então o
  // avatar reage ao tema sozinho.
  const botoesTema = [document.getElementById('btn-tema'), document.getElementById('btn-tema-usuarios')]
  const tema = iniciarTema((atual) => {
    const nomeIcone = atual === 'light' ? 'dark_mode' : 'light_mode'
    for (const b of botoesTema) {
      const icone = b?.querySelector('.material-symbols-rounded')
      if (icone) icone.textContent = nomeIcone
    }
  })
  for (const b of botoesTema) b?.addEventListener('click', () => tema.alternar())

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!elementos.telaErro.hidden) { fecharErro(); return }
      if (!elementos.modalConfirmar.hidden) { fecharConfirmacao(false); return }
      if (elementos.painelRobo?.classList.contains('painel-robo--aberto-mobile')) {
        fecharPainelRoboMobile()
        return
      }
    }

    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
    if (estado.usuarioAtual === null) return

    if (ev.code === 'Space' && !ev.repeat) {
      ev.preventDefault()
      // Em modo robo, Espaco espelha o botao de mic: muta/desmuta o MIC DO ROBO.
      // Nunca ativa o mic do PC (que competiria com o robo).
      if (estaEmModoRobo()) {
        alternarMuteRobo()
      } else if (estado.micAtivo) {
        desativarMic()
      } else {
        ativarMic()
      }
    } else if (ev.key.toLowerCase() === 'r' && !ev.metaKey && !ev.ctrlKey) {
      resetarConversa()
    } else if (ev.key.toLowerCase() === 'c') {
      // Liga/desliga a webcam do PC. Vale tambem em modo robo: a webcam alimenta a
      // visao da Cogni nos dois caminhos (interface e robo fisico). O toggle "camera
      // do robo" (ESP-CAM) e que e fase futura — esse e outro controle.
      toggleCamera().catch(() => {})
    }
  })

  window.addEventListener('beforeunload', () => {
    pararMonitoramento()
    audio.parar()
    visualizer.destruir()
  })
}

configurarEventos()
carregar()
