// LEITURA DE EMOCAO E GESTO: transforma a saida crua do MediaPipe na PERCEPCAO do que
// a crianca esta fazendo (sorrindo, brava, dando joinha...). Fica separado do rosto.js
// de proposito: aqui e logica PURA, sem MediaPipe nem rede - da pra ler, ajustar limiar
// e testar isoladamente. O rosto.js so alimenta os numeros e emite o que sair daqui.
//
// PRINCIPIO: o cliente so PERCEBE ("crianca-feliz"); quem decide a reacao do robo e a
// "alma" da resposta (espelhar, animar) e o SERVIDOR (modules/esp-visao.js). Assim a
// mesma percepcao pode virar comportamentos diferentes sem regravar o firmware.

// ---------------------------------------------------------------------
// Emocao facial a partir dos 52 blendshapes ARKit do FaceLandmarker
// ---------------------------------------------------------------------
// Cada blendshape e um score 0..1 (0 = ausente, 1 = no maximo). Buscamos por NOME
// (categoryName), nunca por indice: a ordem pode mudar entre versoes do modelo, o nome
// nao. Um nome que nao exista simplesmente vale 0 - a classificacao degrada, nao quebra.
//
// Limiares deliberadamente GENEROSOS: e uma crianca em frente a uma webcam qualquer, com
// luz ruim e cara exagerada. Preferimos captar uma emocao clara a exigir a expressao
// perfeita de um ator. O ajuste fino mora aqui em cima, num lugar so.
const LIMIAR = {
  sorriso: 0.42,        // mouthSmile: a partir daqui e um sorriso de verdade
  sorrisoForte: 0.72,   // sorriso largo, de rir: vira 'muito-feliz' (o robo ri mais forte)
  bocaAberta: 0.40,     // jawOpen: boca aberta de "uau"
  bocaMuitoAberta: 0.62,// jawOpen de susto/choque: vira 'muito-surpresa'
  olhoArregalado: 0.40, // eyeWide
  sobrancelhaCima: 0.28,// browInnerUp / browOuterUp: erguida (surpresa/preocupacao)
  bocaBaixo: 0.32,      // mouthFrown: cantos da boca caidos (tristeza)
  franzido: 0.40,       // browDown: sobrancelha franzida (bravo/concentrado)
}

// Media de um par esquerdo/direito (a maioria dos blendshapes vem em par). Ausente = 0.
function par(scores, a, b) {
  return ((scores.get(a) || 0) + (scores.get(b) || 0)) / 2
}

/**
 * Classifica a emocao facial a partir das categorias de blendshape do FaceLandmarker.
 * @param {Array<{categoryName:string, score:number}>} categorias faceBlendshapes[0].categories
 * Emocoes intensas viram uma percepcao "muito-" (o servidor as mapeia numa reacao mais
 * forte) - um sorriso largo faz o robo rir mais que um sorriso de canto.
 * @returns {'crianca-feliz'|'crianca-muito-feliz'|'crianca-surpresa'|'crianca-muito-surpresa'|'crianca-triste'|'crianca-brava'|null}
 */
export function classificarEmocaoFacial(categorias) {
  if (!Array.isArray(categorias) || categorias.length === 0) return null

  // Indexa por nome uma vez para o resto ser lookup O(1) e legivel.
  const s = new Map()
  for (const c of categorias) s.set(c.categoryName, c.score)

  const sorriso = par(s, 'mouthSmileLeft', 'mouthSmileRight')
  const bocaAberta = s.get('jawOpen') || 0
  const olhoArregalado = par(s, 'eyeWideLeft', 'eyeWideRight')
  const sobrancelhaCima = Math.max(s.get('browInnerUp') || 0, par(s, 'browOuterUpLeft', 'browOuterUpRight'))
  const bocaBaixo = par(s, 'mouthFrownLeft', 'mouthFrownRight')
  const franzido = par(s, 'browDownLeft', 'browDownRight')

  // ORDEM = PRIORIDADE. Sorriso vence tudo (um sorriso franzido ainda e um sorriso). Em
  // seguida surpresa (boca aberta + rosto erguido), depois tristeza, por fim bravo.
  if (sorriso >= LIMIAR.sorriso) {
    return sorriso >= LIMIAR.sorrisoForte ? 'crianca-muito-feliz' : 'crianca-feliz'
  }

  if (bocaAberta >= LIMIAR.bocaAberta &&
      (sobrancelhaCima >= LIMIAR.sobrancelhaCima || olhoArregalado >= LIMIAR.olhoArregalado)) {
    return bocaAberta >= LIMIAR.bocaMuitoAberta ? 'crianca-muito-surpresa' : 'crianca-surpresa'
  }

  // Tristeza: canto da boca caido + sobrancelha interna erguida (a "cara chorosa"). Exigir
  // os dois evita confundir uma boca neutra com tristeza.
  if (bocaBaixo >= LIMIAR.bocaBaixo && sobrancelhaCima >= LIMIAR.sobrancelhaCima) {
    return 'crianca-triste'
  }

  // Bravo: sobrancelha bem franzida SEM sorriso (senao seria concentracao divertida).
  if (franzido >= LIMIAR.franzido && sorriso < 0.20) return 'crianca-brava'

  return null   // neutro: nada forte o suficiente
}

