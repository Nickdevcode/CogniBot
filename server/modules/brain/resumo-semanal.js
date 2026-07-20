/**
 * resumo-semanal.js — O "bilhete carinhoso da Cogni" pros pais (Companion).
 *
 * Sob demanda: quando o pai abre a tela de Resumo no site, o servidor le as
 * conversas dos ultimos 7 dias da crianca no Supabase, manda pra IA e devolve um
 * bilhete afetuoso (tom de carta da tutora, NAO planilha). Ver APP-COMPANION.md.
 *
 * Roda fora do fluxo de voz (e o SITE que chama, via endpoint REST), entao pode ser
 * async/await tranquilo — nao trava o robo. A chave da OpenAI vive so no servidor,
 * por isso o resumo passa por aqui e nao e gerado no browser.
 */

const { getClient, lerUltimoResumoSemanal, registrarResumoSemanal, contarConversasDesde } = require('../supabase')
const { log } = require('../logger')
const { criarChatCompletion } = require('./openai')

const DIAS_JANELA = 7
// Teto de conversas mandadas pra IA: protege o custo/tamanho do prompt numa semana
// muito ativa. Pega as mais recentes (a query ordena desc). Suficiente pro resumo.
const MAX_CONVERSAS = 80

/**
 * Le as conversas dos ultimos 7 dias de uma crianca, direto do Supabase. Retorna
 * as linhas cruas (mais recentes primeiro), ja limitadas. Lanca em erro de rede.
 * @param {string} criancaId
 * @returns {Promise<Array<object>>}
 */
