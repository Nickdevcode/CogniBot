/**
 * planos.js — Cache do PLANO DE ESTUDO ativo de cada crianca.
 *
 * O pai cria/edita planos no site (CRUD direto em `planos_estudo` via anon key +
 * RLS); o servidor so LE o plano ATIVO da crianca pra injeta-lo no system prompt
 * da Cogni (ver brain/prompt.js -> blocoPlanoEstudo). Quando a crianca chega no
 * robo, a Cogni ja sabe o roteiro do plano.
 *
 * Mesma filosofia do memoria.js: a LEITURA e SINCRONA, de um cache em RAM — o robo
 * NUNCA espera a nuvem no fluxo de voz. O cache e atualizado:
 *   - no boot, por hidratarPlanos() (igual a hidratacao de criancas);
 *   - sob demanda, por refrescarPlanoAtivo() (fire-and-forget no inicio de cada
 *     conversa) — assim um plano recem-criado pelo pai entra no turno SEGUINTE,
 *     sem bloquear o atual.
 *
 * Sem Supabase (SUPABASE_HABILITADO=false), tudo vira no-op e obterPlanoAtivo
 * retorna null — o servidor roda exatamente como antes dos planos.
 *
 * Regra de produto (single-child): UMA crianca tem no maximo UM plano 'ativo' por
 * vez. Se o banco tiver mais de um (CRUD bagunçado), pegamos o mais recente por
 * `atualizado_em` — comportamento previsivel, sem o prompt seguir varios planos.
 */

const config = require('../config')
const { getClient } = require('./supabase')
const { log } = require('./logger')

// cache: Map<criancaId, plano|null>. `null` armazenado = "ja consultei, nao tem
// plano ativo" (evita reconsultar a toa e distingue de "nunca consultei").
const cache = new Map()

// Evita refreshes concorrentes pra mesma crianca (varios turnos rapidos): guarda a
// Promise em andamento e reusa.
const refreshEmAndamento = new Map()

/**
 * Converte uma linha de `planos_estudo` (snake_case) no objeto `plano` (camelCase)
 * que o prompt usa. So os campos que o system prompt precisa + metadados de status.
 * @param {object} r linha do Postgres
 * @returns {object} plano em camelCase
 */
function linhaParaPlano(r) {
  return {
    id: r.id,
    criancaId: r.crianca_id,
    titulo: r.titulo || '',
    conteudo: r.conteudo || '',
    foco: r.foco || null,
    duracaoDias: r.duracao_dias ?? null,
    status: r.status || 'ativo',
    criadoEm: r.criado_em || null,
    atualizadoEm: r.atualizado_em || r.criado_em || null,
  }
}

// Status que fazem a Cogni SEGUIR o plano (= injetar no prompt). 'ativo' e
// 'em_andamento' contam; 'pausado'/'concluido' nao (a Cogni ignora). Bate com o
// schema do doc-mae (planos_estudo.status).
const STATUS_VIGENTES = ['ativo', 'em_andamento']

// O plano ja venceu? Vence quando passaram mais de `duracaoDias` desde a CRIACAO.
// Sem duracao (null/<=0) = sem prazo, nunca vence por tempo. Sem data de criacao =
// nao da pra calcular, entao NAO vence (conservador: melhor cobrar do que sumir).
// Ex: plano de 1 dia criado ontem -> hoje ja venceu (a Cogni para de cobrar).
function planoVencido(plano, agoraMs = Date.now()) {
  if (!plano) return true
  const dias = Number(plano.duracaoDias)
  if (!Number.isFinite(dias) || dias <= 0) return false   // sem prazo
  if (!plano.criadoEm) return false                        // sem como calcular
  const criadoMs = Date.parse(plano.criadoEm)
  if (Number.isNaN(criadoMs)) return false
  const fimMs = criadoMs + dias * 24 * 60 * 60 * 1000
  return agoraMs >= fimMs
}

/**
 * Busca no Supabase o plano ATIVO mais recente de uma crianca. Async — uso interno
 * (hidratacao e refresh). Retorna o plano (camelCase) ou null.
 * @param {string} criancaId
 * @returns {Promise<object|null>}
 */
