/**
 * theme-init.js — Aplica o tema salvo ANTES do CSS pintar, evitando o flash do
 * tema errado (FOUC). Carregado de forma síncrona no <head>, antes do styles.css.
 *
 * É um arquivo externo (e não um <script> inline) por causa da Content Security
 * Policy do servidor (script-src 'self', via helmet) — inline seria bloqueado.
 * O resto da lógica de tema (toggle, persistência) vive em modules/theme.js.
 */
(function () {
  try {
    var t = localStorage.getItem('cogni-theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {
    /* localStorage indisponível: cai no prefers-color-scheme do CSS */
  }
})();
