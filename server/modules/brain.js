const config = require('../config')
const { openai } = require('./speech')
const { carregarUsuario, carregarUsuarioFresco, refrescarUsuario } = require('./memoria')
const { log } = require('./logger')
const { montarSystemPrompt, limparReferenciasResposta, obterDataAtualFormatada, pediuFonte, lembreteDataSystem } = require('./brain/prompt')
const { extrairMemoriasRegex, verificarOnboarding, extrairMemoriasComIA, temEssenciais } = require('./brain/memoria-ai')
const { criarAcumuladorSentencas } = require('./brain/sentencas')
const { triagemRapida, MODO_PAPO } = require('./brain/triagem')
const { atualizarIdiomaPorMensagem, limparEstadoSessao } = require('./brain/idioma')
const { obterEntrada } = require('./brain/aprendizado')
const { analisarPedagogicamente } = require('./brain/analisador-pedagogico')
const { classificarMateria } = require('./brain/materia')
const { filtrarPalavroesSaida, verificarEntrada, ehDialogoAlucinado } = require('./safety')
const { registrarConversa, atualizarConversaPosIA } = require('./supabase')
const { obterPlanoAtivo, refrescarPlanoAtivo } = require('./planos')
const { pedidoDePareamento, respostaCodigoFalado } = require('./pareamento')

const conversas = new Map()

function obterOuCriarConversa(sessionId) {
  if (!conversas.has(sessionId)) {
    conversas.set(sessionId, [])
  }
  return conversas.get(sessionId)
}

function descartarImagensDeMensagem(mensagem) {
  if (!mensagem || !Array.isArray(mensagem.content)) return mensagem
  const apenasTexto = mensagem.content
    .filter(parte => parte && parte.type === 'text' && typeof parte.text === 'string')
    .map(parte => parte.text)
    .join(' ')
    .trim()
  return { role: mensagem.role, content: apenasTexto }
}

function adicionarMensagem(sessionId, role, content) {
  const historico = obterOuCriarConversa(sessionId)
  historico.push({ role, content })

  if (historico.length > config.MAX_CONVERSATION_MESSAGES) {
    historico.splice(0, historico.length - config.MAX_CONVERSATION_MESSAGES)
  }

  for (let i = 0; i < historico.length - 1; i++) {
    const m = historico[i]
    if (Array.isArray(m?.content)) {
      historico[i] = descartarImagensDeMensagem(m)
    }
  }
}

