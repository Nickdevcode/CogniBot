/**
 * dica.js — A "Dica do Cogni" da tela Inicio do Companion.
 *
 * Sob demanda (o site chama o endpoint quando o pai abre o Dashboard), a Cogni
 * sugere UMA dica curta e pratica pros pais ajudarem na rotina de estudos da
 * crianca, com base nas memorias do perfil + nos topicos que ela explorou nos
 * ultimos dias. A chave da OpenAI vive so no servidor, por isso passa por aqui.
 *
 * REGRA DE REGENERACAO (o ponto-chave): a dica e a "dica de agora" e tem que ser
 * ESTAVEL — nao pode variar de redacao a cada reload/restart. Por isso a fonte de
 * verdade e a ULTIMA dica salva no Supabase (tabela `dicas`), e so geramos uma NOVA
 * quando a crianca CONVERSOU desde a ultima dica. Sem conversa nova => devolvemos a
 * ultima salva, identica. Isso resolve o bug em que o cache (volatil, por tempo)
 * expirava/sumia no restart e a IA regerava variacoes da mesma dica, entupindo o
 * historico.
 *
 * O cache em RAM continua existindo, mas com papel menor: so evita marterlar o
 * Supabase quando a tela recarrega em rajada (janela curta). A DECISAO de regerar e
 * por conversa nova, nao por TTL.
 */

const { getClient, lerUltimaDica, contarConversasDesde, registrarDica } = require('../supabase')
const { carregarUsuario } = require('../memoria')
const { log } = require('../logger')

// Janela de topicos recentes que alimentam a dica (dias). Curta de proposito: a
// dica fala do "agora" da crianca, nao do historico inteiro.
const DIAS_JANELA = 7
const MAX_CONVERSAS = 60
const UM_DIA_MS = 24 * 60 * 60 * 1000

// Cache RAM curto: so absorve reloads em rajada da MESMA tela (ex: o pai abre o
// Dashboard e ele faz 2-3 fetches seguidos). Nao e a fonte de verdade nem decide
// regeneracao — isso e a ultima dica salva + conversa nova. 2 min basta pra cortar
// a rajada sem segurar uma dica velha quando algo muda.
const TTL_CACHE_MS = 2 * 60 * 1000
const cache = new Map() // Map<criancaId, { dica, expiraMs }>

/**
 * Le os topicos distintos que a crianca explorou nos ultimos dias (ignora papo sem
 * topico). Retorna lista de topicos (strings), mais frequentes primeiro.
 * @param {string} criancaId
 * @returns {Promise<string[]>}
 */
