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
  ['portugues', /\b(portugues|redac[ao]|reda[çc]|texto[s]?|interpretac|gramatica|verbo[s]?|substantivo|adjetivo|sujeito|predicado|ortografia|acentuac|virgula|paragrafo|conjugar?|soletra[r]?|escrever\s+(melhor|um\s+texto)|leitura|ler\s+um\s+livro|poema|cra[sz]e|silaba[s]?)/],
  ['ciencias', /\b(ciencia[s]?|biologia|fisica|quimica|corpo\s+humano|celula[s]?|atomo[s]?|planta[s]?|animai[s]|animal|fotossintese|sistema\s+solar|planeta[s]?|gravidade|energia|materia\s+e\s+energia|esqueleto|orgao[s]?|digestao|respiracao|ecossistema|dinossauro[s]?|experiencia\s+cientifica)/],
  // "historia" como MATERIA (nao "conta uma historia/historinha", que e papo):
  // exige o sentido escolar/temporal. "materia de historia", "na historia", ou os
  // temas historicos concretos abaixo. "conta/conte/inventa uma historia" NAO casa.
  ['historia', /\b(materia\s+de\s+historia|aula\s+de\s+historia|na\s+historia\b|historia\s+do\s+(brasil|mundo)|guerra[s]?\b|imperio[s]?|revolucao|civilizac|idade\s+(media|antiga|moderna)|descobrimento|escravidao|independencia\s+d|ditadura|farao|faraos|egito\s+antigo|roma\s+antiga|grecia\s+antiga)/],
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