function montarConteudoUsuario(textoUsuario, imagemBase64) {
  if (!imagemBase64) return textoUsuario
  return [
    { type: 'text', text: textoUsuario },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${imagemBase64}`,
        detail: 'auto',
      },
    },
  ]
}

const CACHE_TRIAGEM_MAX = 64
const cacheTriagem = new Map()

function chaveTriagem(texto) {
  return texto.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function lerCacheTriagem(chave) {
  if (!cacheTriagem.has(chave)) return null
  const valor = cacheTriagem.get(chave)
  cacheTriagem.delete(chave)
  cacheTriagem.set(chave, valor)
  return valor
}

function gravarCacheTriagem(chave, valor) {
  cacheTriagem.set(chave, valor)
  if (cacheTriagem.size > CACHE_TRIAGEM_MAX) {
    const primeira = cacheTriagem.keys().next().value
    cacheTriagem.delete(primeira)
  }
}

// Default seguro/barato quando algo falha (parse, API): papo + sem pesquisa.
const INTERACAO_PADRAO = { modo: MODO_PAPO, pesquisar: false }

// Classificador UNIFICADO: uma unica chamada (modelo barato) decide o MODO da
// interacao (estudo vs papo) E se precisa PESQUISAR. Modelos fracos classificam
// (saida curta, restrita) muito melhor do que geram-seguindo-regras - por isso
// tiramos as duas decisoes do gerador e as resolvemos aqui antes. Saida em JSON
// minusculo, parsing tolerante, default seguro se quebrar.
async function classificarInteracao(texto) {
  const chave = chaveTriagem(texto)
  if (chave) {
    const emCache = lerCacheTriagem(chave)
    if (emCache !== null) return emCache
  }

  const dataAtual = obterDataAtualFormatada()
  let resultado = INTERACAO_PADRAO
  try {
    const resposta = await openai.chat.completions.create({
      model: config.CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Voce classifica a fala de uma CRIANCA conversando com a assistente Cogni. DATA DE HOJE: ${dataAtual}.
Responda APENAS um JSON: {"modo":"estudo"|"papo","pesquisar":true|false}.

modo = "estudo" quando ela quer APRENDER ou resolver algo de escola: exercicio, conta, duvida de materia, "me ajuda com", "como resolvo", conceito que ela ta estudando.
modo = "papo" para todo o resto: conversa, curiosidade solta, opiniao, sentimento, brincadeira (piada/historia/jogo), pergunta sobre a propria Cogni, ou so um fato rapido. NA DUVIDA entre estudo e papo, escolha "papo".

pesquisar = true SOMENTE quando a resposta certa e um FATO ESPECIFICO que voce pode nao saber ou que MUDA com o tempo:
- Data/clima/noticia/preco/cotacao/resultado de jogo/lancamento ("o que ta acontecendo", "quem ganhou", "ultimo modelo").
- Pessoa publica no cargo atual, evento recente.
- Um VALOR ou NOME especifico sobre uma entidade do mundo real, sobretudo nao-famosa: "quantos habitantes tem [cidade]", "qual a altura de [predio]", "quando foi fundada [coisa]".
pesquisar = false para: matematica, gramatica, contas, opiniao, sentimento, conversa, brincadeira, e CONCEITOS estaveis ("por que o ceu e azul", "o que e fotossintese", "como funciona um ima") — isso voce explica sem internet.
Regra de ouro: se a resposta e uma EXPLICACAO -> pesquisar false; se e um VALOR/NOME/DATA especifico ou algo atual -> pesquisar true. Numa crianca, e melhor pesquisar a mais do que ensinar um fato errado.`,
        },
        { role: 'user', content: texto },
      ],
      max_tokens: 20,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const bruto = (resposta.choices[0]?.message?.content || '').trim()
    let dados
    try { dados = JSON.parse(bruto) } catch {
      const m = bruto.match(/\{[\s\S]*\}/)
      dados = m ? JSON.parse(m[0]) : null
    }
    if (dados) {
      resultado = {
        modo: dados.modo === 'estudo' ? 'estudo' : MODO_PAPO,
        pesquisar: dados.pesquisar === true || dados.pesquisar === 'true',
      }
    }
  } catch (err) {
    log('Erro', `Classificador falhou (${err.message}). Usando default (papo, sem pesquisa).`)
    resultado = INTERACAO_PADRAO
  }

  if (chave) gravarCacheTriagem(chave, resultado)
  return resultado
}

// Decide MODO + PESQUISA: primeiro a heuristica regex (barata, corta o obvio);
// se ela nao decidiu, sobe pro classificador IA. Retorna sempre { modo, pesquisar }.
async function decidirInteracao(texto) {
  if (!texto) return INTERACAO_PADRAO
  const rapida = triagemRapida(texto)
  if (rapida.decidiu) {
    log('Triagem', `Heuristica: modo=${rapida.modo} pesquisar=${rapida.pesquisar} "${texto.substring(0, 50)}"`)
    return { modo: rapida.modo, pesquisar: rapida.pesquisar }
  }
  const ia = await classificarInteracao(texto)
  log('Triagem', `IA: modo=${ia.modo} pesquisar=${ia.pesquisar} "${texto.substring(0, 50)}"`)
  return ia
}

async function gerarComWebSearch(mensagens) {
  const resposta = await openai.chat.completions.create({
    model: config.SEARCH_MODEL,
    messages: mensagens,
    web_search_options: { search_context_size: 'low' },
  })
  return resposta.choices[0]?.message?.content || ''
}

