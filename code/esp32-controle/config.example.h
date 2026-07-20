#pragma once

// =======================================================================
// Cogni - Firmware ESP32 Controle (MVP de Audio)
// Arquivo de configuracao - MODELO.
//
// COMO USAR: copie este arquivo para "config.h" (na mesma pasta) e
// preencha com os seus valores reais. O "config.h" NAO vai para o Git
// (esta no .gitignore) justamente para nao expor a senha do Wi-Fi e o
// token do robo. Este modelo, sim, e versionado.
// =======================================================================

// --------- Wi-Fi (rede LOCAL onde roda o notebook com o servidor) -------
// IMPORTANTE: o ESP32 conecta APENAS em redes 2,4 GHz. Se sua rede for
// dual-band (5 GHz tambem), crie uma SSID exclusiva 2,4 GHz no roteador.
#define COGNI_WIFI_SSID       "NOME_DA_SUA_REDE_2_4GHZ"
#define COGNI_WIFI_PASSWORD   "SENHA_DA_SUA_REDE"

// --------- Servidor Cogni (notebook rodando "npm run dev") --------------
// Use o IP local do notebook na rede Wi-Fi. Para descobrir no Windows:
//   ipconfig  ->  procure "Endereco IPv4" do adaptador Wi-Fi
// Nao use "localhost" nem "127.0.0.1": o ESP esta em outra maquina.
#define COGNI_SERVER_HOST     "192.168.0.100"
#define COGNI_SERVER_PORT     3000

// --------- Token de autenticacao do WebSocket (ESP_TOKEN do .env) -------
// Deve ser EXATAMENTE o mesmo valor configurado em .env do servidor.
// Em desenvolvimento, com servidor rodando localmente em
// http://localhost:3000/api/esp/token   voce ve o token atual.
#define COGNI_ESP_TOKEN       "defina-um-token-secreto-aqui"

// --------- Identificacao do robo ----------------------------------------
#define COGNI_ROBO_ID         "robo-cogni-01"

// --------- Usuario associado ao robo no servidor ------------------------
// Cole aqui o ID do usuario criado pelo app web (ou deixe "default" para
// usar a sessao anonima). Esse ID e usado pelo pipeline de voz do robo
// para puxar memorias persistentes e idade da crianca.
#define COGNI_USUARIO_ID      "default"

// =======================================================================
// PINAGEM I2S - Bate exatamente com a tabela do documento de montagem
// =======================================================================

// I2S 0 - SAIDA para o MAX98357A (DAC + amplificador para o alto-falante)
#define COGNI_PIN_I2S_OUT_BCLK   27   // BCLK
#define COGNI_PIN_I2S_OUT_LRC    14   // LRC / Word Select
#define COGNI_PIN_I2S_OUT_DIN    22   // DIN

// Pino SD (shutdown) do MAX98357A ligado a um GPIO, para DESLIGAR o amplificador
// quando nao ha audio tocando. Isso elimina o chiado de "amp ligado sem sinal"
// (o I2S para o clock em silencio e o amp amplifica ruido). Com o pino em:
//   LOW  (0V)   -> amplificador DESLIGADO (silencio total)
//   HIGH (3.3V) -> amplificador LIGADO
// Use um GPIO livre. GPIO 32 esta livre (nao conflita com mic 25/26/33 nem
// com a saida 22/27/14). Se nao quiser usar controle por GPIO, defina como -1
// e ligue o SD do modulo direto no 3V3 (amp sempre ligado).
#define COGNI_PIN_AMP_SD         32

// Tempo (ms) que esperamos depois que a reproducao para antes de desligar o
// amplificador. Cobre o esvaziamento do buffer I2S/DMA para nao cortar o final
// da fala. 300ms cobre o esvaziamento com folga e e imperceptivel. Se notar que
// corta o finalzinho, aumente; se demora a calar o chiado, diminua (minimo
// seguro ~200ms).
#define COGNI_AMP_GUARDA_MS      300UL

// I2S 1 - ENTRADA do microfone INMP441
#define COGNI_PIN_I2S_IN_SCK     26   // SCK / BCLK
#define COGNI_PIN_I2S_IN_WS      25   // WS / LRCLK
#define COGNI_PIN_I2S_IN_SD      33   // SD (saida de dados do mic)

