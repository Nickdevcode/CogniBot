const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')
const { sanitizarNome } = require('./safety')
const { log } = require('./logger')
const supabase = require('./supabase')
const { gerarCodigo } = require('./pareamento')

const PASTA_DADOS = path.join(__dirname, '../dados')
const ARQUIVO_USUARIOS = path.join(PASTA_DADOS, 'usuarios.json')

let cache = null
let timerSalvar = null
let salvandoAgora = false

// ===================================================================
// Sincronizacao com o Supabase (write-through)
// ===================================================================
// O cache em RAM continua sendo a fonte de LEITURA (sincrona) do servidor — o
// robo nunca espera a nuvem no fluxo de voz. As escritas sao espelhadas pro
// Supabase de forma assincrona (fire-and-forget), serializadas por usuario pra
// evitar lost-update no lado do banco. Erro de rede so loga: o usuarios.json
// local tem o dado e o proximo write (ou o boot) ressincroniza.
const filasSync = new Map()

function enfileirarSyncSupabase(usuario) {
  if (!config.SUPABASE_HABILITADO || !usuario || !usuario.id) return
  const sb = supabase.getClient()
  if (!sb) return

  const id = usuario.id
  const linha = supabase.usuarioParaLinha(usuario)
  const anterior = filasSync.get(id) || Promise.resolve()
  const tarefa = anterior
    .catch(() => {})
    .then(async () => {
      const { error } = await sb.from('criancas').upsert(linha, { onConflict: 'id' })
      if (error) log('Erro', `Sync Supabase (crianca ${id}): ${error.message}`)
    })
  filasSync.set(id, tarefa)
  tarefa.finally(() => {
    if (filasSync.get(id) === tarefa) filasSync.delete(id)
  })
}

function excluirNoSupabase(id) {
  if (!config.SUPABASE_HABILITADO) return
  const sb = supabase.getClient()
  if (!sb) return
  sb.from('criancas').delete().eq('id', id).then(({ error }) => {
    if (error) log('Erro', `Exclusao Supabase (crianca ${id}): ${error.message}`)
  })
}

/**
 * Hidratacao no boot: carrega o usuarios.json local primeiro (fallback garantido)
 * e, se o Supabase estiver ligado, sobrescreve o cache com os dados da nuvem (a
 * fonte de verdade compartilhada). Chamada por index.js ANTES do server.listen,
 * pra carregarUsuario ja servir do cache sem I/O de rede no fluxo de voz.
 * @returns {Promise<void>}
 */
async function inicializar() {
  carregarTodosUsuarios() // JSON local primeiro = fallback sempre disponivel

  if (!config.SUPABASE_HABILITADO) {
    log('Memoria', 'Supabase desligado — usando usuarios.json local (fallback).')
    return
  }

  const sb = supabase.getClient()
  if (!sb) return

  try {
    const { data, error } = await sb.from('criancas').select('*')
    if (error) throw error
    const novo = {}
    for (const linha of data) novo[linha.id] = supabase.linhaParaUsuario(linha)
    cache = novo
    log('Memoria', `Cache hidratado do Supabase: ${data.length} crianca(s).`)
  } catch (err) {
    log('Erro', `Hidratacao do Supabase falhou (${err.message}). Servindo do usuarios.json local.`)
  }

  iniciarRealtimeUsuarios()
}

// ===================================================================
// Realtime do Supabase (reforco instantaneo: pai salva -> cache na hora)
// ===================================================================
// REFORCO por cima do refrescarUsuario (que ja cobre "no proximo turno"). Quando o
// pai edita o perfil no site, o Supabase emite o evento e o cache atualiza NA HORA,
// sem esperar a crianca falar de novo. Degradacao graciosa: se o Realtime nao
// estiver habilitado pra tabela `criancas` no painel do Supabase, ou a conexao
// cair, NADA quebra — o refrescarUsuario a cada conversa garante a sincronizacao.
// Por isso isto e best-effort e nunca lanca pro chamador.
let canalRealtime = null

function aplicarMudancaRealtime(novaLinha) {
  if (!novaLinha || !novaLinha.id || !cache) return
  const id = novaLinha.id
  const doSupabase = supabase.linhaParaUsuario(novaLinha)
  const atual = cache[id]
  if (!atual) {
    // Perfil novo criado pelo site (raro: normalmente nasce no robo). Adota inteiro.
    cache[id] = doSupabase
  } else {
    // Mescla SO os campos do pai (mesma regra do refrescarUsuario) — nao pisa nas
    // memorias/idiomas/estilo que o robo aprende e ainda pode nao ter subido.
    for (const campo of CAMPOS_DO_PAI) {
      if (doSupabase[campo] !== undefined) atual[campo] = doSupabase[campo]
    }
  }
  agendarSalvar()
  log('Memoria', `Realtime: perfil ${novaLinha.nome || id} atualizado do site.`)
}

