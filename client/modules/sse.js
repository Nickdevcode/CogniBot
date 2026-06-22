export async function lerStreamSSE(resposta, handlers) {
  const reader = resposta.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const blocos = buffer.split(/\r?\n\r?\n/)
    buffer = blocos.pop() || ''

    for (const bloco of blocos) {
      if (!bloco.trim()) continue

      let evento = null
      let data = null

      for (const linha of bloco.split(/\r?\n/)) {
        if (linha.startsWith('event: ')) evento = linha.slice(7).trim()
        else if (linha.startsWith('data: ')) data = linha.slice(6)
      }

      if (!evento || data === null) continue

      let dados
      try {
        dados = JSON.parse(data)
      } catch {
        continue
      }

      const handler = handlers[evento]
      if (handler) {
        const continuar = await handler(dados)
        if (continuar === false) return
      }
    }
  }
}