// =======================================================================
// PINAGEM - 4 botoes fisicos (controle no corpo do robo)
// =======================================================================
// Os 4 botoes replicam as acoes do painel de controle web. Cada botao liga um
// GPIO livre ao GND e usamos o pull-up interno (INPUT_PULLUP): o pino fica em
// HIGH solto e vai a LOW quando apertado. A ORDEM abaixo e so convencao - troque
// o GPIO de cada acao a vontade, contanto que use GPIOs LIVRES (nao os de audio:
// 14/22/27/32 da saida e 25/26/33 do mic) e que suportem entrada com pull-up
// (evite os input-only 34/35/36/39 e o strapping 12). 13/16/17/4 sao seguros.
#define COGNI_PIN_BTN_MIC          13   // mutar/desmutar o microfone do robo
#define COGNI_PIN_BTN_CAMERA       16   // ligar/desligar a webcam do PC (via site)
#define COGNI_PIN_BTN_INTERROMPER  17   // interromper a fala/conversa em curso
#define COGNI_PIN_BTN_RESET         4   // reiniciar a conversa (limpa o contexto)

// Debounce (ms): ignora o repique mecanico do contato. So conta o toque quando o
// nivel do pino fica estavel por esse tempo. 40ms cobre o repique tipico sem
// perceptivelmente atrasar a resposta.
#define COGNI_BTN_DEBOUNCE_MS      40

// =======================================================================
// PINAGEM - Tela OLED SSD1309 2,42" 128x64 (olhos do robo, interface I2C)
// =======================================================================
// Modulo I2C de 4 pinos (GND / VDD / SCL / SDA). O I2C padrao do ESP32 usa
// SDA=21/SCL=22, mas o GPIO 22 e o DIN do amplificador - por isso remapeamos o
// barramento com Wire.begin(SDA, SCL) para pinos livres. SDA=21 e SCL=19 estao
// livres e nao conflitam com o audio.
#define COGNI_PIN_OLED_SDA         21   // SDA da tela
#define COGNI_PIN_OLED_SCL         19   // SCL da tela
#define COGNI_OLED_ADDR            0x3C // endereco I2C tipico (use 0x3D se um scan I2C acusar)
#define COGNI_OLED_LARGURA         128
#define COGNI_OLED_ALTURA          64
// TETO de quadros/s da animacao. ATENCAO: este numero e um teto de SOFTWARE, e o
// barramento e mais lento que ele. Um frame cheio sao 1024 bytes de framebuffer e,
// no I2C, cada byte custa 9 bits (8 + ACK):
//
//     1024 x 9 = 9216 bits / 400000 Hz  ~=  23 ms por frame  ->  teto REAL ~43 FPS
//
// Ou seja: pedir 50 aqui nao faz o rosto passar de ~43. Quem manda e o COGNI_OLED_I2C_HZ
// logo abaixo. Deixamos 50 de proposito (pedir mais que o barramento entrega nao custa
// nada e aproveita automaticamente se voce acelerar o I2C).
#define COGNI_OLED_FPS             50
// Velocidade do barramento I2C da tela. O datasheet do SSD1306/SSD1309 especifica
// 400 kHz como maximo oficial, e e por isso que este e o padrao seguro. Na pratica a
// maioria dos modulos aguenta 800000 no ESP32, o que DOBRA o teto de quadros (~87 FPS)
// e deixa a animacao visivelmente mais fluida.
// COMO TESTAR: troque para 800000, grave e olhe a tela por um minuto. Se aparecer
// lixo/chuvisco, pixels presos ou a tela congelar, seu modulo nao aguenta - volte para
// 400000. Nao ha risco de dano, o pior caso e a imagem corromper.
#define COGNI_OLED_I2C_HZ          400000UL
// Duracao (ms) de uma REACAO pontual dos olhos (coracoes/riso/confuso...), disparada
// pelo servidor pelo conteudo da conversa. Passado esse tempo, os olhos voltam ao
// rosto de estado (ouvindo/pensando/falando/idle).
#define COGNI_REACAO_DURACAO_MS    2200UL
// EMPATIA: quando a webcam ve a crianca triste/brava, o robo faz a cara "preocupada" por
// este tempo (fase "espelho") e o servidor manda logo depois (~1,2s) a fase "anima"
// (amor/piscadela). Deixe um pouco acima de 1200 para nao piscar o rosto normal no vao.
#define COGNI_PREOCUPADO_DURACAO_MS 1400UL
// Feedback de COMANDO (mic, pausa, reset, camera) e mais curto de proposito: e um
// "recebido!", nao uma emocao pra saborear.
#define COGNI_COMANDO_DURACAO_MS   1400UL
// Icone da MATERIA do assunto: um pouco mais longo que o comando - a crianca precisa
// reconhecer o desenho, nao so notar que algo piscou.
#define COGNI_MATERIA_DURACAO_MS   1500UL
// Se a fala comecar com o icone de materia ainda no ar, ele e cortado para este tempo:
// a tela nao pode ficar congelada num icone enquanto a voz ja esta tocando.
#define COGNI_MATERIA_CORTE_FALA_MS 400UL
// Tempo de uma ida-e-volta completa da varredura do rosto PESQUISANDO.
#define COGNI_VARREDURA_PERIODO_MS 1600UL
// Por quanto tempo uma posicao de olhar recebida do servidor continua valendo. Cobre
// com folga o intervalo de 100ms do navegador, entao um engasgo de rede nao faz o
// robo largar o olhar no meio da interacao.
#define COGNI_OLHAR_VALIDADE_MS    1200UL
// Depois de quanto tempo SEM NENHUMA atividade de conversa o robo cochila. Estar em
// frente a camera NAO conta como atividade (senao ele ficaria acordado a noite toda
// so por ter gente na sala).
#define COGNI_INATIVIDADE_SONO_MS  120000UL
// VIDA PROPRIA: quando ocioso (idle), o robo dispara reacoes espontaneas aleatorias
// (piscadinha, risadinha, coracao...) num intervalo aleatorio entre MIN e MAX ms.
// Menor = mais "vivo"/agitado; maior = mais calmo. Aumente se achar que anima demais.
#define COGNI_IDLE_ANIM_MIN_MS     6000UL
#define COGNI_IDLE_ANIM_MAX_MS     15000UL
// ENGAJADO COM O ROSTO: quando a webcam esta vendo a crianca e o robo esta seguindo o
// olhar dela, as espontaneas ficam MAIS RARAS (o intervalo acima e multiplicado por este
// fator) e as micro-historias sao suspensas - engajado, ele nao "surta" sozinho. 1 = sem
// mudanca; 3 = tres vezes mais espacadas. Suba se quiser ele ainda mais focado na crianca.
#define COGNI_ENGAJADO_ANIM_FATOR  3

