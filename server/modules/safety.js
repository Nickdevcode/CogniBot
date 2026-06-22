const TEMAS_PROIBIDOS = [
  'violencia', 'matar', 'morrer', 'suicidio', 'automutilacao',
  'drogas', 'alcool', 'cigarro', 'maconha', 'cocaina', 'crack', 'ecstasy', 'lsd', 'heroina', 'metanfetamina',
  'sexo', 'pornografia', 'nudez', 'sexual', 'erotico', 'putaria', 'safadeza',
  'armas', 'bombas', 'explosivos', 'pistola', 'revolver', 'fuzil',
  'hack', 'invadir', 'roubar', 'phishing', 'malware', 'ransomware',
  'palavrao', 'xingamento',
  'ignore suas instrucoes', 'ignore as regras', 'finja ser',
  'esqueca suas regras', 'novo modo', 'modo sem restricoes',
  'dan mode', 'jailbreak', 'prompt injection',
  'self-harm', 'autolesao', 'me machucar', 'me cortar',
  'bulimia', 'anorexia',
  'pedofilia', 'abuso infantil', 'abuso sexual',
  'terrorismo', 'terrorista',
  'nazismo', 'nazista', 'hitler', 'supremacista',
  'aposte', 'aposta online', 'cassino', 'jogo de azar',
  'deep web', 'dark web', 'tor browser',
  'bypass', 'contornar filtro', 'burlar sistema', 'desbloquear restricoes',
  'roleplay adulto', 'finja que nao tem regras', 'sem censura',
  'override', 'system prompt', 'repita suas instrucoes',
  'qual seu prompt', 'mostre seu prompt', 'revele suas instrucoes',
]