async function gerarComStream(mensagens, modelo, maxTokens, onDelta) {
  let textoCompleto = ''
  const resposta = await openai.chat.completions.create({
    model: modelo,
    messages: mensagens,
    max_tokens: maxTokens,
    temperature: 0.7,
    stream: true,
  })

  for await (const chunk of resposta) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) {
      textoCompleto += delta
      if (onDelta) onDelta(delta)
    }
  }
  return textoCompleto
}

function prepararContextoIdioma(usuario, sessionId, textoUsuario) {
  if (!usuario) return null
  const idiomaNativo = usuario.idiomaNativo || 'pt'
  const resultado = atualizarIdiomaPorMensagem(sessionId, textoUsuario, { idiomaNativo })

  const ehDev = usuario.role === 'desenvolvedor'
  const entrada = obterEntrada(usuario, resultado.idiomaAtivo)

  // O ciclo de vida do modo ensino agora vive no idioma.js (liga por pedido,
  // desliga por pedido de saida ou por voltar ao nativo). Aqui so: (a) zera pro
  // dev; (b) REATIVA por historico de pratica (vezesPraticado>=2) SO quando a
  // conversa esta num idioma nao-nativo - assim "chega de aula"/voltar ao portugues
  // realmente desliga, sem o historico de pratica religar no proximo turno.
  let modoEnsino = ehDev ? false : !!resultado.modoEnsino
  if (!ehDev && !modoEnsino && resultado.idiomaAtivo !== idiomaNativo
      && entrada && (entrada.vezesPraticado || 0) >= 2) {
    modoEnsino = true
  }

  if (resultado.mudou) {
    log('Idioma', `${usuario.nome}: ${resultado.idiomaAtivo} (${resultado.motivo}, conf=${resultado.confianca.toFixed(2)})`)
  }

  return {
    idiomaAtivo: resultado.idiomaAtivo,
    idiomaMensagem: resultado.idiomaMensagem,
    entradaAprendizado: entrada,
    modoEnsino,
    pediuEnsino: resultado.pediuEnsino,
  }
}