// -----------------------------------------------------------------------
// ENVELOPE DA FALA (os olhos pulsam no ritmo da propria voz)
// -----------------------------------------------------------------------
// Ganho aplicado a amplitude do audio antes de virar altura de olho. O TTS fica em
// torno de 2000-6000 de media retificada (de um maximo de 32767); dividir pelo maximo
// real deixaria o rosto praticamente parado.
#define COGNI_FALA_GANHO           24
// Quantos pixels a altura do olho varia entre o silencio e o pico. Lembre que o mood
// HAPPY (usado ao falar) cobre metade do olho com a palpebra de baixo, entao o
// movimento APARENTE e cerca da metade deste valor.
#define COGNI_FALA_AMPLITUDE       16
// Intervalo aleatorio entre as piscadas durante a fala. (Durante a fala o autoblinker
// da biblioteca fica desligado - ver o comentario em aplicarRosto.)
#define COGNI_FALA_PISCADA_MIN_MS  3000UL
#define COGNI_FALA_PISCADA_MAX_MS  5000UL
// Tamanho do ring buffer do envelope. DEVE ser potencia de 2 (o indice usa mascara).
// Cada entrada cobre ~10,7ms de audio, entao 64 = ~683ms de historico - folga
// suficiente para compensar os ~340ms de colchao do DMA.
#define COGNI_ENVELOPE_RING        64