function iniciarRealtimeUsuarios() {
  if (!config.SUPABASE_HABILITADO) return
  const sb = supabase.getClient()
  if (!sb || canalRealtime) return

  try {
    canalRealtime = sb
      .channel('criancas-perfil')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'criancas' },
        (payload) => { try { aplicarMudancaRealtime(payload.new) } catch (e) { log('Erro', `Realtime aplicar: ${e.message}`) } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'criancas' },
        (payload) => { try { aplicarMudancaRealtime(payload.new) } catch (e) { log('Erro', `Realtime aplicar: ${e.message}`) } })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') log('Memoria', 'Realtime de perfis ativo (pai edita no site -> cache na hora).')
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          log('Aviso', `Realtime de perfis indisponivel (${status}). Fallback: refresh a cada conversa.`)
        }
      })
  } catch (err) {
    log('Aviso', `Nao foi possivel iniciar o Realtime de perfis (${err.message}). Fallback: refresh a cada conversa.`)
  }
}

// ===================================================================
// Refresh do perfil a partir do Supabase (Supabase -> cache)
// ===================================================================
// A hidratacao em inicializar() so roda no BOOT. Mas o PAI edita o perfil pelo
// site (idade, serie, hobbies, prompt personalizado, vinculo...) a qualquer
// momento — e isso ia pro Supabase mas NUNCA voltava pro cache do robo (que so
// recebia as escritas do proprio robo). Resultado: editar no site nao chegava no
// robo, que seguia com o perfil velho/vazio e refazia o onboarding por cima.
//
// refrescarUsuario() corrige isso: puxa a linha do Supabase e MESCLA no cache, de
// forma fire-and-forget (nao trava o fluxo de voz; a leitura segue sincrona do
// cache) e DENTRO de atualizarUsuario (serializado por usuario), pra nao colidir
// com uma escrita do robo em andamento. Mesmo espirito do refrescarPlanoAtivo.
//
// REGRA DE MERGE (quem ganha em cada campo):
//   - Campos do perfil que o PAI edita pelo site (incluindo estiloLinguagem, que o
//     pai TAMBEM edita): o Supabase VENCE no momento do refresh — e o objetivo e
//     trazer a edicao do pai. "Ultima escrita vence": a IA continua refinando o
//     estilo na conversa (salvarUsuario sobe pro Supabase), o pai edita no site;
//     quem escreveu por ultimo fica. Inclui onboardingCompleto (o site pode marcar).
//   - memorias / idiomasEstudando: o ROBO controla (aprende na conversa). NAO
//     sobrescrevemos com o Supabase aqui — manter o do cache evita perder o que a
//     IA acabou de extrair e ainda nao subiu (e a lista do site pode vir vazia).
//   - ultimoAcesso: mantem o do cache (mais fresco).
const filasRefresh = new Map()

// Campos do perfil que o PAI edita pelo site — nestes, o Supabase e a verdade no
// refresh. `estiloLinguagem` entra aqui (o pai edita; a IA tambem refina, e a
// ultima escrita vence — ver nota acima).
const CAMPOS_DO_PAI = [
  'nome', 'idade', 'serie', 'materiaFavorita', 'materiaDificil',
  'comoAprende', 'hobbies', 'estiloLinguagem', 'onboardingCompleto',
  'promptPersonalizado', 'codigoPareamento',
]

// Re-hidrata a LISTA inteira de criancas do Supabase pro cache. Diferente do
// refrescarUsuario (um id), isto descobre perfis NOVOS criados no site que o robo
// ainda nem conhece (sem isso, um perfil criado no site so apareceria na interface
// localhost apos reiniciar, ou se o Realtime estivesse ligado). Mescla pelos campos
// do pai (nao pisa nas memorias que o robo aprendeu) e ADOTA perfis novos inteiros.
// Fire-and-forget; chamada quando a interface lista os perfis. No-op sem Supabase.
let refrescandoLista = false
async function refrescarTodosUsuarios() {
  if (!config.SUPABASE_HABILITADO || refrescandoLista) return
  const sb = supabase.getClient()
  if (!sb) return
  refrescandoLista = true
  try {
    const { data, error } = await sb.from('criancas').select('*')
    if (error) { log('Erro', `Refresh da lista de perfis: ${error.message}`); return }
    if (!cache) carregarTodosUsuarios()
    for (const linha of data) {
      const doSupabase = supabase.linhaParaUsuario(linha)
      const atual = cache[linha.id]
      if (!atual) {
        cache[linha.id] = doSupabase   // perfil novo (criado no site) — adota inteiro
      } else {
        for (const campo of CAMPOS_DO_PAI) {
          if (doSupabase[campo] !== undefined) atual[campo] = doSupabase[campo]
        }
      }
    }
    agendarSalvar()
  } catch (err) {
    log('Erro', `Refresh da lista de perfis falhou: ${err.message}`)
  } finally {
    refrescandoLista = false
  }
}