// Tarefas pos-resposta (memoria + analise pedagogica). Rodam DEPOIS de a resposta
// ja ter sido enviada ao usuario, entao nao precisam bloquear o retorno - mas
// precisam ser SERIALIZADAS entre si: antes rodavam em paralelo (sem await) sobre
// a mesma referencia do cache e uma sobrescrevia a escrita da outra (lost-update).
// Agora extraimos a memoria e SO DEPOIS rodamos a analise pedagogica; cada uma usa
// atualizarUsuario (fila atomica por usuario), entao nunca colidem.
async function pipelinePosResposta(usuario, usuarioId, sessionId, textoUsuario, textoResposta, ehOnboarding, historico, contextoIdioma, origem = 'navegador', duracaoMs = null) {
  if (!usuario) return

  // Diario de Conversas: registra o turno no Supabase. Vem PRIMEIRO pra nao
  // depender das etapas de memoria/IA abaixo (se uma falhar, o turno ja foi
  // gravado). No insert usamos os classificadores BARATOS e SINCRONOS (regex de
  // materia + filtro de seguranca pro sensivel) — assim a linha ja nasce util mesmo
  // se a IA falhar. So grava turnos com conteudo real. Guardamos a Promise do id
  // pra ENRIQUECER a linha depois (topico/materia/sensivel da IA, ver abaixo).
  const sensivelRegex = !verificarEntrada(textoUsuario).seguro
  let idConversaPromise = Promise.resolve(null)
  if (textoUsuario && textoResposta) {
    idConversaPromise = registrarConversa({
      criancaId: usuarioId,
      textoUsuario,
      textoResposta,
      materia: classificarMateria(textoUsuario, textoResposta),
      sensivel: sensivelRegex,
      duracaoMs,
      origem,
    }).catch(err => {
      log('Erro', `Registro de conversa falhou: ${err.message}`)
      return null
    })
  }

  // Regex de alta precisao (so nome/idade) - rapido, sincrono.
  extrairMemoriasRegex(usuario, textoUsuario, ehOnboarding)

  // Extracao por IA (informacoes estruturadas + memoria + estilo + topico/materia/
  // sensivel). Faz o trabalho pesado. Roda ANTES de verificar o onboarding, senao o
  // onboarding decidiria com os campos de UM turno atrasado (a IA preenche serie/
  // hobbies/comoAprende AQUI). Na mesma chamada (custo zero a mais) ela tambem
  // classifica a conversa pro Diario/Painel: topico (assunto fino), materia (mais
  // precisa que o regex) e sensivel (sinal emocional pros pais, alem do regex).
  let analiseIA = null
  try {
    analiseIA = await extrairMemoriasComIA(openai, config.CHAT_MODEL, usuarioId, textoUsuario, textoResposta)
  } catch (err) {
    log('Erro', `Memoria com IA falhou: ${err.message}`)
  }

  // Enriquece a conversa ja gravada com o que a IA refinou (fire-and-forget). Espera
  // o id do insert resolver; se a conversa nao foi gravada (id null), e no-op.
  // - topico: so se a IA achou um (null = papo sem assunto).
  // - materia: a IA VENCE o regex quando classificou (mais precisa); se a IA nao
  //   classificou (null), mantemos o regex que ja foi pro insert.
  // - sensivel: OR entre IA e regex — qualquer um pegando, marca (rede de seguranca).
  //   So mandamos o UPDATE quando a IA mudou algo, pra nao reescrever a toa.
  if (analiseIA) {
    const sensivelFinal = analiseIA.sensivel || sensivelRegex
    const campos = {}
    if (analiseIA.topico) campos.topico = analiseIA.topico
    if (analiseIA.materia) campos.materia = analiseIA.materia
    if (sensivelFinal !== sensivelRegex) campos.sensivel = sensivelFinal
    if (Object.keys(campos).length > 0) {
      idConversaPromise
        .then(id => { if (id) atualizarConversaPosIA(id, campos) })
        .catch(() => { /* id ja logou o proprio erro */ })
    }
  }

  // Onboarding DEPOIS da extracao: recarrega o usuario (a IA acabou de gravar os
  // campos via atualizarUsuario) pra decidir "completo?" com os dados frescos.
  if (ehOnboarding) {
    const atualizado = carregarUsuario(usuarioId) || usuario
    verificarOnboarding(atualizado, historico)
  }

  if (contextoIdioma?.idiomaAtivo && contextoIdioma.idiomaAtivo !== (usuario.idiomaNativo || 'pt')) {
    try {
      await analisarPedagogicamente(
        openai,
        config.CHAT_MODEL,
        usuarioId,
        contextoIdioma.idiomaAtivo,
        textoUsuario,
        textoResposta,
      )
    } catch (err) {
      log('Aviso', `Analise pedagogica falhou: ${err.message}`)
    }
  }
}

