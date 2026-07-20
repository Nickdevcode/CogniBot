const { log } = require('../logger')
const { carregarUsuario, atualizarUsuario } = require('../memoria')
const { registrarPratica, adicionarPalavras, atualizarNivel, obterEntrada } = require('./aprendizado')
const { nomeIdioma } = require('./idioma')
const { criarChatCompletion } = require('./openai')

const MAX_CHARS_ENTRADA = 600

function montarPrompt(usuario, codigoIdioma, textoUsuario, respostaIA, entradaAtual) {
  const nivelAtual = entradaAtual?.nivel || 'A1'
  const palavrasJaVistas = (entradaAtual?.palavrasVistas || [])
    .slice(-25)
    .map(p => p.termo.toLowerCase())
    .join(', ') || '(nenhuma)'

  return `Voce e um analisador pedagogico. O usuario "${usuario.nome}" (idioma nativo: ${nomeIdioma(usuario.idiomaNativo)}) interagiu em ${nomeIdioma(codigoIdioma)}.

NIVEL CEFR REGISTRADO: ${nivelAtual}
PALAVRAS JA VISTAS NESSE IDIOMA: ${palavrasJaVistas}

MENSAGEM DO USUARIO (em ${nomeIdioma(codigoIdioma)} ou misturado):
"${textoUsuario.slice(0, MAX_CHARS_ENTRADA)}"

RESPOSTA DA COGNI:
"${respostaIA.slice(0, MAX_CHARS_ENTRADA)}"

Retorne JSON estritamente com:
- "nivelEstimado": string CEFR ("A1", "A2", "B1", "B2", "C1", "C2") baseado na producao do usuario nesta mensagem. Se nao for possivel avaliar (mensagem muito curta ou misturada demais), use o mesmo nivelAtual. Se a producao for claramente acima ou abaixo do atual, ajuste UM nivel por vez (ex: B1 -> B2 ou B1 -> A2).
- "palavrasNovas": array de objetos {"termo": "...", "traducao": "..."} (max 5) com palavras ou expressoes novas em ${nomeIdioma(codigoIdioma)} que apareceram na conversa e ainda nao estao na lista de vistas. Termos devem ser CURTOS (1-3 palavras). Traducao no idioma nativo do usuario.
- "querAprender": boolean indicando se a INTENCAO do usuario nesta mensagem demonstra desejo de aprender/praticar (true) ou se apenas usou o idioma para conversar (false).
- "engajamento": "alto" se a producao foi rica e bem construida, "medio" se respondeu corretamente mas curto, "baixo" se travou ou ficou no minimo.

Regras:
- Nao inclua palavras triviais (the, a, is, oi, hello, hi) em palavrasNovas.
- Se a mensagem foi 100% no idioma nativo do usuario (sem usar o idioma alvo), use querAprender=false, palavrasNovas=[].
- Se ouve troca de codigo (mistura idioma nativo + alvo), e normal — extraia palavras do idioma alvo.

Retorne APENAS o JSON, sem comentarios.`
}

async function analisarPedagogicamente(openai, modelo, usuarioId, codigoIdioma, textoUsuario, respostaIA) {
  if (!textoUsuario || textoUsuario.trim().length < 4) return null
  if (!codigoIdioma) return null

  // Snapshot leve so para validar e montar o prompt (a chamada LLM nao precisa de
  // lock). A aplicacao dos resultados acontece depois, numa transacao atomica.
  const usuario = carregarUsuario(usuarioId)
  if (!usuario) return null

  // Idioma nativo: nada a analisar (so registra a pratica, de forma atomica). O
  // proprio registrarPratica ja ignora o idioma nativo, mas mantemos o gate aqui
  // para nao gastar uma chamada LLM a toa.
  if (codigoIdioma === usuario.idiomaNativo) {
    return null
  }

  const entradaAtual = obterEntrada(usuario, codigoIdioma)

  let textoResposta
  try {
    const resposta = await criarChatCompletion(openai, {
      model: modelo,
      messages: [{ role: 'user', content: montarPrompt(usuario, codigoIdioma, textoUsuario, respostaIA, entradaAtual) }],
      maxTokens: 280,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
    textoResposta = (resposta.choices[0]?.message?.content || '').trim()
  } catch (err) {
    log('Aviso', `Analise pedagogica falhou: ${err.message}`)
    return null
  }

  let dados
  try {
    dados = JSON.parse(textoResposta)
  } catch {
    const m = textoResposta.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { dados = JSON.parse(m[0]) } catch { return null }
  }

  // Aplica tudo numa unica transacao atomica: registrar pratica + atualizar nivel
  // + adicionar palavras mutam o MESMO usuario travado e sao salvos UMA vez no fim.
  // Sem isso, rodando em paralelo com a memoria-IA, as escritas se perderiam.
  await atualizarUsuario(usuarioId, (u) => {
    registrarPratica(u, codigoIdioma)
    const entrada = obterEntrada(u, codigoIdioma)
    if (dados.nivelEstimado && dados.nivelEstimado !== entrada?.nivel) {
      atualizarNivel(u, codigoIdioma, dados.nivelEstimado)
    }
    if (Array.isArray(dados.palavrasNovas) && dados.palavrasNovas.length > 0) {
      adicionarPalavras(u, codigoIdioma, dados.palavrasNovas.slice(0, 5))
    }
  })

  return {
    nivelEstimado: dados.nivelEstimado,
    palavrasNovas: dados.palavrasNovas || [],
    querAprender: !!dados.querAprender,
    engajamento: dados.engajamento || 'medio',
  }
}

module.exports = { analisarPedagogicamente }
