// =====================================================================
// Triagem rapida (heuristica, ANTES de chamar a IA)
// =====================================================================
// Decide DUAS coisas de uma vez, sem custo de API, quando a fala da crianca e
// OBVIA: (a) se precisa de PESQUISA na internet, e (b) qual o MODO da interacao
// (estudo = ajuda escolar/exercicio -> tutora socratica; papo = conversa/
// curiosidade/brincadeira -> amiga direta). Quando algo nao e obvio, devolve
// `decidiu:false` e o brain.js sobe a decisao para um classificador (modelo
// barato) que resolve modo+pesquisa numa unica chamada.
//
// PRINCIPIOS:
//   1) MOVER A DECISAO PARA FORA DO GERADOR: o modelo fraco (gpt-4o-mini) erra
//      menos CLASSIFICANDO (saida curta) do que gerando-seguindo-regras. Aqui
//      cortamos o obvio de graca; o resto vira uma classificacao explicita.
//   2) PESQUISA = TIPO DE FATO, NAO "INCERTEZA": o modelo nao sabe o que nao
//      sabe. Entao olhamos a PROPRIEDADE DA PERGUNTA: se a resposta e uma
//      EXPLICACAO/CONCEITO estavel -> nao pesquisa; se e um VALOR/NOME especifico
//      ou algo que muda com o tempo -> pesquisa. Vies deliberado a pesquisar em
//      fatos: uma crianca nao pode aprender algo errado.
//   3) NA DUVIDA ENTRE ESTUDO E PAPO -> PAPO: o custo de responder direto uma
//      pergunta que "merecia" socratico e baixo (a crianca aprendeu algo); o
//      custo de socratizar um papo casual e alto (irrita, abandona).
//
// ACENTOS: o texto vem do Whisper (com acentos). NORMALIZAMOS removendo
// diacriticos ANTES de testar (normalizarBusca), entao escrevemos os padroes em
// ASCII puro e eles casam com ou sem acento.

const MODO_ESTUDO = 'estudo'
const MODO_PAPO = 'papo'

// Remove acentos e baixa a caixa, para casar padroes ASCII contra texto acentuado.
// "Você é demais!" -> "voce e demais!". Mantem pontuacao (alguns padroes usam).
function normalizarBusca(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // tira os diacriticos combinantes
    .toLowerCase()
}

// ---------------------------------------------------------------------
// PADROES QUE CLARAMENTE PEDEM PESQUISA (info que muda com o tempo)
// ---------------------------------------------------------------------
// Ancorados em sinais de ATUALIDADE. Evitamos disparar por um numero solto ou uma
// palavra ambigua que tambem aparece em papo comum. Texto ja vem SEM acento.
const PADROES_PESQUISA_OBVIA = [
  // Pergunta direta de data/hora de hoje
  /\b(que\s+horas?\s+sao|que\s+dia\s+(e|foi|sera)\s+hoje|data\s+de\s+hoje|dia\s+de\s+hoje)\b/i,
  // Tempo presente explicito + assunto que muda
  /\b(hoje|agora|neste?\s+momento|no\s+momento|atualmente)\b.*\b(dia|data|hora|temperatura|clima|tempo|cotacao|preco|valor|dolar|euro|noticia)\b/i,
  // Noticias / acontecimentos recentes
  /\b(noticias?|manchetes?|ultimas?\s+noticias?|o\s+que\s+(esta|ta)\s+acontecendo|aconteceu\s+(hoje|ontem|essa\s+semana))\b/i,
  // Cotacoes / precos de mercado (ancorado em ativo financeiro)
  /\b(cotacao|preco|valor)\s+(do|da|de|d[oa]s)\s*(dolar|euro|bitcoin|btc|real|acao|acoes|criptomoeda|ouro|petroleo|gasolina)\b/i,
  /\b(quanto\s+(esta|ta|custa|vale)|qual\s+o\s+(preco|valor))\b.*\b(dolar|euro|bitcoin|btc|gasolina|iphone|passagem|acao)\b/i,
  // Clima / previsao do tempo
  /\b(previsao\s+do\s+tempo|vai\s+chover|ta\s+chovendo|esta\s+chovendo|temperatura\s+(hoje|agora|amanha)|clima\s+(hoje|agora|amanha)|quantos\s+graus)\b/i,
  // Resultado / placar de jogo (exige contexto temporal — nao so "jogo")
  /\b(resultado|placar|quem\s+ganhou|que\s+horas\s+e\s+o\s+jogo)\b.*\b(hoje|ontem|agora|rodada|jogo|partida)\b/i,
  /\b(jogo|partida)\s+(de\s+hoje|de\s+ontem|de\s+amanha|agora)\b/i,
  // Autoridade ATUAL
  /\b(quem\s+e\s+(o|a)\s+)?(presidente|primeiro\s*ministro|governador|prefeito|papa)\s+(atual|de\s+agora|do\s+brasil|de\s+[a-z]+)/i,
  // Lancamentos / estreias / "quando sai"
  /\b(quando\s+(sai|lanca|estreia|chega|vai\s+sair)|ja\s+(saiu|lancou|estreou)|data\s+de\s+(lancamento|estreia))\b/i,
  // Tendencias do momento
  /\b(em\s+alta\s+(hoje|agora)|trending|viral\s+(hoje|agora)|mais\s+(tocada|vista|vendida)\s+(hoje|agora|do\s+momento))\b/i,
  // "Ultima/mais recente versao/modelo de X" (nas duas ordens)
  /\b(ultim[oa]|mais\s+recente|mais\s+nov[oa])\s+(versao|modelo|geracao|lancamento)\b/i,
  /\b(versao|modelo|geracao|celular|iphone|console)\s+(mais\s+(recente|nov[oa])|atual)\b/i,
]