async function buscarPlanoAtivo(criancaId) {
  const sb = getClient()
  if (!sb || !criancaId) return null

  const { data, error } = await sb
    .from('planos_estudo')
    .select('*')
    .eq('crianca_id', criancaId)
    .in('status', STATUS_VIGENTES)
    .order('atualizado_em', { ascending: false })
    .limit(1)

  if (error) {
    log('Erro', `Busca de plano ativo (crianca ${criancaId}): ${error.message}`)
    return null
  }
  return data && data.length ? linhaParaPlano(data[0]) : null
}

/**
 * LEITURA SINCRONA do plano ativo da crianca, direto do cache em RAM. Esta e a
 * funcao que o fluxo de voz chama — nunca toca a rede, nunca trava. Retorna null
 * se nao ha plano ativo (ou se o cache ainda nao foi populado pra essa crianca; o
 * refresh assincrono preenche pro proximo turno).
 * @param {string} criancaId
 * @returns {object|null}
 */
function obterPlanoAtivo(criancaId) {
  if (!config.SUPABASE_HABILITADO || !criancaId) return null
  const plano = cache.get(criancaId) || null
  // Filtro de EXPIRACAO no momento da leitura: um plano de N dias deixa de valer
  // quando o prazo passa, sem o pai precisar fazer nada. Sincrono e barato (so uma
  // conta de data). Plano vencido = a Cogni para de cobrar (retorna null). Nao
  // limpamos o cache aqui: o proximo refrescarPlanoAtivo() reavalia do banco (o pai
  // pode ter renovado/reativado), e a checagem por leitura ja blinda o prompt.
  if (plano && planoVencido(plano)) return null
  return plano
}

/**
 * Atualiza o cache do plano ativo de UMA crianca a partir do banco, em segundo
 * plano (fire-and-forget). Chamada no inicio de cada conversa: o turno ATUAL usa o
 * que ja esta em cache (sincrono), e este refresh deixa o cache fresco pro PROXIMO
 * turno. Dedup por crianca pra nao disparar varias buscas simultaneas.
 * @param {string} criancaId
 */
function refrescarPlanoAtivo(criancaId) {
  if (!config.SUPABASE_HABILITADO || !criancaId) return
  if (refreshEmAndamento.has(criancaId)) return

  const tarefa = buscarPlanoAtivo(criancaId)
    .then(plano => { cache.set(criancaId, plano) })
    .catch(err => log('Erro', `Refresh de plano (crianca ${criancaId}) falhou: ${err.message}`))
    .finally(() => refreshEmAndamento.delete(criancaId))

  refreshEmAndamento.set(criancaId, tarefa)
}

/**
 * Hidratacao no boot: carrega TODOS os planos ativos de uma vez pro cache, pra um
 * plano criado ANTES do servidor subir ja valer no 1o turno. Uma query so (nao N).
 * No-op sem Supabase. Chamada por index.js apos inicializar a memoria.
 * @returns {Promise<void>}
 */
async function hidratarPlanos() {
  if (!config.SUPABASE_HABILITADO) return
  const sb = getClient()
  if (!sb) return

  try {
    const { data, error } = await sb
      .from('planos_estudo')
      .select('*')
      .in('status', STATUS_VIGENTES)
      .order('atualizado_em', { ascending: false })
    if (error) throw error

    cache.clear()
    // data ja vem por atualizado_em desc: o PRIMEIRO de cada crianca e o mais
    // recente. set() so se ainda nao tem (mantem o mais recente, descarta o resto).
    for (const linha of data) {
      if (!cache.has(linha.crianca_id)) cache.set(linha.crianca_id, linhaParaPlano(linha))
    }
    log('Planos', `Cache hidratado do Supabase: ${cache.size} plano(s) ativo(s).`)
  } catch (err) {
    log('Erro', `Hidratacao de planos falhou (${err.message}).`)
  }
}

module.exports = {
  obterPlanoAtivo,
  refrescarPlanoAtivo,
  hidratarPlanos,
  linhaParaPlano,   // exportado pra teste
  planoVencido,     // exportado pra teste
  STATUS_VIGENTES,  // exportado pra teste
}