function refrescarUsuario(id) {
  if (!config.SUPABASE_HABILITADO || !id) return
  if (filasRefresh.has(id)) return   // dedup: ja ha um refresh em voo pra esse id
  const sb = supabase.getClient()
  if (!sb) return

  const tarefa = (async () => {
    const { data, error } = await sb.from('criancas').select('*').eq('id', id).maybeSingle()
    if (error) { log('Erro', `Refresh de perfil (crianca ${id}): ${error.message}`); return }
    if (!data) return   // perfil nao existe no Supabase (so local) — nada a mesclar

    const doSupabase = supabase.linhaParaUsuario(data)
    // Merge DENTRO da fila do usuario (exclusao mutua com escritas do robo).
    await atualizarUsuario(id, (u) => {
      for (const campo of CAMPOS_DO_PAI) {
        // So aplica o que veio definido do Supabase (nao zera campo do cache com
        // null vindo do banco — defensivo). Pro pai, o site e a fonte: se ele
        // limpou um campo, virá string vazia/valor, nao undefined.
        if (doSupabase[campo] !== undefined) u[campo] = doSupabase[campo]
      }
    })
  })()
    .catch(err => log('Erro', `Refresh de perfil (crianca ${id}) falhou: ${err.message}`))
    .finally(() => { if (filasRefresh.get(id) === tarefa) filasRefresh.delete(id) })

  filasRefresh.set(id, tarefa)
}

// Versao AWAITED do refresh: puxa do Supabase, mescla, e devolve o usuario fresco
// do cache. Diferente do refrescarUsuario (fire-and-forget, pro PROXIMO turno),
// esta espera — usada SO no inicio da conversa quando o perfil no cache parece
// incompleto (perfil novo / sem essenciais), pra o PRIMEIRO turno ja decidir o
// onboarding com o que o pai editou no site. Custo (um await de rede) so e pago
// nesse caso raro; perfil ja completo nunca passa por aqui (ver brain.js).
async function carregarUsuarioFresco(id) {
  if (!config.SUPABASE_HABILITADO || !id) return carregarUsuario(id)
  const sb = supabase.getClient()
  if (!sb) return carregarUsuario(id)

  try {
    const { data, error } = await sb.from('criancas').select('*').eq('id', id).maybeSingle()
    if (error) { log('Erro', `Carga fresca de perfil (crianca ${id}): ${error.message}`); return carregarUsuario(id) }
    if (data) {
      const doSupabase = supabase.linhaParaUsuario(data)
      await atualizarUsuario(id, (u) => {
        for (const campo of CAMPOS_DO_PAI) {
          if (doSupabase[campo] !== undefined) u[campo] = doSupabase[campo]
        }
      })
    }
  } catch (err) {
    log('Erro', `Carga fresca de perfil (crianca ${id}) falhou: ${err.message}`)
  }
  return carregarUsuario(id)
}

function garantirPasta() {
  if (!fs.existsSync(PASTA_DADOS)) {
    fs.mkdirSync(PASTA_DADOS, { recursive: true })
  }
}

function carregarTodosUsuarios() {
  if (cache) return cache

  garantirPasta()

  if (!fs.existsSync(ARQUIVO_USUARIOS)) {
    cache = {}
    return cache
  }

  try {
    const conteudo = fs.readFileSync(ARQUIVO_USUARIOS, 'utf-8')
    cache = JSON.parse(conteudo)
  } catch (err) {
    log('Erro', `Falha ao ler usuarios.json (${err.message}). Iniciando vazio.`)
    cache = {}
  }
  return cache
}

function escreverArquivo(usuarios) {
  garantirPasta()
  const tmp = ARQUIVO_USUARIOS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(usuarios, null, 2), 'utf-8')
  fs.renameSync(tmp, ARQUIVO_USUARIOS)
}