// ---------------------------------------------------------------------
// GATILHO DE PESQUISA POR TIPO DE FATO (lacuna de conhecimento)
// ---------------------------------------------------------------------
// Alem da atualidade, pesquisamos FATOS ESPECIFICOS que o modelo tende a alucinar:
// um VALOR/NOME particular sobre uma entidade, nao uma EXPLICACAO. A regra mental:
// "a resposta e uma explicacao -> nao pesquisa; e um numero/nome especifico ->
// pesquisa". Como o regex nao "entende" a pergunta, combinamos dois sinais:
//   (1) a forma da pergunta pede um DADO ("quantos/quantas X tem", "qual a
//       populacao/altura/capital/distancia de"), E
//   (2) NAO e um pedido conceitual (tratado em NAO_PESQUISA_INICIO, que tem
//       prioridade no fluxo). Assim "o que e fotossintese" nunca cai aqui, mas
//       "quantos habitantes tem Sorocaba" cai.
// So disparam quando a frase NAO foi cortada antes como conceito/papo/ajuda.
const PADROES_FATO_ESPECIFICO = [
  // "quantos/quantas X tem/ha/existe(m)" -> contagem de algo do mundo real.
  // (continhas tipo "quanto e 7x8" sao cortadas antes em NAO_PESQUISA_INICIO)
  /\bquant[oa]s?\s+\w+.*\b(tem|ha|existe[m]?|possui|mede|pesa|custa|vive[m]?|habita[m]?)\b/i,
  // Atributo geografico/fisico especifico DE uma entidade nomeada.
  /\b(populacao|habitantes|area|altura|tamanho|profundidade|distancia|capital|moeda|idioma\s+oficial|fuso)\s+(d[aeo]|d[oa]s|de)\b/i,
  // "qual a altura/populacao/capital de X", "qual o tamanho de X"
  /\bqual\s+(a|o|as|os)\s+(altura|populacao|habitantes|area|tamanho|capital|distancia|profundidade|comprimento|largura|peso|velocidade|temperatura\s+media)\b/i,
  // "quando (foi) X" sobre evento/entidade especifica (data factual).
  /\b(em\s+que\s+ano|que\s+ano|quando)\s+(foi|aconteceu|comecou|terminou|nasceu|morreu|surgiu|foi\s+(fundad|criad|inventad|descobert))\b/i,
  // "quantos anos tem/tinha X" (idade de pessoa/coisa especifica -> muda/factual)
  /\bquant[oa]s\s+anos\s+(tem|tinha|teria|faz)\b/i,
]

// ---------------------------------------------------------------------
// PADROES QUE CLARAMENTE NAO PEDEM PESQUISA (conversa / ajuda / Cogni)
// e que ja indicam o MODO PAPO (papo/opiniao/sentimento/brincadeira/sobre a Cogni)
// ---------------------------------------------------------------------
// Texto ja vem SEM acento e em minusculas.

