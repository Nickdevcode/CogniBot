// Store do ULTIMO FRAME DA WEBCAM DO PC (a webcam da interface localhost), para a
// visao da Cogni funcionar tambem quando a crianca fala pelo ROBO FISICO.
//
// Por que existe (e por que e separado da ESP-CAM em esp.js): sao DUAS fontes de
// imagem distintas. A ESP-CAM (esp.js, ultimoFrame) e a camera do robo fisico, que
// chega por WebSocket — fase futura. Esta aqui e a webcam do PC, que a INTERFACE
// captura no browser e envia por HTTP (POST /api/esp/webcam/frame). Mantemos os
// dois caminhos isolados, cada um com seu TTL.
//
// Fluxo: quando o robo detecta voz, o servidor emite o estado 'ouvindo' (SSE de
// atividade). A interface, se a camera estiver ligada, captura UM frame e o envia.
// Como a crianca fala por alguns segundos, o frame chega antes do STT/IA rodarem;
// o esp-pipeline.js le este store no momento de processar a fala.

const ultimoFrame = { base64: null, recebidoEm: 0 }

// TTL maior que os 5s da ESP-CAM de proposito: o frame e capturado no INICIO da
// fala (no 'ouvindo'), mas a IA so roda depois do STT — alguns segundos depois.
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
