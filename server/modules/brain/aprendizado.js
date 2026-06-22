const { log } = require('../logger')
const { nomeIdioma } = require('./idioma')

// NOTA DE CONCORRENCIA: as funcoes deste modulo MUTAM o objeto `usuario` mas NAO
// o salvam. Quem persiste e o chamador, dentro de uma transacao atomica
// `atualizarUsuario(id, fn)` (ver memoria.js). Antes cada funcao salvava sozinha,
// o que, combinado com a analise pedagogica e a memoria-IA rodando em paralelo,
// causava perda de escrita (lost-update). Agora a persistencia e unica e serial.

const NIVEIS_CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const MAX_PALAVRAS_POR_IDIOMA = 80
const JANELA_PRATICA_RECENTE_MS = 7 * 24 * 60 * 60 * 1000

function garantirEntradaIdioma(usuario, codigoIdioma) {
  if (!Array.isArray(usuario.idiomasEstudando)) usuario.idiomasEstudando = []
  let entrada = usuario.idiomasEstudando.find(e => e.idioma === codigoIdioma)
  if (!entrada) {
    entrada = {
      idioma: codigoIdioma,
      nivel: 'A1',
      palavrasVistas: [],
      ultimaPratica: null,
      vezesPraticado: 0,
      criadoEm: new Date().toISOString(),
    }
    usuario.idiomasEstudando.push(entrada)
  }
  return entrada
}

function registrarPratica(usuario, codigoIdioma) {
  if (!usuario || !codigoIdioma) return null
  if (codigoIdioma === usuario.idiomaNativo) return null

  const entrada = garantirEntradaIdioma(usuario, codigoIdioma)
  entrada.ultimaPratica = new Date().toISOString()
  entrada.vezesPraticado = (entrada.vezesPraticado || 0) + 1
  return entrada
}

function adicionarPalavras(usuario, codigoIdioma, palavras = []) {
  if (!usuario || !codigoIdioma || !palavras.length) return null

  const entrada = garantirEntradaIdioma(usuario, codigoIdioma)
  const existentes = new Set(entrada.palavrasVistas.map(p => p.termo.toLowerCase()))
  let adicionadas = 0

  for (const item of palavras) {
    const termo = (typeof item === 'string' ? item : item?.termo || '').trim()
    if (!termo || termo.length > 60) continue
    if (existentes.has(termo.toLowerCase())) continue
    if (entrada.palavrasVistas.length >= MAX_PALAVRAS_POR_IDIOMA) {
      entrada.palavrasVistas.shift()
    }
    entrada.palavrasVistas.push({
      termo,
      traducao: typeof item === 'object' ? (item.traducao || null) : null,
      visto: new Date().toISOString(),
    })
    adicionadas++
  }

  if (adicionadas > 0) {
    log('Aprendizado', `+${adicionadas} palavra(s) em ${nomeIdioma(codigoIdioma)} pra ${usuario.nome}`)
  }
  return entrada
}

function atualizarNivel(usuario, codigoIdioma, novoNivel) {
  if (!usuario || !codigoIdioma) return null
  if (!NIVEIS_CEFR.includes(novoNivel)) return null

  const entrada = garantirEntradaIdioma(usuario, codigoIdioma)
  if (entrada.nivel === novoNivel) return entrada

  entrada.nivel = novoNivel
  log('Aprendizado', `${usuario.nome} agora ${novoNivel} em ${nomeIdioma(codigoIdioma)}`)
  return entrada
}

function obterEntrada(usuario, codigoIdioma) {
  if (!usuario || !codigoIdioma) return null
  if (!Array.isArray(usuario.idiomasEstudando)) return null
  return usuario.idiomasEstudando.find(e => e.idioma === codigoIdioma) || null
}

function estaPraticandoRecentemente(entrada) {
  if (!entrada?.ultimaPratica) return false
  const dt = new Date(entrada.ultimaPratica).getTime()
  return Date.now() - dt < JANELA_PRATICA_RECENTE_MS
}

function descreverProgresso(usuario) {
  if (!usuario || !Array.isArray(usuario.idiomasEstudando) || usuario.idiomasEstudando.length === 0) {
    return null
  }
  const linhas = []
  for (const e of usuario.idiomasEstudando) {
    const nome = nomeIdioma(e.idioma)
    const palavras = (e.palavrasVistas || []).length
    const recente = estaPraticandoRecentemente(e) ? ' (ativo)' : ''
    linhas.push(`${nome} ${e.nivel}, ${palavras} palavras vistas${recente}`)
  }
  return linhas.join('; ')
}

function palavrasParaRevisao(usuario, codigoIdioma, quantidade = 3) {
  const entrada = obterEntrada(usuario, codigoIdioma)
  if (!entrada || !Array.isArray(entrada.palavrasVistas) || entrada.palavrasVistas.length === 0) {
    return []
  }
  const candidatas = [...entrada.palavrasVistas]
    .sort((a, b) => new Date(a.visto) - new Date(b.visto))
    .slice(0, Math.min(quantidade, entrada.palavrasVistas.length))
  return candidatas
}

module.exports = {
  garantirEntradaIdioma,
  registrarPratica,
  adicionarPalavras,
  atualizarNivel,
  obterEntrada,
  descreverProgresso,
  palavrasParaRevisao,
  estaPraticandoRecentemente,
  NIVEIS_CEFR,
}