// 1) Interjeicoes / saudacoes / fechamentos quando a fala e SO isso. -> MODO PAPO.
const NAO_PESQUISA_FRASE_TODA = [
  /^(oi+|ola+|e?\s*a[ii]+|opa+|hey+|hi+|hello+|alo+)[\s.,!?…]*$/i,
  /^(tchau+|falou+|ate\s+(mais|logo|ja)|bye+|adeus)[\s.,!?…]*$/i,
  /^(valeu+|obrigad[oa]+|brigad[oa]+|vlw+|de\s+nada|por\s+nada)[\s.,!?…]*$/i,
  /^(sim+|nao+|talvez|pode\s+ser|claro|com\s+certeza|aham+|uhum+|nops?|nem)[\s.,!?…]*$/i,
  /^(legal+|massa+|show+|top+|maneiro+|daora+|de\s+boa|tranquil[oa]|beleza+|blz+|bele+za)[\s.,!?…]*$/i,
  /^(ha+|kk+|rs+|huehue+|hehe+|haha+|kkk+|auhau+|sla+|sei\s+la)[\s.,!?…]*$/i,
  /^(nossa+|caramba+|eita+|ih+|uau+|caraca+|aff+|credo|meu\s+deus|ai\s+meu\s+deus)[\s.,!?…]*$/i,
  /^(tudo\s+(bem|certo|joia|tranquilo)|td\s+(bem|certo)|como\s+(vai|voce\s+esta|ce\s+ta))[\s.,!?…]*$/i,
]

// 2) Inicio de frase que denuncia papo/opiniao/sentimento/brincadeira — MODO PAPO.
//    NUNCA pesquisa, mesmo que a frase continue.
const NAO_PESQUISA_INICIO_PAPO = [
  // Falando da/com a propria Cogni (voce/vc/ce + verbo)
  /^(voce|vc|ce)\s+(e|eh|gosta|gostas|consegue|sabe|pode|acha|prefere|lembra|ta|esta|curte|tem|fica|sente|nasceu|mora|tinha|era)\b/i,
  /^(qual|quais|como)\s+(e\s+)?(seu|sua|seus|suas)\s+/i,           // "qual seu nome/cor favorita"
  /^(quem\s+e\s+voce|o\s+que\s+voce\s+(e|eh|faz|sabe|gosta|acha|sente))/i,
  /^(me\s+conta|conta\s+(uma|um|ai|pra\s+mim)|fala\s+(uma|de|sobre\s+voce))/i,
  // Pedidos de brincadeira / criatividade (gera, nao pesquisa)
  /^(me\s+)?(conta|fala|faz|cria|inventa|escreve|manda)\s+(uma|um|outra|outro)?\s*(piada|adivinha|charada|historia|estoria|poema|musica|trava[\s-]?lingua|curiosidade)/i,
  /^(vamos|bora|que\s+tal)\s+(brincar|jogar|conversar|cantar|desenhar)/i,
  // Opiniao / sentimento / preferencia (subjetivo, nao factual). "adoro/amo/gosto
  // de X" sem o "eu" na frente tambem conta (crianca fala "adoro jogar bola").
  /^(o\s+que\s+voce\s+acha|voce\s+acha\s+que|na\s+sua\s+opiniao|prefere\s+|gosta\s+mais)/i,
  /^(eu\s+)?(acho|gosto|amo|odeio|prefiro|adoro|curto|detesto)\s+(de\s+|muito\s+|mais\s+)?\w/i,
  /^(eu\s+(quero|preciso|to|tou|estou|tava|fiquei|sinto|senti|tirei|ganhei|joguei|fiz|vi|comi|fui|consegui|aprendi|gostei|amei|odiei)|to\s+|tou\s+|me\s+sinto)\b/i,
  /^(estou|tou|to)\s+(feliz|triste|cansad[oa]|com\s+(sono|fome|medo|raiva|preguica)|animad[oa]|nervos[oa])/i,
  // Respostas curtas do onboarding / sobre si mesmo (a crianca falando dela). Idade
  // tanto em digito ("8 anos") quanto por extenso ("oito anos") - o STT pode trazer
  // qualquer um, e idade nunca e pesquisa.
  /^(meu\s+nome\s+(e|eh)|eu\s+(me\s+chamo|tenho)\s|eu\s+sou\s+(o|a|d[oa])\s)/i,
  /\btenho\s+(\d{1,2}|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito)\s+an(o|os|inho|inhos)\b/i,
]

// 3) Inicio de frase de AJUDA ESCOLAR / CONCEITO (a Cogni ensina do proprio
//    conhecimento) — NUNCA pesquisa (conhecimento estavel) E indica MODO ESTUDO.
//    Estes sao os pedidos onde a tutora socratica entra.
const NAO_PESQUISA_INICIO_ESTUDO = [
  /^(me\s+(ajuda|explica|ensina)|pode\s+(me\s+)?(ajudar|explicar|ensinar)|(explica|ensina|me\s+ensina)\s+(sobre|a|o|os|as|como|quem|que|por|pra))/i,
  /^(vamos|bora|que\s+tal)\s+(estudar|praticar|aprender|resolver)/i,
  /^como\s+(faz|que\s+faz|resolve|funciona|se\s+escreve|escreve|calcula|conjuga|soletra)\b/i,
  /^(o\s+que\s+(e|eh|significa|quer\s+dizer)|qual\s+a\s+diferenca\s+entre|por\s+que\s+(o|a|os|as|que)?)\b/i,
  /^(quanto\s+(e|eh|da|sao)|me\s+ajuda\s+(com|na|no)|resolve|calcula)\s/i,        // continhas: "quanto e 7x8"
  /\b(licao\s+de\s+casa|dever\s+de\s+casa|exercicio|atividade\s+da\s+escola|prova|tarefa\s+da\s+escola|problema\s+de\s+(matematica|mate))\b/i,
]

