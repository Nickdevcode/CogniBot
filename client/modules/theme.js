/**
 * theme.js — Tema claro/escuro da interface do robô.
 *
 * Espelha o comportamento da landing page (Cognify): o tema é controlado pelo
 * atributo `data-theme` no <html> e persistido no localStorage (chave
 * `cogni-theme`). Sem escolha salva, segue o `prefers-color-scheme` do sistema —
 * e reage em tempo real se o usuário trocar o tema do SO (enquanto não tiver
 * escolhido manualmente aqui).
 *
 * O FOUC (flash do tema errado no load) é evitado por um <script> inline no
 * <head> do index.html, que aplica o data-theme salvo ANTES do CSS pintar. Este
 * módulo cuida do toggle em runtime e da sincronização do ícone/meta.
 */

const CHAVE = 'cogni-theme'

function lerSalvo() {
  try {
    const v = localStorage.getItem(CHAVE)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function salvar(tema) {
  try { localStorage.setItem(CHAVE, tema) } catch { /* localStorage indisponível: tema só nesta sessão */ }
}

function prefereDoSistema() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Tema EFETIVO atual: o manual (data-theme) se houver, senão o do sistema. */
function temaAtual() {
  const manual = document.documentElement.getAttribute('data-theme')
  return manual === 'light' || manual === 'dark' ? manual : prefereDoSistema()
}

// Mantém a barra de status do navegador (meta theme-color) coerente com o tema.
function sincronizarMetaThemeColor(tema) {
  const cor = tema === 'light' ? '#f0f0f2' : '#0e1130'
  let meta = document.querySelector('meta[name="theme-color"]:not([media])')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', cor)
}

/**
 * Aplica um tema explícito (manual): grava no <html>, persiste e sincroniza a UI.
 * @param {'light'|'dark'} tema
 * @param {(tema: string) => void} [aoAplicar] callback pra UI atualizar o ícone
 */
function aplicarTema(tema, aoAplicar) {
  document.documentElement.setAttribute('data-theme', tema)
  salvar(tema)
  sincronizarMetaThemeColor(tema)
  if (aoAplicar) aoAplicar(tema)
}

/**
 * Inicializa o tema e devolve um `alternar()` pra ligar no botão. Também escuta a
 * preferência do sistema (só relevante enquanto não há escolha manual salva).
 * @param {(tema: string) => void} [aoMudar] chamado a cada mudança (pra UI/ícone)
 * @returns {{ alternar: () => void, atual: () => string }}
 */
export function iniciarTema(aoMudar) {
  // Estado inicial: o script inline já pode ter setado data-theme (do localStorage).
  // Aqui só garantimos a meta e notificamos a UI do estado efetivo.
  const inicial = temaAtual()
  sincronizarMetaThemeColor(inicial)
  if (aoMudar) aoMudar(inicial)

  // Reage ao SO mudar de tema — só quando o usuário ainda não escolheu manualmente.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!lerSalvo()) {
        const t = prefereDoSistema()
        sincronizarMetaThemeColor(t)
        if (aoMudar) aoMudar(t)
      }
    })
  }

  function alternar() {
    const proximo = temaAtual() === 'light' ? 'dark' : 'light'
    aplicarTema(proximo, aoMudar)
  }

  return { alternar, atual: temaAtual }
}
