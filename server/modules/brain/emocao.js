// =====================================================================
// Classificacao de EMOCAO por IA (a segunda camada, atras do regex)
// =====================================================================
// As reacoes dos olhos do robo saem primeiro do esp-reacoes.js, que e regex puro:
// instantaneo, de graca e disparado ANTES da fala comecar. Ele acerta o caso obvio
// ("kkkk", "te amo", "nao entendi") e e o caminho que queremos na maioria das vezes.
//
// So que regex nao entende contexto. Ele nao pega:
//   - ironia e entusiasmo escritos sem as palavras-chave ("agora eu SEI fazer isso!")
//   - a crianca frustrada de um jeito que a lista nao previu ("ja tentei tres vezes")
//   - qualquer coisa em INGLES, e o robo conversa em ingles
//   - orgulho, alivio, curiosidade - emocoes sem gatilho lexical fixo
//
// Entao esta camada roda SO QUANDO O REGEX NAO ACHOU NADA. O resultado chega alguns
// segundos depois, com o robo ainda falando - o que na pratica fica natural: e como
// alguem cuja expressao muda no meio da propria frase, ao se dar conta do que ouviu.
//
// CUSTO: modelo auxiliar (o mais barato), prompt minusculo e teto de tokens curto.
// E ainda so entra em turnos com conteudo de verdade - ver COMPRIMENTO_MINIMO.

const { log } = require('../logger')
const { criarChatCompletion } = require('./openai')

// As emocoes precisam bater EXATAMENTE com o enum Reacao do firmware
// (esp32-controle.ino) e com o mapeamento de string em onWsEvent. Qualquer nome fora
// desta lista e descartado - o firmware ignoraria em silencio, o que e pior que negar
// aqui, porque some sem deixar rastro no log.
const EMOCOES_VALIDAS = ['amor', 'riso', 'celebra', 'surpresa', 'confuso', 'triste', 'suor', 'ideia', 'piscadela']

// Abaixo disto nao vale a chamada: "sim", "ta bom", "oi" nao carregam emocao que
// vale animar, e sao justamente os turnos mais frequentes.
const COMPRIMENTO_MINIMO = 25

const PROMPT = `Voce rotula a EMOCAO que um robo de companhia infantil deve demonstrar no rosto ao final deste turno de conversa.

O robo tem olhos animados numa telinha. A emocao escolhida vira uma animacao curta (2 segundos) sobre o rosto dele.

Escolha UMA opcao desta lista, ou "nenhuma":
- amor: a crianca demonstrou carinho, afeto ou apego pelo robo
- riso: algo foi engracado, houve piada ou brincadeira
- celebra: a crianca acertou, conseguiu, superou uma dificuldade ou merece festa
- surpresa: algo espantoso, inesperado ou impressionante apareceu
- confuso: a crianca esta perdida, frustrada, travada ou nao entendeu
- triste: despedida, desanimo, algo doloroso ou uma decepcao
- suor: houve um errinho, vergonha ou saia-justa leve
- ideia: a crianca aprendeu algo novo, teve um insight, "caiu a ficha"
- piscadela: cumplicidade, combinado, segredinho compartilhado
- nenhuma: o turno foi neutro, informativo ou sem carga emocional

REGRAS IMPORTANTES:
- Na duvida, responda "nenhuma". Um robo que reage a tudo cansa mais rapido do que um que reage pouco - e a reacao rara e a que emociona.
- Julgue a emocao do MOMENTO da conversa, nao o tema. Falar sobre a morte de um dinossauro nao e "triste".
- Vale para qualquer idioma.

Responda APENAS com JSON: {"emocao": "..."}`

/**
 * Rotula a emocao de um turno usando a IA. Pensado para rodar SO quando a heuristica
 * de palavras-chave nao achou nada.
 *
 * Nunca lanca: qualquer falha (rede, quota, JSON invalido) vira null e o robo
 * simplesmente nao reage - o rosto de estado continua valendo e a conversa segue.
 *
 * @param {object} openai cliente da OpenAI ja construido
 * @param {string} modelo modelo auxiliar (barato) a usar
 * @param {string} textoCrianca fala transcrita da crianca
 * @param {string} textoResposta resposta que a Cogni vai falar
 * @returns {Promise<string|null>} emocao canonica ou null
 */
async function detectarEmocaoIA(openai, modelo, textoCrianca, textoResposta) {
  const crianca = (textoCrianca || '').trim()
  const resposta = (textoResposta || '').trim()
  if (crianca.length + resposta.length < COMPRIMENTO_MINIMO) return null

  let bruto
  try {
    const r = await criarChatCompletion(openai, {
      model: modelo,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `CRIANCA: "${crianca.slice(0, 500)}"\n\nCOGNI: "${resposta.slice(0, 500)}"` },
      ],
      maxTokens: 20,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    bruto = (r.choices[0]?.message?.content || '').trim()
  } catch (err) {
    log('Aviso', `Classificacao de emocao falhou: ${err.message}`)
    return null
  }

  let dados
  try {
    dados = JSON.parse(bruto)
  } catch {
    return null
  }

  const emocao = String(dados?.emocao || '').toLowerCase().trim()
  if (!EMOCOES_VALIDAS.includes(emocao)) return null
  return emocao
}

module.exports = { detectarEmocaoIA, EMOCOES_VALIDAS }
