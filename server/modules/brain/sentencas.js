const TERMINADORES = /[.!?…\n]/
const TERMINADORES_FORTES = /[.!?…]/
const TERMINADORES_SECUNDARIOS = /[,;:—]/

function criarAcumuladorSentencas({ minChars = 40, minCharsPrimeira = 18, onSentenca } = {}) {
  let buffer = ''
  let primeiraEmitida = false

  function emitir(texto) {
    const limpo = texto.trim()
    if (!limpo) return 0
    if (onSentenca) onSentenca(limpo)
    primeiraEmitida = true
    return 1
  }

  function tamanhoMinimoAtual() {
    return primeiraEmitida ? minChars : minCharsPrimeira
  }

  function adicionar(delta) {
    if (!delta) return 0
    buffer += delta
    let emitidos = 0

    while (true) {
      let corte = -1
      let cortePorTerminadorFraco = false

      for (let i = 0; i < buffer.length; i++) {
        if (TERMINADORES_FORTES.test(buffer[i])) {
          let fim = i
          while (fim + 1 < buffer.length && TERMINADORES.test(buffer[fim + 1])) {
            fim++
          }
          corte = fim
          break
        }
      }

      if (corte === -1 && !primeiraEmitida && buffer.length > minCharsPrimeira * 2) {
        for (let i = minCharsPrimeira; i < buffer.length; i++) {
          if (TERMINADORES_SECUNDARIOS.test(buffer[i])) {
            corte = i
            cortePorTerminadorFraco = true
            break
          }
        }
      }

      if (corte === -1) break

      const candidato = buffer.slice(0, corte + 1)
      const minAtual = tamanhoMinimoAtual()

      if (candidato.trim().length < minAtual && corte + 1 < buffer.length && !cortePorTerminadorFraco) {
        const proximoCorte = procurarProximoTerminador(buffer, corte + 1)
        if (proximoCorte === -1) break
        emitidos += emitir(buffer.slice(0, proximoCorte + 1))
        buffer = buffer.slice(proximoCorte + 1)
      } else {
        emitidos += emitir(candidato)
        buffer = buffer.slice(corte + 1)
      }
    }

    return emitidos
  }

  function procurarProximoTerminador(texto, inicio) {
    for (let i = inicio; i < texto.length; i++) {
      if (TERMINADORES.test(texto[i])) {
        let fim = i
        while (fim + 1 < texto.length && TERMINADORES.test(texto[fim + 1])) fim++
        return fim
      }
    }
    return -1
  }

  function flush() {
    const restante = buffer
    buffer = ''
    return emitir(restante)
  }

  return { adicionar, flush }
}

module.exports = { criarAcumuladorSentencas }
