const config = require('../config')

function processarFrame(base64Imagem) {
  if (!base64Imagem || typeof base64Imagem !== 'string') return null

  let limpo = base64Imagem
  if (limpo.startsWith('data:')) {
    limpo = limpo.split(',')[1] || ''
  }

  return limpo || null
}

function validarImagem(base64Imagem) {
  if (!base64Imagem || typeof base64Imagem !== 'string') return false

  const limpo = base64Imagem.startsWith('data:')
    ? (base64Imagem.split(',')[1] || '')
    : base64Imagem

  if (!limpo) return false

  try {
    const tamanho = Buffer.byteLength(limpo, 'base64')
    const limite = (config.MAX_IMAGE_SIZE_MB || 8) * 1024 * 1024
    return tamanho > 100 && tamanho < limite
  } catch {
    return false
  }
}

module.exports = { processarFrame, validarImagem }
