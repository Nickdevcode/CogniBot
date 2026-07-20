// =====================================================================
// Cogni - Firmware ESP32 de Controle (MVP de Audio)
// Plataforma : ESP32 DevKit V1 (ESP-WROOM-32)
// Funcao     : Conecta ao servidor Cogni via WebSocket. Captura a voz da
//              crianca pelo INMP441 e envia PCM ao servidor; recebe de volta
//              o PCM da resposta da Cogni e o reproduz pelo MAX98357A. O
//              servidor (e a interface web) comandam perfil, mute e fala.
// Stack 2026 :
//   - Arduino-ESP32 core 3.3.8 (Espressif)
//   - WebSockets (Links2004) 2.6.1
//   - ArduinoJson 7.4.3
//   - Audio: I2S nativo (driver i2s_std do ESP-IDF). NAO usamos a lib
//     schreibfaul1: ela exige PSRAM (aloca ~700KB), que o ESP32 DevKit nao tem.
//     O servidor manda PCM 24kHz 16-bit mono pronto e tocamos direto no I2S
//     (PCM, NAO MP3 - decodificar MP3 exigiria a PSRAM que esta placa nao tem).
// =====================================================================

#include "config.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "driver/i2s_std.h"  // I2S "Standard" novo do ESP-IDF (entrada do mic E saida do alto-falante)
#include "esp_system.h"      // esp_reset_reason() - diagnostico do motivo do ultimo boot

// Tela OLED (olhos do robo): SSD1309 128x64 via I2C. Usamos o driver SSD1306, que
// e register-compatible com o SSD1309, e a lib RoboEyes (sobre Adafruit GFX) para
// desenhar/animar os olhos. Incluida por ULTIMO de proposito: a RoboEyes define
// macros curtas e genericas (ON/OFF/DEFAULT/N/E/S/W...) que so devem valer daqui
// pra frente, sem afetar os headers de sistema acima.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <FluxGarage_RoboEyes.h>

// ---------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------
WebSocketsClient ws;

// Canal de RX do microfone INMP441 (driver I2S novo, port 1).
// Preenchido em configurarMicI2S(); nulo se o mic estiver desligado/falhar.
static i2s_chan_handle_t micRxHandle = nullptr;

// Canal de TX da saida de audio para o MAX98357A (driver I2S novo, port 0).
// Preenchido em configurarSaidaI2S().
static i2s_chan_handle_t txHandle = nullptr;

// --- Reproducao de audio em task dedicada (core 0) ---
// O audio NAO e tocado dentro do loop(): o i2s_channel_write bloqueia, e isso
// travava o ws.loop() (desconexao por pong atrasado) e fazia o audio engasgar.
// O callback WebSocket so EMPACOTA o chunk numa fila; uma task pinada no core 0
// consome a fila e escreve no I2S, deixando o loop()/ws.loop() (core 1) livres.
//
// IMPORTANTE (anti-gagueira): cada item da fila e um INDICE de um POOL fixo de
// buffers, NAO um ponteiro de malloc. Antes, cada chunk fazia malloc()/free();
// numa fala com centenas de chunks isso fragmentava o heap e gerava picos de
// latencia que faziam o DMA secar (underrun) -> aquele picote/duplicacao/loop
// no meio e fim da fala. Com o pool, emprestar/devolver um bloco e O(1), sem
// fragmentacao e com latencia estavel.
struct ChunkAudio {
  uint16_t slot;     // indice do bloco no pool (poolBuffers[slot])
  uint16_t tamanho;  // bytes uteis nesse bloco (<= COGNI_AUDIO_POOL_BLOCO_BYTES)
};

// Pool: memoria reservada UMA vez no boot. poolBuffers[i] aponta para um bloco
// de COGNI_AUDIO_POOL_BLOCO_BYTES. poolLivres e uma fila de indices disponiveis.
static uint8_t*      poolBuffers[COGNI_AUDIO_POOL_BLOCOS];
static QueueHandle_t poolLivres = nullptr;   // fila de slots livres (uint16_t)

static QueueHandle_t filaAudio = nullptr;
static TaskHandle_t  tarefaAudioHandle = nullptr;
static volatile bool audioInterrompido = false;   // sinaliza a task p/ descartar
static volatile bool tarefaAudioOcupada = false;   // true enquanto escreve no I2S
static volatile unsigned long ultimoWriteMs = 0;   // quando a task escreveu por ultimo

// --- Controle de fluxo: contabilidade do que ainda NAO tocou ---
// O nivel de buffer reportado ao servidor tem DOIS componentes (somados):
//   (1) bytesEnfileirados: chunks na fila que a task ainda NAO escreveu no I2S.
//   (2) bytesNoDma: audio que a task JA escreveu no DMA mas que o alto-falante
//       ainda nao terminou de tocar (o "colchao" do DMA, ~256ms).
// ANTES so reportavamos (1). Como a task drena a fila quase na hora, (1) vivia em
// ~1 chunk (~85ms) MESMO com o DMA cheio - o servidor recebia um nivel falso-baixo
// e mandava sempre no minimo, "as cegas". Contar (2) faz o servidor enxergar o
// nivel REAL e regular o ritmo como projetado.
//
// Como o driver i2s_std nao expoe o "fill level" do DMA, estimamos (2): bytesNoDma
// SOBE quando a task escreve um lote e e DRENADO pelo tempo (48 B/ms) ao ler o
// nivel. dmaAtualizadoMs marca a ultima vez que ajustamos. volatile + porta
// critica porque dois cores mexem nisso (callback WS no core 1, task no core 0).
static volatile uint32_t bytesEnfileirados = 0;   // (1) na fila, ainda nao escritos no I2S
static volatile uint32_t bytesNoDma = 0;          // (2) escritos no DMA, ainda tocando
static volatile unsigned long dmaAtualizadoMs = 0; // ultima vez que bytesNoDma foi drenado
static portMUX_TYPE muxFluxo = portMUX_INITIALIZER_UNLOCKED;
static unsigned long ultimoNivelMs = 0;           // ultimo envio do nivel ao servidor
static volatile uint32_t contadorGaps = 0;        // diagnostico: DMA ficou ocioso entre buffers

static unsigned long ultimoStatusMs = 0;
static bool wsConectado = false;

// Reaplicacao periodica do desligamento do modem-sleep do Wi-Fi (ver loop()). O
// intervalo tem fallback aqui para nao exigir um novo #define no config.h de cada
// maquina; quem quiser tunar pode sobrescrever no config.h.
#ifndef COGNI_WIFI_SLEEP_GUARD_MS
#define COGNI_WIFI_SLEEP_GUARD_MS 10000UL
#endif
static unsigned long ultimoWifiSleepGuardMs = 0;

// Recepcao do PCM que chega entre "audio-inicio" e "audio-fim". O servidor manda
// PCM raw (24kHz, 16-bit signed, mono, little-endian) em chunks binarios. Como
// uma resposta pode ter centenas de KB (nao cabe na RAM), tocamos CONFORME chega:
// cada chunk binario e escrito direto no I2S (duplicando mono->estereo). Nao
// guardamos o audio inteiro.
static size_t audioTamanhoEsperado = 0;
static size_t audioRecebido = 0;
static bool   recebendoAudio = false;
static unsigned long ultimoChunkMs = 0;   // marca quando chegou o ultimo chunk

// ---------------------------------------------------------------------
// Tela OLED (olhos do robo) + estado das expressoes
// ---------------------------------------------------------------------
// Velocidade do barramento da tela. Fallback aqui para nao quebrar quem ainda tem um
// config.h antigo (o valor "de verdade" e documentado no config.example.h).
#ifndef COGNI_OLED_I2C_HZ
#define COGNI_OLED_I2C_HZ 400000UL
#endif

// Display SSD1309 (compativel com o driver SSD1306) 128x64 no barramento I2C
// remapeado (SDA/SCL de config.h). reset = -1: o modulo de 4 pinos nao expoe um
// pino RESET, entao confiamos no reset RC de fabrica do modulo.
//
// O 5o parametro (clkDuring) e o que REALMENTE define a velocidade da tela. A
// Adafruit_SSD1306 guarda esse valor em wireClk e reaplica Wire.setClock() a cada
// transferencia, restaurando depois para clkAfter - ou seja, um Wire.setClock() nosso
// em configurarTela() seria simplesmente sobrescrito pela lib e nao teria efeito
// nenhum. Por isso a velocidade entra por aqui.
static Adafruit_SSD1306 display(COGNI_OLED_LARGURA, COGNI_OLED_ALTURA, &Wire, -1,
                                COGNI_OLED_I2C_HZ);
static RoboEyes<Adafruit_SSD1306> roboEyes(display);
static bool telaOk = false;
static TaskHandle_t tarefaOlhoHandle = nullptr;
// Altura padrao dos olhos, capturada no boot. A reacao SURPRESA arregala os olhos
// com setHeight(); como a propria RoboEyes usa setHeight para redefinir seu
// "default" interno, guardamos o valor original aqui para restaurar depois.
static int alturaOlhoPadrao = 36;

// Estado da conversa que o SERVIDOR informa (mensagem "expressao"). O firmware
// sozinho so sabe "falando" (recebendoAudio) e "desconectado" (wsConectado); os
// demais estados (ouvindo/pensando/pesquisando/idle) e o mute vem do servidor.
// volatile: escritos no callback WS (core 1) e lidos na task da tela (core 0).
enum EstadoConversa { CONV_IDLE, CONV_OUVINDO, CONV_PENSANDO, CONV_PESQUISANDO, CONV_FALANDO };
static volatile EstadoConversa estadoConversa = CONV_IDLE;
static volatile bool micMutadoRobo = false;

// Expressao EFETIVA aplicada aos olhos (derivada do estado acima + estado local).
enum Rosto { ROSTO_DORMINDO, ROSTO_IDLE, ROSTO_OUVINDO, ROSTO_PENSANDO, ROSTO_PESQUISANDO, ROSTO_FALANDO };

// SONO POR INATIVIDADE: o robo dorme em dois casos - desconectado do servidor, ou
// depois de um tempo sem NENHUMA atividade de conversa (ninguem falando com ele e ele
// sem responder). Qualquer atividade acorda na hora. O mute do mic NAO faz dormir:
// mutado ele fica no repouso normal, com as animacoes espontaneas de idle.
#ifndef COGNI_INATIVIDADE_SONO_MS
#define COGNI_INATIVIDADE_SONO_MS 120000UL   // 2 minutos
#endif
// volatile: marcada no loop (core 1: botoes, callback do WS) e na task da tela (core 0),
// que renova enquanto o rosto esta ativo. Escrita de 32 bits e atomica no ESP32.
static volatile unsigned long ultimaAtividadeMs = 0;
// marcarAtividade() (quem zera esse relogio) fica logo abaixo do bloco dos botoes -
// nao pode subir pra ca: veja a nota do pre-processador do Arduino la.

// REACOES pontuais (one-shot) que o servidor dispara pelo CONTEUDO da conversa
// (mensagem "reacao"), diferente do estado CONTINUO acima. Duram alguns segundos
// SOBRE o rosto de estado e depois voltam ao normal. Ex: elogio -> coracoes;
// piada -> riso; "nao entendi" -> confuso. A heuristica que decide vive no servidor
// (modules/esp-reacoes.js); aqui so animamos. volatile: escrito no callback WS
// (core 1), lido na task da tela (core 0).
// A segunda familia (a partir de REACAO_MIC_OFF) e o FEEDBACK DE COMANDO: cada acao
// do painel - no navegador ou nos botoes fisicos, tanto faz, o servidor dispara nos
// dois casos - vira um icone no rosto, pra crianca ver que o robo entendeu o clique.
// Elas se distinguem das emocoes de proposito: emocao ocupa os DOIS olhos, comando
// desenha UM icone no centro da tela.
// A terceira familia (a partir de REACAO_MAT_MATEMATICA) e a MATERIA do assunto: o
// servidor classifica a fala da crianca e o rosto mostra o icone da disciplina antes
// da resposta comecar. A ORDEM importa - materia vem por ultimo para tambem satisfazer
// reacaoEhComando() (icone central), e duracaoReacao() testa materia ANTES de comando.
enum Reacao { REACAO_NENHUMA, REACAO_AMOR, REACAO_RISO, REACAO_CONFUSO, REACAO_SURPRESA,
              REACAO_TRISTE, REACAO_SUOR, REACAO_PISCADELA, REACAO_CELEBRA, REACAO_IDEIA,
              REACAO_MIC_OFF, REACAO_MIC_ON, REACAO_PARAR, REACAO_RESET,
              REACAO_CAM_ON, REACAO_CAM_OFF, REACAO_OLA, REACAO_TCHAU,
              REACAO_MAT_MATEMATICA, REACAO_MAT_CIENCIAS, REACAO_MAT_PORTUGUES,
              REACAO_MAT_HISTORIA, REACAO_MAT_GEOGRAFIA, REACAO_MAT_IDIOMAS };
static volatile Reacao reacaoAtiva = REACAO_NENHUMA;
static volatile unsigned long reacaoAteMs = 0;   // millis() ate quando a reacao vale
// Duracao de uma reacao. Fallback aqui para nao exigir novo #define no config.h.
#ifndef COGNI_REACAO_DURACAO_MS
#define COGNI_REACAO_DURACAO_MS 2200UL
#endif
// Feedback de comando e mais curto: e um "recebido!", nao uma emocao pra saborear.
#ifndef COGNI_COMANDO_DURACAO_MS
#define COGNI_COMANDO_DURACAO_MS 1400UL
#endif
// Tempo de uma ida-e-volta completa da varredura do rosto PESQUISANDO.
#ifndef COGNI_VARREDURA_PERIODO_MS
#define COGNI_VARREDURA_PERIODO_MS 1600UL
#endif
// Icone da materia: um pouco mais longo que o feedback de comando (a crianca precisa
// reconhecer o desenho, nao so notar que algo piscou).
#ifndef COGNI_MATERIA_DURACAO_MS
#define COGNI_MATERIA_DURACAO_MS 1500UL
#endif
// Se a fala comecar com o icone de materia ainda no ar, ele e cortado para este
// tempo: a tela nao pode ficar congelada num icone enquanto a voz toca.
#ifndef COGNI_MATERIA_CORTE_FALA_MS
#define COGNI_MATERIA_CORTE_FALA_MS 400UL
#endif
// reacaoEhComando()/duracaoReacao() ficam junto de marcarAtividade(), depois do bloco
// dos botoes - pela mesma regra do pre-processador documentada la.

// VIDA PROPRIA: quando o robo esta OCIOSO (rosto idle), dispara reacoes espontaneas
// aleatorias de tempos em tempos - piscadinha, risadinha, olhos de coracao, etc. -
// pra parecer vivo mesmo sem ninguem falando. Intervalo aleatorio entre os disparos.
#ifndef COGNI_IDLE_ANIM_MIN_MS
#define COGNI_IDLE_ANIM_MIN_MS 6000UL
#endif
#ifndef COGNI_IDLE_ANIM_MAX_MS
#define COGNI_IDLE_ANIM_MAX_MS 15000UL
#endif
static unsigned long proximaAnimEspontaneaMs = 0;

// ---------------------------------------------------------------------
// VIVACIDADE: os micro-movimentos que separam "rosto vivo" de "imagem parada"
// ---------------------------------------------------------------------
// Um olho humano NUNCA fica imovel: mesmo fixando um ponto ele salta em pequenos
// movimentos involuntarios (sacadas) varias vezes por segundo, e o corpo respira. Sem
// isso, um rosto tecnicamente correto ainda "cheira" a imagem congelada - e essa e a
// diferenca mais barata que existe entre um desenho e um bicho.
//
// Amplitudes propositalmente MINUSCULAS (1-2px). O efeito tem que ser quase
// subliminar: se der pra ver o olho tremendo, passou do ponto e vira tique nervoso.
#ifndef COGNI_SACADA_AMPLITUDE
#define COGNI_SACADA_AMPLITUDE 2
#endif
#ifndef COGNI_SACADA_MIN_MS
#define COGNI_SACADA_MIN_MS 280UL
#endif
#ifndef COGNI_SACADA_MAX_MS
#define COGNI_SACADA_MAX_MS 900UL
#endif
#ifndef COGNI_RESPIRACAO_AMPLITUDE
#define COGNI_RESPIRACAO_AMPLITUDE 2
#endif
#ifndef COGNI_RESPIRACAO_PERIODO_MS
#define COGNI_RESPIRACAO_PERIODO_MS 4200UL
#endif

