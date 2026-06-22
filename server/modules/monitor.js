const { log } = require('./logger')

// "Grampo" de monitoramento para desenvolvimento: permite ouvir no navegador
// (localhost/monitor) o mesmo audio que e enviado ao robo fisico. Util quando o
// alto-falante (MAX98357A) ainda nao esta montado, ou para depurar exatamente o
// que a Cogni respondeu no fluxo de voz do robo.
//
// O audio do robo e PCM raw (24kHz, 16-bit mono); a pagina /monitor o envelopa
// num cabecalho WAV para o navegador tocar (ver pcmParaWavBlob em monitor.js do
// cliente). O formato/sampleRate vao nos metadados de cada evento.
//
// Nao interfere no fluxo do robo: e apenas um canal SSE paralelo. Os ouvintes
// recebem o audio em base64 junto com o texto correspondente.

const ouvintes = new Set()

function registrarOuvinte(callback) {
  ouvintes.add(callback)
  return () => ouvintes.delete(callback)
}

function totalOuvintes() {
  return ouvintes.size
}

// Transmite um audio (Buffer; PCM no fluxo do robo, MP3 nos caminhos legados) +
// metadados para todos os ouvintes do monitor. O formato vai em metadata.formato.
function transmitirAudio(audioBuffer, metadata = {}) {
  if (ouvintes.size === 0) return
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return

  const evento = {
    audioBase64: audioBuffer.toString('base64'),
    texto: typeof metadata.texto === 'string' ? metadata.texto : '',
    origem: metadata.origem || 'robo',
    transcricao: typeof metadata.transcricao === 'string' ? metadata.transcricao : '',
    tamanho: audioBuffer.length,
    em: Date.now(),
  }

  for (const ouvinte of ouvintes) {
    try {
      ouvinte(evento)
    } catch (err) {
      log('Aviso', `Falha ao notificar ouvinte do monitor: ${err.message}`)
    }
  }
}

module.exports = {
  registrarOuvinte,
  totalOuvintes,
  transmitirAudio,
}
