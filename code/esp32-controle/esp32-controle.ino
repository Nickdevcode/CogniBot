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

  JsonDocument doc;
  doc["tipo"] = "buffer";
  doc["payload"]["ms"]    = ms;     // milissegundos de audio em maos (na fila)
  doc["payload"]["bytes"] = pend;
  doc["payload"]["gaps"]  = (uint32_t) contadorGaps;  // diagnostico de underrun
  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
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
      for (size_t j = 0; j < lote; j++) {
        const int16_t v = mono[i + j];
        estereo[j * 2]     = v;
        estereo[j * 2 + 1] = v;
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
      portEXIT_CRITICAL(&muxFluxo);
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

      } else if (strcmp(t, "andar") == 0 || strcmp(t, "girar") == 0 || strcmp(t, "expressao") == 0) {
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
}

// ---------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------
void loop() {
  ws.loop();
  atualizarAmp();    // desliga o amp com seguranca apos a fala terminar
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
}