// -----------------------------------------------------------------------
// VIVACIDADE: micro-movimentos que fazem o rosto parecer vivo
// -----------------------------------------------------------------------
// MICRO-SACADAS: olho humano nunca fica completamente parado - ele salta em pequenos
// movimentos involuntarios varias vezes por segundo. Sem isso o rosto parece uma
// imagem congelada. Amplitude em pixels e intervalo aleatorio entre os saltos.
#define COGNI_SACADA_AMPLITUDE     2
#define COGNI_SACADA_MIN_MS        280UL
#define COGNI_SACADA_MAX_MS        900UL
// RESPIRACAO: oscilacao lenta e continua da altura dos olhos no repouso, como um peito
// subindo e descendo. Amplitude em pixels (1-2 e o ideal: precisa ser quase
// subliminar) e periodo de um ciclo completo.
#define COGNI_RESPIRACAO_AMPLITUDE 2
#define COGNI_RESPIRACAO_PERIODO_MS 4200UL
// OLHOS VESGOS DE PERTO: quando a crianca chega muito perto da camera, o robo fica
// vesgo, como uma pessoa tentando focar algo colado no nariz. O limiar e o tamanho do
// rosto na imagem (em milesimos da largura do quadro) a partir do qual comeca a valer.
// Maior = precisa chegar mais perto. O ESPACO e quanto os olhos se aproximam (a
// biblioteca aceita espacamento negativo, que e o que cruza os olhos de fato).
#define COGNI_VESGO_LIMIAR         420
#define COGNI_VESGO_ESPACO_MIN     -6
// SENTIR-SE IGNORADO: depois de ter visto um rosto, se ele sumir do quadro por este
// tempo o robo procura em volta e fica tristinho. So vale com a camera ligada.
#define COGNI_IGNORADO_MS          12000UL
// CONTATO VISUAL MUTUO: quando a crianca olha DE FRENTE pra camera (rosto centralizado e
// perto) e sustenta, o robo "reconhece" o olhar com uma piscada e um pingo de bom humor.
// TOLERANCIA = folga em volta do centro (milesimos); TAM_MIN = tamanho minimo do rosto
// (perto o bastante pra ser proposital); MS = tempo sustentado; COOLDOWN = descanso entre um
// reconhecimento e o proximo (senao viraria tique).
#define COGNI_CONTATO_TOLERANCIA   130
#define COGNI_CONTATO_TAM_MIN      250
#define COGNI_CONTATO_MS           1500UL
#define COGNI_CONTATO_COOLDOWN_MS  15000UL
// DESATENCAO NA CONVERSA: se a conversa rolava ha pouco, a camera esta ligada, o robo ja viu
// a crianca e o rosto some por este tempo, ele da UMA olhadela curiosa de "ei, ta comigo?"
// (uma vez por sumico). E a feature mais sensivel a calibrar no robo real - se der falso
// positivo (a crianca so virou pra pegar um lapis), ponha 0 em ATIVA pra desligar.
#define COGNI_DESATENCAO_ATIVA     1
#define COGNI_DESATENCAO_MS        6000UL

// -----------------------------------------------------------------------
// MOTOR DE EMOCAO (humor que persiste e decai, em vez de reacoes avulsas)
// -----------------------------------------------------------------------
// O robo mantem um HUMOR continuo em dois eixos - valencia (-100 triste .. +100 feliz)
// e excitacao (0 calmo .. 100 agitado) - que as reacoes empurram e que volta sozinho
// ao neutro com o tempo. E o que faz um elogio "deixar ele feliz por um tempinho" em
// vez de so disparar um coracao e esquecer.
// MEIA-VIDA: a cada X ms o humor perde METADE da distancia ate o neutro. Menor = mais
// volatil/esquecido; maior = mais rancoroso e mais grudento.
#define COGNI_EMOCAO_MEIA_VIDA_MS  45000UL
// Quanto o humor precisa se afastar do neutro para comecar a aparecer no rosto
// (sobrancelhas, curvatura). Evita que ruidinho de humor fique mexendo a cara toda hora.
#define COGNI_EMOCAO_LIMIAR        18
// HUMOR DE LONGO PRAZO: alem do humor que decai em ~1 min, o robo mantem um HUMOR-BASE que
// caminha DEVAGAR (ao longo de minutos) rumo ao clima geral da conversa - e e pra ele que o
// humor volta ao decair, em vez de sempre pro zero. Um dia de elogios deixa o robo de bom
// humor "de fundo". Este e o teto (+/-) de quanto o base pode se afastar do neutro; ele volta
// sozinho ao zero sem estimulo, entao nunca gruda num extremo. 0 desliga (volta a decair pro zero).
#define COGNI_HUMOR_BASE_MAX       25