// ---------------------------------------------------------------------
// ENVELOPE DA FALA: os olhos pulsam no ritmo da voz do robo
// ---------------------------------------------------------------------
// A task de audio mede a amplitude de cada lote que manda pro I2S e a task da tela
// usa isso pra modular a altura dos olhos - o rosto "fala" junto com o alto-falante.
//
// O PORQUE DO CARIMBO DE TEMPO: i2s_channel_write retorna quando COPIA o audio pro
// DMA, nao quando ele SOA. Como o colchao de DMA aqui chega a ~340ms (ver
// configurarSaidaI2S), usar a amplitude na hora deixaria os olhos quase meio segundo
// ADIANTADOS - pareceria dublagem fora de sincronia. Por isso cada medida vai com o
// instante em que ela deve SOAR, calculado a partir do bytesNoDma que o controle de
// fluxo ja mantem, e a tela so consome quando aquele instante chega.
struct AmostraEnvelope {
  uint32_t tocaEmMs;   // millis() em que este trecho comeca a sair no alto-falante
  uint8_t  nivel;      // 0..255 (media do valor absoluto das amostras, com ganho)
};
// 64 entradas x ~10,7ms de audio cada = ~680ms de historico: cobre o colchao do DMA
// com folga. Potencia de dois para o indice usar mascara em vez de divisao.
#define COGNI_ENVELOPE_RING 64
static AmostraEnvelope envelopeRing[COGNI_ENVELOPE_RING];
// Fila de produtor unico / consumidor unico: SO a tarefaAudio escreve a cabeca, SO a
// tarefaOlho escreve a cauda. Isso e o que dispensa mutex - e o que faz a task de
// audio (prioridade 5, alimenta o I2S) nunca esperar pela task da tela.
// CUIDADO: a seguranca disso depende das duas tasks estarem PINADAS NO MESMO CORE
// (ver xTaskCreatePinnedToCore no setup). Se um dia forem separadas em cores
// diferentes, isto precisa virar secao critica (portMUX).
static volatile uint16_t envelopeCabeca = 0;
static volatile uint16_t envelopeCauda = 0;
// Divisor da amplitude media -> 0..255. Fala do TTS costuma ficar em 2000-6000 de
// media retificada (de 32767); dividir por 32767 deixaria o rosto quase parado.
#ifndef COGNI_FALA_GANHO
#define COGNI_FALA_GANHO 24
#endif
// Quantos pixels a altura do olho varia entre silencio e pico. Vale lembrar que o
// mood HAPPY do rosto FALANDO cobre metade do olho com a palpebra de baixo, entao o
// movimento APARENTE e cerca de metade deste valor.
#ifndef COGNI_FALA_AMPLITUDE
#define COGNI_FALA_AMPLITUDE 16
#endif
// Piscada durante a fala: como a altura do olho passa a ser escrita a cada frame, o
// autoblinker da lib seria sobrescrito silenciosamente. Piscamos por conta propria.
#ifndef COGNI_FALA_PISCADA_MIN_MS
#define COGNI_FALA_PISCADA_MIN_MS 3000UL
#endif
#ifndef COGNI_FALA_PISCADA_MAX_MS
#define COGNI_FALA_PISCADA_MAX_MS 5000UL
#endif

// ---------------------------------------------------------------------
// OLHAR: os olhos acompanham a crianca
// ---------------------------------------------------------------------
// O navegador detecta o rosto na webcam e manda a posicao normalizada (mensagem
// "olhar"); aqui so guardamos o alvo e a task da tela persegue suavemente.
// Guardamos em MILESIMOS (0..1000) em vez de float: a escrita fica atomica em 32
// bits, dispensando secao critica entre o callback do WS (core 1) e a tela (core 0).
static volatile int16_t alvoOlharX = 500;   // 500 = centro
static volatile int16_t alvoOlharY = 500;
// Largura do rosto no quadro, tambem em milesimos: a nossa medida de DISTANCIA. Rosto
// grande = crianca perto. 0 = o painel nao informou (versao antiga) ou nao ha rosto.
static volatile int16_t alvoOlharTam = 0;
static volatile unsigned long ultimoOlharMs = 0;
// A webcam do painel esta ligada? Informado pelo servidor junto da expressao. Usado
// para o robo so se sentir ignorado quando de fato PODERIA estar vendo alguem.
static volatile bool cameraLigadaRobo = false;
// Sem posicao nova por este tempo, o robo volta ao comportamento normal (idle mode).
// Cobre com folga o intervalo de ~100ms do navegador, entao um engasgo de rede nao
// faz o olhar "soltar" no meio de uma interacao.
#ifndef COGNI_OLHAR_VALIDADE_MS
#define COGNI_OLHAR_VALIDADE_MS 1200UL
#endif

// OLHOS VESGOS DE PERTO: quando a crianca cola o rosto na camera, o robo cruza os
// olhos - como alguem tentando focar algo no proprio nariz. O limiar e o tamanho do
// rosto a partir do qual o efeito comeca; o espaco minimo e o quanto os olhos chegam
// a se aproximar (a RoboEyes aceita espacamento NEGATIVO, que e o que de fato cruza).
#ifndef COGNI_VESGO_LIMIAR
#define COGNI_VESGO_LIMIAR 420
#endif
#ifndef COGNI_VESGO_ESPACO_MIN
#define COGNI_VESGO_ESPACO_MIN -6
#endif
// SENTIR-SE IGNORADO: com a camera ligada, depois de ter visto um rosto, se ninguem
// aparecer por este tempo o robo procura em volta e fica tristinho.
#ifndef COGNI_IGNORADO_MS
#define COGNI_IGNORADO_MS 12000UL
#endif

// Descarta o envelope pendente. Obrigatorio sempre que o audio for jogado fora
// (corte de fala, desconexao): sem isto o rosto continuaria pulsando por centenas de
// milissegundos com som que nunca vai tocar.
static inline void limparEnvelope() { envelopeCauda = envelopeCabeca; }

// ---------------------------------------------------------------------
// Botoes fisicos (4) - replicam as acoes do painel de controle web
// ---------------------------------------------------------------------
struct BotaoFisico {
  uint8_t pino;
  const char* acao;      // enviado ao servidor em payload.acao
  int nivelEstavel;      // ultimo nivel ja debounced (HIGH solto / LOW apertado)
  int nivelBruto;        // ultima leitura crua (para medir a janela de debounce)
  unsigned long mudouEm; // quando a leitura crua mudou pela ultima vez
};
static BotaoFisico botoes[] = {
  { COGNI_PIN_BTN_MIC,         "mute",        HIGH, HIGH, 0 },
  { COGNI_PIN_BTN_CAMERA,      "camera",      HIGH, HIGH, 0 },
  { COGNI_PIN_BTN_INTERROMPER, "interromper", HIGH, HIGH, 0 },
  { COGNI_PIN_BTN_RESET,       "reset",       HIGH, HIGH, 0 },
};
static const size_t NUM_BOTOES = sizeof(botoes) / sizeof(botoes[0]);

// Marca "houve atividade agora" (conversa, botao, (re)conexao) e zera o cochilo por
// inatividade (ver COGNI_INATIVIDADE_SONO_MS).
// ATENCAO ao mover: o pre-processador do .ino injeta os prototipos que ele mesmo gera
// na altura da PRIMEIRA funcao do arquivo. Se esta definicao subir para antes dos
// enums/structs, os prototipos passam a citar tipos ainda nao declarados e o sketch
// nem compila. Por isso ela vive aqui, depois de todas as declaracoes de tipo.
static inline void marcarAtividade() { ultimaAtividadeMs = millis(); }

// True para as reacoes de COMANDO e MATERIA (as duas familias de icone central).
static inline bool reacaoEhComando(Reacao r) { return r >= REACAO_MIC_OFF; }
static inline bool reacaoEhMateria(Reacao r) { return r >= REACAO_MAT_MATEMATICA; }
// ORDEM DOS TESTES: materia PRIMEIRO - ela tambem satisfaz reacaoEhComando (esta
// depois no enum), entao inverter aqui daria a duracao errada silenciosamente.
static inline unsigned long duracaoReacao(Reacao r) {
  if (reacaoEhMateria(r)) return COGNI_MATERIA_DURACAO_MS;
  return reacaoEhComando(r) ? COGNI_COMANDO_DURACAO_MS : COGNI_REACAO_DURACAO_MS;
}

// ---------------------------------------------------------------------
// Logs amigaveis no Serial
// ---------------------------------------------------------------------
static void logInfo(const String& tag, const String& msg) {
  Serial.printf("[%s] %s\n", tag.c_str(), msg.c_str());
}

// Traduz o motivo do ultimo boot. Se o ESP estiver reiniciando ao receber o
// audio (em vez de so cair o WebSocket), isso revela a causa: PANIC = crash de
// software (ex: estouro), TASK_WDT/INT_WDT = travou o loop (watchdog),
// BROWNOUT = queda de tensao na fonte/USB. POWERON = ligou normal.
static void logMotivoDoBoot() {
  esp_reset_reason_t r = esp_reset_reason();
  const char* nome;
  switch (r) {
    case ESP_RST_POWERON:  nome = "POWERON (ligou normal)"; break;
    case ESP_RST_SW:       nome = "SW (ESP.restart proposital)"; break;
    case ESP_RST_PANIC:    nome = "PANIC (crash de software!)"; break;
    case ESP_RST_INT_WDT:  nome = "INT_WDT (watchdog de interrupcao!)"; break;
    case ESP_RST_TASK_WDT: nome = "TASK_WDT (watchdog - loop travou!)"; break;
    case ESP_RST_WDT:      nome = "WDT (watchdog generico!)"; break;
    case ESP_RST_BROWNOUT: nome = "BROWNOUT (queda de tensao na fonte!)"; break;
    case ESP_RST_DEEPSLEEP: nome = "DEEPSLEEP"; break;
    case ESP_RST_EXT:      nome = "EXT (reset externo)"; break;
    default:               nome = "DESCONHECIDO"; break;
  }
  logInfo("Boot", String("Motivo do ultimo boot: ") + nome);
}

// ---------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------
static bool conectarWiFi() {
  logInfo("WiFi", String("Conectando em ") + COGNI_WIFI_SSID + " ...");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  // DESLIGA o power save (modem-sleep) do Wi-Fi. Por padrao o ESP32 adormece o
  // radio ~10s depois de conectar; nesse estado os pacotes recebidos atrasam ate
  // o DTIM do roteador, e o pong do heartbeat WebSocket nao chega a tempo - o
  // servidor entao acha que o robo morreu e derruba a conexao "do nada". Manter o
  // radio sempre ligado e a causa nº1 de desconexao intermitente de WebSocket no
  // ESP32. Custa um pouco mais de energia, mas o robo fica ligado na tomada.
  WiFi.setSleep(false);
  WiFi.begin(COGNI_WIFI_SSID, COGNI_WIFI_PASSWORD);

  const unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - inicio > COGNI_WIFI_TIMEOUT_MS) {
      logInfo("WiFi", "Falha ao conectar dentro do timeout. Reiniciando em 5 s...");
      delay(5000);
      ESP.restart();
      return false;
    }
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  logInfo("WiFi", String("Conectado. IP local: ") + WiFi.localIP().toString());
  logInfo("WiFi", String("RSSI: ") + WiFi.RSSI() + " dBm");
  return true;
}

// ---------------------------------------------------------------------
// Mensagens JSON utilitarias
// ---------------------------------------------------------------------
static void enviarStatus() {
  if (!wsConectado) return;
  JsonDocument doc;
  doc["tipo"] = "status";
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["id"]       = COGNI_ROBO_ID;
  payload["ip"]       = WiFi.localIP().toString();
  payload["rssi"]     = WiFi.RSSI();
  payload["uptimeMs"] = (uint32_t) millis();
  payload["heap"]     = (uint32_t) ESP.getFreeHeap();

  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
}

static void enviarLog(const char* mensagem) {
  if (!wsConectado) return;
  JsonDocument doc;
  doc["tipo"] = "log";
  doc["payload"]["mensagem"] = mensagem;
  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
}

static void enviarConfiguracaoVoz() {
  if (!wsConectado) return;
  JsonDocument doc;
  doc["tipo"] = "voz-config";
  doc["payload"]["usuarioId"] = COGNI_USUARIO_ID;
  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
  logInfo("WS", String("voz-config enviado (usuario=") + COGNI_USUARIO_ID + ")");
}

// Drena bytesNoDma pelo tempo decorrido desde a ultima drenagem: o DMA toca a uma
// taxa CONSTANTE (COGNI_AUDIO_BYTES_POR_MS = 48 B/ms), entao a cada ms que passa
// some 48 bytes do colchao. Chamada tanto ao ESCREVER (antes de somar o lote novo)
// quanto ao LER o nivel, para manter a conta sempre atual. DEVE ser chamada dentro
// da porta critica muxFluxo (mexe em bytesNoDma/dmaAtualizadoMs, tocados por 2 cores).
static inline void drenarDmaPorTempo() {
  const unsigned long agora = millis();
  if (dmaAtualizadoMs == 0) { dmaAtualizadoMs = agora; return; }
  const unsigned long dt = agora - dmaAtualizadoMs;
  if (dt == 0) return;
  const uint32_t drenado = (uint32_t) dt * COGNI_AUDIO_BYTES_POR_MS;
  if (bytesNoDma > drenado) bytesNoDma -= drenado;
  else bytesNoDma = 0;
  dmaAtualizadoMs = agora;
}

static void enviarNivelBuffer() {
  if (!wsConectado) return;
  // Nivel REAL = fila (ainda nao escrita) + colchao do DMA (ja escrito, ainda
  // tocando). Drenamos o DMA pelo tempo antes de somar, para refletir o que de
  // fato ainda nao saiu pelo alto-falante. Ver nota em bytesNoDma.
  uint32_t pend;
  portENTER_CRITICAL(&muxFluxo);
  drenarDmaPorTempo();
  pend = bytesEnfileirados + bytesNoDma;
  portEXIT_CRITICAL(&muxFluxo);

  const uint32_t ms = pend / COGNI_AUDIO_BYTES_POR_MS;

  // JSON fixo e minusculo montado com snprintf num buffer de PILHA, em vez de alocar
  // um JsonDocument + String. Esta funcao roda a cada ~40ms DURANTE a fala; a
  // alocacao/liberacao repetida fragmentava o heap justamente na janela em que a
  // folga importa para os buffers do Wi-Fi/WebSocket - contribuindo para a
  // desconexao "na fala". O campo "heap" (memoria livre) e diagnostico: o servidor
  // rastreia o minimo por fala para revelar pressao de heap.
  char json[128];
  snprintf(json, sizeof(json),
           "{\"tipo\":\"buffer\",\"payload\":{\"ms\":%lu,\"bytes\":%lu,\"gaps\":%lu,\"heap\":%lu}}",
           (unsigned long) ms, (unsigned long) pend,
           (unsigned long) contadorGaps, (unsigned long) ESP.getFreeHeap());
  ws.sendTXT(json);
}

// ---------------------------------------------------------------------
// Botoes fisicos: leitura com debounce e envio ao servidor
// ---------------------------------------------------------------------
// Envia um evento de botao ao servidor. O servidor (tratarBotaoFisico em esp.js)
// mapeia a acao para a MESMA funcao que o painel web usa (mute/camera/interromper/
// reset), mantendo robo e dashboard em sincronia.
static void enviarEventoBotao(const char* acao) {
  if (!wsConectado) return;
  JsonDocument doc;
  doc["tipo"] = "botao";
  doc["payload"]["acao"] = acao;
  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
  logInfo("Botao", String("Pressionado: ") + acao);
}

