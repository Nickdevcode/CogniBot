/**
 * pareamento.js — Vínculo pai↔filho por CÓDIGO FIXO (Companion, Fase 4).
 *
 * Modelo (decisão do Nicolas): o código mora no PRÓPRIO perfil
 * (`criancas.codigo_pareamento`), gerado UMA vez quando o perfil nasce e
 * PERMANENTE — não rotaciona, não expira (segurança suficiente pra TCC: quem não
 * tem o código não pareia). Não há tabela `pareamentos`.
 *
 * Fluxo:
 *   1. O perfil nasce no robô já com um código (ver memoria.js -> criarUsuario,
 *      que usa o gerarCodigo() daqui). O código aparece no painel localhost e a
 *      Cogni pode falá-lo por voz.
 *   2. O pai entra no Companion (1ª vez = sem criança vinculada), digita o código,
 *      e o site chama o servidor -> vincularPorCodigo() seta
 *      `criancas.responsavel_id = <id do pai>`. Pareado pra sempre.
 *
 * Segurança: vincularPorCodigo RECUSA se a criança já tem OUTRO responsável
 * (idempotente pro mesmo pai). Roda com a service_role (só no backend).
 */

const crypto = require('crypto')
const config = require('../config')
const { getClient } = require('./supabase')
const { log } = require('./logger')

// Alfabeto SEM caracteres ambíguos (0/O, 1/I) — o código é falado por voz E lido
// na tela; evitar confusão na hora de ditar/digitar. 6 chars.
const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const TAMANHO_CODIGO = 6

// Pedido por VOZ pra parear com os pais. Texto vem do Whisper (acentuado); o teste
// normaliza acento antes (ver pedidoDePareamento). Cobre as formas naturais que uma
// criança/responsável usaria. Exige a noção de "parear/conectar/vincular" perto de
// "pais/responsavel/familia/companion/app" pra não disparar em papo qualquer.
const PADROES_PAREAMENTO = [
  // verbo de "conectar/parear" (infinitivo OU 1a pessoa: conecto/pareio/vinculo/ligo)
  // perto de "pais/mae/companion/app...". O [^.?!]{0,30} limita a 30 chars pra nao
  // casar frases longas onde os termos so coincidem por acaso.
  /\b(parear|pareio|pareia|parea|conectar|conecto|conecta|vincular|vinculo|sincronizar|sincronizo)\b[^.?!]{0,30}\b(pais|mae|pai|responsavel|familia|companion|app|aplicativo|conta)\b/i,
  /\b(codigo)\b[^.?!]{0,30}\b(pareamento|parear|conectar|pais|companion|app)\b/i,
  /\b(quero|queria|como\s+(eu\s+)?(faco\s+pra|posso))\b[^.?!]{0,30}\b(parear|conectar|vincular)\b/i,
]

// Remove acentos pra casar a regex ASCII (mesma prática do projeto pra texto de STT).
function semAcento(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * Detecta se a fala é um pedido de pareamento. Normaliza acento antes de testar.
 * @param {string} texto
 * @returns {boolean}
 */
function pedidoDePareamento(texto) {
  if (!texto) return false
  const t = semAcento(texto)
  return PADROES_PAREAMENTO.some(re => re.test(t))
}

/**
 * Monta a resposta FALADA com o código, ditado caractere a caractere (ex: "K, 7,
 * H, 2, Q, M") pra o TTS pronunciar claro e o pai conseguir anotar. Tom da Cogni.
 * @param {string} codigo
 * @returns {string}
 */
function respostaCodigoFalado(codigo) {
  const ditado = String(codigo || '').split('').join(', ')
  return `Pra te conectar com seus pais no aplicativo, o código é: ${ditado}. É só eles digitarem isso lá no Cogni Companion. Quer que eu repita?`
}

/**
 * Gera um código de pareamento aleatório (6 chars, sem ambíguos). Função PURA, sem
 * I/O — a unicidade global é garantida pela constraint UNIQUE da coluna no banco
 * (e, na prática, pelo espaço de 32^6 ≈ 1 bilhão de combinações). Quem cria o
 * perfil em lote pode chamar e, em caso raríssimo de colisão no insert, regerar.
 * @returns {string} ex: "K7H2QM"
 */
function gerarCodigo() {
  const bytes = crypto.randomBytes(TAMANHO_CODIGO)
  let codigo = ''
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    codigo += ALFABETO[bytes[i] % ALFABETO.length]
  }
  return codigo
}

/**
 * Normaliza um código digitado pelo pai: tira espaços/hífens, caixa alta. Aceita
 * "k7h2-qm", "K7H2 QM" etc. Não valida o conteúdo (isso é no banco).
 * @param {string} codigo
 * @returns {string}
 */
function normalizarCodigo(codigo) {
  return String(codigo || '').replace(/[\s-]/g, '').toUpperCase()
}