function agendarSalvar() {
  if (salvandoAgora) return
  if (timerSalvar) clearTimeout(timerSalvar)
  timerSalvar = setTimeout(() => {
    timerSalvar = null
    salvandoAgora = true
    try {
      escreverArquivo(cache)
    } catch (err) {
      log('Erro', `Falha ao salvar usuarios.json: ${err.message}`)
    } finally {
      salvandoAgora = false
    }
  }, 200)
}

function flushSync() {
  if (timerSalvar) {
    clearTimeout(timerSalvar)
    timerSalvar = null
  }
  if (cache) {
    try {
      escreverArquivo(cache)
    } catch (err) {
      log('Erro', `Falha ao flush usuarios.json: ${err.message}`)
    }
  }
}

function gerarId() {
  return 'usuario_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex')
}

function criarUsuario(nome) {
  const usuarios = carregarTodosUsuarios()
  const id = gerarId()

  // Detecta o segredo de DEV no nome CRU, ANTES de sanitizar/truncar. Bug antigo: o
  // sanitizarNome truncava em 30 chars e podia CORTAR o "#segredo" no fim de um nome
  // longo ("Nicolas Carvalho Silva #nickdev" > 30) - ai o role nunca virava dev.
  // Match tolerante: ignora caixa e espacos ao redor do '#' ("# nickdev", "#NickDev").
  let role = 'estudante'
  const nomeCru = typeof nome === 'string' ? nome : ''
  const segredoEsc = String(config.DEVELOPER_SECRET).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regexSegredo = new RegExp(`#\\s*${segredoEsc}`, 'i')
  let nomeSemSegredo = nomeCru
  if (regexSegredo.test(nomeCru)) {
    role = 'desenvolvedor'
    nomeSemSegredo = nomeCru.replace(regexSegredo, '')
  }

  // So agora sanitiza/trunca o nome (ja sem o segredo).
  let nomeLimpo = sanitizarNome(nomeSemSegredo, config.MAX_NOME_LENGTH)
  if (!nomeLimpo) {
    nomeLimpo = role === 'desenvolvedor' ? 'Dev' : 'Estudante'
  }

  const ehDev = role === 'desenvolvedor'

  usuarios[id] = {
    id,
    nome: nomeLimpo,
    role,
    idade: null,
    serie: null,
    materiaFavorita: null,
    materiaDificil: null,
    comoAprende: null,
    hobbies: null,
    estiloLinguagem: null,
    onboardingCompleto: ehDev,
    memorias: [],
    idiomaNativo: 'pt',
    idiomasEstudando: [],
    // Instrucoes que o responsavel escreve sobre esse filho (vem do Companion).
    // Comeca null; o robo nunca preenche — quem mexe e o pai pelo site.
    promptPersonalizado: null,
    // Codigo de pareamento FIXO do perfil: nasce com ele e nunca muda. O pai usa
    // pra vincular a crianca no Companion (ver pareamento.js).
    codigoPareamento: gerarCodigo(),
    criadoEm: new Date().toISOString(),
    ultimoAcesso: new Date().toISOString(),
  }

  agendarSalvar()
  enfileirarSyncSupabase(usuarios[id])
  return usuarios[id]
}

function carregarUsuario(id) {
  if (!id || typeof id !== 'string') return null
  const usuarios = carregarTodosUsuarios()
  const usuario = usuarios[id] || null

  if (usuario) {
    if (!usuario.role) usuario.role = 'estudante'
    if (!Array.isArray(usuario.memorias)) usuario.memorias = []
    if (!usuario.idiomaNativo) usuario.idiomaNativo = 'pt'
    if (!Array.isArray(usuario.idiomasEstudando)) usuario.idiomasEstudando = []
    if (!('promptPersonalizado' in usuario)) usuario.promptPersonalizado = null
    // Backfill do codigo de pareamento: perfis criados antes desta feature ganham
    // um codigo ao serem carregados (e ele sincroniza pro Supabase na proxima escrita).
    if (!usuario.codigoPareamento) usuario.codigoPareamento = gerarCodigo()
    if (usuario.role === 'desenvolvedor' && !usuario.onboardingCompleto) {
      usuario.onboardingCompleto = true
    }
    usuario.ultimoAcesso = new Date().toISOString()
    // DE PROPOSITO nao sincroniza o Supabase aqui: carregarUsuario roda no fluxo
    // de voz e a cada leitura — sincronizar o ultimoAcesso a cada vez estouraria a
    // quota de writes do free tier. O ultimoAcesso pega carona na proxima escrita
    // de conteudo real (salvarUsuario/salvarUsuarioImediato), que ja sincroniza.
    agendarSalvar()
  }

  return usuario
}