async function lerTopicosRecentes(criancaId) {
  const sb = getClient()
  if (!sb) return []

  const desde = new Date(Date.now() - DIAS_JANELA * UM_DIA_MS).toISOString()
  const { data, error } = await sb
    .from('conversas')
    .select('topico, materia, criado_em')
    .eq('crianca_id', criancaId)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(MAX_CONVERSAS)

  if (error) {
    log('Erro', `Leitura de topicos recentes (crianca ${criancaId}): ${error.message}`)
    return []
  }

  // Conta por topico (so os nao-nulos) e ordena por frequencia desc.
  const freq = new Map()
  for (const c of data || []) {
    if (!c.topico) continue
    freq.set(c.topico, (freq.get(c.topico) || 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
}

function montarPromptDica(nomeCrianca, memorias, topicos) {
  const nome = nomeCrianca || 'a crianca'
  const blocoMemorias = (Array.isArray(memorias) && memorias.length)
    ? memorias.slice(0, 12).map(m => `- ${m}`).join('\n')
    : '(nenhuma ainda)'
  const blocoTopicos = topicos.length ? topicos.slice(0, 10).join(', ') : '(nenhum esta semana)'

  return `Voce e a Cogni, a tutora-amiga (voz feminina, calorosa, brasileira) de ${nome}. Escreva UMA dica curta e pratica para os PAIS de ${nome} — algo que eles possam fazer pra apoiar os estudos/curiosidades dela no dia a dia.

Baseie-se SO nestes dados (nao invente fatos, nomes ou numeros que nao estejam aqui):

Coisas que voce sabe sobre ${nome}:
${blocoMemorias}

Assuntos que ${nome} explorou nos ultimos dias: ${blocoTopicos}

REGRAS da dica:
- UMA frase, no maximo duas. Curta, leve, calorosa e ACIONAVEL (algo concreto pros pais fazerem).
- Conecte com um interesse/assunto real dos dados quando der (ex: se explorou "sistema solar", sugira algo nessa linha). Se os dados forem pobres, de uma dica geral e gentil de incentivo ao estudo.
- Tom de amiga que conhece a crianca, nunca de relatorio. Portugues do Brasil natural. No maximo 1 emoji.
- NUNCA exponha nada sensivel/delicado. Fale so do lado leve e positivo.
- Responda APENAS com o texto da dica, sem aspas, titulo nem "Dica:".`
}

// Gera o texto da dica com a IA (ou a versao generica sem dados). Nao decide cache
// nem persistencia — quem chama (gerarDicaDoCogni) cuida disso.
async function gerarTextoDica({ openai, modelo }, criancaId, nomeCrianca) {
  const usuario = carregarUsuario(criancaId)
  const nome = nomeCrianca || usuario?.nome || ''
  const memorias = Array.isArray(usuario?.memorias) ? usuario.memorias : []
  const topicos = await lerTopicosRecentes(criancaId)

  // Sem nenhum dado (perfil novo, sem conversas): dica generica amigavel, sem IA.
  if (!memorias.length && !topicos.length) {
    return {
      dica: `Que tal puxar uma conversa com ${nome || 'a crianca'} sobre o que ela aprendeu hoje? Curiosidade puxa curiosidade! 💜`,
      vazio: true,
    }
  }

  const prompt = montarPromptDica(nome, memorias, topicos)
  const resposta = await openai.chat.completions.create({
    model: modelo,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    temperature: 0.8,
  })
  const dica = (resposta.choices[0]?.message?.content || '').trim()
  if (!dica) throw new Error('IA nao devolveu texto de dica')
  return { dica, vazio: false }
}

/**
 * Devolve a Dica do Cogni pros pais. A "dica de agora" e ESTAVEL: so muda quando a
 * crianca conversa. Fluxo:
 *   1. Cache RAM curto (corta reload em rajada) — devolve na hora.
 *   2. Le a ultima dica salva (fonte de verdade). Se existe e NAO houve conversa
 *      desde ela => reusa identica (nada de IA, nada de variacao).
 *   3. So gera com IA quando: nao ha dica salva, OU houve conversa nova desde a
 *      ultima. A nova entra no historico (registrarDica dedup a repetida).
 *
 * @param {object} deps          injecao pra testar/desacoplar
 * @param {object} deps.openai   cliente OpenAI
 * @param {string} deps.modelo   modelo de chat (config.CHAT_MODEL)
 * @param {string} criancaId
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.forcar] ignora cache E a regra de conversa nova (debug)
 * @returns {Promise<{ dica: string, deCache: boolean, vazio: boolean, regenerada: boolean }>}
 */
async function gerarDicaDoCogni({ openai, modelo }, criancaId, opcoes = {}) {
  if (!criancaId) throw new Error('criancaId obrigatorio')

  if (!opcoes.forcar) {
    const emCache = cache.get(criancaId)
    if (emCache && emCache.expiraMs > Date.now()) {
      return { dica: emCache.dica, deCache: true, vazio: false, regenerada: false }
    }
  }

  const nomeCrianca = carregarUsuario(criancaId)?.nome || ''

  // Fonte de verdade: a ultima dica salva. So regeramos se houver conversa nova
  // depois dela (ou se nao houver dica salva, ou em modo forcar).
  const ultima = opcoes.forcar ? null : await lerUltimaDica(criancaId)
  if (ultima && ultima.texto) {
    const conversasNovas = await contarConversasDesde(criancaId, ultima.criadoEm)
    if (conversasNovas === 0) {
      // Nada novo: reusa a ultima, identica. Cacheia pra cortar a rajada.
      cache.set(criancaId, { dica: ultima.texto, expiraMs: Date.now() + TTL_CACHE_MS })
      return { dica: ultima.texto, deCache: false, vazio: false, regenerada: false }
    }
  }

  // Gera de novo (primeira dica da crianca, ou houve conversa desde a ultima).
  const { dica, vazio } = await gerarTextoDica({ openai, modelo }, criancaId, nomeCrianca)
  cache.set(criancaId, { dica, expiraMs: Date.now() + TTL_CACHE_MS })
  // Guarda no historico ("Dicas da Cogni" do site) — fire-and-forget; o registrarDica
  // dedup a repetida. A dica generica (vazio) tambem nao polui: e sempre o mesmo texto.
  if (!vazio) registrarDica(criancaId, dica).catch(() => { /* registrarDica ja loga */ })
  return { dica, deCache: false, vazio, regenerada: true }
}

module.exports = { gerarDicaDoCogni, lerTopicosRecentes }
