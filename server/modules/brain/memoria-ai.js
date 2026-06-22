const { carregarUsuario, salvarUsuario, atualizarUsuario } = require('../memoria')
const { log } = require('../logger')

const NOMES_PROIBIDOS = [
  'cogni', 'robo', 'robô', 'tutor', 'tutora', 'assistente',
  'professor', 'professora', 'ia', 'inteligencia', 'bot',
  'chatbot', 'gpt', 'openai', 'sistema',
]

const MAX_MEMORIAS = 50

// Stopwords curtas (pt/en) ignoradas na comparacao semantica de memorias: sozinhas
// nao distinguem o conteudo de uma memoria ("tem UM gato" vs "tem UM cachorro").
const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'e', 'em', 'no', 'na', 'nos', 'nas', 'que', 'com', 'por', 'pra', 'para', 'se',
  'eu', 'meu', 'minha', 'tem', 'ter', 'e', 'é', 'ao', 'aos',
  'the', 'a', 'an', 'of', 'in', 'on', 'and', 'to', 'is', 'has', 'have', 'my', 'i',
])

// Normaliza uma memoria para comparacao: minusculas, sem acento, sem pontuacao,
// espacos colapsados. Usada tanto na igualdade quanto no overlap de tokens.
function normalizarMemoria(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokensConteudo(textoNormalizado) {
  return textoNormalizado
    .split(' ')
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
}

// Dedupe SEMANTICO leve (substitui o antigo "includes(substring(0,20))", que nao
// detectava reformulacoes e nao impedia duplicatas reais). Considera "ja existe"
// quando: (a) a forma normalizada e igual, ou (b) o overlap de tokens de conteudo
// passa de 60% do menor conjunto. E so a 2a linha de defesa - o grosso da edicao
// agora vem por "substituir" (indice), nao por adicionar+dedupe.
function jaExisteSemelhante(memorias, nova) {
  const n = normalizarMemoria(nova)
  if (!n) return true
  const tn = new Set(tokensConteudo(n))
  if (tn.size === 0) {
    // Memoria sem tokens de conteudo (so stopwords): cai para igualdade exata.
    return memorias.some(m => normalizarMemoria(m) === n)
  }
  for (const m of memorias) {
    const nm = normalizarMemoria(m)
    if (nm === n) return true
    const tm = new Set(tokensConteudo(nm))
    if (tm.size === 0) continue
    let comuns = 0
    for (const t of tn) if (tm.has(t)) comuns++
    const overlap = comuns / Math.min(tn.size, tm.size)
    if (overlap >= 0.6) return true
  }
  return false
}

// Captura rapida e de ALTA PRECISAO por regex, como rede de seguranca da extracao
// por IA (que faz o trabalho pesado em extrairMemoriasComIA). Mantemos SO o que o
// regex acerta quase sempre e de graca: NOME (no onboarding) e IDADE. Os campos de
// string livre (materia, hobbies, comoAprende) e a SERIE saiam daqui por serem
// FRAGEIS e gerarem lixo (ex: "fórmula 1" capturado como materiaFavorita) - agora
// sao extraidos pela IA com validacao por campo. A IA SEMPRE vence; este regex so
// preenche idade/nome cedo (e resiliencia se a chamada de IA falhar).
function extrairMemoriasRegex(usuario, textoUsuario, ehOnboarding = false) {
  const texto = textoUsuario.toLowerCase()
  let mudou = false

  const padraoNome = texto.match(/(?:meu nome e|me chamo|pode me chamar de|eu sou o|eu sou a)\s+(\w+)/i)
  if (padraoNome && ehOnboarding) {
    const nomeDetectado = padraoNome[1].charAt(0).toUpperCase() + padraoNome[1].slice(1)
    const nomeLower = nomeDetectado.toLowerCase()
    const nomeProibido = NOMES_PROIBIDOS.some(p => nomeLower.includes(p))
    if (!nomeProibido && nomeDetectado.length > 1 && nomeDetectado.length < 30) {
      usuario.nome = nomeDetectado
      mudou = true
    }
  }

  // Idade: "8 anos"/"oito aninhos". Alta precisao. (A serie NAO e mais por regex -
  // "tenho 18 anos" nunca mais vira "18o ano"; quem cuida de serie agora e a IA.)
  const padraoIdade = texto.match(/\b(\d{1,2})\s*(?:anos|aninhos)\b/i)
  if (padraoIdade) {
    const idade = parseInt(padraoIdade[1], 10)
    if (idade >= 4 && idade <= 18 && usuario.idade !== idade) {
      usuario.idade = idade
      mudou = true
    }
  }

  if (mudou) salvarUsuario(usuario)
}

// Campos ESSENCIAIS do perfil (os que o onboarding por voz busca preencher). Se o
// pai ja preencheu todos pelo site, nao ha o que perguntar — o onboarding e pulado.
const CAMPOS_ESSENCIAIS = ['idade', 'serie', 'hobbies', 'comoAprende']

// Quais essenciais ainda faltam no perfil (array de nomes de campo). Vazio = perfil
// ja tem tudo. Usado tanto pra DECIDIR pular o onboarding quanto pra dizer ao prompt
// SO o que ainda perguntar (onboarding parcial — ver blocoOnboarding em prompt.js).
function camposEssenciaisFaltantes(usuario) {
  if (!usuario) return [...CAMPOS_ESSENCIAIS]
  return CAMPOS_ESSENCIAIS.filter(campo => !usuario[campo])
}

function temEssenciais(usuario) {
  return camposEssenciaisFaltantes(usuario).length === 0
}

function verificarOnboarding(usuario, historico) {
  if (!usuario || usuario.role === 'desenvolvedor') return
  if (usuario.onboardingCompleto) return

  // Atalho: o pai preencheu todos os essenciais no site (ou a IA acabou de
  // completa-los). Nao ha mais o que perguntar — fecha o onboarding na hora, sem
  // depender de contar mensagens. Isto resolve o "editei no site e ela refez tudo".
  if (temEssenciais(usuario)) {
    usuario.onboardingCompleto = true
    salvarUsuario(usuario)
    return
  }

  // Fallback por contagem (quando faltam campos mas a conversa ja se estendeu): nao
  // prende a crianca num onboarding infinito se ela nao quis responder algo.
  const totalMensagensUsuario = historico.filter(m => m.role === 'user').length
  if (totalMensagensUsuario >= 8) {
    usuario.onboardingCompleto = true
    salvarUsuario(usuario)
  }
}

// Mostra o valor ATUAL de um campo do perfil entre colchetes (ou "vazio"). Faz o
// modelo (a) corrigir um campo errado que ele ve preenchido, e (b) nao re-extrair
// o que ja esta certo.
function valorCampo(v) {
  return (v === null || v === undefined || v === '') ? 'vazio' : String(v)
}

function montarPromptMemoria(memorias, textoUsuario, respostaIA, usuario = {}) {
  const listaNumerada = memorias.length
    ? memorias.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '(nenhuma memoria ainda)'

  const estiloAtual = usuario.estiloLinguagem ? `"${usuario.estiloLinguagem}"` : 'ainda nao observado'

  return `Voce mantem o PERFIL de longo prazo de uma assistente (a Cogni) sobre um usuario (uma crianca/adolescente). Analise a ULTIMA troca e atualize o perfil. Ha DOIS tipos de dado, NAO confunda:

(1) INFORMACOES = campos FIXOS do perfil (lista fechada abaixo). Cada um tem UM valor.
(2) MEMORIA = qualquer outro fato pessoal que NAO seja um desses campos (lista aberta).

CAMPOS DE INFORMACAO (valor atual entre colchetes; so preencha/corrija se ESTA mensagem falar disso, sobre o PROPRIO usuario):
- idade [${valorCampo(usuario.idade)}]: numero de 4 a 18.
- serie [${valorCampo(usuario.serie)}]: a SERIE/ANO ESCOLAR atual, no formato "Xo ano" (1 a 12; 1o-9o ano = fundamental, 1o-3o do medio vira 10o-12o ano). Aceite por extenso ("quinta serie"->"5o ano").
- materiaFavorita [${valorCampo(usuario.materiaFavorita)}]: MATERIA DA ESCOLA (matematica, portugues, ciencias, historia, geografia, ingles, artes, educacao fisica...). NAO e hobby! "gosto de Formula 1" NAO e materia, e hobby.
- materiaDificil [${valorCampo(usuario.materiaDificil)}]: materia da escola que ele tem dificuldade.
- comoAprende [${valorCampo(usuario.comoAprende)}]: como ele prefere aprender. Use UMA destas: "exemplos do dia a dia", "jogos", "historias", "videos", "pratica", "desafios".
- hobbies [${valorCampo(usuario.hobbies)}]: o que ele faz por diversao fora da escola (jogar bola, desenhar, games...).

MEMORIAS ATUAIS (referenciadas por NUMERO):
${listaNumerada}

ESTILO DE LINGUAGEM observado ate agora: ${estiloAtual}

MENSAGEM DO USUARIO:
"${textoUsuario}"

RESPOSTA DA COGNI:
"${respostaIA}"

Retorne APENAS um JSON:
{
  "informacoes": { "campo": "valor", ... },
  "adicionar": ["fato novo curto", ...],
  "substituir": [{"indice": N, "texto": "fato atualizado"}, ...],
  "remover": [N, ...],
  "estilo": "frase curta sobre o jeito de falar do usuario" ou null,
  "topico": "assunto especifico estudado nesta troca" ou null,
  "materia": "uma materia escolar" ou null,
  "sensivel": true ou false
}

DECISAO MAIS IMPORTANTE — adicionar vs substituir vs remover:
Antes de adicionar QUALQUER fato, olhe a lista de MEMORIAS ATUAIS e pergunte: "isso CONTRADIZ ou ATUALIZA uma memoria que ja existe sobre o MESMO tema?".
- Se SIM (o usuario corrigiu, trocou de gosto, mudou de ideia, ou o fato novo bate de frente com um existente sobre o mesmo assunto) => use "substituir" com o NUMERO daquela memoria. NUNCA adicione. So pode haver UMA verdade por tema (um esporte favorito, uma cor favorita, um animal de estimacao do mesmo tipo).
- O gatilho NAO e a palavra parecida, e o MESMO TEMA. "Fórmula 1" e "futebol" sao temas-irmaos (esporte favorito): se existe "Gosta de Fórmula 1" e ele diz "na verdade prefiro futebol", isso e {"substituir":[{"indice":N,"texto":"Esporte favorito e futebol"}]}, NAO um "adicionar".
- Sinais de correcao/mudanca: "na verdade", "errei", "menti", "nao e X e sim Y", "nao gosto mais de X", "agora gosto de Y", "mudei de ideia", "troquei", "deixei de".
- Se for um fato REALMENTE novo, sobre um tema que NAO esta na lista => "adicionar".
- Se o usuario pede pra esquecer, ou afirma o OPOSTO de uma memoria sem colocar nada no lugar ("nao tenho mais cachorro") => "remover" com o NUMERO.

REGRAS (siga a risca):
- "informacoes": inclua SO os campos que ESTA mensagem revelou ou corrigiu, sobre o PROPRIO usuario. Se ele diz "to no quinto ano" => {"informacoes":{"serie":"5o ano"}}. Se nao revelou nenhum campo, use {} (objeto vazio).
- NUNCA invente: so preencha um campo se o usuario REALMENTE disse. "meu irmao ta no 5o ano" NAO e a serie DELE - ignore.
- Um fato que cabe num CAMPO vai SO em "informacoes", NUNCA tambem em "adicionar" (sem duplicar). Ex: "to no 6o ano" -> informacoes.serie, e NADA em adicionar sobre serie/ano.
- CORRIGIR/ATUALIZAR memoria que ja existe => "substituir" com o NUMERO. NUNCA duplique, NUNCA deixe a antiga e a nova convivendo. Ex 1 (cor): existe "2. Cor favorita e azul", ele diz "na verdade verde" => {"substituir":[{"indice":2,"texto":"Cor favorita e verde"}]}. Ex 2 (gosto/esporte): existe "1. Gosta de Fórmula 1", ele diz "errei, gosto e de futebol" => {"substituir":[{"indice":1,"texto":"Esporte favorito e futebol"}]} (e NAO {"adicionar":["Gosta de futebol"]}).
- APAGAR memoria => "remover" com o NUMERO. So o que ele pediu pra esquecer ou um fato DIRETAMENTE contradito sem substituto. Na duvida, NAO remova.
- "adicionar" => SO fatos NOVOS, de um tema que NAO esta na lista de memorias atuais, e que NAO sao campos de informacao. Curtos ("Tem um cachorro chamado Rex", "Pai se chama Joao"). Se o tema ja existe na lista, e "substituir", nunca "adicionar".
- "estilo": descreva o JEITO DE FALAR do usuario (formal/informal, simples/elaborado, animado/calmo). REFINE o estilo atual com base na conversa - NAO reescreva do zero por causa de uma unica mensagem. Se o estilo atual ja captura bem, devolva null (sem mudanca).
- "topico": o ASSUNTO ESPECIFICO que esta troca estudou, em 1 a 4 palavras, minusculas, sem ponto final. Ex: "sistema solar", "tabuada do 7", "interpretacao de texto", "verbo to be", "ciclo da agua". NAO e a materia generica ("matematica"): e o TEMA dentro dela. Se a troca for papo/saudacao/brincadeira sem assunto de estudo, devolva null. NUNCA invente um topico que a conversa nao tocou.
  VISAO (camera): a Cogni enxerga pela camera, entao a resposta dela pode estar descrevendo/ensinando sobre algo que a crianca MOSTROU (figurinhas, pagina de livro, desenho, lição, objeto, mapa, foto). Se a resposta indica isso e teve aprendizado, extraia o TEMA do que foi visto, igual a qualquer outro estudo. Ex: mostrou figurinhas de jogadores da Copa e a Cogni falou deles => "jogadores de futebol"; mostrou uma pagina de matematica => o tema da pagina ("fracoes"); mostrou um desenho de uma planta e ela explicou as partes => "partes da planta". So quando houve assunto real — mostrar algo a toa e dizer "que legal" continua null.
- "materia": classifique o ASSUNTO desta troca em UMA destas materias EXATAS (minusculas): "portugues", "matematica", "ciencias", "historia", "geografia", "idiomas", "outros". Use "outros" para papo/brincadeira/sentimento/saudacao (qualquer coisa que NAO seja materia escolar). Olhe o SENTIDO real: "me conta uma historia" e papo (outros), nao historia; "quanto e 3 vezes 4" e matematica. Na duvida entre uma materia e papo, escolha "outros".
- "sensivel": true se a fala da crianca revelar algo EMOCIONALMENTE DELICADO que os pais deveriam saber, mesmo sem palavra-chave obvia: sofrer bullying/exclusao/zoacao, tristeza forte, medo, ansiedade, solidao, briga seria em casa, vontade de se machucar, abuso, ou qualquer sofrimento real. NAO marque por assunto escolar dificil, frustracao leve com licao, ou papo normal. Seja sensivel ao SENTIDO, nao a palavras literais — "os meninos vivem rindo de mim na escola" e sensivel (bullying) mesmo sem a palavra "bullying". Na duvida sobre sofrimento real, marque true.
- Ignore saudacoes/conversa trivial. Se nada mudou: {"informacoes":{},"adicionar":[],"substituir":[],"remover":[],"estilo":null,"topico":null,"materia":"outros","sensivel":false}.
- Os NUMEROS em "substituir"/"remover" devem existir na lista. Retorne APENAS o JSON.`
}

// ---------------------------------------------------------------------
// Validacao dos campos de INFORMACAO (a IA propoe, o validador dispoe)
// ---------------------------------------------------------------------
// Cada validador recebe o valor cru da IA e devolve o valor LIMPO a gravar, ou
// null se invalido (nesse caso o campo NAO e tocado). Principio: DESCARTAR o que
// nao passa, nunca truncar (meia-frase no campo e lixo). Nunca zera um campo bom.

const MATERIAS_VALIDAS = /\b(matematica|portugues|ciencias?|biologia|fisica|quimica|historia|geografia|ingles|espanhol|frances|artes?|educacao\s+fisica|redacao|gramatica|literatura|filosofia|sociologia|ensino\s+religioso|musica)\b/i
const COMO_APRENDE_VALIDOS = ['exemplos do dia a dia', 'jogos', 'historias', 'videos', 'pratica', 'desafios', 'curiosidades']

function normalizarSimples(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

const VALIDADORES_INFO = {
  idade(v) {
    const n = typeof v === 'number' ? v : parseInt(String(v).match(/\d{1,2}/)?.[0] || '', 10)
    return (Number.isInteger(n) && n >= 4 && n <= 18) ? n : null
  },
  serie(v) {
    // Extrai o numero 1-12 de qualquer forma ("5o ano", "quinta serie", "6", "2º").
    // O \d casa MESMO colado ao ordinal (5o/2º), por isso NAO usamos \b apos o digito.
    const txt = normalizarSimples(v)
    const porExtenso = { primeir: 1, segund: 2, terceir: 3, quart: 4, quint: 5, sext: 6, setim: 7, oitav: 8, non: 9, decim: 10 }
    let n = parseInt((txt.match(/(\d{1,2})/) || [])[1] || '', 10)
    if (!Number.isInteger(n)) {
      for (const [raiz, num] of Object.entries(porExtenso)) {
        if (txt.includes(raiz)) { n = num; break }
      }
    }
    // "1o/2o/3o ano do medio" as vezes vem como 1-3: se o texto cita "medio" e n<=3, mapeia pra 10-12.
    if (/medio/.test(txt) && n >= 1 && n <= 3) n += 9
    return (Number.isInteger(n) && n >= 1 && n <= 12) ? `${n}o ano` : null
  },
  materiaFavorita(v) {
    const s = String(v || '').trim().replace(/[.,!?;]+$/, '')
    if (s.length < 2 || s.length > 40 || s.split(/\s+/).length > 5 || /\n/.test(s)) return null
    // So aceita se parecer materia escolar (barra "formula 1" e afins).
    return MATERIAS_VALIDAS.test(s) ? s.toLowerCase() : null
  },
  materiaDificil(v) {
    return VALIDADORES_INFO.materiaFavorita(v)   // mesma regra
  },
  comoAprende(v) {
    const s = normalizarSimples(v)
    // Casa com um dos valores canonicos (por inclusao de palavra-chave).
    for (const canon of COMO_APRENDE_VALIDOS) {
      const chave = normalizarSimples(canon).split(' ')[0]   // "exemplos", "jogos", ...
      if (s.includes(chave)) return canon
    }
    return null
  },
  hobbies(v) {
    const s = String(v || '').trim().replace(/[.,!?;]+$/, '')
    if (s.length < 2 || s.length > 60 || s.split(/\s+/).length > 10 || /\n/.test(s)) return null
    return s
  },
}

// Aplica as informacoes validadas no usuario (DENTRO de atualizarUsuario). So
// grava o que passa na validacao; loga sobrescritas (auditoria). Retorna true se
// mudou algo. NUNCA zera um campo existente com vazio.
function aplicarInformacoes(usuario, informacoes) {
  if (!informacoes || typeof informacoes !== 'object') return false
  let mudou = false
  for (const [campo, validador] of Object.entries(VALIDADORES_INFO)) {
    if (!(campo in informacoes)) continue
    const cru = informacoes[campo]
    if (cru === null || cru === undefined || cru === '') continue   // nao zera
    const limpo = validador(cru)
    if (limpo === null) {
      log('Perfil', `Campo "${campo}" descartado (invalido): ${JSON.stringify(cru)}`)
      continue
    }
    if (usuario[campo] === limpo) continue   // ja igual
    log('Perfil', `${campo}: ${JSON.stringify(usuario[campo] ?? null)} -> ${JSON.stringify(limpo)}`)
    usuario[campo] = limpo
    mudou = true
  }
  return mudou
}

// Materias genericas que NAO valem como "topico" (o topico e o tema DENTRO da
// materia, ex: "sistema solar", nao "ciencias"). Se a IA devolver so a materia,
// descartamos — o Painel ja tem a materia pela classificacao por regex.
const TOPICO_GENERICO = new Set([
  'matematica', 'portugues', 'ciencias', 'ciencia', 'historia', 'geografia',
  'idiomas', 'ingles', 'espanhol', 'artes', 'arte', 'estudo', 'estudos',
  'escola', 'licao', 'tarefa', 'materia', 'outros',
])

// Valida o "topico" cru da IA: tema curto e especifico, ou null. Mesmo principio
// dos outros validadores — descarta lixo, nunca trunca. Barra topico generico
// (so a materia), texto longo demais e null/vazio.
function validarTopico(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(/[.,!?;:]+$/, '')
  if (s.length < 2 || s.length > 40 || /\n/.test(s)) return null
  if (s.split(/\s+/).length > 4) return null
  if (TOPICO_GENERICO.has(normalizarSimples(s))) return null
  return s.toLowerCase()
}

// Lista canonica de materias (a MESMA do schema e do materia.js). Mantida aqui pra
// validar a materia que a IA devolve sem criar dependencia circular com materia.js.
const MATERIAS_CANONICAS = new Set([
  'portugues', 'matematica', 'ciencias', 'historia', 'geografia', 'idiomas', 'outros',
])

// Valida a "materia" crua da IA: tem que ser uma das canonicas. Qualquer outra
// coisa (ou null) devolve null — quem chama cai no fallback por regex (materia.js).
function validarMateria(v) {
  if (v === null || v === undefined) return null
  const s = normalizarSimples(v).replace(/[.,!?;:]+$/, '')
  return MATERIAS_CANONICAS.has(s) ? s : null
}

// Heuristica anti-duplicacao: uma memoria nova que e "sobre" um campo de info ja
// gravado nao deve ir pra lista de memorias (ex: "esta no 5o ano" quando serie ja
// foi pra informacoes). Barra os casos obvios por palavra-chave.
function memoriaEhInfo(textoMemoria) {
  const t = normalizarSimples(textoMemoria)
  return /\b(\d{1,2}\s*o?\s*ano|\d{1,2}\s*a?\s*serie|tem\s+\d{1,2}\s+anos?\s+de\s+idade|materia\s+(favorita|preferida))\b/.test(t)
}

// Fila de extracao de memoria POR USUARIO. Resolve um bug de timing (lost-update na
// DECISAO da IA): a leitura do snapshot de memorias + a chamada de IA aconteciam
// FORA da fila do atualizarUsuario (que so serializa a aplicacao). Em dois turnos
// seguidos da mesma crianca ("gosto de F1" e depois "na verdade futebol"), a
// extracao do turno 2 lia o snapshot ANTES de a do turno 1 gravar — entao via a
// lista sem "Fórmula 1" e mandava ADICIONAR "futebol" em vez de SUBSTITUIR (o
// modelo nao tinha o que corrigir). Resultado: duas memorias contraditorias.
// Serializar a EXTRACAO inteira (snapshot -> IA -> aplicacao) por usuario garante
// que o turno N+1 sempre ve o que o turno N gravou. Nao adiciona latencia
// perceptivel: os turnos de uma crianca ja sao sequenciais (ela so fala de novo
// depois de ouvir a resposta). Filas de usuarios diferentes nao se bloqueiam.
const filasExtracao = new Map()

function extrairMemoriasComIA(openai, modelo, usuarioId, textoUsuario, respostaIA = '') {
  if (!usuarioId || typeof usuarioId !== 'string') {
    return extrairMemoriasComIAInterno(openai, modelo, usuarioId, textoUsuario, respostaIA)
  }
  const anterior = filasExtracao.get(usuarioId) || Promise.resolve()
  const tarefa = anterior
    .catch(() => {})
    .then(() => extrairMemoriasComIAInterno(openai, modelo, usuarioId, textoUsuario, respostaIA))

  filasExtracao.set(usuarioId, tarefa)
  // Limpa a entrada quando esta for a ultima da fila (evita o Map crescer sem fim).
  tarefa.finally(() => {
    if (filasExtracao.get(usuarioId) === tarefa) filasExtracao.delete(usuarioId)
  })
  return tarefa
}

async function extrairMemoriasComIAInterno(openai, modelo, usuarioId, textoUsuario, respostaIA = '') {
  if (!textoUsuario || textoUsuario.trim().length < 5) return

  const usuarioAtual = carregarUsuario(usuarioId)
  if (!usuarioAtual) return

  // Snapshot lido DENTRO da fila de extracao (ver filasExtracao): o turno anterior
  // ja gravou, entao esta lista esta fresca. Os numeros que o LLM devolve continuam
  // validos na aplicacao (o atualizarUsuario abaixo serializa a escrita; e nenhuma
  // outra extracao desta crianca roda em paralelo, pela fila).
  const memoriasSnapshot = Array.isArray(usuarioAtual.memorias) ? usuarioAtual.memorias.slice() : []
  const prompt = montarPromptMemoria(memoriasSnapshot, textoUsuario, respostaIA, usuarioAtual)

  let textoResposta
  try {
    const resposta = await openai.chat.completions.create({
      model: modelo,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300, // folga pro campo "topico" extra nao truncar o JSON
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
    textoResposta = (resposta.choices[0]?.message?.content || '').trim()
  } catch (err) {
    log('Erro', `Extracao de memorias com IA falhou: ${err.message}`)
    return null
  }

  let dados
  try {
    dados = JSON.parse(textoResposta)
  } catch {
    const jsonMatch = textoResposta.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    try { dados = JSON.parse(jsonMatch[0]) } catch { return null }
  }

  // Campos do Diario/Painel que NAO vao pro perfil (vao pra linha da conversa):
  // topico (assunto fino), materia (classificacao da IA, melhor que o regex) e
  // sensivel (algo emocionalmente delicado pros pais). Calculados aqui e retornados
  // pra pipeline gravar/atualizar a conversa. materia null = cai no fallback regex.
  const topico = validarTopico(dados.topico)
  const materia = validarMateria(dados.materia)
  const sensivel = dados.sensivel === true

  await atualizarUsuario(usuarioId, (u) => {
    if (!Array.isArray(u.memorias)) u.memorias = []
    const mems = u.memorias
    let mudou = false

    // 0) INFORMACOES estruturadas (idade/serie/materia/hobbies/comoAprende). Aplica
    //    com validacao por campo ANTES da memoria, pra o filtro anti-duplicacao
    //    abaixo saber o que ja virou campo.
    if (aplicarInformacoes(u, dados.informacoes)) mudou = true

    const ehIndiceValido = (n) => Number.isInteger(n) && n >= 1 && n <= mems.length

    // 1) SUBSTITUIR in-place (edicao cirurgica, sem duplicar). Aplica direto pelo
    //    indice 1-based; a posicao no array nao muda, entao a ordem importa pouco.
    if (Array.isArray(dados.substituir)) {
      for (const item of dados.substituir) {
        if (!item || !ehIndiceValido(item.indice)) continue
        const texto = typeof item.texto === 'string' ? item.texto.trim() : ''
        if (texto.length < 3) continue
        const antigo = mems[item.indice - 1]
        if (antigo === texto) continue
        log('Memoria', `Substituindo [${item.indice}] "${antigo}" -> "${texto}"`)
        mems[item.indice - 1] = texto
        mudou = true
      }
    }

    // 2) REMOVER por indice (cirurgico). Coleta indices validos, ordena DESC e faz
    //    splice de tras pra frente para nao deslocar os indices ainda nao aplicados.
    if (Array.isArray(dados.remover)) {
      const indices = [...new Set(
        dados.remover
          .map(n => (typeof n === 'number' ? n : parseInt(n, 10)))
          .filter(ehIndiceValido)
      )].sort((a, b) => b - a)
      for (const idx of indices) {
        log('Memoria', `Removendo [${idx}]: "${mems[idx - 1]}"`)
        mems.splice(idx - 1, 1)
        mudou = true
      }
    }

    // 3) ADICIONAR fatos novos, com dedupe semantico e teto de tamanho. Barra
    //    tambem o que e INFORMACAO (serie/idade/materia) pra nao duplicar no campo.
    if (Array.isArray(dados.adicionar)) {
      for (const nova of dados.adicionar) {
        if (typeof nova !== 'string') continue
        const texto = nova.trim()
        if (texto.length < 3) continue
        if (memoriaEhInfo(texto)) { log('Memoria', `Ignorada (e campo de info): "${texto}"`); continue }
        if (jaExisteSemelhante(mems, texto)) continue
        if (mems.length >= MAX_MEMORIAS) break
        mems.push(texto)
        mudou = true
      }
    }

    // 4) Estilo de linguagem com HISTERESE (antes sobrescrevia todo turno -> estilo
    //    "bipolar"). Agora: o prompt ja pede pra REFINAR (nao reescrever) e devolver
    //    null se nao mudou. Aqui reforcamos: so aceita a troca se a nova observacao
    //    for de tamanho razoavel E (se ja havia estilo) realmente diferente. Como a
    //    IA ve o estilo atual no prompt e foi instruida a so mudar com padrao claro,
    //    o estilo "amadurece" em vez de oscilar a cada mensagem atipica.
    if (dados.estilo && typeof dados.estilo === 'string') {
      const novo = dados.estilo.trim()
      const atual = u.estiloLinguagem || ''
      if (novo.length >= 4 && novo.length <= 80 && normalizarSimples(novo) !== normalizarSimples(atual)) {
        log('Perfil', `estilo: ${JSON.stringify(atual || null)} -> ${JSON.stringify(novo)}`)
        u.estiloLinguagem = novo
        mudou = true
      }
    }

    if (mudou) {
      log('Memoria', `Atualizadas para ${u.nome} (${mems.length} itens)`)
    }
  })

  // Volta pra pipeline completar a linha da conversa no Diario. topico null = papo
  // sem assunto; materia null = usar o fallback regex; sensivel = sinal pros pais.
  return { topico, materia, sensivel }
}

module.exports = {
  extrairMemoriasRegex,
  verificarOnboarding,
  extrairMemoriasComIA,
  camposEssenciaisFaltantes,
  temEssenciais,
}
