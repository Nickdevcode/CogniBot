// Baixa a biblioteca do MediaPipe (detector de rosto) para client/vendor/mediapipe.
//
// Por que vendorizar em vez de usar CDN: o robo roda em rede local e o painel pode
// ser aberto sem internet (numa apresentacao, por exemplo). Servindo os arquivos do
// proprio Express, o rastreio de rosto funciona offline e nao depende de um CDN
// estar no ar na hora errada.
//
// Por que NAO versionar no Git: sao ~11MB de WASM compilado - peso demais para o
// repositorio, e nao e codigo nosso. Por isso client/vendor/ esta no .gitignore e
// este script existe: `npm run vendor` reconstroi a pasta em qualquer maquina.
//
// Uso: npm run vendor   (a partir de server/)

const fs = require('fs')
const path = require('path')

// Fixado de proposito: uma troca de versao do MediaPipe deve ser uma decisao
// consciente (a API do FaceDetector ja mudou entre releases), nunca algo que
// acontece sozinho porque alguem rodou o script num dia diferente.
const VERSAO = '0.10.35'
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSAO}`
const MODELO = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

const DESTINO = path.join(__dirname, '..', '..', 'client', 'vendor', 'mediapipe')

// So o build SIMD: todo navegador com suporte a webcam que nos interessa (Chrome,
// Edge, Firefox e Safari atuais) tem WASM SIMD ha anos, e o build nosimd sozinho
// dobraria o tamanho do download.
const ARQUIVOS = [
  { url: `${CDN}/vision_bundle.mjs`, destino: 'vision_bundle.mjs' },
  { url: `${CDN}/wasm/vision_wasm_internal.js`, destino: path.join('wasm', 'vision_wasm_internal.js') },
  { url: `${CDN}/wasm/vision_wasm_internal.wasm`, destino: path.join('wasm', 'vision_wasm_internal.wasm') },
  { url: MODELO, destino: 'blaze_face_short_range.tflite' },
]

async function baixar({ url, destino }) {
  const caminho = path.join(DESTINO, destino)
  fs.mkdirSync(path.dirname(caminho), { recursive: true })
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(caminho, buffer)
  const mb = (buffer.length / 1024 / 1024).toFixed(2)
  console.log(`  ok  ${destino.padEnd(40)} ${mb.padStart(6)} MB`)
}

async function main() {
  console.log(`Baixando MediaPipe tasks-vision ${VERSAO} para client/vendor/mediapipe...`)
  for (const arquivo of ARQUIVOS) {
    await baixar(arquivo)
  }
  console.log('Pronto. O rastreio de rosto ja funciona offline.')
}

main().catch((err) => {
  console.error(`Falhou: ${err.message}`)
  console.error('Sem esses arquivos o painel continua funcionando - so o rastreio de rosto fica desligado.')
  process.exit(1)
})