async function conversar(usuarioId, textoUsuario, imagemBase64 = null, callbacks = {}) {
  // duracaoMs: o chamador (fluxo de voz) pode passar a duracao REAL da fala. Quando
  // nao vem (fluxo de texto), medimos aqui o tempo de geracao da resposta (relogio
  // abaixo) — esse e o "tempo real" do turno digitado pro Painel de Aprendizado.
  const { onPesquisa, onIdioma, origem = 'navegador', duracaoMs: duracaoExterna = null } = callbacks
  const inicioTurnoMs = Date.now()
  let usuario = carregarUsuario(usuarioId)
  // Sincroniza o perfil com o site (ver nota detalhada em conversarStream).
  refrescarUsuario(usuarioId)
  if (usuario && !usuario.onboardingCompleto && !temEssenciais(usuario)) {
    usuario = await carregarUsuarioFresco(usuarioId)
  }
  const sessionId = `sessao_${usuarioId}`
  const historico = obterOuCriarConversa(sessionId)
  const contextoIdioma = prepararContextoIdioma(usuario, sessionId, textoUsuario)

  // Avisa o idioma da conversa cedo (paridade com conversarStream), util para quem
  // chama (ex: o pipeline do robo) reagir antes da resposta ficar pronta.
  if (onIdioma) {
    try { onIdioma(contextoIdioma) } catch { /* nao deixa o callback derrubar o pipeline */ }
  }

  const ehPrimeiroTurno = !historico.some(m => m.role === 'assistant')
  adicionarMensagem(sessionId, 'user', montarConteudoUsuario(textoUsuario, imagemBase64))

  // Atalho de PAREAMENTO: se a crianca pediu pra parear, a Cogni responde com o
  // codigo do proprio perfil — falado digito a digito — SEM gastar IA. So com
  // texto (com imagem segue o fluxo normal). O turno entra no historico igual.
  if (!imagemBase64 && usuario?.codigoPareamento && pedidoDePareamento(textoUsuario)) {
    const resposta = respostaCodigoFalado(usuario.codigoPareamento)
    adicionarMensagem(sessionId, 'assistant', resposta)
    log('Pareamento', `Codigo falado pra ${usuario.nome} (${usuario.codigoPareamento}).`)
    return { texto: resposta, pesquisouWeb: false, contextoIdioma }
  }

  const ehOnboarding = usuario && !usuario.onboardingCompleto
  const temImagem = !!imagemBase64
  const ehDev = !!(usuario && usuario.role === 'desenvolvedor')
  // Filtro de palavrao na saida: identidade pro dev, suaviza pro estudante (ver
  // camadaDev e filtrarPalavroesSaida). Mesma regra da conversarStream.
  const limparSaida = (t) => (ehDev ? t : filtrarPalavroesSaida(t))
  const querFonte = pediuFonte(textoUsuario)
  const tokensExtraIdioma = contextoIdioma?.modoEnsino ? 120 : 0
  const maxTokens = (ehOnboarding ? config.CHAT_MAX_TOKENS_ONBOARDING : config.CHAT_MAX_TOKENS) + tokensExtraIdioma
  const modelo = temImagem ? config.VISION_CHAT_MODEL : config.CHAT_MODEL

  // Classifica modo + pesquisa ANTES de montar o prompt (uma chamada, duas
  // decisoes). Com imagem nao pesquisamos (a visao ja responde), mas ainda vale
  // o modo pra pedagogia.
  const interacao = temImagem ? { modo: MODO_PAPO, pesquisar: false } : await decidirInteracao(textoUsuario)
  let usarWebSearch = interacao.pesquisar
  if (usarWebSearch && onPesquisa) onPesquisa()

  // Plano de estudo ativo: leitura SINCRONA do cache (nunca trava o robo). O
  // refresh assincrono atualiza o cache pro proximo turno — um plano recem-criado
  // pelo pai entra na conversa seguinte, sem bloquear esta.
  const planoAtivo = obterPlanoAtivo(usuarioId)
  refrescarPlanoAtivo(usuarioId)

  const mensagens = [
    { role: 'system', content: montarSystemPrompt(usuario, contextoIdioma, { ehPrimeiroTurno, pediuFonte: querFonte, modo: interacao.modo, usouWebSearch: usarWebSearch, plano: planoAtivo }) },
    ...historico,
    lembreteDataSystem(),
  ]

  let textoResposta = ''

  if (usarWebSearch) {
    log('WebSearch', `Ativado: "${textoUsuario.substring(0, 80)}"`)
    try {
      textoResposta = await gerarComWebSearch(mensagens)
    } catch (err) {
      log('Erro', `WebSearch falhou: ${err.message}. Usando fallback.`)
      usarWebSearch = false
      const resposta = await openai.chat.completions.create({
        model: modelo,
        messages: mensagens,
        max_tokens: maxTokens,
        temperature: 0.7,
      })
      textoResposta = resposta.choices[0]?.message?.content || ''
    }
  } else {
    const resposta = await openai.chat.completions.create({
      model: modelo,
      messages: mensagens,
      max_tokens: maxTokens,
      temperature: 0.7,
    })
    textoResposta = resposta.choices[0]?.message?.content || ''
  }

  textoResposta = limparSaida(limparReferenciasResposta(textoResposta, { permitirFonte: querFonte }))

  // Guard anti "dialogo fantasma": se o modelo devolveu um ROTEIRO (varios "Nome:"
  // de turno) — tipico quando o STT passou um fragmento alucinado e o modelo fraco
  // "virou roteirista" — NAO salva isso no historico (senao o proximo turno herda o
  // formato e a bola de neve continua) nem devolve pra crianca. Ver ehDialogoAlucinado.
  if (ehDialogoAlucinado(textoResposta)) {
    log('Seguranca', `Resposta roteirizada (dialogo fantasma) descartada: "${textoResposta.slice(0, 60)}"`)
    return { texto: '', pesquisouWeb: usarWebSearch, contextoIdioma }
  }

  adicionarMensagem(sessionId, 'assistant', textoResposta)
  // Duracao do turno: a real da fala (voz) tem prioridade; sem ela, o tempo de
  // geracao medido aqui (turno digitado). Alimenta tempo de uso/materia no Painel.
  const duracaoTurnoMs = duracaoExterna ?? (Date.now() - inicioTurnoMs)
  // Fire-and-forget: a resposta ja esta pronta; a persistencia (memoria/aprendizado)
  // roda em segundo plano e e serializada internamente (ver pipelinePosResposta).
  pipelinePosResposta(usuario, usuarioId, sessionId, textoUsuario, textoResposta, ehOnboarding, historico, contextoIdioma, origem, duracaoTurnoMs)
    .catch(err => log('Erro', `Pipeline pos-resposta falhou: ${err.message}`))

  return { texto: textoResposta, pesquisouWeb: usarWebSearch, contextoIdioma }
}