// Heuristica: numero que parece ANO (1900–2099) so e sinal de atualidade se vier
// junto de contexto de tempo/evento ("em 2026", "foi lancado em 2025", "no ano que
// vem"). Sozinho ("tirei 2025 pontos") NAO e pesquisa. Esta funcao distingue.
const REGEX_ANO = /\b(19|20)\d{2}\b/
const REGEX_CONTEXTO_TEMPORAL = /\b(em|no\s+ano|desde|ate|que\s+vem|passad[oa]|atual|recente|lanc|estre|copa\s+de|olimpiada)\b/i

function anoComContextoDeAtualidade(textoNorm) {
  if (!REGEX_ANO.test(textoNorm)) return false
  if (!REGEX_CONTEXTO_TEMPORAL.test(textoNorm)) return false
  // So considera ATUAL se o ano for >= 2024 (perto/depois do corte de conhecimento).
  const m = textoNorm.match(/\b(20\d{2})\b/)
  if (!m) return false
  return parseInt(m[1], 10) >= 2024
}

// Triagem rapida: decide modo+pesquisa quando OBVIO. Retorna sempre o mesmo
// formato { decidiu, pesquisar, modo }. Quando `decidiu` e false, `modo` ainda
// traz um PALPITE (default papo) que o brain.js pode refinar com o classificador.
function triagemRapida(texto) {
  if (!texto || typeof texto !== 'string') {
    return { decidiu: true, pesquisar: false, modo: MODO_PAPO }
  }
  const original = texto.trim()
  if (original.length < 3) return { decidiu: true, pesquisar: false, modo: MODO_PAPO }

  const t = normalizarBusca(original)

  // 1) Conversa pura tem prioridade: saudacao/interjeicao OU inicio claro de
  //    papo/opiniao/sentimento/brincadeira -> NAO pesquisa, MODO PAPO.
  for (const padrao of NAO_PESQUISA_FRASE_TODA) {
    if (padrao.test(t)) return { decidiu: true, pesquisar: false, modo: MODO_PAPO }
  }
  for (const padrao of NAO_PESQUISA_INICIO_PAPO) {
    if (padrao.test(t)) return { decidiu: true, pesquisar: false, modo: MODO_PAPO }
  }

  // 2) Ajuda escolar / conceito estavel -> NAO pesquisa, MODO ESTUDO. Vem ANTES
  //    do gatilho de fato especifico de proposito: "o que e", "por que", "como
  //    funciona", continhas e licao sao conhecimento do modelo, nao busca.
  for (const padrao of NAO_PESQUISA_INICIO_ESTUDO) {
    if (padrao.test(t)) return { decidiu: true, pesquisar: false, modo: MODO_ESTUDO }
  }

  // 3) Sinal claro de ATUALIDADE -> pesquisar. Modo: tratamos como estudo-neutro;
  //    o gerador responde o fato (nao socratiza fato atual). Mantemos PAPO aqui
  //    para o tom ficar leve/direto ao dar a informacao.
  for (const padrao of PADROES_PESQUISA_OBVIA) {
    if (padrao.test(t)) return { decidiu: true, pesquisar: true, modo: MODO_PAPO }
  }
  if (anoComContextoDeAtualidade(t)) return { decidiu: true, pesquisar: true, modo: MODO_PAPO }

  // 4) Fato ESPECIFICO (valor/nome/data sobre entidade) que nao foi cortado como
  //    conceito acima -> pesquisar (vies a pesquisar: nao alucinar pra crianca).
  for (const padrao of PADROES_FATO_ESPECIFICO) {
    if (padrao.test(t)) return { decidiu: true, pesquisar: true, modo: MODO_PAPO }
  }

  // 5) Indefinido: o brain.js sobe para o classificador (modo+pesquisa). Palpite
  //    default = papo, sem pesquisa (defaults baratos/seguros). O classificador
  //    decide; na falha dele, este palpite prevalece.
  return { decidiu: false, pesquisar: false, modo: MODO_PAPO }
}

module.exports = { triagemRapida, MODO_ESTUDO, MODO_PAPO }