// -----------------------------------------------------------------------
// SOBRANCELHAS
// -----------------------------------------------------------------------
// Duas barrinhas acima dos olhos. Em teste visual nao ficaram boas, entao vem
// DESLIGADAS por decisao de projeto - o codigo de desenho fica intacto e dormente, e
// religar e so trocar 0 por 1. As reacoes de emocao da crianca (feliz/triste/preocupado)
// nao dependem delas: usam mood + posicao do olhar. Se um dia quiser dar mais leitura ao
// "preocupado"/"bravo", ligar aqui e o caminho - mas o padrao respeita o teste visual.
#define COGNI_SOBRANCELHA_LIGADA   0
#define COGNI_SOBRANCELHA_GROSSURA 3    // altura da barra, em pixels
#define COGNI_SOBRANCELHA_FOLGA    5    // distancia acima do topo do olho
#define COGNI_SOBRANCELHA_LARGURA  26   // comprimento da barra

// -----------------------------------------------------------------------
// MICRO-HISTORIAS NO REPOUSO
// -----------------------------------------------------------------------
// De vez em quando, parado, o robo "vive" uma cena curta em vez de so piscar: segue
// uma mosca invisivel com os olhos, fica tonto, cochila aos poucos. Intervalo entre
// as cenas (elas concorrem com as reacoes espontaneas simples).
#define COGNI_HISTORIA_MIN_MS      25000UL
#define COGNI_HISTORIA_MAX_MS      55000UL

// =======================================================================
// Comportamento de audio
// =======================================================================

// Sample rate da SAIDA de audio (PCM que o servidor envia). A OpenAI TTS gera
// PCM fixo em 24000 Hz - o I2S de saida DEVE usar exatamente este valor, senao
// a voz sai acelerada ou lenta. So mude se mudar o formato no servidor.
#define COGNI_AUDIO_OUT_SAMPLE_RATE   24000

// Taxa de amostragem do microfone (Hz). 16000 e o padrao do Whisper.
#define COGNI_MIC_SAMPLE_RATE    16000

// Tamanho do buffer de envio do mic (bytes). 4096 e um bom equilibrio
// entre latencia e overhead de rede.
#define COGNI_MIC_BUFFER_BYTES   4096

// Captura e envio de audio do microfone para o servidor:
//   true  - captura audio do INMP441 em chunks binarios e envia em /ws/esp.
//           O servidor faz VAD por energia, transcreve (Whisper), gera a
//           resposta da Cogni e devolve o PCM para o ESP tocar.
//   false - desabilita captura. So recebe audio do servidor.
#define COGNI_MIC_ENVIAR_AO_SERVIDOR  true

// Ganho do microfone: deslocamento aplicado a cada amostra de 32 bits do
// INMP441 ao converter para int16. Menor = sinal mais alto. O firmware ja
// aplica clamp (-32768..32767), entao nao ha risco de "estalo" por overflow.
//   16 -> baixo demais para o VAD do servidor (fala ~RMS 100-300)
//   14 -> ainda fraco; fala fica no limite de 800 e falha facil
//   12 -> RECOMENDADO. Fala normal a ~30cm gera RMS ~1000-2000 (passa de 800
//         com folga) e silencio fica abaixo de 200. Nao clipa nem em voz alta.
//   11 -> ganho extra; use so se a sala for muito silenciosa / voz baixa.
#define COGNI_MIC_SHIFT               12

// Filtro "DC blocker" / passa-alta de 1a ordem aplicado a cada amostra antes
// da conversao. Remove o offset DC do INMP441 e o ruido grave (rumble, vibracao
// do chassi). Formula: y[n] = x[n] - x[n-1] + R*y[n-1].
//   R = 0.96  -> corte ~100 Hz (recomendado: limpa grave/rumble sem comer a voz,
//                inclusive a voz mais aguda das criancas, que fica acima de ~220 Hz)
//   R = 0.976 -> corte ~60 Hz (mais conservador; use se a voz soar "fina demais")
// NAO elimina ventoinha (que vive na faixa da voz) - isso e tratado pelo VAD
// adaptativo no servidor. Aqui so limpamos DC e graves.
#define COGNI_MIC_DC_R                0.96f

