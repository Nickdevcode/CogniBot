// Store do ULTIMO FRAME DA WEBCAM DO PC (a webcam da interface localhost), para a
// visao da Cogni funcionar tambem quando a crianca fala pelo ROBO FISICO.
//
// Esta e a UNICA fonte de imagem do projeto: a webcam do dispositivo onde o
// dashboard esta aberto, capturada no browser e enviada por HTTP (POST
// /api/esp/webcam/frame). O robo nao tem camera propria.
//
// Fluxo: quando o robo detecta voz, o servidor emite o estado 'ouvindo' (SSE de
// atividade). A interface, se a camera estiver ligada, captura UM frame e o envia.
// Como a crianca fala por alguns segundos, o frame chega antes do STT/IA rodarem;
// o esp-pipeline.js le este store no momento de processar a fala.

const ultimoFrame = { base64: null, recebidoEm: 0 }

// TTL generoso de proposito: o frame e capturado no INICIO da fala (no 'ouvindo'),
// mas a IA so roda depois do STT — alguns segundos depois.
// 10s cobre a fala + o pipeline com folga, sem reusar frame de uma fala anterior.
const TTL_MS = 10000

// Grava o frame (base64 JPEG, ja limpo/validado pela rota). Sobrescreve o anterior.
function definirFrameWebcam(base64) {
  ultimoFrame.base64 = base64
  ultimoFrame.recebidoEm = Date.now()
}

// Retorna o frame se ainda estiver dentro do TTL; senao null (camera desligada ou
// frame velho). Guardamos base64 direto — e o formato que o brain.js consome.
function obterFrameWebcamBase64() {
  if (!ultimoFrame.base64) return null
  if (Date.now() - ultimoFrame.recebidoEm > TTL_MS) return null
  return ultimoFrame.base64
}

module.exports = { definirFrameWebcam, obterFrameWebcamBase64 }
