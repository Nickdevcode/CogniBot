const CORES = {
  Estado: 'color: #7C5CFF',
  Mic: 'color: #38E08A',
  VAD: 'color: #FFB770',
  Gravacao: 'color: #FF5C7A',
  Audio: 'color: #4FB6FF',
  Servidor: 'color: #19D9C9',
  Reset: 'color: #FF6FB4',
  Camera: 'color: #A99CFF',
  ESP: 'color: #38E08A',
  Erro: 'color: #FF5C7A; font-weight: bold',
}

function ts() {
  const d = new Date()
  return d.toLocaleTimeString('pt-BR', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

export function log(categoria, mensagem, ...extras) {
  const cor = CORES[categoria] || 'color: #6F698D'
  console.log(`%c[Cogni][${categoria}] ${ts()}`, cor, mensagem, ...extras)
}

export function criarLogger(categoria) {
  return (mensagem, ...extras) => log(categoria, mensagem, ...extras)
}