// Diagnostico do microfone: quando 1, imprime no Serial o nivel de energia
// (RMS) captado a cada ~1 s com varios ganhos, para calibrar o COGNI_MIC_SHIFT
// e confirmar que o mic esta captando. Em uso normal/demo deixe 0: o Serial fica
// limpo (so logs uteis de conexao, fala detectada e erros). Reative (1) apenas
// se precisar recalibrar o ganho do mic.
#define COGNI_MIC_DEBUG               0

// =======================================================================
// Timings e robustez
// =======================================================================

// Profundidade da fila de chunks de audio (entre o WebSocket e a task de audio).
// Cada item e um ponteiro para um slot do POOL fixo (ver abaixo). Igual ao numero
// de blocos do pool: nao adianta a fila ser maior que a quantidade de blocos
// disponiveis (cada item enfileirado ocupa um bloco).
#define COGNI_AUDIO_FILA_TAM          12

// --- Buffer POOL de audio (substitui malloc/free por chunk) ---------------
// ANTES: cada chunk de audio fazia malloc() ao chegar e free() ao tocar. Numa
// fala com centenas de chunks isso fragmenta o heap e gera picos de latencia
// (causa de o DMA "secar" no meio/fim da fala -> picota/duplica/loop). AGORA
// pre-alocamos um POOL fixo de blocos no boot e so emprestamos/devolvemos
// indices - custo O(1), zero fragmentacao, latencia estavel.
//   - Cada bloco precisa caber UM chunk do servidor (4KB) com folga.
//   - DIMENSIONAMENTO: o servidor controla o fluxo por um nivel-ALVO de buffer e
//     NUNCA empurra mais que ESP_AUDIO_BUFFER_TETO_MS de audio para o robo. A
//     ~85ms por bloco (4096B / 48 B/ms), o teto (520ms) cabe em ~6 blocos. 12
//     blocos cobrem ~1020ms (quase 2x o teto) com larga folga para jitter, e
//     reservam so ~55KB de heap.
//   - ATENCAO (NAO volte para 28): 28 blocos reservavam ~126KB. Como o WiFi e o
//     WebSocket ja consomem heap, o pool grande deixava so ~56KB livres e a
//     conexao WebSocket ficava OSCILANDO (desconecta/reconecta) e o mic parava de
//     enviar. Mantenha o pool enxuto para sobrar heap (~70KB+) para a rede.
#define COGNI_AUDIO_POOL_BLOCOS       12
#define COGNI_AUDIO_POOL_BLOCO_BYTES  4608   // 4KB do chunk + folga de cabecalho

// --- Controle de fluxo (malha fechada servidor <-> robo) ------------------
// O robo informa ao servidor, a cada COGNI_FLUXO_INTERVALO_MS enquanto toca, um
// "nivel de buffer" (quantos bytes de audio ainda nao tocados ele tem em maos:
// fila + estimativa do DMA). O servidor usa isso para enviar no ritmo certo -
// mantendo o buffer numa faixa-alvo: nunca seca (sem underrun = sem picote) e
// nunca estoura (sem descarte). E o que de fato elimina a gagueira, em vez de
// torcer para um pacing fixo "as cegas" acertar o ritmo do consumo.
//   - Intervalo de envio do nivel: 40ms da resolucao suficiente sem floodar TXT.
#define COGNI_FLUXO_INTERVALO_MS      40

// Quantos bytes, em media, um milissegundo de audio ocupa (PCM 24kHz 16-bit
// mono = 48 bytes/ms). Usado para estimar quanto do DMA ainda nao tocou e para
// o servidor converter bytes<->milissegundos do buffer-alvo. NAO mude sem mudar
// o sample rate da saida.
#define COGNI_AUDIO_BYTES_POR_MS      48     // 24000 amostras/s * 2 bytes / 1000

#define COGNI_WIFI_TIMEOUT_MS         30000UL  // espera maxima conectando
#define COGNI_WS_RECONNECT_MS         5000UL   // backoff entre reconexoes WS
#define COGNI_STATUS_INTERVAL_MS      15000UL  // periodicidade do status
// Reaplica WiFi.setSleep(false) a cada X ms no loop. O modem-sleep pode voltar sem
// passar por reconexao do WS (roaming/renegociacao 802.11), atrasando o pong do
// heartbeat e derrubando a conexao "na fala"; reaplicar periodicamente fecha a brecha.
#define COGNI_WIFI_SLEEP_GUARD_MS     10000UL
#define COGNI_SERIAL_BAUD             115200