// Le os 4 botoes no loop (digitalRead e instantaneo, nao bloqueia). Debounce por
// tempo: so confirma a mudanca de nivel quando ela permanece estavel por
// COGNI_BTN_DEBOUNCE_MS. Dispara no flanco de DESCIDA (HIGH->LOW = apertou).
static void lerBotoes() {
  const unsigned long agora = millis();
  for (size_t i = 0; i < NUM_BOTOES; i++) {
    const int leitura = digitalRead(botoes[i].pino);
    if (leitura != botoes[i].nivelBruto) {
      botoes[i].nivelBruto = leitura;
      botoes[i].mudouEm = agora;   // reinicia a janela de debounce
    }
    if (leitura != botoes[i].nivelEstavel && (agora - botoes[i].mudouEm) >= COGNI_BTN_DEBOUNCE_MS) {
      botoes[i].nivelEstavel = leitura;
      if (leitura == LOW) {
        marcarAtividade();   // apertar botao e interacao: acorda o robo se estiver dormindo
        enviarEventoBotao(botoes[i].acao);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Controle do amplificador (pino SD do MAX98357A)
// ---------------------------------------------------------------------
// Liga/desliga fisicamente o amplificador. Mantemos ele DESLIGADO em silencio
// para eliminar o chiado de "amp ligado sem sinal", e ligamos so enquanto a
// Cogni esta falando. Como agora tocamos PCM em streaming, o "fim da fala" e
// detectado por timeout: se nenhum chunk novo chega em COGNI_AMP_GUARDA_MS, a
// fala acabou e desligamos o amp (depois de esvaziar o buffer I2S).
static bool ampLigado = false;

static void ampLigar() {
#if COGNI_PIN_AMP_SD >= 0
  digitalWrite(COGNI_PIN_AMP_SD, HIGH);
  delay(5);   // pequena pausa para o amp estabilizar antes do audio comecar
#endif
  ampLigado = true;
}

static void ampDesligar() {
#if COGNI_PIN_AMP_SD >= 0
  digitalWrite(COGNI_PIN_AMP_SD, LOW);
#endif
  ampLigado = false;
}

// ---------------------------------------------------------------------
// Audio: receber PCM do servidor e tocar direto no I2S (streaming)
// ---------------------------------------------------------------------
// O servidor manda PCM raw (24kHz, 16-bit signed, mono, little-endian) em chunks.
// Tocamos cada chunk assim que chega, duplicando mono->estereo (L=R) e escrevendo
// no I2S. Nao guardamos o audio inteiro (uma resposta tem centenas de KB).

// Devolve um slot do pool para a lista de livres. Seguro chamar de qualquer core.
static inline void devolverSlot(uint16_t slot) {
  xQueueSend(poolLivres, &slot, 0);
}

static void iniciarRecepcaoAudio(size_t tamanho) {
  audioTamanhoEsperado = tamanho;
  audioRecebido = 0;
  recebendoAudio = true;
  audioInterrompido = false;   // nova fala legitima: para de descartar
  ultimoChunkMs = millis();
  ultimoWriteMs = millis();
  // Zera a contabilidade de fluxo para esta nova fala (fila E colchao do DMA). O
  // preload de silencio que ja esta no DMA nao conta como audio a tocar, por isso
  // bytesNoDma comeca em 0 e dmaAtualizadoMs e re-ancorado em agora.
  portENTER_CRITICAL(&muxFluxo);
  bytesEnfileirados = 0;
  bytesNoDma = 0;
  dmaAtualizadoMs = millis();
  portEXIT_CRITICAL(&muxFluxo);
  contadorGaps = 0;
  ultimoNivelMs = millis();
  ampLigar();   // liga o amp para a fala que vai comecar
  logInfo("Audio", String("Recepcao PCM iniciada (") + tamanho + " bytes, heap livre: " + ESP.getFreeHeap() + ")");
}

// PRODUTOR: recebe um chunk binario (PCM mono) do WebSocket e o ENFILEIRA para a
// task de audio tocar. NAO escreve no I2S aqui (isso bloquearia o ws.loop()).
// Pega um SLOT LIVRE do pool (sem malloc!), copia o chunk para ele e enfileira o
// indice. Se nao ha slot livre OU a fila esta cheia, descarta o chunk (raro:
// agora o servidor controla o fluxo pelo nivel de buffer). O `dados` do callback
// e reaproveitado pela lib, por isso copiamos.
static void tocarChunkPcm(uint8_t* dados, size_t len) {
  if (!recebendoAudio || !filaAudio || !poolLivres || len == 0) return;
  if (len > COGNI_AUDIO_POOL_BLOCO_BYTES) len = COGNI_AUDIO_POOL_BLOCO_BYTES;  // blinda overflow do bloco
  ultimoChunkMs = millis();
  audioRecebido += len;

  uint16_t slot;
  if (xQueueReceive(poolLivres, &slot, 0) != pdTRUE) {
    // Pool esgotado: o consumo ficou para tras. Descarta este chunk (o controle
    // de fluxo deve evitar chegar aqui; se acontecer, e so um micro-gap, nao crash).
    return;
  }
  memcpy(poolBuffers[slot], dados, len);

  ChunkAudio item = { slot, (uint16_t) len };
  if (xQueueSend(filaAudio, &item, 10 / portTICK_PERIOD_MS) != pdTRUE) {
    devolverSlot(slot);   // fila cheia: devolve o slot para nao vazar
    return;
  }
  // Contabiliza para o controle de fluxo (este audio ainda nao tocou).
  portENTER_CRITICAL(&muxFluxo);
  bytesEnfileirados += len;
  portEXIT_CRITICAL(&muxFluxo);
}

// CONSUMIDOR (task no core 0): tira chunks da fila e escreve no I2S como estereo
// (L=R; estereo evita o bug de troca de bytes do I2S mono 16-bit no ESP32). O
// i2s_channel_write bloqueia ate ter espaco no DMA - aqui isso e OK, pois esta na
// task, nao no loop(). Trata o write parcial (respeita `escrito`) para nunca
// perder amostra (causa de engasgo). Checa audioInterrompido para descartar
// imediatamente quando o servidor manda "parar-audio". Ao terminar cada chunk,
// devolve o slot ao pool e abate os bytes do contador de fluxo.
static void tarefaAudio(void* arg) {
  static int16_t estereo[256 * 2];   // ate 256 amostras mono por vez -> 512 int16
  ChunkAudio item;
  for (;;) {
    if (xQueueReceive(filaAudio, &item, portMAX_DELAY) != pdTRUE) continue;

    if (audioInterrompido || !txHandle) {
      devolverSlot(item.slot);
      portENTER_CRITICAL(&muxFluxo);
      if (bytesEnfileirados >= item.tamanho) bytesEnfileirados -= item.tamanho;
      else bytesEnfileirados = 0;
      portEXIT_CRITICAL(&muxFluxo);
      continue;
    }

    // Diagnostico de underrun: se a task ficou ociosa por MAIS que a duracao de
    // audio de um bloco (~85ms a 4KB@24kHz) desde o ultimo write, o DMA pode ter
    // secado entre blocos. O limiar de 60ms era sensivel demais: como cada bloco
    // dura ~85ms, esperar perto disso entre blocos e NORMAL, e o contador disparava
    // falsos-positivos. 120ms (>1 bloco) so conta um gap quando de fato houve uma
    // pausa anormal (jitter de rede real). Subir esse contador = secou de verdade.
    const unsigned long agora = millis();
    if (ultimoWriteMs != 0 && (agora - ultimoWriteMs) > 120 && recebendoAudio) {
      contadorGaps++;
    }

    tarefaAudioOcupada = true;
    const int16_t* mono = (const int16_t*) poolBuffers[item.slot];
    const size_t amostras = item.tamanho / 2;

    size_t i = 0;
    while (i < amostras) {
      if (audioInterrompido) break;   // corte imediato no meio do chunk
      size_t lote = amostras - i;
      if (lote > 256) lote = 256;
      // A soma do valor absoluto sai de carona no laco que ja monta o estereo: as
      // amostras estao em registrador, entao custa ~2 instrucoes por amostra (~0,02%
      // de CPU). Media retificada, nao pico: envelope bem mais estavel pelo mesmo
      // preco. O cast pra int32_t importa - abs(-32768) nao cabe em int16_t.
      uint32_t somaAbs = 0;
      for (size_t j = 0; j < lote; j++) {
        const int16_t v = mono[i + j];
        estereo[j * 2]     = v;
        estereo[j * 2 + 1] = v;
        somaAbs += (v < 0) ? (uint32_t) (-(int32_t) v) : (uint32_t) v;
      }
      // Escreve o bloco INTEIRO, respeitando writes parciais (sem perder amostra).
      // Como o canal e estereo (L=R), escrevemos 2x os bytes do audio mono; o
      // colchao do DMA em termos do nosso PCM mono e metade dos bytes escritos.
      const uint8_t* p = (const uint8_t*) estereo;
      const size_t bytesEstereo = lote * 2 * sizeof(int16_t);
      size_t restante = bytesEstereo;
      while (restante > 0 && !audioInterrompido) {
        size_t escrito = 0;
        if (i2s_channel_write(txHandle, p, restante, &escrito, 300 / portTICK_PERIOD_MS) != ESP_OK) break;
        p += escrito;
        restante -= escrito;
      }
      ultimoWriteMs = millis();
      // Este lote entrou no DMA: vira "colchao tocando". Some ao bytesNoDma a
      // PARTE MONO (bytesEstereo / 2), que e a unidade do nosso nivel de buffer.
      // Drena antes para nao inflar o colchao com o tempo ja decorrido.
      portENTER_CRITICAL(&muxFluxo);
      drenarDmaPorTempo();
      bytesNoDma += bytesEstereo / 2;
      const uint32_t colchaoBytes = bytesNoDma;
      portEXIT_CRITICAL(&muxFluxo);

      // ENVELOPE: publica a amplitude deste lote com o instante em que ele vai SOAR.
      // Este lote e o ULTIMO da fila do DMA, entao ele so comeca quando tudo o que
      // estava na frente escoar - ou seja, o colchao MENOS o proprio lote.
      {
        const uint32_t loteMono = bytesEstereo / 2;
        const uint32_t atrasoMs = (colchaoBytes > loteMono ? colchaoBytes - loteMono : 0)
                                  / COGNI_AUDIO_BYTES_POR_MS;
        uint32_t nivel = (somaAbs / lote) / COGNI_FALA_GANHO;
        if (nivel > 255) nivel = 255;
        const uint16_t prox = (envelopeCabeca + 1) & (COGNI_ENVELOPE_RING - 1);
        // Ring cheio: descarta a medida em vez de esperar. Perder um quadro de
        // animacao e irrelevante; travar a task que alimenta o I2S causaria picote.
        if (prox != envelopeCauda) {
          envelopeRing[envelopeCabeca].tocaEmMs = millis() + atrasoMs;
          envelopeRing[envelopeCabeca].nivel    = (uint8_t) nivel;
          // Publica o conteudo ANTES do indice: sem esta barreira o compilador
          // poderia reordenar e a task da tela leria uma entrada pela metade.
          __asm__ __volatile__("" ::: "memory");
          envelopeCabeca = prox;
        }
      }
      i += lote;
    }

    // Chunk inteiramente entregue ao DMA: devolve o slot e abate da FILA (ele saiu
    // da fila; o audio dele agora esta contabilizado em bytesNoDma, acima).
    devolverSlot(item.slot);
    portENTER_CRITICAL(&muxFluxo);
    if (bytesEnfileirados >= item.tamanho) bytesEnfileirados -= item.tamanho;
    else bytesEnfileirados = 0;
    portEXIT_CRITICAL(&muxFluxo);
    tarefaAudioOcupada = false;
  }
}

// Esvazia a fila de audio devolvendo todos os slots pendentes ao pool (usado ao
// interromper). Nao toca no DMA - quem faz isso e pararAudioAgora.
static void esvaziarFilaAudio() {
  if (!filaAudio) return;
  ChunkAudio item;
  while (xQueueReceive(filaAudio, &item, 0) == pdTRUE) {
    devolverSlot(item.slot);
  }
  portENTER_CRITICAL(&muxFluxo);
  bytesEnfileirados = 0;
  portEXIT_CRITICAL(&muxFluxo);
}

static void finalizarRecepcaoAudio() {
  if (!recebendoAudio) return;
  recebendoAudio = false;
  logInfo("Audio", String("PCM recebido: ") + audioRecebido + "/" + audioTamanhoEsperado + " bytes");
  audioTamanhoEsperado = 0;
  audioRecebido = 0;
  // O amp e desligado em atualizarAmp(), apos o buffer I2S esvaziar.
}

// Para a fala AGORA, no meio (comando "parar-audio" do servidor). Diferente do
// audio-fim normal (que deixa o buffer I2S escoar), aqui DESCARTAMOS o que ainda
// nao tocou: i2s_channel_disable para a transmissao na hora e esvazia a fila DMA;
// o enable logo em seguida rearma o canal para a proxima fala (sem re-habilitar,
// o proximo i2s_channel_write falharia). Usado quando a crianca interrompe (voz,
// botao "Parar" ou "Limpar contexto" na interface). recebendoAudio=false faz o
// guard de tocarChunkPcm descartar quaisquer chunks atrasados que ainda cheguem.
static void pararAudioAgora() {
  // Ordem importa: (1) sinaliza para parar de aceitar/tocar, (2) esvazia a fila,
  // (3) zera o DMA. A task checa audioInterrompido e abandona o chunk em curso.
  recebendoAudio = false;
  audioInterrompido = true;
  audioTamanhoEsperado = 0;
  audioRecebido = 0;
  esvaziarFilaAudio();
  if (txHandle) {
    i2s_channel_disable(txHandle);   // para na hora e esvazia a fila DMA
    i2s_channel_enable(txHandle);    // rearma para a proxima fala
  }
  // O disable acima esvaziou o DMA fisicamente: zera o colchao contabilizado para
  // o nivel de buffer nao reportar audio que ja nao existe mais.
  portENTER_CRITICAL(&muxFluxo);
  bytesNoDma = 0;
  dmaAtualizadoMs = millis();
  portEXIT_CRITICAL(&muxFluxo);
  // Pelo mesmo motivo, joga fora o envelope pendente: aquele audio nao vai soar, e
  // sem isto o rosto continuaria "falando" sozinho depois do corte.
  limparEnvelope();
  ampDesligar();
  logInfo("Audio", "Fala interrompida (parar-audio): fila e I2S zerados, amp desligado");
}

// Chamado a cada loop: desliga o amp com seguranca quando a fala acabou. Com a
// task de audio, "acabou" = NAO esta mais recebendo (recebendoAudio=false) E a
// fila esta vazia E a task nao esta escrevendo E passou o tempo de guarda desde
// o ultimo write da TASK (nao desde a recepcao - senao cortaria o fim da fala
// enquanto a task ainda drena a fila).
static void atualizarAmp() {
  if (!ampLigado) return;
  if (recebendoAudio) return;
  if (uxQueueMessagesWaiting(filaAudio) > 0) return;
  if (tarefaAudioOcupada) return;
  if (millis() - ultimoWriteMs >= COGNI_AMP_GUARDA_MS) {
    ampDesligar();
    logInfo("Audio", "Amp desligado (fim da fala, silencio)");
  }
}

// ---------------------------------------------------------------------
// Microfone INMP441 (preparado, mas so envia se a flag estiver ligada)
// ---------------------------------------------------------------------
static void configurarMicI2S() {
  // Cria o canal de RX no port I2S 1 (o port 0 fica para a saida de audio).
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  // Aumenta a folga do buffer DMA (padrao 6x240 ~= 90ms). Como o loop tambem
  // toca o PCM da saida e roda ws.loop(), um pico de processamento poderia
  // "engolir" amostras do mic. 8x256 ~= 128ms de folga evita esses gaps.
  chanCfg.dma_desc_num = 8;
  chanCfg.dma_frame_num = 256;
  esp_err_t err = i2s_new_channel(&chanCfg, nullptr, &micRxHandle);
  if (err != ESP_OK) {
    logInfo("Mic", String("Falha em i2s_new_channel: ") + esp_err_to_name(err));
    micRxHandle = nullptr;
    return;
  }

  // Modo "standard" (Philips I2S), 32 bits mono no slot esquerdo.
  // O INMP441 entrega 24 bits uteis dentro de uma palavra de 32 bits.
  i2s_std_config_t stdCfg = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(COGNI_MIC_SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t) COGNI_PIN_I2S_IN_SCK,
      .ws   = (gpio_num_t) COGNI_PIN_I2S_IN_WS,
      .dout = I2S_GPIO_UNUSED,
      .din  = (gpio_num_t) COGNI_PIN_I2S_IN_SD,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };
  // O INMP441 entrega o dado no slot esquerdo (pino L/R em GND).
  stdCfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;

  err = i2s_channel_init_std_mode(micRxHandle, &stdCfg);
  if (err != ESP_OK) {
    logInfo("Mic", String("Falha em init_std_mode: ") + esp_err_to_name(err));
    i2s_del_channel(micRxHandle);
    micRxHandle = nullptr;
    return;
  }

  err = i2s_channel_enable(micRxHandle);
  if (err != ESP_OK) {
    logInfo("Mic", String("Falha em channel_enable: ") + esp_err_to_name(err));
    i2s_del_channel(micRxHandle);
    micRxHandle = nullptr;
    return;
  }

  logInfo("Mic", "INMP441 inicializado (I2S port 1, driver novo)");
}

// ---------------------------------------------------------------------
// Saida de audio I2S para o MAX98357A (port 0, driver novo)
// ---------------------------------------------------------------------
// Configura o canal TX para tocar o PCM 24kHz, 16-bit, ESTEREO. O servidor manda
// PCM mono; duplicamos para estereo (L=R) em tocarChunkPcm. Usar estereo evita o
// bug de troca de bytes do I2S mono 16-bit no ESP32.
static void configurarSaidaI2S() {
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  // Buffer DMA generoso: e o "colchao" FISICO que segura a reproducao enquanto os
  // chunks chegam pela rede. E a ULTIMA linha de defesa contra o picote: quando o
  // buffer de software (fila) seca por um instante de jitter de Wi-Fi, e este DMA
  // que continua tocando som. 32x256 quadros ~= 340ms de folga (subimos de 24x256 =
  // ~256ms). Subimos porque, mesmo com o look-ahead de sintese e o controle de fluxo
  // do servidor, um unico soluco de rede ainda virava picote AUDIVEL com 256ms -
  // 340ms cobre esse jitter com folga. Custo: ~+8KB de RAM DMA (32*256*4 = ~32KB vs
  // 24*256*4 = ~24KB). LIMITES do driver i2s_std (ESP-IDF): dma_frame_num <= 511 e o
  // buffer POR descriptor (frame_num*canais*bytes = 256*2*2 = 1024B) <= 4092B - os
  // dois OK aqui. dma_desc_num e so o NUMERO de buffers (cada um alocado a parte); 32
  // e seguro. Se faltar heap (ver o log de heap no boot), baixe para 28.
  chanCfg.dma_desc_num = 32;
  chanCfg.dma_frame_num = 256;
  esp_err_t err = i2s_new_channel(&chanCfg, &txHandle, nullptr);
  if (err != ESP_OK) {
    logInfo("Audio", String("Falha em i2s_new_channel (saida): ") + esp_err_to_name(err));
    txHandle = nullptr;
    return;
  }

  i2s_std_config_t stdCfg = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(COGNI_AUDIO_OUT_SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t) COGNI_PIN_I2S_OUT_BCLK,
      .ws   = (gpio_num_t) COGNI_PIN_I2S_OUT_LRC,
      .dout = (gpio_num_t) COGNI_PIN_I2S_OUT_DIN,
      .din  = I2S_GPIO_UNUSED,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };

  err = i2s_channel_init_std_mode(txHandle, &stdCfg);
  if (err != ESP_OK) {
    logInfo("Audio", String("Falha em init_std_mode (saida): ") + esp_err_to_name(err));
    i2s_del_channel(txHandle);
    txHandle = nullptr;
    return;
  }

  // PRELOAD de silencio antes de habilitar: enche o DMA com zeros para que, ao
  // chegar o primeiro audio, ele toque IMEDIATO sobre um colchao ja cheio (em vez
  // de partir de um DMA vazio que seca no primeiro hiccup). E a forma oficial do
  // ESP-IDF de reduzir o atraso/instabilidade inicial. Precisa ser feito com o
  // canal ainda DESABILITADO (apos init_std_mode, antes de channel_enable).
  {
    static const uint8_t silencio[512] = {0};   // 128 quadros estereo de zero
    size_t carregado = 0;
    size_t total = 0;
    // Carrega ate o DMA recusar mais (retorna carregado < enviado), enchendo o colchao.
    for (int i = 0; i < 64; i++) {
      esp_err_t pe = i2s_channel_preload_data(txHandle, silencio, sizeof(silencio), &carregado);
      total += carregado;
      if (pe != ESP_OK || carregado < sizeof(silencio)) break;
    }
    logInfo("Audio", String("DMA pre-carregado com ") + total + " bytes de silencio");
  }

  err = i2s_channel_enable(txHandle);
  if (err != ESP_OK) {
    logInfo("Audio", String("Falha em channel_enable (saida): ") + esp_err_to_name(err));
    i2s_del_channel(txHandle);
    txHandle = nullptr;
    return;
  }

  // Colchao de DMA em ms = desc * frames / (sample_rate/1000). Com 32x256 a 24kHz:
  // 32*256/24 = ~341ms de folga fisica. Logamos pra confirmar o colchao e o heap
  // livre apos alocar o DMA (o descriptor sai da RAM interna; se o heap cair demais,
  // o WiFi sofre - por isso medimos).
  const uint32_t colchaoDmaMs = (32u * 256u * 1000u) / COGNI_AUDIO_OUT_SAMPLE_RATE;
  logInfo("Audio", String("Saida I2S inicializada (port 0, ") + COGNI_AUDIO_OUT_SAMPLE_RATE
          + "Hz estereo, colchao DMA ~" + colchaoDmaMs + "ms, heap livre: " + ESP.getFreeHeap() + ")");
}

// Le um bloco do mic, converte para PCM 16 bits mono e envia ao servidor
// como mensagem binaria. O servidor (esp-pipeline.js) faz VAD por energia,
// detecta inicio/fim de fala, transcreve (Whisper), gera a resposta da Cogni
// e devolve o PCM para o ESP tocar. So roda se COGNI_MIC_ENVIAR_AO_SERVIDOR
// for true (para nao desperdicar bateria/CPU no modo "so saida").
static void capturarEEnviarMic() {
  if (!micRxHandle) return;

  // ANTI-ECO + responsividade: enquanto o robo esta tocando a resposta (ou o amp
  // ainda esta ligado dentro da guarda pos-fala), NAO capturamos nem enviamos o
  // mic. Dois ganhos:
  //   1) corta o caminho fisico do eco na origem - o mic nao reenvia o som do
  //      proprio alto-falante, entao o robo nao se auto-responde num loop;
  //   2) libera o loop() durante a fala (nao roda a leitura I2S bloqueante de
  //      ~20ms), mantendo o ws.loop() responsivo - o que ajuda a evitar a
  //      desconexao por pong atrasado.
  // O servidor tambem tem uma janela anti-eco (barge-in por energia) como segunda
  // camada, caso reste algum rabo de audio no buffer I2S.
  if (recebendoAudio || ampLigado) return;

  static int32_t bufferEntrada[COGNI_MIC_BUFFER_BYTES / 4];
  static int16_t bufferEnvio  [COGNI_MIC_BUFFER_BYTES / 4];

  // Leitura com timeout pequeno (nao zero). A 16 kHz, encher o buffer leva
  // ~64 ms; com timeout 0 (nao-bloqueante) a leitura voltava vazia na maioria
  // das iteracoes do loop e o bloco era descartado. 20 ms espera o DMA encher
  // sem travar o ws.loop().
  size_t bytesLidos = 0;
  esp_err_t r = i2s_channel_read(micRxHandle, bufferEntrada, sizeof(bufferEntrada), &bytesLidos, 20 / portTICK_PERIOD_MS);
  if (r != ESP_OK || bytesLidos == 0) return;

  const size_t amostras = bytesLidos / 4;

#if COGNI_MIC_DEBUG
  // ----- Diagnostico temporario -----
  // Acumula a energia ao longo de ~1 s e imprime UMA linha legivel, ja dizendo
  // se o trecho parece FALA ou SILENCIO (com base no pico bruto). Mostra o RMS
  // resultante com varios ganhos para escolhermos o COGNI_MIC_SHIFT que coloca
  // a fala acima do limiar de VAD do servidor (padrao 800).
  static unsigned long janelaInicioMs = 0;
  static double accSoma11 = 0, accSoma12 = 0, accSoma14 = 0;
  static int32_t accPico = 0;
  static uint32_t accAmostras = 0;
  if (janelaInicioMs == 0) janelaInicioMs = millis();

  for (size_t i = 0; i < amostras; i++) {
    const int32_t bruto = bufferEntrada[i];
    const int32_t abs32 = bruto < 0 ? -bruto : bruto;
    if (abs32 > accPico) accPico = abs32;
    const int32_t s11 = bruto >> 11;
    const int32_t s12 = bruto >> 12;
    const int32_t s14 = bruto >> 14;
    accSoma11 += (double) s11 * s11;
    accSoma12 += (double) s12 * s12;
    accSoma14 += (double) s14 * s14;
  }
  accAmostras += amostras;

  if (millis() - janelaInicioMs >= 1000 && accAmostras > 0) {
    const double rms11 = sqrt(accSoma11 / accAmostras);
    const double rms12 = sqrt(accSoma12 / accAmostras);
    const double rms14 = sqrt(accSoma14 / accAmostras);
    // Heuristica simples: pico bruto alto => provavelmente houve fala na janela.
    const char* tipo = (accPico > 2000000) ? "FALA?   " : "silencio";
    Serial.printf("[MicDbg] %s pico=%8ld | RMS >>14=%5.0f  >>12=%5.0f  >>11=%5.0f  (VAD servidor=800)\n",
                  tipo, (long) accPico, rms14, rms12, rms11);
    janelaInicioMs = millis();
    accSoma11 = accSoma12 = accSoma14 = 0;
    accPico = 0;
    accAmostras = 0;
  }
#endif

  // Estado do filtro DC blocker - precisa sobreviver entre chamadas (cada
  // chamada processa so um bloco; o filtro e continuo ao longo do tempo).
  static float dcX1 = 0.0f, dcY1 = 0.0f;

  for (size_t i = 0; i < amostras; i++) {
    // 1) DC blocker / passa-alta de 1a ordem sobre a amostra bruta de 32 bits,
    //    em float, ANTES do shift (preserva resolucao). Tira DC e graves.
    const float x = (float) bufferEntrada[i];
    const float y = x - dcX1 + COGNI_MIC_DC_R * dcY1;
    dcX1 = x;
    dcY1 = y;

    // 2) INMP441 entrega 24 bits no MSB de uma palavra de 32. O deslocamento
    //    define o ganho efetivo: quanto menor, mais "alto" o sinal enviado.
    //    Com shift menor (mais ganho) a voz alta pode estourar o int16, entao
    //    limitamos (clamp) a faixa valida antes de converter, evitando o
    //    "wrap-around" que viraria um estalo no audio.
    int32_t amostra = (int32_t) y >> COGNI_MIC_SHIFT;
    if (amostra > 32767) amostra = 32767;
    else if (amostra < -32768) amostra = -32768;
    bufferEnvio[i] = (int16_t) amostra;
  }
  if (wsConectado) {
    ws.sendBIN((uint8_t*) bufferEnvio, amostras * sizeof(int16_t));
  }
}

// ---------------------------------------------------------------------
// Callback principal do WebSocket
// ---------------------------------------------------------------------
static void onWsEvent(WStype_t tipo, uint8_t* payload, size_t length) {
  switch (tipo) {
    case WStype_DISCONNECTED: {
      wsConectado = false;
      // Se a conexao caiu no meio de uma recepcao de audio, o estado ficaria
      // "preso recebendo" e o amp poderia ficar ligado chiando. Zera tudo (e a
      // fila da task) e desliga o amp para um (re)start limpo.
      recebendoAudio = false;
      audioTamanhoEsperado = 0;
      audioRecebido = 0;
      audioInterrompido = true;
      esvaziarFilaAudio();   // zera bytesEnfileirados
      limparEnvelope();      // e o envelope pendente (audio que nao vai mais soar)
      // Zera tambem o colchao do DMA contabilizado, para o nivel nao carregar
      // audio de uma fala interrompida pela queda (iniciarRecepcaoAudio rezera na
      // proxima fala, mas mantemos o estado limpo aqui por consistencia).
      // dmaAtualizadoMs=0 e a sentinela "nao inicializado" que drenarDmaPorTempo
      // trata (re-ancora no proximo write em vez de drenar um intervalo gigante).
      portENTER_CRITICAL(&muxFluxo);
      bytesNoDma = 0;
      dmaAtualizadoMs = 0;
      portEXIT_CRITICAL(&muxFluxo);
      ampDesligar();
      logInfo("WS", "Desconectado do servidor Cogni (tentando reconectar...)");
      break;
    }

    case WStype_CONNECTED: {
      wsConectado = true;
      // Acorda ao (re)conectar: o robo abre os olhos e so volta a cochilar depois de
      // COGNI_INATIVIDADE_SONO_MS parado - senao ele acordaria ja com o prazo vencido.
      marcarAtividade();
      // Reforca o power save desligado: algumas reconexoes do Wi-Fi reativam o
      // modem-sleep, que e justamente o que derruba o WebSocket.
      WiFi.setSleep(false);
      logInfo("WS", String("Conectado em ") + (const char*) payload);
      enviarStatus();
      enviarConfiguracaoVoz();
      enviarLog("ESP32 controle online");
      break;
    }

    case WStype_TEXT: {
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        logInfo("WS", String("JSON invalido: ") + err.c_str());
        return;
      }
      const char* t = doc["tipo"] | "";

      if (strcmp(t, "bem-vindo") == 0) {
        const char* id = doc["payload"]["id"] | "";
        logInfo("WS", String("bem-vindo recebido. id servidor=") + id);

      } else if (strcmp(t, "audio-inicio") == 0) {
        const size_t tamanho = doc["payload"]["tamanho"] | 0;
        iniciarRecepcaoAudio(tamanho);

      } else if (strcmp(t, "audio-fim") == 0) {
        finalizarRecepcaoAudio();

      } else if (strcmp(t, "parar-audio") == 0) {
        pararAudioAgora();

      } else if (strcmp(t, "expressao") == 0) {
        // O servidor informa o estado da conversa (e o mute) para os olhos do robo
        // reagirem: ouvindo/pensando/pesquisando/falando/idle. A task da tela le
        // estadoConversa e aplica a expressao correspondente. O mute NAO muda mais o
        // rosto (mutado = repouso normal); ele so serve para detectar que alguem mexeu
        // no mic - pelo botao ou pelo painel web - e acordar o robo se estiver dormindo.
        const char* estado = doc["payload"]["estado"] | "";
        const bool mutado = doc["payload"]["mutado"] | false;
        if (mutado != micMutadoRobo) marcarAtividade();
        micMutadoRobo = mutado;
        // Estado da webcam do painel. Sem ele o robo nao consegue diferenciar "estou
        // sendo ignorado" (camera ligada e ninguem aparece) de "estou sem camera" - e
        // ficaria se sentindo abandonado toda vez que a webcam estivesse desligada.
        cameraLigadaRobo = doc["payload"]["camera"] | false;
        if      (strcmp(estado, "ouvindo") == 0)     estadoConversa = CONV_OUVINDO;
        else if (strcmp(estado, "pensando") == 0)    estadoConversa = CONV_PENSANDO;
        else if (strcmp(estado, "pesquisando") == 0) estadoConversa = CONV_PESQUISANDO;
        else if (strcmp(estado, "falando") == 0)     estadoConversa = CONV_FALANDO;
        else                                         estadoConversa = CONV_IDLE;

      } else if (strcmp(t, "olhar") == 0) {
        // Posicao do rosto da crianca (0..1) detectada na webcam do painel. Chega a
        // ~10Hz: guardamos o alvo e saimos - quem move os olhos e a task da tela.
        // NAO chama marcarAtividade: estar em frente a camera nao e conversar, e o
        // robo nao deveria ficar acordado a noite toda so porque tem gente na sala.
        const float x = doc["payload"]["x"] | 0.5f;
        const float y = doc["payload"]["y"] | 0.5f;
        // `t` = largura do rosto no quadro, nossa unica medida de DISTANCIA. Zero (ou
        // ausente, se o painel for de uma versao anterior) significa "nao sei", e ai o
        // robo simplesmente nao fica vesgo.
        const float tam = doc["payload"]["t"] | 0.0f;
        alvoOlharX = (int16_t) (constrain(x, 0.0f, 1.0f) * 1000.0f);
        alvoOlharY = (int16_t) (constrain(y, 0.0f, 1.0f) * 1000.0f);
        alvoOlharTam = (int16_t) (constrain(tam, 0.0f, 1.0f) * 1000.0f);
        ultimoOlharMs = millis();

      } else if (strcmp(t, "reacao") == 0) {
        // Reacao pontual disparada pelo CONTEUDO (elogio/piada/duvida...): a task da
        // tela sobrepoe a animacao ao rosto de estado por COGNI_REACAO_DURACAO_MS.
        const char* emo = doc["payload"]["emocao"] | "";
        Reacao r = REACAO_NENHUMA;
        if      (strcmp(emo, "amor") == 0)      r = REACAO_AMOR;
        else if (strcmp(emo, "riso") == 0)      r = REACAO_RISO;
        else if (strcmp(emo, "confuso") == 0)   r = REACAO_CONFUSO;
        else if (strcmp(emo, "surpresa") == 0)  r = REACAO_SURPRESA;
        else if (strcmp(emo, "triste") == 0)    r = REACAO_TRISTE;
        else if (strcmp(emo, "suor") == 0)      r = REACAO_SUOR;
        else if (strcmp(emo, "piscadela") == 0) r = REACAO_PISCADELA;
        else if (strcmp(emo, "celebra") == 0)   r = REACAO_CELEBRA;
        else if (strcmp(emo, "ideia") == 0)     r = REACAO_IDEIA;
        // Feedback dos comandos do painel (web ou botao fisico - o servidor manda nos
        // dois casos). Nomes com hifen espelham as acoes da interface.
        else if (strcmp(emo, "mic-off") == 0)    r = REACAO_MIC_OFF;
        else if (strcmp(emo, "mic-on") == 0)     r = REACAO_MIC_ON;
        else if (strcmp(emo, "parar") == 0)      r = REACAO_PARAR;
        else if (strcmp(emo, "reset") == 0)      r = REACAO_RESET;
        else if (strcmp(emo, "camera-on") == 0)  r = REACAO_CAM_ON;
        else if (strcmp(emo, "camera-off") == 0) r = REACAO_CAM_OFF;
        else if (strcmp(emo, "ola") == 0)        r = REACAO_OLA;
        else if (strcmp(emo, "tchau") == 0)      r = REACAO_TCHAU;
        // Materia do assunto (classificada no servidor a partir da fala da crianca).
        else if (strcmp(emo, "materia-matematica") == 0) r = REACAO_MAT_MATEMATICA;
        else if (strcmp(emo, "materia-ciencias") == 0)   r = REACAO_MAT_CIENCIAS;
        else if (strcmp(emo, "materia-portugues") == 0)  r = REACAO_MAT_PORTUGUES;
        else if (strcmp(emo, "materia-historia") == 0)   r = REACAO_MAT_HISTORIA;
        else if (strcmp(emo, "materia-geografia") == 0)  r = REACAO_MAT_GEOGRAFIA;
        else if (strcmp(emo, "materia-idiomas") == 0)    r = REACAO_MAT_IDIOMAS;
        if (r != REACAO_NENHUMA) {
          // Reagir e interagir: se estava cochilando, acorda para mostrar a animacao
          // (senao o feedback do botao se perderia atras dos olhos fechados).
          marcarAtividade();
          reacaoAteMs = millis() + duracaoReacao(r);
          reacaoAtiva = r;   // seta por ultimo: a task so ve a reacao com o prazo ja valido
        }

      } else if (strcmp(t, "andar") == 0 || strcmp(t, "girar") == 0) {
        // No MVP de audio nao ha motores nem servos. Apenas registra.
        logInfo("WS", String("Comando recebido (sem hardware no MVP): ") + t);

      } else {
        logInfo("WS", String("Mensagem desconhecida: ") + t);
      }
      break;
    }

    case WStype_BIN: {
      tocarChunkPcm(payload, length);
      break;
    }

    case WStype_PING:
    case WStype_PONG:
      break;

    case WStype_ERROR: {
      logInfo("WS", "Erro no socket (a lib vai reconectar automaticamente)");
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------
// Olhos do robo (tela OLED): mapeia o estado da conversa em expressoes
// ---------------------------------------------------------------------
// Deriva a expressao EFETIVA a partir do estado local (mais imediato) e do estado
// que o servidor informou. Prioridade: desconectado > falando (local) > estado do
// servidor > cochilo por inatividade > repouso.
static Rosto calcularRosto() {
  if (!wsConectado) return ROSTO_DORMINDO;

  // recebendoAudio antes do estado do servidor: a fala de saida e o sinal mais
  // imediato que o firmware tem (o "falando" do servidor pode chegar depois).
  Rosto ativo = ROSTO_IDLE;
  if (recebendoAudio) {
    ativo = ROSTO_FALANDO;
  } else {
    switch (estadoConversa) {
      case CONV_OUVINDO:     ativo = ROSTO_OUVINDO;     break;
      case CONV_PENSANDO:    ativo = ROSTO_PENSANDO;    break;
      case CONV_PESQUISANDO: ativo = ROSTO_PESQUISANDO; break;
      case CONV_FALANDO:     ativo = ROSTO_FALANDO;     break;
      default:               ativo = ROSTO_IDLE;        break;
    }
  }

  // Enquanto ha conversa em curso, renova o relogio da inatividade aqui mesmo: assim
  // o cochilo so comeca a contar a partir do instante em que TUDO parou, sem precisar
  // marcar atividade em cada ponto do pipeline de audio.
  if (ativo != ROSTO_IDLE) {
    marcarAtividade();
    return ativo;
  }

  if (millis() - ultimaAtividadeMs >= COGNI_INATIVIDADE_SONO_MS) return ROSTO_DORMINDO;
  return ROSTO_IDLE;
}

// Aplica uma expressao aos olhos. Chamada SO na transicao (nao a cada frame), para
// nao reiniciar as animacoes internas da RoboEyes. Cada caso primeiro normaliza os
// modificadores (flicker/curiosidade) e depois configura mood/posicao/piscar.
static void aplicarRosto(Rosto r) {
  roboEyes.setHFlicker(OFF, 0);
  roboEyes.setVFlicker(OFF, 0);
  roboEyes.setCuriosity(OFF);
  switch (r) {
    case ROSTO_DORMINDO:     // desconectado do servidor OU ocioso ha muito tempo
      roboEyes.setAutoblinker(OFF, 1, 1);
      roboEyes.setIdleMode(OFF, 1, 1);
      roboEyes.setMood(TIRED);
      roboEyes.setPosition(DEFAULT);
      roboEyes.close();
      break;
    case ROSTO_OUVINDO:      // atento, olhando pra frente
      roboEyes.setMood(DEFAULT);
      roboEyes.setIdleMode(OFF, 1, 1);
      roboEyes.setPosition(DEFAULT);
      roboEyes.open();
      roboEyes.setAutoblinker(ON, 4, 2);
      roboEyes.setCuriosity(ON);
      break;
    case ROSTO_PENSANDO:     // olhar pra cima, pensativo
      roboEyes.setMood(DEFAULT);
      roboEyes.setIdleMode(OFF, 1, 1);
      roboEyes.open();
      roboEyes.setAutoblinker(ON, 4, 2);
      roboEyes.setPosition(N);
      break;
    case ROSTO_PESQUISANDO:  // varredura horizontal continua, tipo scanner
      roboEyes.setMood(DEFAULT);
      roboEyes.open();
      roboEyes.setAutoblinker(ON, 4, 2);
      // idleMode DESLIGADO: ele reposicionava aos saltos, em intervalos aleatorios.
      // Quem move os olhos aqui e animarVarredura(), quadro a quadro.
      roboEyes.setIdleMode(OFF, 1, 1);
      roboEyes.setCuriosity(ON);   // o olho da ponta cresce nos extremos do percurso
      break;
    case ROSTO_FALANDO:      // alegre e animado; a altura pulsa com a voz (animarFala)
      roboEyes.setMood(HAPPY);
      roboEyes.setIdleMode(OFF, 1, 1);
      roboEyes.setPosition(DEFAULT);
      roboEyes.open();
      // Autoblinker DESLIGADO aqui: a lib pisca escrevendo eyeLheightNext, e o
      // envelope da fala reescreve esse mesmo campo todo quadro - a piscada seria
      // engolida sem nenhum aviso. Quem pisca durante a fala e a propria animarFala.
      roboEyes.setAutoblinker(OFF, 3, 2);
      break;
    case ROSTO_IDLE:         // repouso: olhando em volta e piscando sozinho
    default:
      roboEyes.setMood(DEFAULT);
      roboEyes.setPosition(DEFAULT);
      roboEyes.open();
      roboEyes.setAutoblinker(ON, 3, 2);
      roboEyes.setIdleMode(ON, 2, 2);
      break;
  }
}

// Aplica o ENVELOPE DA FALA na altura dos olhos. Chamada a cada frame da task da
// tela (e SO no ramo sem reacao, entao nunca briga com REACAO_SURPRESA, que tambem
// mexe na altura). Retorna true enquanto estiver no controle da altura.
//
// Escreve eyeLheightNext/eyeRheightNext DIRETO em vez de usar setHeight(): o setter
// tambem redefine o ...Default interno da lib, o que estragaria a centralizacao
// vertical e a geometria das palpebras de forma permanente.
static bool animarFala() {
  static uint8_t suave = 0;             // envelope suavizado (0..255)
  static bool controlando = false;      // ja mexemos na altura? (precisa devolver)
  static unsigned long proximaPiscadaMs = 0;
  static unsigned long piscandoAteMs = 0;

  // Consome tudo o que JA deveria estar soando. Pode haver mais de uma amostra por
  // quadro: o audio produz a cada ~10,7ms e a tela desenha, na melhor das hipoteses, a
  // cada 20ms (COGNI_OLED_FPS) - na pratica ~23ms, que e o tempo de empurrar o frame
  // inteiro pelo I2C a 400kHz. Fica com a ultima madura; a primeira que ainda nao
  // "chegou a hora" interrompe o laco.
  int bruto = -1;
  while (envelopeCauda != envelopeCabeca) {
    const AmostraEnvelope& a = envelopeRing[envelopeCauda];
    if ((long) (millis() - a.tocaEmMs) < 0) break;   // ainda nao soou: espera
    bruto = a.nivel;
    envelopeCauda = (envelopeCauda + 1) & (COGNI_ENVELOPE_RING - 1);
  }

  // Ataque rapido (10/16 = ~1 quadro) e decaimento lento (2/16 = ~8 quadros): o olho
  // abre no ataque da silaba e fecha macio, como uma boca. Tudo em inteiro - nada de
  // float no caminho quente da animacao.
  const int alvo = (bruto >= 0) ? bruto : 0;
  const int k = (alvo > (int) suave) ? 10 : 2;
  int delta = ((alvo - (int) suave) * k) / 16;
  // PISO DE 1: divisao inteira trunca em direcao a zero, entao com suave pequeno o
  // decaimento vira exatamente 0 ((0-7)*2/16 == 0) e o envelope FICA PRESO - o rosto
  // congelaria num pulso baixo e nunca devolveria a altura padrao. Simulado: sem
  // este piso ele empaca em 7/255 pra sempre; com ele zera em ~0,9s.
  if (delta == 0 && alvo != (int) suave) delta = (alvo > (int) suave) ? 1 : -1;
  suave = (uint8_t) ((int) suave + delta);

  if (suave == 0 && !controlando) return false;   // silencio total: nem entra

  // Piscada propria: com a altura sendo escrita a cada quadro, o autoblinker da lib
  // seria sobrescrito sem aviso (ele roda ANTES da nossa escrita, no update()).
  const unsigned long agora = millis();
  if (proximaPiscadaMs == 0) proximaPiscadaMs = agora + COGNI_FALA_PISCADA_MIN_MS;
  if (piscandoAteMs == 0 && (long) (agora - proximaPiscadaMs) >= 0) {
    piscandoAteMs = agora + 90;   // olho fechado por ~4 quadros
    proximaPiscadaMs = agora + random(COGNI_FALA_PISCADA_MIN_MS, COGNI_FALA_PISCADA_MAX_MS);
  }

  if (piscandoAteMs != 0 && (long) (agora - piscandoAteMs) < 0) {
    roboEyes.eyeLheightNext = roboEyes.eyeRheightNext = 1;   // piscando
  } else {
    piscandoAteMs = 0;
    const int base = roboEyes.eyeLheightDefault - (COGNI_FALA_AMPLITUDE / 2);
    const int altura = base + ((int) suave * COGNI_FALA_AMPLITUDE) / 255;
    roboEyes.eyeLheightNext = roboEyes.eyeRheightNext = altura;
  }
  controlando = true;

  if (suave == 0) {   // decaiu ate o fim: devolve a altura padrao e solta o controle
    roboEyes.eyeLheightNext = roboEyes.eyeRheightNext = roboEyes.eyeLheightDefault;
    controlando = false;
    piscandoAteMs = 0;
    proximaPiscadaMs = 0;
    return false;
  }
  return true;
}

// Move os olhos na direcao do rosto detectado pela webcam. Retorna false quando nao
// ha alvo fresco - ai o rosto volta a se virar sozinho (idle mode da lib).
//
// O X e ESPELHADO de proposito: a webcam mostra a cena como um espelho, entao quando
// a crianca anda pra direita dela, o rosto vai pra ESQUERDA na imagem. Sem inverter,
// o robo olharia sempre pro lado oposto de onde ela esta.
static bool animarOlhar(Rosto rosto) {
  if (millis() - ultimoOlharMs > COGNI_OLHAR_VALIDADE_MS) {
    // Sem alvo fresco: desfaz um eventual "vesgo" para os olhos nao ficarem cruzados
    // depois que a crianca saiu de vista. Escrevemos so o ...Next e deixamos a lib
    // caminhar ate ele, entao o descruzar sai suave de graca.
    roboEyes.spaceBetweenNext = roboEyes.spaceBetweenDefault;
    return false;
  }

  const int alvoX = (1000 - alvoOlharX) * roboEyes.getScreenConstraint_X() / 1000;
  int alvoY = alvoOlharY * roboEyes.getScreenConstraint_Y() / 1000;

  // PENSANDO olha pra cima - mas aplicarRosto() so faz isso na TRANSICAO (setPosition(N)),
  // e nos reescrevemos eyeLyNext a cada quadro. Resultado: com a camera ligada o olhar
  // pensativo simplesmente sumia, porque o alvo do rosto detectado ganhava sempre.
  // Aqui os dois convivem: seguimos a crianca no horizontal (que e o que da a sensacao
  // de "ele me olha") mas puxamos o vertical pra cima, preservando a pose pensativa.
  if (rosto == ROSTO_PENSANDO) alvoY /= 3;
  // Persegue por aproximacao (1/4 da distancia por quadro) em vez de saltar: o
  // detector entrega a posicao aos degraus de 100ms e o olho ficaria "tremendo".
  roboEyes.eyeLxNext += (alvoX - roboEyes.eyeLxNext) / 4;
  roboEyes.eyeLyNext += (alvoY - roboEyes.eyeLyNext) / 4;

  // VESGO DE PERTO: passando do limiar de proximidade, os olhos vao se aproximando ate
  // cruzar. E proporcional (nao um liga/desliga) para nao "estalar" quando a crianca
  // fica oscilando em volta do limiar - ela chega perto e ve os olhos cruzarem AO VIVO,
  // que e onde esta a graca. Espacamento negativo e suportado pela lib de proposito.
  const int tam = alvoOlharTam;
  if (tam > COGNI_VESGO_LIMIAR) {
    const int faixa = 1000 - COGNI_VESGO_LIMIAR;
    const int excesso = tam - COGNI_VESGO_LIMIAR;
    const int padrao = roboEyes.spaceBetweenDefault;
    roboEyes.spaceBetweenNext = padrao - ((padrao - COGNI_VESGO_ESPACO_MIN) * excesso) / faixa;
  } else {
    roboEyes.spaceBetweenNext = roboEyes.spaceBetweenDefault;
  }
  return true;
}

// Varredura horizontal continua do rosto PESQUISANDO ("procurando..."), chamada a
// cada frame enquanto esse rosto estiver ativo.
//
// Escreve SO eyeLxNext de proposito: a lib recalcula eyeRxNext = eyeLxNext + largura
// + espacamento a cada frame (drawEyes), entao escrever no olho direito seria no-op -
// os dois andam como um par rigido, que e justamente o efeito desejado.
//
// O cosseno da o ease-in-out nos extremos (desacelera antes de voltar) e a propria
// lib ainda faz uma media com a posicao atual, o que suaviza mais um pouco.
static void animarVarredura() {
  const float fase = (millis() % COGNI_VARREDURA_PERIODO_MS) / (float) COGNI_VARREDURA_PERIODO_MS;
  const float amplitude = roboEyes.getScreenConstraint_X() / 2.0f;
  roboEyes.eyeLxNext = (int) (amplitude * (1.0f - cosf(fase * 2.0f * PI)));
  // Y travado no centro: este e o unico rosto que nao chama setPosition(), entao sem
  // isto ele herdaria o Y do rosto anterior - vindo de PENSANDO (que olha pra cima),
  // a varredura acontecia colada no topo da tela.
  roboEyes.eyeLyNext = roboEyes.getScreenConstraint_Y() / 2;
}

// Micro-movimentos involuntarios: sacadas (saltinhos aleatorios) + respiracao (balanco
// vertical lento e continuo). Some um deslocamento de poucos pixels por cima de onde
// quer que os olhos ja estejam, sem tomar o controle de ninguem.
//
// POR QUE APLICAMOS A DIFERENCA, E NAO O OFFSET: eyeLxNext/eyeLyNext sao ALVOS
// PERSISTENTES - a lib caminha ate eles e os mantem entre um quadro e outro. Somar o
// offset a cada quadro faria ele se ACUMULAR (2px por quadro, 50 quadros por segundo)
// e em pouco mais de um segundo os olhos estariam fora da tela. Entao guardamos quanto
// ja foi aplicado e mexemos so no que mudou; o efeito liquido e o offset atual, uma
// vez so. Quando `ativo` e falso, o alvo vai a zero e o deslocamento se desfaz sozinho
// - sem precisar de nenhuma limpeza especial em quem chama.
//
// Nao mexemos na ALTURA de proposito: altura e o campo que o autoblinker e o envelope
// da fala disputam, e escrever ali todo quadro engoliria as piscadas em silencio (a
// mesma armadilha ja documentada em aplicarRosto).
static void animarVivacidade(bool ativo) {
  static int aplicadoX = 0, aplicadoY = 0;      // quanto do offset ja esta na posicao
  static int sacadaX = 0, sacadaY = 0;
  static unsigned long proximaSacadaMs = 0;

  int alvoX = 0, alvoY = 0;
  if (ativo) {
    const unsigned long agora = millis();
    if ((long) (agora - proximaSacadaMs) >= 0) {
      sacadaX = random(-COGNI_SACADA_AMPLITUDE, COGNI_SACADA_AMPLITUDE + 1);
      sacadaY = random(-COGNI_SACADA_AMPLITUDE, COGNI_SACADA_AMPLITUDE + 1);
      proximaSacadaMs = agora + random(COGNI_SACADA_MIN_MS, COGNI_SACADA_MAX_MS);
    }
    // Respiracao: seno completo no periodo configurado, entao ele sobe e desce de
    // volta sem nenhum salto na virada do ciclo.
    const float fase = (millis() % COGNI_RESPIRACAO_PERIODO_MS) / (float) COGNI_RESPIRACAO_PERIODO_MS;
    const int respiro = (int) (COGNI_RESPIRACAO_AMPLITUDE * sinf(fase * 2.0f * PI));
    alvoX = sacadaX;
    alvoY = sacadaY + respiro;
  }

  roboEyes.eyeLxNext += (alvoX - aplicadoX);
  roboEyes.eyeLyNext += (alvoY - aplicadoY);
  aplicadoX = alvoX;
  aplicadoY = alvoY;
}

// ---------------------------------------------------------------------
// Reacoes pontuais (one-shot) sobre os olhos
// ---------------------------------------------------------------------
// Desenha um coracao preenchido centrado em (cx, cy) com "tamanho" s (metade da
// largura). Dois lobulos circulares no topo + um triangulo apontando pra baixo.
// Usa as primitivas do Adafruit_GFX pelo ponteiro publico da RoboEyes (roboEyes.
// display) - a lib nao tem sprite de coracao, entao desenhamos por cima.
static void desenharCoracao(int cx, int cy, int s) {
  const int lobulo = s / 2;             // raio de cada lobulo do topo
  const int topoY = cy - lobulo / 2;    // centro Y dos lobulos
  roboEyes.display->fillCircle(cx - lobulo + 1, topoY, lobulo, SSD1306_WHITE);
  roboEyes.display->fillCircle(cx + lobulo - 1, topoY, lobulo, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx - s, topoY, cx + s, topoY, cx, cy + s, SSD1306_WHITE);
}

// Desenha uma estrela de 4 pontas (sparkle) centrada em (cx, cy), "raio" r. Quatro
// triangulos finos a partir do centro (cima/baixo/esquerda/direita). Usada na reacao
// IDEIA ("aprendi algo!") - os olhos viram estrelinhas.
static void desenharEstrela(int cx, int cy, int r) {
  const int b = r / 3;   // meia-largura da base de cada ponta
  roboEyes.display->fillTriangle(cx, cy - r, cx - b, cy, cx + b, cy, SSD1306_WHITE); // cima
  roboEyes.display->fillTriangle(cx, cy + r, cx - b, cy, cx + b, cy, SSD1306_WHITE); // baixo
  roboEyes.display->fillTriangle(cx - r, cy, cx, cy - b, cx, cy + b, SSD1306_WHITE); // esquerda
  roboEyes.display->fillTriangle(cx + r, cy, cx, cy - b, cx, cy + b, SSD1306_WHITE); // direita
}

// ---------------------------------------------------------------------
// Icones de COMANDO (feedback visual das acoes do painel)
// ---------------------------------------------------------------------
// Risco diagonal de "desligado" (mic mutado, camera off). O icone e branco sobre
// fundo preto, entao uma linha branca simples sumiria dentro dele: desenhamos antes
// uma faixa PRETA de 5px (abre um vao no icone) e so depois a linha branca no meio.
static void desenharRisco(int x0, int y0, int x1, int y1) {
  for (int d = -2; d <= 2; d++) {
    roboEyes.display->drawLine(x0 + d, y0, x1 + d, y1, SSD1306_BLACK);
  }
  roboEyes.display->drawLine(x0, y0, x1, y1, SSD1306_WHITE);
}

// Microfone de podcast: capsula arredondada, suporte em U, haste e base. Com
// `comOndas`, dois arcos laterais indicam que ele esta CAPTANDO (desmutado).
static void desenharMicrofone(int cx, int cy, bool comOndas) {
  roboEyes.display->fillRoundRect(cx - 7, cy - 20, 14, 22, 7, SSD1306_WHITE);
  roboEyes.display->drawLine(cx - 12, cy - 4, cx - 12, cy + 3, SSD1306_WHITE);   // U esquerdo
  roboEyes.display->drawLine(cx + 12, cy - 4, cx + 12, cy + 3, SSD1306_WHITE);   // U direito
  roboEyes.display->drawLine(cx - 12, cy + 3, cx + 12, cy + 3, SSD1306_WHITE);   // base do U
  roboEyes.display->drawLine(cx, cy + 3, cx, cy + 12, SSD1306_WHITE);            // haste
  roboEyes.display->drawLine(cx - 7, cy + 13, cx + 7, cy + 13, SSD1306_WHITE);   // pe
  if (comOndas) {
    // drawCircleHelper desenha UM quadrante: 0x1=sup-esq, 0x2=sup-dir, 0x4=inf-dir,
    // 0x8=inf-esq. Somando os dois de cada lado sai um arco vertical (a "onda").
    // Raios 20/25 a partir de (cx, cy-6) para o arco caber inteiro na altura de 64px -
    // maior que isso o topo da onda sai da tela e o desenho fica "cortado".
    roboEyes.display->drawCircleHelper(cx, cy - 6, 20, 0x2 | 0x4, SSD1306_WHITE);
    roboEyes.display->drawCircleHelper(cx, cy - 6, 20, 0x1 | 0x8, SSD1306_WHITE);
    roboEyes.display->drawCircleHelper(cx, cy - 6, 25, 0x2 | 0x4, SSD1306_WHITE);
    roboEyes.display->drawCircleHelper(cx, cy - 6, 25, 0x1 | 0x8, SSD1306_WHITE);
  }
}

// Duas barras de PAUSA: o "opa, parei" de quando cortam a fala do robo.
static void desenharPausa(int cx, int cy) {
  roboEyes.display->fillRoundRect(cx - 13, cy - 15, 9, 30, 3, SSD1306_WHITE);
  roboEyes.display->fillRoundRect(cx + 4,  cy - 15, 9, 30, 3, SSD1306_WHITE);
}

// Seta circular de "recomecar" (limpar contexto). O anel e um circulo cheio com um
// menor preto por dentro; `meiaVolta` troca o lado do vao e da ponta, e alternar isso
// quadro a quadro faz a seta parecer GIRAR - sem custo de rotacao real.
static void desenharSetaReset(int cx, int cy, bool meiaVolta) {
  roboEyes.display->fillCircle(cx, cy, 17, SSD1306_WHITE);
  roboEyes.display->fillCircle(cx, cy, 11, SSD1306_BLACK);
  if (meiaVolta) {
    roboEyes.display->fillRect(cx - 20, cy + 2, 20, 20, SSD1306_BLACK);            // vao embaixo/esq
    roboEyes.display->fillTriangle(cx - 2, cy + 21, cx - 2, cy + 7, cx - 15, cy + 14, SSD1306_WHITE);
  } else {
    roboEyes.display->fillRect(cx, cy - 22, 20, 20, SSD1306_BLACK);                // vao em cima/dir
    roboEyes.display->fillTriangle(cx + 2, cy - 21, cx + 2, cy - 7, cx + 15, cy - 14, SSD1306_WHITE);
  }
}

// Camera: corpo arredondado com visor e a lente vazada (anel + brilho no meio).
static void desenharCamera(int cx, int cy) {
  roboEyes.display->fillRect(cx + 2, cy - 19, 13, 6, SSD1306_WHITE);        // visor no topo
  roboEyes.display->fillRoundRect(cx - 21, cy - 14, 42, 28, 5, SSD1306_WHITE);
  roboEyes.display->fillCircle(cx, cy, 10, SSD1306_BLACK);                  // vao da lente
  roboEyes.display->drawCircle(cx, cy, 7, SSD1306_WHITE);                   // aro
  roboEyes.display->fillCircle(cx, cy, 3, SSD1306_WHITE);                   // brilho
}

// "Flash" da camera ligando: raios curtos irradiando do icone. De proposito NAO
// usamos fillScreen(WHITE) - acender a tela inteira puxa corrente de sobra e este
// projeto ja teve brownout por causa da OLED; oito linhas custam praticamente nada.
static void desenharFlash(int cx, int cy, int raioInterno, int raioExterno) {
  for (int i = 0; i < 8; i++) {
    const float a = i * (PI / 4.0f);
    const int dx = (int) (cos(a) * raioInterno), dy = (int) (sin(a) * raioInterno);
    const int fx = (int) (cos(a) * raioExterno), fy = (int) (sin(a) * raioExterno);
    roboEyes.display->drawLine(cx + dx, cy + dy, cx + fx, cy + fy, SSD1306_WHITE);
  }
}

// ---------------------------------------------------------------------
// Icones das MATERIAS (o assunto da conversa aparece no rosto)
// ---------------------------------------------------------------------
// Matematica: um "+" grande no centro, ladeado por "x" e ":" menores.
static void desenharMatematica(int cx, int cy) {
  roboEyes.display->fillRect(cx - 4, cy - 18, 9, 36, SSD1306_WHITE);   // haste vertical
  roboEyes.display->fillRect(cx - 18, cy - 4, 37, 9, SSD1306_WHITE);   // haste horizontal
  const int lx = cx - 38, rx = cx + 38;
  roboEyes.display->drawLine(lx - 7, cy - 7, lx + 7, cy + 7, SSD1306_WHITE);   // "x"
  roboEyes.display->drawLine(lx - 7, cy + 7, lx + 7, cy - 7, SSD1306_WHITE);
  roboEyes.display->fillCircle(rx, cy - 8, 2, SSD1306_WHITE);                  // ":"
  roboEyes.display->fillCircle(rx, cy + 8, 2, SSD1306_WHITE);
  roboEyes.display->drawLine(rx - 7, cy, rx + 7, cy, SSD1306_WHITE);
}

// Ciencias: erlenmeyer com liquido no fundo e bolhas subindo pelo espaco vazio.
// O liquido e desenhado como TRAPEZIO explicito (dois triangulos) em vez de "pintar
// tudo e apagar o topo": apagar com um retangulo comia as paredes inclinadas do
// frasco na parte estreita, e sobrava um liquido flutuando sem vidro em volta.
static void desenharCiencias(int cx, int cy) {
  roboEyes.display->fillRect(cx - 5, cy - 24, 10, 10, SSD1306_WHITE);   // gargalo
  roboEyes.display->fillTriangle(cx - 20, cy + 18, cx + 20, cy + 18, cx, cy - 16, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx - 15, cy + 14, cx + 15, cy + 14, cx, cy - 9, SSD1306_BLACK);
  // Trapezio do liquido: 8px de meia-largura no nivel de cima (onde o interior do
  // frasco e mais estreito) abrindo para 15px no fundo, acompanhando as paredes.
  roboEyes.display->fillTriangle(cx - 8, cy + 3, cx + 8, cy + 3, cx + 15, cy + 14, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx - 8, cy + 3, cx + 15, cy + 14, cx - 15, cy + 14, SSD1306_WHITE);
  // Bolhas subindo no vazio acima do liquido (fase derivada de millis: sem estado
  // proprio, nada a resetar quando a reacao acaba).
  for (int i = 0; i < 3; i++) {
    const uint32_t t = (millis() + i * 420) % 1260;
    const int y = cy + 1 - (int) (t * 10 / 1260);
    roboEyes.display->drawCircle(cx - 5 + i * 5, y, 2, SSD1306_WHITE);
  }
}

// Portugues: livro aberto (duas paginas, lombada no meio, linhas de texto).
static void desenharPortugues(int cx, int cy) {
  roboEyes.display->fillRoundRect(cx - 24, cy - 15, 22, 30, 3, SSD1306_WHITE);
  roboEyes.display->fillRoundRect(cx + 2, cy - 15, 22, 30, 3, SSD1306_WHITE);
  roboEyes.display->drawLine(cx, cy - 17, cx, cy + 17, SSD1306_WHITE);   // lombada
  for (int i = 0; i < 3; i++) {   // "linhas" de texto vazadas em preto
    const int y = cy - 7 + i * 7;
    roboEyes.display->drawLine(cx - 20, y, cx - 6, y, SSD1306_BLACK);
    roboEyes.display->drawLine(cx + 6, y, cx + 20, y, SSD1306_BLACK);
  }
}

// Historia: ampulheta (le muito melhor que pergaminho/coluna em 128x64 mono).
static void desenharHistoria(int cx, int cy) {
  roboEyes.display->fillRect(cx - 16, cy - 20, 32, 4, SSD1306_WHITE);   // tampa de cima
  roboEyes.display->fillRect(cx - 16, cy + 16, 32, 4, SSD1306_WHITE);   // tampa de baixo
  roboEyes.display->fillTriangle(cx - 14, cy - 16, cx + 14, cy - 16, cx, cy, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx - 14, cy + 16, cx + 14, cy + 16, cx, cy, SSD1306_WHITE);
}

// Geografia: globo (circulo + equador + dois meridianos feitos de meios-arcos).
static void desenharGeografia(int cx, int cy) {
  roboEyes.display->drawCircle(cx, cy, 20, SSD1306_WHITE);
  roboEyes.display->drawLine(cx - 20, cy, cx + 20, cy, SSD1306_WHITE);   // equador
  roboEyes.display->drawLine(cx, cy - 20, cx, cy + 20, SSD1306_WHITE);   // meridiano central
  // Meridianos laterais: dois arcos estreitos, um abrindo pra cada lado.
  roboEyes.display->drawCircleHelper(cx - 10, cy, 20, 0x2 | 0x4, SSD1306_WHITE);
  roboEyes.display->drawCircleHelper(cx + 10, cy, 20, 0x1 | 0x8, SSD1306_WHITE);
}

// Idiomas: dois baloes de fala conversando (o halo preto separa um do outro).
static void desenharIdiomas(int cx, int cy) {
  roboEyes.display->fillRoundRect(cx - 24, cy - 18, 28, 20, 4, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx - 18, cy + 2, cx - 8, cy + 2, cx - 16, cy + 9, SSD1306_WHITE);
  // Halo: apaga uma borda em volta do balao da frente pra ele nao "colar" no de tras.
  roboEyes.display->fillRoundRect(cx - 6, cy - 4, 32, 24, 5, SSD1306_BLACK);
  roboEyes.display->fillRoundRect(cx - 4, cy - 2, 28, 20, 4, SSD1306_WHITE);
  roboEyes.display->fillTriangle(cx + 4, cy + 18, cx + 14, cy + 18, cx + 12, cy + 25, SSD1306_WHITE);
}

// Despacha o icone da materia (chamado pelo frame custom da task da tela).
static void desenharMateria(Reacao r, int cx, int cy) {
  switch (r) {
    case REACAO_MAT_MATEMATICA: desenharMatematica(cx, cy); break;
    case REACAO_MAT_CIENCIAS:   desenharCiencias(cx, cy);   break;
    case REACAO_MAT_PORTUGUES:  desenharPortugues(cx, cy);  break;
    case REACAO_MAT_HISTORIA:   desenharHistoria(cx, cy);   break;
    case REACAO_MAT_GEOGRAFIA:  desenharGeografia(cx, cy);  break;
    case REACAO_MAT_IDIOMAS:    desenharIdiomas(cx, cy);    break;
    default: break;
  }
}

// Reacoes desenhadas QUADRO A QUADRO (icones custom no lugar dos olhos), que NAO usam
// roboEyes.update(). As demais usam as animacoes da propria RoboEyes.
static inline bool reacaoEhDesenhoCustom(Reacao r) {
  return r == REACAO_AMOR || r == REACAO_IDEIA ||
         (reacaoEhComando(r) && r != REACAO_OLA && r != REACAO_TCHAU);
}

// Repertorio de reacoes ESPONTANEAS do idle (vida propria). A tabela e uma urna com
// REPETICAO: quantas vezes uma reacao aparece aqui e o peso dela no sorteio. A ideia e
// que o robo pareca ter tiques (a piscadinha, discreta, o tempo todo) e mimos raros
// (coracao/ideia), que valem justamente por serem raros - se um coracao aparecesse a
// cada 10 segundos ele deixaria de significar qualquer coisa.
//
// Pesos: piscadela 4/12 (33%), surpresa/confuso/riso 2/12 (17% cada), amor e ideia
// 1/12 (8% cada). A versao anterior prometia isso no comentario mas dava peso igual a
// quase tudo - o coracao saia com a mesma frequencia da piscada.
static const Reacao ANIM_ESPONTANEAS[] = {
  REACAO_PISCADELA, REACAO_PISCADELA, REACAO_PISCADELA, REACAO_PISCADELA,
  REACAO_SURPRESA,  REACAO_SURPRESA,
  REACAO_CONFUSO,   REACAO_CONFUSO,
  REACAO_RISO,      REACAO_RISO,
  REACAO_AMOR,
  REACAO_IDEIA,
};

static void agendarProximaAnimEspontanea() {
  proximaAnimEspontaneaMs = millis() + random(COGNI_IDLE_ANIM_MIN_MS, COGNI_IDLE_ANIM_MAX_MS);
}

// Dispara uma reacao espontanea aleatoria (setando o mesmo estado que o servidor
// setaria). Chamada pela task quando o robo esta ocioso e o intervalo estourou.
//
// NUNCA REPETE A ULTIMA: sorteio uniforme puro produz repeticoes seguidas com
// frequencia alta demais, e e exatamente isso que denuncia que ha um script rodando -
// duas surpresas identicas em sequencia matam a ilusao de vida mais rapido do que um
// repertorio pequeno. Tentamos algumas vezes e desistimos (se todas caiu na mesma,
// deixa passar - e melhor repetir do que travar).
static void dispararAnimacaoEspontanea() {
  static Reacao ultimaEspontanea = REACAO_NENHUMA;
  const int n = sizeof(ANIM_ESPONTANEAS) / sizeof(ANIM_ESPONTANEAS[0]);
  Reacao escolhida = ANIM_ESPONTANEAS[random(n)];
  for (int tentativa = 0; tentativa < 4 && escolhida == ultimaEspontanea; tentativa++) {
    escolhida = ANIM_ESPONTANEAS[random(n)];
  }
  ultimaEspontanea = escolhida;
  reacaoAteMs = millis() + duracaoReacao(escolhida);
  reacaoAtiva = escolhida;   // seta por ultimo (prazo ja valido)
}

// Aplica o efeito INICIAL de uma reacao (na transicao pra ela). As animacoes
// one-shot da RoboEyes (anim_laugh/anim_confused) duram ~500ms e sao re-armadas na
// task; os modificadores (sweat/mood/height) ficam ate limparReacao. AMOR nao tem
// setup: e desenhado quadro a quadro (coracoes) na task.
static void iniciarReacao(Reacao r) {
  switch (r) {
    case REACAO_RISO:
    case REACAO_CELEBRA:
      roboEyes.setMood(HAPPY); roboEyes.open(); roboEyes.anim_laugh(); break;
    case REACAO_CONFUSO:
      roboEyes.setMood(DEFAULT); roboEyes.open(); roboEyes.anim_confused(); break;
    case REACAO_SUOR:
      roboEyes.setMood(DEFAULT); roboEyes.open(); roboEyes.setSweat(ON); break;
    case REACAO_TRISTE:
      roboEyes.setMood(TIRED); roboEyes.setPosition(S); roboEyes.open(); break;
    case REACAO_SURPRESA:
      roboEyes.setMood(DEFAULT); roboEyes.setPosition(DEFAULT);
      roboEyes.setHeight(48, 48);   // olhos arregalados (altura default = 36)
      roboEyes.open(); break;
    case REACAO_PISCADELA:
      roboEyes.setMood(HAPPY); roboEyes.open(); roboEyes.blink(true, false); break; // pisca so o olho esquerdo
    case REACAO_OLA:     // entrou no modo robo: acorda animado e da um "oi" piscando
      roboEyes.setMood(HAPPY); roboEyes.setPosition(DEFAULT); roboEyes.open();
      roboEyes.blink(true, false); break;
    case REACAO_TCHAU:   // saiu do modo robo: olhar cai, despedida sonolenta
      roboEyes.setMood(TIRED); roboEyes.setPosition(S); roboEyes.open(); break;
    case REACAO_AMOR:    // desenho custom (coracoes) - sem setup aqui
    case REACAO_IDEIA:   // desenho custom (estrelas)  - sem setup aqui
    default:
      break;
  }
}

// Desfaz os efeitos PERSISTENTES que aplicarRosto nao reseta sozinho. O resto
// (mood/posicao/flicker/curiosidade/autoblinker) e normalizado no proximo
// aplicarRosto - a task forca reaplicar o rosto de estado ao sair da reacao.
static void limparReacao(Reacao r) {
  if (r == REACAO_SUOR) roboEyes.setSweat(OFF);
  // setHeight redefine o "default" interno da lib, entao restauramos com o valor
  // ORIGINAL capturado no boot (nao com o eyeLheightDefault, ja sobrescrito).
  if (r == REACAO_SURPRESA) roboEyes.setHeight(alturaOlhoPadrao, alturaOlhoPadrao);
}

// Monta um frame 100% CUSTOM: a tela deixa de ser um rosto e vira um icone (coracoes,
// estrelas, microfone, pausa, o simbolo da materia...). Fica numa funcao propria - e
// nao dentro da task - para o laco de animacao continuar legivel e para o gate de FPS
// que a chama ficar obvio.
//
// De proposito NAO chamamos roboEyes.update() aqui: ele limparia a tela e redesenharia
// os olhos por cima do icone. Quem limpa e publica o frame somos nos.
//
// Convencao visual: EMOCAO ocupa os dois olhos (dois desenhos lado a lado); COMANDO e
// MATERIA desenham UM icone no centro.
static void desenharFrameCustom(Reacao r, bool pulsoGrande, unsigned long inicioReacaoMs) {
  roboEyes.display->clearDisplay();
  const int cx = COGNI_OLED_LARGURA / 2, cy = COGNI_OLED_ALTURA / 2;
  switch (r) {
    case REACAO_AMOR: {
      const int s = pulsoGrande ? 16 : 13;
      desenharCoracao(41, 30, s);
      desenharCoracao(87, 30, s);
      break;
    }
    case REACAO_IDEIA: {
      const int s = pulsoGrande ? 13 : 10;
      desenharEstrela(41, 30, s);
      desenharEstrela(87, 30, s);
      break;
    }
    case REACAO_MIC_OFF:
      desenharMicrofone(cx, cy, false);
      desenharRisco(cx - 22, cy - 24, cx + 22, cy + 20);
      break;
    case REACAO_MIC_ON:
      desenharMicrofone(cx, cy, pulsoGrande);   // ondas piscando = voltou a captar
      break;
    case REACAO_PARAR:
      desenharPausa(cx + (pulsoGrande ? 2 : -2), cy);   // treme = freada brusca
      break;
    case REACAO_RESET:
      desenharSetaReset(cx, cy, pulsoGrande);   // alterna o vao = parece girar
      break;
    case REACAO_CAM_ON:
      desenharCamera(cx, cy);
      if (millis() - inicioReacaoMs < 260) desenharFlash(cx, cy, 26, 32);
      break;
    case REACAO_CAM_OFF:
      desenharCamera(cx, cy);
      desenharRisco(cx - 25, cy - 21, cx + 25, cy + 21);
      break;
    default:
      // Materia do assunto: o desenho e escolhido pelo despachante.
      if (reacaoEhMateria(r)) desenharMateria(r, cx, cy);
      break;
  }
  roboEyes.display->display();
}

// Inicializa o I2C remapeado e a tela; liga a RoboEyes. Retorna sem marcar telaOk
// se a tela nao responder (fiacao/endereco errado) - o robo segue funcionando sem
// rosto. Desenha um primeiro frame para dar feedback visual ja no boot.
static void configurarTela() {
  Wire.begin(COGNI_PIN_OLED_SDA, COGNI_PIN_OLED_SCL);
  // NAO chame Wire.setClock() aqui: a Adafruit_SSD1306 reaplica a propria velocidade
  // (o clkDuring do construtor) a cada transferencia e restaura outra depois, entao
  // qualquer ajuste nosso neste ponto seria sobrescrito silenciosamente. Quem manda na
  // velocidade da tela e o COGNI_OLED_I2C_HZ, la na declaracao do display.
  if (!display.begin(SSD1306_SWITCHCAPVCC, COGNI_OLED_ADDR)) {
    telaOk = false;
    logInfo("Tela", "OLED nao encontrada no I2C (verifique fiacao SDA/SCL e o endereco)");
    return;
  }
  telaOk = true;
  roboEyes.begin(COGNI_OLED_LARGURA, COGNI_OLED_ALTURA, COGNI_OLED_FPS);
  alturaOlhoPadrao = roboEyes.eyeLheightDefault;   // guarda antes de qualquer reacao mexer
  randomSeed(micros());                            // varia o suficiente pras anim espontaneas
  agendarProximaAnimEspontanea();                  // agenda a 1a "vida propria"
  aplicarRosto(ROSTO_IDLE);   // estado inicial ate o servidor informar algo
  roboEyes.update();          // primeiro frame ja no boot
  logInfo("Tela", "OLED + RoboEyes inicializados");
}

// Task dedicada (core 0, prioridade baixa) que anima os olhos. Fica FORA do loop()
// para nao competir com o ws.loop() (core 1) nem com a leitura do mic. A RoboEyes
// respeita o proprio teto de FPS dentro de update(); o vTaskDelay cede a CPU - a
// task de audio (prioridade maior) sempre tem preferencia no core 0.
static void tarefaOlho(void* arg) {
  Rosto ultimoRosto = (Rosto) 255;       // valor impossivel: forca a 1a aplicacao
  Reacao ultimaReacao = REACAO_NENHUMA;
  unsigned long ultimoRedisparoMs = 0;   // re-arma anim_laugh/confused (duram ~500ms)
  unsigned long ultimoPulsoMs = 0;       // pulsar dos icones custom (coracao/estrela)
  unsigned long ultimoFrameCustomMs = 0; // gate de FPS do desenho custom (ver abaixo)
  unsigned long inicioReacaoMs = 0;      // quando a reacao atual comecou (flash da camera)
  bool pulsoGrande = false;
  bool seguindoRosto = false;            // se estamos perseguindo o alvo da webcam
  bool jaViuAlguem = false;              // ja houve um rosto em algum momento?
  bool sentiuFalta = false;              // ja reagiu a esta ausencia? (evita looping)

  for (;;) {
    Reacao r = reacaoAtiva;

    // Reacao expirada: desfaz o efeito e volta ao rosto de estado.
    if (r != REACAO_NENHUMA && (long)(millis() - reacaoAteMs) >= 0) {
      limparReacao(r);
      reacaoAtiva = REACAO_NENHUMA;
      r = REACAO_NENHUMA;
      ultimoRosto = (Rosto) 255;
    }

    if (r != REACAO_NENHUMA) {
      if (r != ultimaReacao) {             // transicao: limpa a anterior e arma a nova
        if (ultimaReacao != REACAO_NENHUMA) limparReacao(ultimaReacao);
        iniciarReacao(r);
        ultimaReacao = r;
        ultimoRedisparoMs = inicioReacaoMs = millis();
        ultimoRosto = (Rosto) 255;         // ao sair da reacao, reaplica o rosto
      }

      // O icone de materia e mostrado ANTES da resposta; se a fala comecar com ele
      // ainda no ar, encurta o prazo. Sem isto o ramo de reacao continuaria vencendo
      // o rosto e a tela ficaria parada no icone enquanto a voz toca (parece travado).
      if (reacaoEhMateria(r) && recebendoAudio) {
        const unsigned long limite = millis() + COGNI_MATERIA_CORTE_FALA_MS;
        if ((long)(reacaoAteMs - limite) > 0) reacaoAteMs = limite;
      }
      if (reacaoEhDesenhoCustom(r)) {
        // GATE DE QUADROS: este ramo monta o frame na mao e, ao contrario do
        // roboEyes.update(), NAO passa pelo teto de FPS da biblioteca. Sem o gate ele
        // redesenhava a cada volta do laco (5ms = 200Hz) contra um barramento que
        // entrega ~43 quadros/s - a task ficava presa no I2C sem nenhum ganho visual,
        // roubando fatia do core 0 a toa. Usamos o MESMO intervalo da RoboEyes, para o
        // rosto e os icones andarem na mesma cadencia.
        if (millis() - ultimoFrameCustomMs >= roboEyes.frameInterval) {
          ultimoFrameCustomMs = millis();
          if (millis() - ultimoPulsoMs > 220) { pulsoGrande = !pulsoGrande; ultimoPulsoMs = millis(); }
          desenharFrameCustom(r, pulsoGrande, inicioReacaoMs);
        }
      } else {
        // Re-arma as animacoes one-shot da lib pra tremer/rir o tempo todo enquanto
        // a reacao vale, em vez de disparar so uma vez.
        if ((r == REACAO_RISO || r == REACAO_CELEBRA) && millis() - ultimoRedisparoMs > 520) {
          roboEyes.anim_laugh(); ultimoRedisparoMs = millis();
        } else if (r == REACAO_CONFUSO && millis() - ultimoRedisparoMs > 520) {
          roboEyes.anim_confused(); ultimoRedisparoMs = millis();
        }
        roboEyes.update();
      }
    } else {
      ultimaReacao = REACAO_NENHUMA;
      const Rosto atual = calcularRosto();
      if (atual != ultimoRosto) {
        aplicarRosto(atual);
        // PISCADA COMO PONTUACAO: uma piscada curta na troca de estado marca a
        // mudanca de pensamento, do mesmo jeito que um corte de cena no cinema. Sem
        // ela a transicao entre "ouvindo" e "pensando" e so um deslize dos olhos e
        // passa despercebida; com ela o robo parece ter TOMADO uma decisao.
        // Excecoes: DORMINDO (olho ja fechado, piscar nao faz sentido) e FALANDO (o
        // envelope reescreve a altura todo quadro e engoliria a piscada em silencio -
        // a fala tem a propria piscada, dentro de animarFala).
        if (ultimoRosto != (Rosto) 255 && atual != ROSTO_DORMINDO && atual != ROSTO_FALANDO) {
          roboEyes.blink();
        }
        ultimoRosto = atual;
      }
      // Animacoes CONTINUAS do rosto atual (rodam a cada frame, ao contrario do
      // aplicarRosto, que so roda na transicao).
      if (atual == ROSTO_PESQUISANDO) {
        animarVarredura();   // a varredura tem prioridade: ele esta procurando algo
      } else if (atual != ROSTO_DORMINDO) {
        // Segue o rosto da crianca em todos os outros estados (menos dormindo, que
        // e olho fechado). O idleMode da lib move os olhos sozinho e brigaria com o
        // alvo, entao so um dos dois fica ligado por vez.
        const bool seguindo = animarOlhar(atual);
        if (seguindo != seguindoRosto) {
          seguindoRosto = seguindo;
          if (seguindo) roboEyes.setIdleMode(OFF, 1, 1);
          else aplicarRosto(atual);   // devolve o comportamento padrao do rosto
        }
      }
      // Envelope da fala: NAO usa `atual == ROSTO_FALANDO` como gate. O rosto volta
      // pra idle assim que o servidor manda o fim, mas ainda ha ate ~340ms de audio
      // no DMA - quem manda parar e o proprio envelope secar.
      // Micro-movimentos por cima de tudo o que ja foi decidido acima. Fora em dois
      // casos: DORMINDO (olho fechado, nao ha o que tremer) e PESQUISANDO, onde a
      // varredura escreve a posicao de forma ABSOLUTA a cada quadro e atrapalharia a
      // contabilidade de "quanto ja apliquei" - e, de qualquer forma, ali ja ha
      // movimento de sobra.
      animarVivacidade(atual != ROSTO_DORMINDO && atual != ROSTO_PESQUISANDO);

      const bool pulsando = animarFala();
      if (pulsando && atual != ROSTO_FALANDO) {
        // Sobrou fala tocando fora do rosto FALANDO: mantem os olhos abertos pra
        // altura escrita nao ficar disputando com um rosto de olho fechado.
        roboEyes.open();
      }
      roboEyes.update();

      // SENTIR-SE IGNORADO: a camera esta ligada, o robo JA viu um rosto em algum
      // momento, e faz muito tempo que ninguem aparece. Ele reage uma vez - fica
      // tristinho - e so volta a reagir depois de ver alguem de novo. Sem esse
      // "so uma vez" ele ficaria em looping de tristeza com a sala vazia, o que e
      // deprimente em vez de fofo.
      //
      // Repare que nao precisamos de nenhuma mensagem nova do servidor: o painel
      // simplesmente PARA de mandar posicao quando nao ha rosto, e o silencio e a
      // informacao. Por isso a checagem da camera importa - sem ela, camera desligada
      // (que tambem e silencio) seria confundida com abandono.
      if (atual == ROSTO_IDLE && cameraLigadaRobo && jaViuAlguem &&
          !sentiuFalta && (millis() - ultimoOlharMs) > COGNI_IGNORADO_MS) {
        sentiuFalta = true;
        reacaoAteMs = millis() + duracaoReacao(REACAO_TRISTE);
        reacaoAtiva = REACAO_TRISTE;   // por ultimo: prazo ja valido
      }
      if ((millis() - ultimoOlharMs) <= COGNI_OLHAR_VALIDADE_MS) {
        jaViuAlguem = true;
        sentiuFalta = false;   // rearma: da pra sentir falta de novo na proxima
      }

      // VIDA PROPRIA: so quando OCIOSO (idle) e sem ninguem falando, dispara reacoes
      // espontaneas de tempos em tempos. Fora do idle, adia o proximo disparo pra nao
      // acumular varias e estourar de uma vez ao voltar pro repouso.
      if (atual == ROSTO_IDLE && (long)(millis() - proximaAnimEspontaneaMs) >= 0) {
        dispararAnimacaoEspontanea();
        agendarProximaAnimEspontanea();
      } else if (atual != ROSTO_IDLE) {
        agendarProximaAnimEspontanea();
      }
    }

    vTaskDelay(5 / portTICK_PERIOD_MS);
  }
}

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(COGNI_SERIAL_BAUD);
  delay(200);
  Serial.println();
  Serial.println(F("==========================================="));
  Serial.println(F("  Cogni - ESP32 Controle (MVP de Audio)   "));
  Serial.println(F("==========================================="));
  logMotivoDoBoot();
  logInfo("Boot", String("Heap livre inicial: ") + ESP.getFreeHeap() + " bytes");

  // Tela OLED (olhos): inicializa CEDO para dar feedback visual ja no boot. Sao
  // periféricos I2C + um framebuffer de ~1KB, entao (ao contrario do pool de audio
  // de ~55KB) nao ameaca o heap que o WiFi precisa. A TASK de animacao so e criada
  // no fim do setup (com o WiFi ja no ar).
  configurarTela();

  // Botoes fisicos: entradas com pull-up interno (apertar leva o pino a GND=LOW).
  // Le o nivel inicial para o debounce nao disparar um falso toque no boot.
  for (size_t i = 0; i < NUM_BOTOES; i++) {
    pinMode(botoes[i].pino, INPUT_PULLUP);
    botoes[i].nivelBruto = botoes[i].nivelEstavel = digitalRead(botoes[i].pino);
    botoes[i].mudouEm = millis();
  }
  logInfo("Botoes", String(NUM_BOTOES) + " botoes configurados (pull-up interno, ativo em LOW)");

  // Controle do amplificador: comeca DESLIGADO (silencio) e so liga ao tocar.
#if COGNI_PIN_AMP_SD >= 0
  pinMode(COGNI_PIN_AMP_SD, OUTPUT);
  digitalWrite(COGNI_PIN_AMP_SD, LOW);
  logInfo("Audio", String("Controle do amp no GPIO ") + COGNI_PIN_AMP_SD + " (desligado em silencio)");
#endif

  // Saida de audio I2S para o MAX98357A (toca o PCM que chega do servidor).
  // Inicializar o I2S aqui (so periféricos/DMA, sem grandes mallocs no heap)
  // nao atrapalha o WiFi - quem atrapalhava era o POOL de audio (~126KB) abaixo.
  configurarSaidaI2S();

  // ORDEM IMPORTA (causa de "addba ... sta bss deleted" + timeout no WiFi):
  // o driver WiFi do ESP32, ao subir a conexao 802.11n, aloca buffers de Block
  // Acknowledgment (o "addba" = ADD Block Ack) no heap interno. Se o heap ja
  // estiver consumido/fragmentado pelo POOL de audio (28 blocos de 4.6KB =
  // ~126KB, alocados em mallocs separados), essas alocacoes do WiFi falham e o
  // driver fica montando/deletando a BSS em loop, sem nunca conectar. Por isso
  // conectamos o WiFi (e subimos o WebSocket) com o heap AINDA INTEIRO (~279KB),
  // e SO DEPOIS reservamos o pool e criamos a task de audio (mais abaixo).

  // Microfone: so inicializa o I2S de entrada se formos de fato capturar/enviar
  // audio ao servidor. Assim, no modo "so saida" nao gastamos um canal I2S.
  // (Tambem so periféricos I2S, sem grande consumo de heap - seguro antes do WiFi.)
  if (COGNI_MIC_ENVIAR_AO_SERVIDOR) {
    configurarMicI2S();
  }

  // Wi-Fi - conecta com o heap inteiro, antes de qualquer alocacao grande.
  conectarWiFi();

  // WebSocket
  String caminho = String("/ws/esp?token=") + COGNI_ESP_TOKEN;
  ws.begin(COGNI_SERVER_HOST, COGNI_SERVER_PORT, caminho.c_str());
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(COGNI_WS_RECONNECT_MS);
  // Heartbeat do proprio ESP (independente do ping do servidor). pingInterval
  // (20s) DEVE ser bem maior que pongTimeout (8s): com os dois proximos, a lib
  // rearma o ultimo ping antes de detectar o timeout e a conexao oscila (bug
  // conhecido da lib). Com 20s/8s/2 ha folga de sobra para o modem do Wi-Fi
  // acordar e responder, sem competir com o heartbeat do servidor.
  ws.enableHeartbeat(20000, 8000, 2);
  logInfo("WS", String("Apontado para ws://") + COGNI_SERVER_HOST + ":" + COGNI_SERVER_PORT + caminho);

  // ---------------------------------------------------------------------
  // AUDIO (alocado SO AGORA, com o WiFi ja no ar - ver nota de ordem acima).
  // ---------------------------------------------------------------------
  // POOL de buffers de audio: reserva os blocos UMA vez aqui (sem malloc por
  // chunk depois). poolLivres comeca com todos os indices disponiveis. Se a
  // alocacao falhar (heap insuficiente), o robo segue funcionando para tudo
  // menos audio - melhor que travar no boot.
  poolLivres = xQueueCreate(COGNI_AUDIO_POOL_BLOCOS, sizeof(uint16_t));
  uint16_t blocosOk = 0;
  if (poolLivres) {
    for (uint16_t s = 0; s < COGNI_AUDIO_POOL_BLOCOS; s++) {
      poolBuffers[s] = (uint8_t*) malloc(COGNI_AUDIO_POOL_BLOCO_BYTES);
      if (!poolBuffers[s]) break;          // sem heap: para de alocar
      xQueueSend(poolLivres, &s, 0);
      blocosOk++;
    }
  }
  logInfo("Audio", String("Pool de audio: ") + blocosOk + "/" + COGNI_AUDIO_POOL_BLOCOS
          + " blocos de " + COGNI_AUDIO_POOL_BLOCO_BYTES + "B (heap livre: " + ESP.getFreeHeap() + ")");

  // Fila + task dedicada de audio (core 0). O WebSocket so enfileira os indices;
  // a task os escreve no I2S, deixando o loop()/ws.loop() (core 1) livres.
  filaAudio = xQueueCreate(COGNI_AUDIO_FILA_TAM, sizeof(ChunkAudio));
  if (filaAudio && blocosOk > 0) {
    xTaskCreatePinnedToCore(tarefaAudio, "tarefaAudio", 4096, nullptr, 5, &tarefaAudioHandle, 0);
    logInfo("Audio", String("Task de audio criada (core 0, fila=") + COGNI_AUDIO_FILA_TAM + ")");
  } else {
    logInfo("Audio", "FALHA ao criar fila/pool de audio!");
  }

  // Task da tela (olhos): core 0, prioridade BAIXA (1) para que o audio (prio 5) e
  // o WebSocket (core 1) sempre tenham preferencia. So cria se a tela inicializou.
  if (telaOk) {
    xTaskCreatePinnedToCore(tarefaOlho, "tarefaOlho", 4096, nullptr, 1, &tarefaOlhoHandle, 0);
    logInfo("Tela", "Task dos olhos criada (core 0, prioridade 1)");
  }
}

// ---------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------
void loop() {
  ws.loop();
  atualizarAmp();    // desliga o amp com seguranca apos a fala terminar
  lerBotoes();       // le os 4 botoes fisicos e envia os eventos ao servidor
  // O audio PCM e tocado direto em tocarChunkPcm() quando os chunks chegam pelo
  // WebSocket - nao ha mais decodificacao em segundo plano (sem schreibfaul1).

  if (COGNI_MIC_ENVIAR_AO_SERVIDOR && wsConectado) {
    capturarEEnviarMic();
  }

  // CONTROLE DE FLUXO: enquanto recebe/toca audio, informa o nivel de buffer ao
  // servidor a cada COGNI_FLUXO_INTERVALO_MS. E uma mensagem TXT minuscula (~60B);
  // diferente do status (que evitamos durante o audio), esta e ESSENCIAL para o
  // servidor saber o ritmo de consumo e nao secar/estourar o buffer. O custo de TX
  // e baixo e a lib serializa TXT/BIN no mesmo socket sem corromper o fluxo.
  if (wsConectado && recebendoAudio && millis() - ultimoNivelMs >= COGNI_FLUXO_INTERVALO_MS) {
    ultimoNivelMs = millis();
    enviarNivelBuffer();
  }

  // Nao envia STATUS (TXT) ENQUANTO recebe audio: o status e grande e periodico;
  // intercala-lo no meio do fluxo de chunks aumenta a contencao de TX. Volta assim
  // que a fala termina. (O nivel de buffer acima e a excecao justificada.)
  if (!recebendoAudio && millis() - ultimoStatusMs > COGNI_STATUS_INTERVAL_MS) {
    ultimoStatusMs = millis();
    enviarStatus();
  }

  // Reaplica o desligamento do modem-sleep periodicamente. WiFi.setSleep(false) ja
  // e chamado no connect e no WStype_CONNECTED, mas o driver pode reativar o power
  // save sem passar por um evento de reconexao do WebSocket (renegociacao/roaming
  // 802.11). Quando isso acontece o radio volta a adormecer e o pong do heartbeat
  // atrasa, derrubando a conexao "do nada". Reaplicar e barato e idempotente.
  if (WiFi.status() == WL_CONNECTED && millis() - ultimoWifiSleepGuardMs > COGNI_WIFI_SLEEP_GUARD_MS) {
    ultimoWifiSleepGuardMs = millis();
    WiFi.setSleep(false);
  }
}