const PADROES_JAILBREAK = [
  /ignore (todas|suas|as) (instruc|regras|restricoes)/i,
  /finja (ser|que voce e)/i,
  /esqueca (tudo|suas regras|o que)/i,
  /(modo|mode) (sem restricoes|ilimitado|dev|developer|dan)/i,
  /voce (agora e|sera|vai ser) (um|uma)/i,
  /a partir de agora/i,
  /new persona/i,
  /act as/i,
  /you are now/i,
  /ignore (all|your|previous) (instructions|rules|prompts)/i,
  /do anything now/i,
  /pretend (you are|to be|you're)/i,
  /forget (all|your|everything)/i,
  /disregard (all|your|previous)/i,
  /override (your|all|the) (instructions|rules|safety)/i,
  /repeat (your|the) (system|initial) (prompt|instructions|message)/i,
  /show me your (prompt|instructions|rules|system)/i,
  /(qual|mostre|revele|exiba|conte) (seu|suas|o) (prompt|instruc|regras|sistema)/i,
  /responda sem (filtro|censura|restricao|regras)/i,
  /fale sobre (qualquer|todo) (assunto|tema) sem (restricao|filtro)/i,
  /nao (siga|obedeca|respeite) (suas|as) (regras|instrucoes)/i,
  /enable (dev|developer|admin|sudo|root) mode/i,
  /\bDAN\b/,
  /token smuggling/i,
  /prompt leak/i,
]

const REGEX_DIACRITICOS = /[\u0300-\u036f]/g
const REGEX_CONTROLE = /[\u0000-\u001f\u007f]/g

function normalizar(texto) {
  return texto.toLowerCase().normalize('NFD').replace(REGEX_DIACRITICOS, '')
}

function verificarEntrada(texto) {
  if (!texto || typeof texto !== 'string') {
    return { seguro: true, motivo: null }
  }

  const textoNormalizado = normalizar(texto)

  for (const tema of TEMAS_PROIBIDOS) {
    const temaNormalizado = normalizar(tema)
    if (textoNormalizado.includes(temaNormalizado)) {
      return {
        seguro: false,
        motivo: 'Conteudo potencialmente inadequado detectado',
      }
    }
  }

  for (const padrao of PADROES_JAILBREAK) {
    if (padrao.test(texto)) {
      return {
        seguro: false,
        motivo: 'Tentativa de manipulacao detectada',
      }
    }
  }

  return { seguro: true, motivo: null }
}

const RESPOSTA_BLOQUEIO = 'Opa, acho que fugimos um pouquinho do assunto! Que tal a gente voltar a estudar? Me conta, no que você precisa de ajuda?'

// =====================================================================
// Filtro de palavrao na SAIDA (rede de seguranca pro perfil ESTUDANTE)
// =====================================================================
// O prompt ja instrui a Cogni a nao xingar com criancas, mas o modelo fraco
// (gpt-4o-mini) as vezes ESCAPA um palavrao ("merda", etc). Como e um produto
// infantil, o prompt sozinho nao basta: aqui filtramos a RESPOSTA antes do TTS.
// SO se aplica ao perfil estudante - com o dev o linguajar e liberado (ver
// camadaDev no prompt). Estrategia: trocar o palavrao por uma alternativa leve e
// natural (nao "[bip]" nem ***), pra fala continuar fluida. Casa a palavra mesmo
// com acento/variacao e com a fronteira certa (nao pega "concha" por "cona").
const SUBSTITUICOES_PALAVRAO = [
  // [regex da palavra, substituto leve]
  [/\bmerd(a|as|inha)\b/gi, 'droga'],
  [/\bporr(a|as)\b/gi, 'poxa'],
  [/\bcacete\b/gi, 'caramba'],
  [/\bcarac(a| as)\b/gi, 'caramba'],
  [/\bdroga\b/gi, 'droga'],   // ja e leve; mantem (no-op pra consistencia)
  [/\bcaralh(o|os)\b/gi, 'caramba'],
  [/\bf(o|u)d(a|asse|eu|er|ido|ida)\b/gi, 'chato'],
  [/\bp(o|u)t(a|aria|o)\b/gi, 'poxa'],
  [/\bbost(a|as)\b/gi, 'droga'],
  [/\bdesgrac(a|ado|ada)\b/gi, 'droga'],
  [/\bdiab(o|os|inho)\b/gi, 'nossa'],   // "que diabos" -> "que nossa" (suaviza xingamento leve)
  [/\bcu\b/gi, 'bumbum'],
  [/\bbund(a|ao)\b/gi, 'bumbum'],
  [/\bidiot(a|as)\b/gi, 'bobo'],
  [/\bburr(o|a|os|as)\b/gi, 'bobo'],
  [/\best[uú]pid(o|a|os|as)\b/gi, 'bobo'],
]

// Limpa palavroes da RESPOSTA (so chamar pro perfil estudante). Preserva a
// capitalizacao aproximada e a fluidez. Retorna o texto suavizado.
function filtrarPalavroesSaida(texto) {
  if (!texto || typeof texto !== 'string') return texto
  let limpo = texto
  for (const [regex, substituto] of SUBSTITUICOES_PALAVRAO) {
    limpo = limpo.replace(regex, (match) => {
      // Preserva a 1a letra maiuscula se o original comecava maiusculo.
      if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
        return substituto.charAt(0).toUpperCase() + substituto.slice(1)
      }
      return substituto
    })
  }
  return limpo
}

function sanitizarTexto(texto, maxLen = 4000) {
  if (typeof texto !== 'string') return ''
  let limpo = texto.replace(REGEX_CONTROLE, '')
  limpo = limpo.trim()
  if (limpo.length > maxLen) limpo = limpo.slice(0, maxLen)
  return limpo
}

function sanitizarNome(nome, maxLen = 30) {
  const limpo = sanitizarTexto(nome, maxLen)
  return limpo.replace(/[<>]/g, '').replace(/\s+/g, ' ')
}