function salvarUsuario(usuario) {
  if (!usuario || !usuario.id) return
  const usuarios = carregarTodosUsuarios()
  usuarios[usuario.id] = usuario
  agendarSalvar()
  enfileirarSyncSupabase(usuario)
}

// Salva AGORA, sincrono (sem o debounce de agendarSalvar). Usado nos caminhos
// "quentes" pos-resposta (memoria com IA, aprendizado), que rodam dentro de
// atualizarUsuario: como escreverArquivo ja e writeFileSync + rename atomico, o
// custo e desprezivel para o volume do projeto e elimina o risco do clearTimeout
// em cascata (uma escrita cancelando a anterior) que causava perda de dados.
function salvarUsuarioImediato(usuario) {
  if (!usuario || !usuario.id) return
  const usuarios = carregarTodosUsuarios()
  usuarios[usuario.id] = usuario
  try {
    escreverArquivo(usuarios)
  } catch (err) {
    log('Erro', `Falha ao salvar (imediato) usuarios.json: ${err.message}`)
  }
  enfileirarSyncSupabase(usuario)
}

// Atualizacao ATOMICA por usuario. Serializa ler->mutar->salvar numa fila (uma
// por usuarioId), garantindo exclusao mutua durante TODO o ciclo - inclusive o
// await de uma chamada de LLM dentro de `fn`. Resolve o lost-update que acontecia
// quando extrairMemoriasComIA e analisarPedagogicamente (disparados em paralelo)
// liam/mutavam a MESMA referencia do cache e salvavam por cima um do outro.
//
//   await atualizarUsuario(id, async (u) => { ...muta u...; return algo })
//
// `fn` recebe o usuario vivo (mesma referencia do cache) ja "travado" para esta
// fila; nao precisa (e nao deve) salvar - o salvamento imediato e feito aqui no
// fim. Se `fn` lanca, o erro propaga para o chamador (que normalmente faz .catch),
// e a fila segue para a proxima tarefa sem travar.
const filasPorUsuario = new Map()

function atualizarUsuario(id, fn) {
  if (!id || typeof id !== 'string') return Promise.resolve(null)

  const anterior = filasPorUsuario.get(id) || Promise.resolve()
  const resultado = anterior
    .catch(() => {})
    .then(async () => {
      const usuario = carregarUsuario(id)
      if (!usuario) return null
      const r = await fn(usuario)
      salvarUsuarioImediato(usuario)
      return r
    })

  filasPorUsuario.set(id, resultado)
  // Limpa a entrada da fila quando esta for a ultima tarefa (evita o Map crescer
  // sem limite). Se outra tarefa ja encadeou depois, nao remove.
  resultado.finally(() => {
    if (filasPorUsuario.get(id) === resultado) filasPorUsuario.delete(id)
  })
  return resultado
}

function listarUsuarios() {
  const usuarios = carregarTodosUsuarios()

  return Object.values(usuarios).map(u => ({
    id: u.id,
    nome: u.nome,
    idade: u.idade,
    ultimoAcesso: u.ultimoAcesso,
  }))
}

function excluirUsuario(id) {
  const usuarios = carregarTodosUsuarios()

  if (!usuarios[id]) return false

  const nome = usuarios[id].nome
  delete usuarios[id]
  agendarSalvar()
  excluirNoSupabase(id)
  log('Memoria', `Usuario "${nome}" (${id}) removido. Memorias apagadas.`)
  return true
}

// Rede de seguranca: persiste o cache se o processo for sair naturalmente (sem
// pendencias no event loop). NAO registramos handlers de SIGINT/SIGTERM aqui de
// proposito: o encerramento do processo e responsabilidade do entry point
// (index.js), que ja chama flushSync() e DEPOIS fecha o servidor graciosamente
// (server.close). Se este modulo tambem desse process.exit() no sinal, mataria o
// processo antes do server.close() escoar as conexoes WebSocket/SSE abertas.
process.on('beforeExit', flushSync)

module.exports = {
  inicializar,
  criarUsuario,
  carregarUsuario,
  carregarUsuarioFresco,
  refrescarUsuario,
  refrescarTodosUsuarios,
  salvarUsuario,
  salvarUsuarioImediato,
  atualizarUsuario,
  listarUsuarios,
  excluirUsuario,
  flushSync,
}
