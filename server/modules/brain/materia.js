// =====================================================================
// Classificacao de MATERIA escolar (heuristica, sem custo de API)
// =====================================================================
// Para o Diario de Conversas e o Painel de Aprendizado do Companion, cada turno
// e rotulado com uma materia. Fazemos isso por PALAVRAS-CHAVE (regex), no mesmo
// espirito do triagem.js: instantaneo, gratis e sem latencia no fluxo de voz —
// chamar a IA so pra rotular materia a cada turno nao se justifica num TCC.
//
// Nao e perfeito (um classificador por regex nunca e), mas e honesto e suficiente:
// quando nada casa, cai em 'outros' (papo/assunto fora das materias escolares).
//
// ACENTOS: o texto vem do Whisper (acentuado). Normalizamos removendo diacriticos
// ANTES de testar (mesma pratica do projeto), entao os padroes sao ASCII puro e
// casam com ou sem acento. Ver memoria do projeto sobre normalizar NFD em STT.

// Lista canonica (a MESMA do schema do banco: conversas.materia / planos.foco).
const MATERIAS = ['portugues', 'matematica', 'ciencias', 'historia', 'geografia', 'idiomas', 'outros']

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacriticos combinantes
    .toLowerCase()
}

// Ordem importa: a primeira materia cujo padrao casar vence. Padroes mais
// especificos/seguros primeiro. Texto ja vem normalizado (sem acento, minusculo).
const PADROES_MATERIA = [
  // "conta" so vale no sentido matematico: "conta de somar/dividir", "continha",
  // ou "conta(s)" precedido de artigo/numero ("a conta", "essas contas") — nunca o
  // verbo contar ("me conta uma piada"), que e papo.
  ['matematica', /\b(matematica|tabuada|multiplicac|divis[ao]|somar\b|subtrac|adic[ao]|continha|conta\s+de\s+(somar|dividir|multiplicar|subtrair|mais|menos|vezes)|(uma|a|essa|essas|as|umas)\s+conta[s]?\b|numero[s]?|fracao|fracoes|geometria|algebra|equac[ao]|raiz\s+quadrada|porcentagem|quanto\s+(e|eh|da|sao)\b|\d+\s+vezes\b|mais\s+\d|menos\s+\d|\d+\s*[x*+\-]\s*\d+)/],
  ['portugues', /\b(portugues|redac[ao]|reda[çc]|texto[s]?|interpretac|gramatica|verbo[s]?|substantivo|adjetivo|sujeito|predicado|ortografia|acentuac|virgula|paragrafo|conjugar?|soletra[r]?|escrever\s+(melhor|um\s+texto)|leitura|ler\s+um\s+livro|poema|cra[sz]e|silaba[s]?|cedilha|pontuac[ao]|sinonimo|antonimo|plural\s+d|rima[r]?)/],
  ['ciencias', /\b(ciencia[s]?|biologia|fisica|quimica|corpo\s+humano|celula[s]?|atomo[s]?|planta[s]?|animai[s]|animal|fotossintese|sistema\s+solar|planeta[s]?|gravidade|energia|materia\s+e\s+energia|esqueleto|orgao[s]?|digestao|respiracao|ecossistema|dinossauro[s]?|experiencia\s+cientifica)/],
  // "historia" como MATERIA (nao "conta uma historia/historinha", que e papo):
  // exige o sentido escolar/temporal. "materia de historia", "na historia", os temas
  // historicos concretos, ou as marcas de PERGUNTA sobre o passado abaixo.
  // "conta/conte/inventa uma historia" NAO casa - e o caso que mantem esse padrao
  // conservador, entao qualquer coisa nova aqui precisa passar longe disso.
  // NAO use marcas genericas de pergunta aqui ("quem foi", "em que ano"): testadas,
  // elas roubam papo demais ("quem foi que apagou a luz", "em que ano voce nasceu",
  // "quem era aquele personagem do desenho"). Cada assunto historico entra pelo seu
  // TERMO CONCRETO - e um regex mais comprido, mas que erra pro lado seguro.
  ['historia', new RegExp([
    // sentido escolar explicito
    /materia\s+de\s+historia|aula\s+de\s+historia|na\s+historia\b|historia\s+d[oa]\s+(brasil|mundo|humanidade)/,
    /pre\s*-?\s*historia|historia\s+(antiga|geral)/,
    // periodos e processos
    /imperio[s]?|revolucao|civilizac|idade\s+(media|antiga|moderna)|feudalismo|cruzadas/,
    /renascimento|iluminismo|colonial|brasil\s+colonia|colonizac|bandeirante[s]?|imigrac/,
    // "guerra" QUALIFICADA: guerra de travesseiro nao e materia escolar.
    /guerra[s]?\s+(mundial|fria|civil|do\b|da\b|dos\b|das\b)|(primeira|segunda)\s+guerra/,
    // eventos concretos do Brasil
    /descobri(u|mento|ram)|foi\s+descoberto|escravidao|abolic|lei\s+aurea|independencia\s+d/,
    /ditadura|proclamac|inconfidencia|revolta\s+d|republica\s+velha/,
    // mundo antigo
    /farao|faraos|egito\s+antigo|roma\s+antiga|grecia\s+antiga|homen[s]?\s+das\s+cavernas/,
    // personagens que aparecem sempre nessa idade escolar
    /dom\s+pedro|dom\s+joao|princesa\s+isabel|tiradentes|getulio|napoleao|zumbi|palmares/,
    /pedro\s+alvares|cabral\b|hitler|nazis/,
    // marcas temporais que sobrevivem ao teste de papo
    /\bseculo[s]?\b|\bantigamente\b|\bno\s+passado\b|\bmuro\s+de\s+berlim\b/,
  ].map(r => r.source).join('|'))],
  ['geografia', /\b(geografia|mapa[s]?|continente[s]?|pais(es)?|capital\s+d|capitais|rio[s]?\b|montanha[s]?|oceano[s]?|clima[s]?|relevo|estado[s]?\s+brasileir|regi[ao]es|populac[ao]|territorio|hemisferio|latitude|longitude|bioma[s]?)/],
  ['idiomas', /\b(ingles|english|espanhol|spanish|frances|french|idioma[s]?\b|lingua\s+(estrangeira|inglesa|espanhola)|traduz[ir]?|traducao|como\s+(se\s+)?(fala|diz|escreve)\s+\w+\s+em\s+(ingles|espanhol|frances)|verbo\s+(to\s+be|ser\s+em\s+ingles))/],
]

/**
 * Classifica a materia de um turno a partir do texto da crianca (e, opcionalmente,
 * da resposta da Cogni como reforco). Retorna uma das MATERIAS canonicas; 'outros'
 * quando nada casa (papo/assunto fora do escopo escolar).
 *
 * @param {string} textoUsuario  fala da crianca (fonte principal)
 * @param {string} [textoResposta] resposta da Cogni (reforco quando a fala e curta)
 * @returns {string} materia canonica (ver MATERIAS)
 */
function classificarMateria(textoUsuario, textoResposta = '') {
  const base = `${textoUsuario || ''} ${textoResposta || ''}`.trim()
  if (!base) return 'outros'
  const t = normalizar(base)
  for (const [materia, padrao] of PADROES_MATERIA) {
    if (padrao.test(t)) return materia
  }
  return 'outros'
}

module.exports = { classificarMateria, MATERIAS }
