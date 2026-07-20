// Heuristica de REACOES dos olhos do robo pelo CONTEUDO da conversa. Diferente do
// estado CONTINUO (ouvindo/pensando/falando), uma reacao e um evento PONTUAL que a
// tela OLED anima por alguns segundos: elogio da crianca -> coracoes; piada -> riso;
// "nao entendi" -> confuso; etc. Fonte da emocao = palavras-chave (custo e latencia
// ZERO), aplicada tanto na fala da crianca quanto na resposta da Cogni.
//
// IMPORTANTE (acento): o texto vem do STT (Whisper) e da IA, SEMPRE acentuado. Regex
// ASCII nao casa "voce"/"nao" com acento - por isso NORMALIZAMOS com NFD (remove os
// diacriticos) antes de testar. Mesma licao da triagem web (ver memoria do projeto).

// Remove acentos e baixa a caixa para o casamento por palavra-chave ser robusto.
function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // remove os diacriticos combinantes (acentos)
}

// Regras em ORDEM DE PRIORIDADE (a primeira que casar vence). `alvo` define onde
// procurar: 'crianca' (fala da crianca), 'cogni' (resposta da IA) ou 'ambos'. As
// emocoes espelham o enum Reacao do firmware (esp32-controle.ino).
const REGRAS = [
  // Crianca demonstrando carinho pela Cogni -> coracoes nos olhos.
  { emocao: 'amor', alvo: 'crianca',
    re: /\b(te amo|te adoro|amo voce|adoro voce|gosto (muito )?de voce)\b|voce e (muito |super )?(legal|incrivel|demais|otim[ao]|lind[ao]|maravilhos[ao]|fof[ao]|especial|querid[ao]|a melhor|o melhor)/ },
  // Riso explicito (de qualquer lado) -> olhos rindo.
  { emocao: 'riso', alvo: 'ambos',
    re: /(k{3,})|((ha){2,})|((he){2,})|((rs){2,})|\b(que engracad[ao]|muito engracad[ao]|hilario|que comico)\b/ },
  // Cogni elogiando/celebrando a crianca -> comemoracao.
  { emocao: 'celebra', alvo: 'cogni',
    re: /\b(parabens|mandou (muito )?bem|arrasou|isso ai|muito bem|acertou|que orgulho|show de bola|perfeito|excelente|mitou|voce conseguiu|boa!)\b/ },
  // Surpresa/espanto (de qualquer lado) -> olhos arregalados.
  { emocao: 'surpresa', alvo: 'ambos',
    re: /\b(uau|nossa|caramba|serio|jura|que incrivel|impressionante|inacreditavel)\b/ },
  // Crianca confusa/em duvida -> olhos confusos.
  { emocao: 'confuso', alvo: 'crianca',
    re: /\b(nao entendi|nao intendi|nao sei|que dificil|to confus[ao]|to perdid[ao]|como assim|nao consigo|to boiando|nao faz sentido)\b/ },
  // Despedida/tristeza (de qualquer lado) -> olhos tristes/cansados.
  { emocao: 'triste', alvo: 'ambos',
    re: /\b(tchau|ate amanha|ate mais|boa noite|vou dormir|tenho que ir|to indo|to triste|que pena|fiquei triste)\b/ },
  // Errinho/vergonha (de qualquer lado) -> gota de suor.
  { emocao: 'suor', alvo: 'ambos',
    re: /\b(ops|foi mal|desculp[ae]|errei|me enganei|que vergonha|foi sem querer)\b/ },
]

// Decide UMA reacao (ou null) a partir da fala da crianca e da resposta da Cogni.
// Retorna a emocao da primeira regra que casar, na ordem de prioridade acima.
function detectarReacao(textoResposta, textoCrianca) {
  const cogni = normalizar(textoResposta)
  const crianca = normalizar(textoCrianca)
  if (!cogni && !crianca) return null

  for (const regra of REGRAS) {
    const alvoTexto =
      regra.alvo === 'crianca' ? crianca :
      regra.alvo === 'cogni'   ? cogni :
      `${crianca}\n${cogni}`
    if (alvoTexto && regra.re.test(alvoTexto)) return regra.emocao
  }
  return null
}

module.exports = { detectarReacao }
