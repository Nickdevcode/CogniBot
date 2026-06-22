const container = document.getElementById('toast-container')

const ICONES = {
  info: 'info',
  ok: 'check_circle',
  aviso: 'warning',
  erro: 'error',
}

export function toast(mensagem, tipo = 'info', duracao = 3500) {
  if (!container) return

  const div = document.createElement('div')
  div.className = `toast toast--${tipo}`
  div.setAttribute('role', tipo === 'erro' ? 'alert' : 'status')

  const icone = document.createElement('span')
  icone.className = 'material-symbols-rounded'
  icone.setAttribute('aria-hidden', 'true')
  icone.textContent = ICONES[tipo] || 'info'

  const texto = document.createElement('span')
  texto.textContent = mensagem
  texto.style.flex = '1'

  const btnFechar = document.createElement('button')
  btnFechar.type = 'button'
  btnFechar.className = 'toast-fechar'
  btnFechar.setAttribute('aria-label', 'Fechar notificação')
  const iconeFechar = document.createElement('span')
  iconeFechar.className = 'material-symbols-rounded'
  iconeFechar.setAttribute('aria-hidden', 'true')
  iconeFechar.textContent = 'close'
  btnFechar.appendChild(iconeFechar)

  div.append(icone, texto, btnFechar)
  container.appendChild(div)

  let removido = false
  const remover = () => {
    if (removido) return
    removido = true
    div.classList.add('toast--saindo')
    setTimeout(() => div.remove(), 240)
  }

  btnFechar.addEventListener('click', remover)
  setTimeout(remover, duracao)
}