// ---------------------------------------------------------------------
// Gestos de mao a partir do GestureRecognizer
// ---------------------------------------------------------------------
// O modelo ja entrega o gesto NOMEADO (nao precisamos olhar os 21 pontos da mao). So
// traduzimos o nome do MediaPipe para a nossa percepcao canonica. "None" e ruido viram
// null. Um gesto desconhecido tambem vira null (seguro por padrao).
const GESTO_PARA_PERCEPCAO = {
  Thumb_Up:    'gesto-joinha',    // 👍 comemorar
  Thumb_Down:  'gesto-negativo',  // 👎 ops/desanimo
  ILoveYou:    'gesto-amor',      // 🤟 coracoes
  Victory:     'gesto-vitoria',   // ✌️ vitoria
  Open_Palm:   'gesto-tchau',     // ✋ oi/tchau (acenar)
  Pointing_Up: 'gesto-aponta',    // ☝️ "ideia!"
  Closed_Fist: 'gesto-forca',     // ✊ forca/combinado
}

/**
 * Traduz o nome de gesto do MediaPipe na percepcao canonica.
 * @param {string} nomeMediaPipe categoryName do gesto (ex.: 'Thumb_Up')
 * @returns {string|null}
 */
export function classificarGesto(nomeMediaPipe) {
  if (!nomeMediaPipe || nomeMediaPipe === 'None') return null
  return GESTO_PARA_PERCEPCAO[nomeMediaPipe] || null
}

// ---------------------------------------------------------------------
// Estabilizador: de "quadro a quadro" para "aconteceu de verdade"
// ---------------------------------------------------------------------
// O detector muda de opiniao varias vezes por segundo, e disparar uma reacao no robo a
// cada quadro floodaria o servidor e faria a cara dele piscar sem parar. Este pequeno
// estabilizador aplica tres regras:
//   1. HISTERESE: a percepcao precisa se MANTER por `confirmarMs` para ser considerada
//      real (um sorriso de meio quadro nao conta).
//   2. SO NA TRANSICAO: emite quando o estado confirmado MUDA - continuar sorrindo nao
//      re-dispara; voltar ao neutro "arma" a proxima deteccao.
//   3. COOLDOWN por percepcao: a MESMA percepcao nao volta a disparar antes de
//      `cooldownMs`, mesmo que a crianca fique alternando cara.
//
// Retorna a percepcao a ENVIAR ao servidor, ou null quando nao ha nada novo a relatar.
export function criarEstabilizador({ confirmarMs, cooldownMs }) {
  let candidata = null            // ultima percepcao bruta vista (pode oscilar)
  let candidataDesdeMs = 0        // desde quando a candidata esta estavel
  let confirmado = null           // percepcao atualmente CONFIRMADA (null = neutro)
  const ultimoEnvioMs = new Map() // cooldown por percepcao

  return function estabilizar(percepcaoBruta, agora) {
    // A candidata mudou: reinicia a janela de confirmacao.
    if (percepcaoBruta !== candidata) {
      candidata = percepcaoBruta
      candidataDesdeMs = agora
    }

    // Ainda nao ficou estavel o bastante: nada a decidir neste quadro.
    if (agora - candidataDesdeMs < confirmarMs) return null

    // Candidata confirmada. So agimos se ela MUDA o estado confirmado.
    if (candidata === confirmado) return null
    confirmado = candidata

    // Voltar ao neutro nunca dispara nada - so rearma para a proxima emocao.
    if (confirmado === null) return null

    // Transicao para uma percepcao real: respeita o cooldown daquela percepcao.
    if (agora - (ultimoEnvioMs.get(confirmado) || 0) < cooldownMs) return null
    ultimoEnvioMs.set(confirmado, agora)
    return confirmado
  }
}