async function lerConversasDaSemana(criancaId) {
  const sb = getClient()
  if (!sb) return []

  const desde = new Date(Date.now() - DIAS_JANELA * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('conversas')
    .select('texto_usuario, texto_resposta, materia, topico, sensivel, criado_em')
    .eq('crianca_id', criancaId)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(MAX_CONVERSAS)

  if (error) {
    log('Erro', `Leitura de conversas da semana (crianca ${criancaId}): ${error.message}`)
    throw new Error(error.message)
  }
  return data || []
}

/**
 * Compacta as conversas num resumo-fonte enxuto pro prompt: por materia, os topicos
 * vistos e uma amostra das falas da crianca. Evita despejar a transcricao inteira
 * (caro e ruidoso) — a IA recebe o essencial pra escrever com carinho e precisao.
 * @param {Array<object>} conversas
 * @returns {{ resumoFonte: string, materias: string[], topicos: string[], total: number }}
 */
function compactarConversas(conversas) {
  const porMateria = new Map()
  const topicos = new Set()
  const falasCrianca = []

  // Itera do mais antigo pro mais novo (a query veio desc) pra a amostra ler
  // cronologica, ajudando a IA a perceber evolucao ("comecou X, terminou Y").
  for (const c of [...conversas].reverse()) {
    const materia = c.materia || 'outros'
    porMateria.set(materia, (porMateria.get(materia) || 0) + 1)
    if (c.topico) topicos.add(c.topico)
    if (c.texto_usuario && falasCrianca.length < 25) {
      falasCrianca.push(`- ${c.texto_usuario.slice(0, 140)}`)
    }
  }

  const linhasMateria = [...porMateria.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}: ${n} conversa(s)`)

  let resumoFonte = `Conversas por materia: ${linhasMateria.join('; ')}.\n`
  if (topicos.size) resumoFonte += `Topicos explorados: ${[...topicos].join(', ')}.\n`
  if (falasCrianca.length) resumoFonte += `\nAlgumas falas da crianca (cronologico):\n${falasCrianca.join('\n')}`

  return {
    resumoFonte,
    materias: [...porMateria.keys()],
    topicos: [...topicos],
    total: conversas.length,
  }
}

function montarPromptResumo(nomeCrianca, fonte) {
  const nome = nomeCrianca || 'a crianca'
  return `Voce e a Cogni, a tutora-amiga (voz feminina, calorosa, brasileira) de ${nome}. Escreva um BILHETE curto e carinhoso para os PAIS, resumindo a semana de estudos de ${nome} com a Cogni.

Baseie-se SO nos dados abaixo (nao invente fatos, nomes ou numeros que nao estejam aqui):
${fonte}

REGRAS do bilhete:
- Tom de CARTA afetuosa da tutora, nao relatorio nem planilha. Calor humano, leve, especifico.
- Comece com uma saudacao aos pais ("Oi! 💜" ou parecido) e assine no fim como "Beijo, Cogni".
- 1 paragrafo curto (4 a 6 frases). Destaque 1 ou 2 coisas concretas da semana (uma materia/topico que apareceu bastante, uma curiosidade).
- Se der pra notar um progresso ou um detalhe fofo nos dados, mencione com delicadeza. Se NAO der, nao force nem invente.
- Portugues do Brasil, natural. Pode usar 1 ou 2 emojis, com parcimonia.
- NUNCA exponha falas sensiveis/delicadas em detalhe; se a semana teve algo assim, trate de forma geral e acolhedora (sem citar o conteudo).
- Responda APENAS com o texto do bilhete, sem aspas nem titulo.`
}

/**
 * Gera o bilhete semanal pros pais. Le as conversas da semana e chama a IA.
 * @param {object} deps              injecao pra testar/desacoplar
 * @param {object} deps.openai       cliente OpenAI
 * @param {string} deps.modelo       modelo de chat (config.CHAT_MODEL)
 * @param {string} criancaId
 * @param {string} [nomeCrianca]
 * @returns {Promise<{ resumo: string, periodoDias: number, totalConversas: number, materias: string[], topicos: string[], vazio: boolean }>}
 */
async function gerarResumoSemanal({ openai, modelo }, criancaId, nomeCrianca = '') {
  if (!criancaId) throw new Error('criancaId obrigatorio')

  const conversas = await lerConversasDaSemana(criancaId)

  // Sem conversas na semana: bilhete amigavel, sem gastar IA.
  if (!conversas.length) {
    return {
      resumo: `Essa semana ${nomeCrianca || 'a crianca'} ainda nao bateu papo comigo — quando rolar a proxima conversa, eu conto tudo pra voces aqui! 💜`,
      periodoDias: DIAS_JANELA,
      totalConversas: 0,
      materias: [],
      topicos: [],
      vazio: true,
    }
  }

  const fonte = compactarConversas(conversas)
  const prompt = montarPromptResumo(nomeCrianca, fonte.resumoFonte)

  const resposta = await criarChatCompletion(openai, {
    model: modelo,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 320,
    temperature: 0.8, // bilhete carinhoso pede um pouco mais de calor/variedade
  })
  const resumo = (resposta.choices[0]?.message?.content || '').trim()

  if (!resumo) throw new Error('IA nao devolveu texto de resumo')

  return {
    resumo,
    periodoDias: DIAS_JANELA,
    totalConversas: fonte.total,
    materias: fonte.materias,
    topicos: fonte.topicos,
    vazio: false,
  }
}

/**
 * Camada de obtencao COM persistencia/reuso (o que a rota usa). Espelha a logica da
 * dica: a fonte de verdade e o ultimo resumo SALVO; so geramos um novo quando ha
 * conversa nova desde ele. Assim:
 *   - robo desligado / sem conversa nova => devolve a ULTIMA carta salva (estavel,
 *     sobrevive a restart) em vez do "sem comunicacao".
 *   - houve conversa nova na semana => gera uma carta fresca e a persiste.
 *   - sem nenhum resumo salvo E sem conversa => bilhete amigavel de "ainda nao
 *     conversamos" (nao persiste: e generico).
 * `forcar` (debug) ignora o reuso e sempre gera.
 *
 * @returns {Promise<{ resumo, periodoDias, totalConversas, materias, topicos, vazio, deCache }>}
 */
async function obterResumoSemanal({ openai, modelo }, criancaId, nomeCrianca = '', opcoes = {}) {
  if (!criancaId) throw new Error('criancaId obrigatorio')

  // Fonte de verdade: o ultimo resumo salvo. Sem conversa nova desde ele => reusa.
  const ultimo = opcoes.forcar ? null : await lerUltimoResumoSemanal(criancaId)
  if (ultimo && ultimo.resumo) {
    const conversasNovas = await contarConversasDesde(criancaId, ultimo.criadoEm)
    if (conversasNovas === 0) {
      return {
        resumo: ultimo.resumo,
        periodoDias: DIAS_JANELA,
        totalConversas: ultimo.totalConversas,
        materias: ultimo.materias,
        topicos: ultimo.topicos,
        vazio: false,
        deCache: true,
      }
    }
  }

  // Gera fresco (sem resumo salvo, ou houve conversa desde o ultimo, ou forcar).
  const gerado = await gerarResumoSemanal({ openai, modelo }, criancaId, nomeCrianca)

  // Persiste so quando ha conteudo real (a semana teve conversa). O bilhete de
  // "ainda nao conversamos" (vazio) e generico — nao polui o historico de cartas.
  if (!gerado.vazio) {
    registrarResumoSemanal({
      criancaId,
      texto: gerado.resumo,
      materias: gerado.materias,
      topicos: gerado.topicos,
      totalConversas: gerado.totalConversas,
      periodoDias: gerado.periodoDias,
    }).catch(() => { /* registrarResumoSemanal ja loga */ })
  }

  return { ...gerado, deCache: false }
}

module.exports = { gerarResumoSemanal, obterResumoSemanal, lerConversasDaSemana, compactarConversas }