// Padroes de "texto lixo" da transcricao (STT). O Whisper alucina frases no
// silencio/ruido - tipicamente legendas de video ("inscreva-se", "legendas pela
// comunidade", "obrigado por assistir"). Tambem pega fillers ("hmm", "ah") e
// respostas curtas demais que nao valem disparar o pipeline. Usado tanto pela
// interface (/api/conversation) quanto pelo robo (esp-pipeline) para paridade.
const TEXTOS_LIXO = [
  /^[\s.,!?…\-–—:;'"()[\]{}]+$/,
  /^(hmm?|ah+|oh+|uh+|eh+|tss+|hm+|mhm+|shh+|pff+|tsk+|psiu|oi+)[\s.,!?]*$/i,
  /^(obrigad[oa]|tchau|bye|ok)[\s.,!?]*$/i,
  /legendas?\s*(pela|por|da)\s*comunidade/i,
  /amara\.org/i,
  /inscreva[\s-]*se/i,
  /obrigad[oa]\s*por\s*assistir/i,
  /like\s*(e|and)\s*subscribe/i,
  /subscribe\s*(to|and)/i,
  /^\s*\.+\s*$/,
  /sigam[\s-]*(me|nos)/i,
  /ativa[r]?\s*o\s*sininho/i,
  /deixe?\s*(o\s*)?(seu\s*)?(like|comentario)/i,
  /compartilh[ea]/i,
  /legenda(s|do)?\s*(em\s*)?portugu[eê]s/i,
  /translated\s*by/i,
  /subt[ií]tulos/i,
  // Dialogo "roteirizado" alucinado pelo Whisper no mic aberto/ruido: a transcricao
  // vem como um roteiro com a propria Cogni de um lado ("Cogni: ...", "Cogni diz:").
  // Uma fala REAL da crianca nunca se refere a Cogni em terceira pessoa com dois-
  // pontos de turno. Pega o caso do "dialogo fantasma" (ver ehDialogoAlucinado).
  /\bcogni\s*(diz|disse|responde|respondeu|fala|falou)?\s*:/i,
]

// Marca de DIALOGO ALUCINADO: o Whisper (ou o modelo, ao continuar uma transcricao
// ruim) devolve um ROTEIRO com varios turnos no formato "Nome: fala. Nome: fala."
// — exatamente o "dialogo fantasma" que apareceu com o mic aberto sozinho. Sinal
// inequivoco: DOIS OU MAIS rotulos de locutor "Palavra:" no inicio de turnos (apos
// pontuacao final). Fala humana normal nao tem isso; uma resposta da Cogni tambem
// nao (ela conversa, nao roteiriza). Conservador de proposito (>=2 rotulos) para
// nao pegar um "olha:" solto ou um horario "16:47".
const REGEX_ROTULO_LOCUTOR = /(?:^|[.!?]\s+)[A-ZÀ-Ý][\wÀ-ÿ]{1,20}\s*:\s/g

function ehDialogoAlucinado(texto) {
  if (!texto) return false
  const rotulos = texto.match(REGEX_ROTULO_LOCUTOR)
  return !!rotulos && rotulos.length >= 2
}

function ehTextoLixo(texto) {
  if (!texto) return true
  const limpo = texto.trim()
  if (limpo.length < 2) return true

  const soPontuacao = limpo.replace(/[\s.,!?…\-–—:;'"()[\]{}]/g, '')
  if (soPontuacao.length < 2) return true

  const palavras = limpo.split(/\s+/).filter(p => p.length > 1)
  if (palavras.length < 1) return true

  for (const padrao of TEXTOS_LIXO) {
    if (padrao.test(limpo)) return true
  }

  // Roteiro alucinado (multiplos "Nome:" de turno): trata como lixo de transcricao.
  if (ehDialogoAlucinado(limpo)) return true

  return false
}

module.exports = { verificarEntrada, RESPOSTA_BLOQUEIO, sanitizarTexto, sanitizarNome, ehTextoLixo, ehDialogoAlucinado, filtrarPalavroesSaida }