/**
 * Vincula uma criança a um responsável a partir do código. Usado pelo endpoint que
 * o site chama no onboarding. Regras:
 *   - código inexistente -> { ok:false, motivo:'codigo_invalido' }
 *   - criança já é do MESMO responsável -> { ok:true, jaPareado:true } (idempotente)
 *   - criança já é de OUTRO responsável -> { ok:false, motivo:'ja_pareada' }
 *   - caso normal -> seta responsavel_id e { ok:true }
 *
 * @param {string} codigo         código digitado pelo pai
 * @param {string} responsavelId  auth.uid() do pai (uuid)
 * @returns {Promise<{ok:boolean, motivo?:string, jaPareado?:boolean, criancaId?:string, nome?:string}>}
 */
async function vincularPorCodigo(codigo, responsavelId) {
  if (!config.SUPABASE_HABILITADO) return { ok: false, motivo: 'supabase_desligado' }
  const sb = getClient()
  if (!sb) return { ok: false, motivo: 'supabase_desligado' }
  if (!responsavelId) return { ok: false, motivo: 'responsavel_invalido' }

  const cod = normalizarCodigo(codigo)
  if (cod.length !== TAMANHO_CODIGO) return { ok: false, motivo: 'codigo_invalido' }

  // Acha a criança dona do código.
  const { data: crianca, error: errBusca } = await sb
    .from('criancas')
    .select('id, nome, responsavel_id')
    .eq('codigo_pareamento', cod)
    .maybeSingle()

  if (errBusca) {
    log('Erro', `Busca por codigo de pareamento falhou: ${errBusca.message}`)
    return { ok: false, motivo: 'erro_interno' }
  }
  if (!crianca) return { ok: false, motivo: 'codigo_invalido' }

  // Já pareada?
  if (crianca.responsavel_id) {
    if (crianca.responsavel_id === responsavelId) {
      return { ok: true, jaPareado: true, criancaId: crianca.id, nome: crianca.nome }
    }
    return { ok: false, motivo: 'ja_pareada' }
  }

  // Vincula.
  const { error: errUp } = await sb
    .from('criancas')
    .update({ responsavel_id: responsavelId })
    .eq('id', crianca.id)

  if (errUp) {
    log('Erro', `Vinculo de pareamento falhou (crianca ${crianca.id}): ${errUp.message}`)
    return { ok: false, motivo: 'erro_interno' }
  }

  log('Pareamento', `Crianca ${crianca.id} ("${crianca.nome}") vinculada ao responsavel ${responsavelId}.`)
  return { ok: true, criancaId: crianca.id, nome: crianca.nome }
}

/**
 * Desfaz o vínculo de uma criança (zera o responsavel_id). Usado pelo site quando
 * o pai escolhe desvincular (ex: parear outro filho). O `codigo_pareamento` NÃO
 * muda — continua o mesmo, então dá pra reparear depois.
 *
 * Segurança: só desvincula se a criança estiver vinculada AO PRÓPRIO responsável
 * que pediu (um pai não pode desvincular o filho de outro). Idempotente: se já
 * não estava vinculada a ele, retorna ok sem erro.
 *
 * @param {string} criancaId
 * @param {string} responsavelId  auth.uid() do pai que pede o despareamento
 * @returns {Promise<{ok:boolean, motivo?:string, jaDesvinculado?:boolean}>}
 */
async function desvincularPorCrianca(criancaId, responsavelId) {
  if (!config.SUPABASE_HABILITADO) return { ok: false, motivo: 'supabase_desligado' }
  const sb = getClient()
  if (!sb) return { ok: false, motivo: 'supabase_desligado' }
  if (!criancaId || !responsavelId) return { ok: false, motivo: 'dados_invalidos' }

  const { data: crianca, error: errBusca } = await sb
    .from('criancas')
    .select('id, nome, responsavel_id')
    .eq('id', criancaId)
    .maybeSingle()

  if (errBusca) {
    log('Erro', `Busca pra desvincular falhou: ${errBusca.message}`)
    return { ok: false, motivo: 'erro_interno' }
  }
  if (!crianca) return { ok: false, motivo: 'crianca_invalida' }

  // Já não está vinculada a ele (ou a ninguém): nada a fazer (idempotente).
  if (crianca.responsavel_id !== responsavelId) {
    return { ok: true, jaDesvinculado: true }
  }

  const { error: errUp } = await sb
    .from('criancas')
    .update({ responsavel_id: null })
    .eq('id', crianca.id)

  if (errUp) {
    log('Erro', `Despareamento falhou (crianca ${crianca.id}): ${errUp.message}`)
    return { ok: false, motivo: 'erro_interno' }
  }

  log('Pareamento', `Crianca ${crianca.id} ("${crianca.nome}") DESvinculada do responsavel ${responsavelId}.`)
  return { ok: true }
}

module.exports = {
  gerarCodigo,
  normalizarCodigo,
  vincularPorCodigo,
  desvincularPorCrianca,
  pedidoDePareamento,
  respostaCodigoFalado,
  TAMANHO_CODIGO,
}