// Frases de preenchimento ditas enquanto a busca roda (ver uso em conversarStream).
// Curtas, naturais, do jeito que uma amiga ganha tempo. Variamos pelo tamanho do
// texto (sem Math.random, que e proibido aqui) so pra nao soar repetitivo.
const FILLERS = [
  'deixa eu dar uma olhadinha nisso aqui...',
  'peraí que eu vou conferir rapidinho...',
  'boa pergunta, deixa eu ver certinho...',
  'hmm, deixa eu pesquisar isso pra te falar certo...',
]

function escolherFiller(texto) {
  const i = (texto ? texto.length : 0) % FILLERS.length
  return FILLERS[i]
}

async function conversarStream(usuarioId, textoUsuario, imagemBase64 = null, callbacks = {}) {
  // duracaoMs: ver nota em conversar() — voz passa a duracao real da fala; texto cai
  // no relogio de geracao abaixo.
  const { onChunk, onPesquisa, onSentenca, onIdioma, origem = 'navegador', duracaoMs: duracaoExterna = null } = callbacks
  const inicioTurnoMs = Date.now()
  let usuario = carregarUsuario(usuarioId)
  // Sincroniza o perfil com o que o pai editou no site (Supabase -> cache). Sempre
  // dispara o refresh fire-and-forget pro PROXIMO turno (barato). E SO quando o
  // perfil do cache parece incompleto (perfil novo, ou pai editou e o robo ainda
  // nao viu), faz a carga FRESCA awaited — assim ja o PRIMEIRO turno usa o perfil
  // do site e nao refaz o onboarding por cima. Perfil ja completo nao espera nada.
  refrescarUsuario(usuarioId)
  if (usuario && !usuario.onboardingCompleto && !temEssenciais(usuario)) {
    usuario = await carregarUsuarioFresco(usuarioId)
  }
  const sessionId = `sessao_${usuarioId}`
  const historico = obterOuCriarConversa(sessionId)
  const contextoIdioma = prepararContextoIdioma(usuario, sessionId, textoUsuario)

  // Avisa o idioma da conversa CEDO (antes de qualquer chunk/sentenca sair), para
  // o TTS por sentenca ja sintetizar no idioma certo (sem aplicar as conversoes de
  // portugues a uma resposta em ingles/espanhol). Ver C4 no plano.
  if (onIdioma) {
    try { onIdioma(contextoIdioma) } catch { /* nao deixa o callback derrubar o pipeline */ }
  }

  const ehPrimeiroTurno = !historico.some(m => m.role === 'assistant')
  adicionarMensagem(sessionId, 'user', montarConteudoUsuario(textoUsuario, imagemBase64))

  // Atalho de PAREAMENTO (paridade com conversar): responde o codigo do perfil,
  // falado digito a digito, SEM IA. Emite pelos callbacks de streaming pra o robo
  // sintetizar o audio normalmente. Onboarding/persistencia nao se aplicam aqui.
  if (!imagemBase64 && usuario?.codigoPareamento && pedidoDePareamento(textoUsuario)) {
    const resposta = respostaCodigoFalado(usuario.codigoPareamento)
    if (onChunk) onChunk(resposta)
    if (onSentenca) onSentenca(resposta)
    adicionarMensagem(sessionId, 'assistant', resposta)
    log('Pareamento', `Codigo falado pra ${usuario.nome} (${usuario.codigoPareamento}).`)
    return { texto: resposta, pesquisouWeb: false, contextoIdioma }
  }

  const ehOnboarding = usuario && !usuario.onboardingCompleto
  const temImagem = !!imagemBase64
  const ehDev = !!(usuario && usuario.role === 'desenvolvedor')
  const querFonte = pediuFonte(textoUsuario)
  const tokensExtraIdioma = contextoIdioma?.modoEnsino ? 120 : 0
  const maxTokens = (ehOnboarding ? config.CHAT_MAX_TOKENS_ONBOARDING : config.CHAT_MAX_TOKENS) + tokensExtraIdioma
  const modelo = temImagem ? config.VISION_CHAT_MODEL : config.CHAT_MODEL

  const interacao = temImagem ? { modo: MODO_PAPO, pesquisar: false } : await decidirInteracao(textoUsuario)
  let usarWebSearch = interacao.pesquisar
  if (usarWebSearch && onPesquisa) onPesquisa()

  // Plano de estudo ativo: leitura SINCRONA do cache (nunca trava o robo). O
  // refresh assincrono atualiza o cache pro proximo turno — um plano recem-criado
  // pelo pai entra na conversa seguinte, sem bloquear esta.
  const planoAtivo = obterPlanoAtivo(usuarioId)
  refrescarPlanoAtivo(usuarioId)

  const mensagens = [
    { role: 'system', content: montarSystemPrompt(usuario, contextoIdioma, { ehPrimeiroTurno, pediuFonte: querFonte, modo: interacao.modo, usouWebSearch: usarWebSearch, plano: planoAtivo }) },
    ...historico,
    lembreteDataSystem(),
  ]

  // Filtro de palavrao na saida: SO pro estudante (com o dev o linguajar e
  // liberado - ver camadaDev). Rede de seguranca pro caso de o modelo fraco escapar
  // um palavrao apesar do prompt. Aplicado por SENTENCA (antes do TTS) e no texto
  // final. Identidade pro dev (nao altera nada).
  const limparSaida = (t) => (ehDev ? t : filtrarPalavroesSaida(t))

  const acumulador = onSentenca
    ? criarAcumuladorSentencas({
        minChars: config.TTS_STREAM_MIN_CHARS,
        minCharsPrimeira: config.TTS_STREAM_MIN_CHARS_PRIMEIRA,
        onSentenca: (s) => onSentenca(limparSaida(s)),
      })
    : null

  // FILLER de voz: a busca demora alguns segundos e em voz isso e silencio morto
  // (a crianca acha que travou). Mandamos UMA frase curta de preenchimento pro TTS
  // ANTES da busca, transformando a espera em fala. NAO entra no historico nem no
  // texto final (a IA nao deve "achar" que ja disse isso) - vai direto pro audio.
  // So no streaming por sentenca (robo) e so pro estudante (o dev nao precisa).
  if (usarWebSearch && onSentenca && !ehDev) {
    onSentenca(escolherFiller(textoUsuario))
  }

  let textoCompleto = ''

  if (usarWebSearch) {
    log('WebSearch', `Ativado: "${textoUsuario.substring(0, 80)}"`)
    try {
      const bruto = await gerarComWebSearch(mensagens)
      textoCompleto = limparReferenciasResposta(bruto, { permitirFonte: querFonte })
      if (onChunk && textoCompleto) onChunk(textoCompleto)
      if (acumulador) {
        acumulador.adicionar(textoCompleto)
        acumulador.flush()
      }
    } catch (err) {
      log('Erro', `WebSearch falhou: ${err.message}. Fallback streaming.`)
      usarWebSearch = false
      textoCompleto = await gerarComStream(mensagens, modelo, maxTokens, (delta) => {
        if (onChunk) onChunk(delta)
        if (acumulador) acumulador.adicionar(delta)
      })
      if (acumulador) acumulador.flush()
    }
  } else {
    textoCompleto = await gerarComStream(mensagens, modelo, maxTokens, (delta) => {
      if (onChunk) onChunk(delta)
      if (acumulador) acumulador.adicionar(delta)
    })
    if (acumulador) acumulador.flush()
  }

  textoCompleto = limparSaida(limparReferenciasResposta(textoCompleto, { permitirFonte: querFonte }))

  // Guard anti "dialogo fantasma" (ver conversar()). No streaming as sentencas ja
  // foram pro TTS enquanto a IA gerava — a defesa de verdade contra ISSO e na ENTRADA
  // (ehTextoLixo no esp-pipeline). Aqui o objetivo e nao PERSISTIR o roteiro: nao
  // salva no historico (evita a bola de neve no proximo turno) nem grava no Diario/
  // Painel dos pais. Raro chegar aqui (o STT roteirizado ja e barrado antes).
  if (ehDialogoAlucinado(textoCompleto)) {
    log('Seguranca', `Resposta roteirizada (dialogo fantasma) nao persistida: "${textoCompleto.slice(0, 60)}"`)
    return { texto: textoCompleto, pesquisouWeb: usarWebSearch, contextoIdioma }
  }

  adicionarMensagem(sessionId, 'assistant', textoCompleto)
  // Duracao do turno: real da fala (voz) ou tempo de geracao (texto). Ver conversar().
  const duracaoTurnoMs = duracaoExterna ?? (Date.now() - inicioTurnoMs)
  // Fire-and-forget: idem ao conversar() acima.
  pipelinePosResposta(usuario, usuarioId, sessionId, textoUsuario, textoCompleto, ehOnboarding, historico, contextoIdioma, origem, duracaoTurnoMs)
    .catch(err => log('Erro', `Pipeline pos-resposta falhou: ${err.message}`))

  return { texto: textoCompleto, pesquisouWeb: usarWebSearch, contextoIdioma }
}

function limparConversa(usuarioId) {
  const sessionId = `sessao_${usuarioId}`
  conversas.delete(sessionId)
  limparEstadoSessao(sessionId)
}

// Deriva o idioma a forcar no TTS a partir do contexto de idioma da conversa.
// Preferimos o idioma DA MENSAGEM (o que a pessoa acabou de falar) e caimos no
// idioma ATIVO da sessao. Retorna null quando nao ha sinal claro - nesse caso o
// prepararTextoParaFala usa seu proprio heuristico (ehProvavelmentePortugues),
// preservando o comportamento seguro anterior. Sem isso, respostas em ingles/
// espanhol levavam as conversoes de portugues ("ta"/"pra", siglas) por engano.
function idiomaParaTTS(contextoIdioma) {
  if (!contextoIdioma) return null
  return contextoIdioma.idiomaMensagem || contextoIdioma.idiomaAtivo || null
}

module.exports = { conversar, conversarStream, limparConversa, idiomaParaTTS }
