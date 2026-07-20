/**
 * supabase.js — Cliente Supabase do servidor + mapeadores de dados.
 *
 * Este modulo e a unica porta de saida do servidor para o Supabase (a fonte
 * unica compartilhada com o site Companion). Usa a SERVICE_ROLE_KEY, que ignora
 * o RLS: por isso vive SO no backend, nunca no front.
 *
 * O servidor trabalha com o usuario em camelCase (materiaFavorita, idiomaNativo,
 * ...); o Postgres usa snake_case (materia_favorita, idioma_nativo, ...). Os
 * mapeadores `usuarioParaLinha`/`linhaParaUsuario` convertem entre os dois nos
 * limites de I/O, pra o resto do codigo (memoria.js, brain.js, prompt.js) nao
 * precisar saber que o Supabase existe.
 *
 * Se SUPABASE_HABILITADO for false (sem as variaveis no .env), `getClient()`
 * retorna null e quem chama simplesmente nao sincroniza — o servidor segue 100%
 * no usuarios.json local (fallback). Ver memoria.js.
 */

const config = require('../config')
const { log } = require('./logger')

let client = null

function getClient() {
  if (!config.SUPABASE_HABILITADO) return null
  if (client) return client
  // require tardio: so carrega o SDK quando o Supabase esta ligado.
  const { createClient } = require('@supabase/supabase-js')
  client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

/**
 * Converte o objeto `usuario` (camelCase, shape do memoria.js) para uma linha da
 * tabela `criancas` (snake_case). Campos jsonb (memorias, idiomasEstudando) vao
 * como arrays/objetos JS — o supabase-js serializa sozinho.
 * @param {object} u
 * @returns {object}
 */
function usuarioParaLinha(u) {
  return {
    id: u.id,
    nome: u.nome,
    role: u.role || 'estudante',
    idade: u.idade ?? null,
    serie: u.serie ?? null,
    materia_favorita: u.materiaFavorita ?? null,
    materia_dificil: u.materiaDificil ?? null,
    como_aprende: u.comoAprende ?? null,
    hobbies: u.hobbies ?? null,
    estilo_linguagem: u.estiloLinguagem ?? null,
    onboarding_completo: !!u.onboardingCompleto,
    memorias: Array.isArray(u.memorias) ? u.memorias : [],
    idioma_nativo: u.idiomaNativo || 'pt',
    idiomas_estudando: Array.isArray(u.idiomasEstudando) ? u.idiomasEstudando : [],
    prompt_personalizado: u.promptPersonalizado ?? null,
    // Geometria dos olhos desenhada pela crianca no Companion. Sem este campo o
    // rosto so vivia no cache/JSON local: nao subia pro Supabase e nao voltava na
    // hidratacao, entao reiniciar o servidor devolvia o robo pro rosto de fabrica.
    rosto_robo: u.rostoRobo ?? null,
    codigo_pareamento: u.codigoPareamento ?? null,
    criado_em: u.criadoEm || new Date().toISOString(),
    ultimo_acesso: u.ultimoAcesso ?? null,
    atualizado_em: new Date().toISOString(),
  }
}

/**
 * Converte uma linha da tabela `criancas` (snake_case) para o objeto `usuario`
 * (camelCase) que o servidor usa. `responsavel_id` nao vira campo do usuario:
 * o servidor opera por crianca; o vinculo so importa pro site (via RLS).
 * @param {object} r
 * @returns {object}
 */
function linhaParaUsuario(r) {
  return {
    id: r.id,
    nome: r.nome,
    role: r.role || 'estudante',
    idade: r.idade ?? null,
    serie: r.serie ?? null,
    materiaFavorita: r.materia_favorita ?? null,
    materiaDificil: r.materia_dificil ?? null,
    comoAprende: r.como_aprende ?? null,
    hobbies: r.hobbies ?? null,
    estiloLinguagem: r.estilo_linguagem ?? null,
    onboardingCompleto: !!r.onboarding_completo,
    memorias: Array.isArray(r.memorias) ? r.memorias : [],
    idiomaNativo: r.idioma_nativo || 'pt',
    idiomasEstudando: Array.isArray(r.idiomas_estudando) ? r.idiomas_estudando : [],
    promptPersonalizado: r.prompt_personalizado ?? null,
    // null = crianca nunca desenhou; enviarRostoParaEsp() cai no ROSTO_PADRAO.
    rostoRobo: r.rosto_robo ?? null,
    codigoPareamento: r.codigo_pareamento ?? null,
    criadoEm: r.criado_em || new Date().toISOString(),
    ultimoAcesso: r.ultimo_acesso ?? null,
  }
}

/**
 * Grava UM turno de conversa (fala da crianca + resposta da Cogni) na tabela
 * `conversas`. Fire-and-forget no fluxo de voz — a resposta ja foi entregue, isto
 * e so registro pro Diario do Companion. Erro so loga.
 *
 * Retorna o `id` da linha inserida (bigint) pra quem quiser completar a linha
 * depois — o `topico` do Painel de Aprendizado e gravado num segundo passo, via
 * `atualizarTopicoConversa`, porque so fica pronto apos a extracao por IA (que
 * roda DEPOIS deste insert, pra o Diario nunca ficar refem da IA). Retorna null
 * quando o Supabase esta desligado, faltam dados ou o insert falha.
 *
 * @param {object} turno
 * @param {string} turno.criancaId    id do perfil (= criancas.id)
 * @param {string} turno.textoUsuario fala da crianca
 * @param {string} turno.textoResposta resposta da Cogni
 * @param {string} turno.materia      materia canonica (ver brain/materia.js)
 * @param {boolean} turno.sensivel    bateu no filtro de seguranca infantil?
 * @param {number|null} turno.duracaoMs duracao do turno em ms (pra tempo de uso)
 * @param {string} turno.origem       'robo' | 'navegador'
 * @returns {Promise<number|null>} id da linha inserida, ou null
 */
async function registrarConversa(turno) {
  if (!config.SUPABASE_HABILITADO) return null
  const sb = getClient()
  if (!sb || !turno || !turno.criancaId) return null

  const { data, error } = await sb
    .from('conversas')
    .insert({
      crianca_id: turno.criancaId,
      texto_usuario: turno.textoUsuario || '',
      texto_resposta: turno.textoResposta || '',
      materia: turno.materia || 'outros',
      sensivel: !!turno.sensivel,
      duracao_ms: turno.duracaoMs ?? null,
      origem: turno.origem || 'navegador',
    })
    .select('id')
    .single()

  if (error) {
    log('Erro', `Registro de conversa (crianca ${turno.criancaId}): ${error.message}`)
    return null
  }
  return data?.id ?? null
}

/**
 * Completa uma conversa ja gravada com o `topico` (assunto fino do Painel de
 * Aprendizado), extraido pela IA depois do insert. Fire-and-forget: nao bloqueia
 * o fluxo de voz e nao e critico (o Diario ja existe sem o topico). No-op quando
 * falta o id ou o topico, ou o Supabase esta desligado.
 *
 * @param {number} conversaId id retornado por `registrarConversa`
 * @param {string} topico     assunto validado (ver brain/memoria-ai.js)
 */
function atualizarTopicoConversa(conversaId, topico) {
  if (!config.SUPABASE_HABILITADO) return
  const sb = getClient()
  if (!sb || !conversaId || !topico) return

  sb.from('conversas')
    .update({ topico })
    .eq('id', conversaId)
    .then(({ error }) => {
      if (error) log('Erro', `Atualizacao de topico (conversa ${conversaId}): ${error.message}`)
    })
}

/**
 * Completa uma conversa ja gravada com os campos refinados pela IA pos-resposta:
 * `topico` (assunto fino), `materia` (classificacao da IA, mais precisa que o regex
 * do insert) e `sensivel` (algo emocionalmente delicado pros pais — vem da IA OU do
 * filtro de seguranca). Fire-and-forget, igual ao topico: o Diario ja existe sem
 * isto; aqui so enriquecemos. So aplica os campos presentes em `campos` (PATCH
 * parcial) — assim nunca sobrescreve com vazio o que o insert ja gravou.
 *
 * @param {number} conversaId id retornado por `registrarConversa`
 * @param {object} campos     { topico?, materia?, sensivel? } — so os que mudam
 */
function atualizarConversaPosIA(conversaId, campos = {}) {
  if (!config.SUPABASE_HABILITADO) return
  const sb = getClient()
  if (!sb || !conversaId) return

  const patch = {}
  if (campos.topico) patch.topico = campos.topico
  if (campos.materia) patch.materia = campos.materia
  if (typeof campos.sensivel === 'boolean') patch.sensivel = campos.sensivel
  if (Object.keys(patch).length === 0) return

  sb.from('conversas')
    .update(patch)
    .eq('id', conversaId)
    .then(({ error }) => {
      if (error) log('Erro', `Atualizacao pos-IA (conversa ${conversaId}): ${error.message}`)
    })
}

/**
 * Le a ULTIMA dica salva de uma crianca (texto + quando foi criada). E a fonte de
 * verdade da "dica de agora": a dica so e regerada quando ha conversa nova DEPOIS
 * deste `criadoEm` (ver dica.js). Sem isso, a dica regenerava com redacao diferente
 * a cada reload/restart e enchia o historico de variacoes da mesma coisa.
 *
 * @param {string} criancaId
 * @returns {Promise<{ texto: string, criadoEm: string }|null>} ultima dica, ou null
 */
async function lerUltimaDica(criancaId) {
  if (!config.SUPABASE_HABILITADO) return null
  const sb = getClient()
  if (!sb || !criancaId) return null

  const { data, error } = await sb
    .from('dicas')
    .select('texto, criado_em')
    .eq('crianca_id', criancaId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log('Erro', `Leitura da ultima dica (crianca ${criancaId}): ${error.message}`)
    return null
  }
  if (!data) return null
  return { texto: (data.texto || '').trim(), criadoEm: data.criado_em }
}

/**
 * Conta quantas conversas a crianca teve DEPOIS de um instante ISO. Usado pra
 * decidir se a dica/resumo precisa ser regerado: zero conversas novas => reusa o
 * ultimo salvo (sem gastar IA, sem variar o texto). > 0 => vale gerar de novo.
 * Retorna 0 em erro/sem Supabase (degrada pra "nao regera", o lado seguro/barato).
 *
 * @param {string} criancaId
 * @param {string} desdeIso  instante ISO (ex: criado_em da ultima dica)
 * @returns {Promise<number>} contagem de conversas com criado_em > desdeIso
 */
async function contarConversasDesde(criancaId, desdeIso) {
  if (!config.SUPABASE_HABILITADO) return 0
  const sb = getClient()
  if (!sb || !criancaId || !desdeIso) return 0

  const { count, error } = await sb
    .from('conversas')
    .select('id', { count: 'exact', head: true })
    .eq('crianca_id', criancaId)
    .gt('criado_em', desdeIso)

  if (error) {
    log('Erro', `Contagem de conversas desde ${desdeIso} (crianca ${criancaId}): ${error.message}`)
    return 0
  }
  return count || 0
}

/**
 * Grava uma Dica do Cogni no histórico (tabela `dicas`), pro Companion listar em
 * "Dicas da Cogni". Para NÃO encher o histórico de repetidas (o cache curto faz a
 * dica regenerar várias vezes/dia), só insere se o texto for DIFERENTE da última
 * dica salva dessa criança. Fire-and-forget; erro só loga. No-op sem Supabase/dados.
 *
 * @param {string} criancaId
 * @param {string} texto  o texto da dica
 * @returns {Promise<boolean>} true se gravou uma linha nova; false se repetida/no-op
 */
async function registrarDica(criancaId, texto) {
  if (!config.SUPABASE_HABILITADO) return false
  const sb = getClient()
  if (!sb || !criancaId || !texto) return false

  try {
    // Última dica salva dessa criança — pra não duplicar a mesma.
    const { data: ultimas, error: erroLeitura } = await sb
      .from('dicas')
      .select('texto')
      .eq('crianca_id', criancaId)
      .order('criado_em', { ascending: false })
      .limit(1)
    if (erroLeitura) { log('Erro', `Leitura da última dica (crianca ${criancaId}): ${erroLeitura.message}`); return false }

    const ultima = ultimas && ultimas.length ? (ultimas[0].texto || '').trim() : null
    if (ultima && ultima === texto.trim()) return false   // igual à última: não grava

    const { error } = await sb.from('dicas').insert({ crianca_id: criancaId, texto: texto.trim() })
    if (error) { log('Erro', `Registro de dica (crianca ${criancaId}): ${error.message}`); return false }
    return true
  } catch (err) {
    log('Erro', `Registro de dica (crianca ${criancaId}) falhou: ${err.message}`)
    return false
  }
}

/**
 * Le o ULTIMO resumo semanal salvo de uma crianca (tabela `resumos_semanais`).
 * Mesma ideia da ultima dica: e a "ultima carta" que o site mostra quando o robo
 * esta desligado ou enquanto nao geramos uma nova. So regeramos quando ha conversa
 * nova desde `criadoEm` (ver resumo-semanal.js). Devolve o pacote completo que o
 * site consome (texto + materias/topicos/total), ou null.
 *
 * @param {string} criancaId
 * @returns {Promise<{ resumo: string, materias: string[], topicos: string[], totalConversas: number, criadoEm: string }|null>}
 */
async function lerUltimoResumoSemanal(criancaId) {
  if (!config.SUPABASE_HABILITADO) return null
  const sb = getClient()
  if (!sb || !criancaId) return null

  const { data, error } = await sb
    .from('resumos_semanais')
    .select('texto, materias, topicos, total_conversas, criado_em')
    .eq('crianca_id', criancaId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log('Erro', `Leitura do ultimo resumo (crianca ${criancaId}): ${error.message}`)
    return null
  }
  if (!data) return null
  return {
    resumo: (data.texto || '').trim(),
    materias: Array.isArray(data.materias) ? data.materias : [],
    topicos: Array.isArray(data.topicos) ? data.topicos : [],
    totalConversas: data.total_conversas ?? 0,
    criadoEm: data.criado_em,
  }
}

/**
 * Grava um resumo semanal no historico (tabela `resumos_semanais`). Diferente da
 * dica, NAO dedup por texto: cada geracao e um retrato da semana (o site pode listar
 * o historico de cartas). Fire-and-forget; erro so loga. No-op sem Supabase/dados.
 *
 * @param {object} dados
 * @param {string} dados.criancaId
 * @param {string} dados.texto           o bilhete gerado
 * @param {string[]} [dados.materias]
 * @param {string[]} [dados.topicos]
 * @param {number} [dados.totalConversas]
 * @param {number} [dados.periodoDias]
 * @returns {Promise<boolean>} true se gravou; false em no-op/erro
 */
async function registrarResumoSemanal(dados) {
  if (!config.SUPABASE_HABILITADO) return false
  const sb = getClient()
  if (!sb || !dados || !dados.criancaId || !dados.texto) return false

  const { error } = await sb.from('resumos_semanais').insert({
    crianca_id: dados.criancaId,
    texto: dados.texto.trim(),
    materias: Array.isArray(dados.materias) ? dados.materias : [],
    topicos: Array.isArray(dados.topicos) ? dados.topicos : [],
    total_conversas: dados.totalConversas ?? 0,
    periodo_dias: dados.periodoDias ?? 7,
  })
  if (error) {
    log('Erro', `Registro de resumo semanal (crianca ${dados.criancaId}): ${error.message}`)
    return false
  }
  return true
}

module.exports = {
  getClient,
  usuarioParaLinha,
  linhaParaUsuario,
  registrarConversa,
  atualizarTopicoConversa,
  atualizarConversaPosIA,
  registrarDica,
  lerUltimaDica,
  contarConversasDesde,
  lerUltimoResumoSemanal,
  registrarResumoSemanal,
}
