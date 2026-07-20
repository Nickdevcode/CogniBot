const config = require('../../config')

// Helper CENTRAL para chamar o Chat Completions normalizando os parametros conforme
// a familia do modelo. Os modelos de RACIOCINIO (gpt-5.x, o1, o3, o4...) tem uma API
// de parametros diferente dos legados (gpt-4o-mini etc.):
//   - NAO aceitam `temperature` (so o default 1) nem `max_tokens`.
//   - usam `max_completion_tokens` e aceitam `reasoning_effort`.
// Em vez de espalhar esse `if` por todos os call sites (brain.js, memoria-ai.js,
// analisador-pedagogico.js, resumo-semanal.js, dica.js...), centralizamos aqui: os
// chamadores continuam passando { maxTokens, temperature } e este helper monta a
// chamada certa. Trocar CHAT_MODEL de volta pro legado volta a funcionar sozinho.

// Detecta a familia pelo id do modelo. Cobrimos os prefixos de raciocinio da OpenAI.
function ehModeloRaciocinio(model) {
  return /^(o1|o3|o4|gpt-5)/i.test(model || '')
}

// Dispara uma chat completion. opts aceita as chaves "semanticas" { model, messages,
// maxTokens, temperature, reasoningEffort } + qualquer chave nativa da API (stream,
// response_format, web_search_options...), que sao repassadas intactas.
//
// Sobre `maxTokens` no raciocinio: ele representa o tamanho da RESPOSTA desejada. Os
// reasoning tokens consomem do MESMO orcamento de `max_completion_tokens`, entao
// somamos CHAT_REASONING_RESERVA_TOKENS para o modelo ter espaco para pensar E
// responder (sem isso, um limite curto sairia vazio - so pensamento, sem resposta).
function criarChatCompletion(openai, opts = {}) {
  const { model, maxTokens, temperature, reasoningEffort, ...resto } = opts
  const params = { model, ...resto }

  if (ehModeloRaciocinio(model)) {
    if (maxTokens != null) {
      params.max_completion_tokens = maxTokens + config.CHAT_REASONING_RESERVA_TOKENS
    }
    const effort = reasoningEffort || config.CHAT_REASONING_EFFORT
    if (effort) params.reasoning_effort = effort
    // `temperature` deliberadamente omitido: nao suportado por modelos de raciocinio.
  } else {
    if (maxTokens != null) params.max_tokens = maxTokens
    if (temperature != null) params.temperature = temperature
  }

  return openai.chat.completions.create(params)
}

module.exports = { criarChatCompletion, ehModeloRaciocinio }
