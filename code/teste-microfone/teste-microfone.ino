// =====================================================================
// TESTE ISOLADO DO MICROFONE INMP441 - Cogni
// ---------------------------------------------------------------------
// Objetivo: provar, SEM Wi-Fi e SEM servidor, se o microfone esta
// captando voz. Mostra no Monitor Serial uma barra (VU-meter) que cresce
// quando voce fala, o valor de pico e o RMS, e um veredito automatico.
//
// Como usar:
//   1. Abra ESTE sketch (pasta code/teste-microfone).
//   2. Placa: "ESP32 Dev Module". Porta: a COM do seu ESP.
//      (Particao nao importa aqui - o sketch e pequeno.)
//   3. Carregar (->).
//   4. Abra o Monitor Serial em 115200 baud.
//   5. Fique em silencio alguns segundos, depois fale perto do mic.
//
// Pinagem (mesma do projeto, conforme seu diagrama de montagem):
//   VDD -> 3V3 | GND -> GND | L/R -> GND
//   WS  -> GPIO 25 | SCK -> GPIO 26 | SD -> GPIO 33
// =====================================================================

#include <Arduino.h>
#include "driver/i2s_std.h"

// ---- Pinos (iguais ao config.h do projeto) ----
static const gpio_num_t PIN_WS  = GPIO_NUM_25;   // WS  / LRCLK
static const gpio_num_t PIN_SCK = GPIO_NUM_26;   // SCK / BCLK
static const gpio_num_t PIN_SD  = GPIO_NUM_33;   // SD  (dados do mic)

static const uint32_t SAMPLE_RATE = 16000;

static i2s_chan_handle_t rx = nullptr;

// Le um bloco e devolve pico bruto (24 bits) e RMS ja convertido p/ int16.
static bool lerBloco(int32_t& picoOut, double& rms16Out, double& rms12Out) {
  static int32_t buf[1024];
  size_t lidos = 0;
  esp_err_t err = i2s_channel_read(rx, buf, sizeof(buf), &lidos, 200 / portTICK_PERIOD_MS);
  if (err != ESP_OK || lidos == 0) return false;

  const size_t n = lidos / 4;
  int32_t pico = 0;
  double soma16 = 0, soma12 = 0;
  for (size_t i = 0; i < n; i++) {
    const int32_t bruto = buf[i];
    const int32_t a = bruto < 0 ? -bruto : bruto;
    if (a > pico) pico = a;
    const int32_t s16 = bruto >> 16;
    const int32_t s12 = bruto >> 12;
    soma16 += (double) s16 * s16;
    soma12 += (double) s12 * s12;
  }
  picoOut  = pico;
  rms16Out = sqrt(soma16 / n);
  rms12Out = sqrt(soma12 / n);
  return true;
}

// Desenha uma barra proporcional ao nivel (0..max -> 0..largura).
static void barra(double valor, double max, int largura) {
  int preenchido = (int) (valor / max * largura);
  if (preenchido > largura) preenchido = largura;
  if (preenchido < 0) preenchido = 0;
  Serial.print('[');
  for (int i = 0; i < largura; i++) Serial.print(i < preenchido ? '#' : ' ');
  Serial.print(']');
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println(F("==================================================="));
  Serial.println(F("   TESTE ISOLADO DO MICROFONE INMP441 (Cogni)      "));
  Serial.println(F("==================================================="));
  Serial.println(F("Pinos: WS=25  SCK=26  SD=33  | L/R em GND, VDD em 3V3"));
  Serial.println(F("Fique em silencio, depois fale perto do mic.\n"));

  // --- Cria canal RX no driver I2S novo ---
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  esp_err_t err = i2s_new_channel(&chanCfg, nullptr, &rx);
  if (err != ESP_OK) {
    Serial.printf("ERRO i2s_new_channel: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }

  i2s_std_config_t cfg = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = PIN_SCK,
      .ws   = PIN_WS,
      .dout = I2S_GPIO_UNUSED,
      .din  = PIN_SD,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };
  cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;   // L/R em GND => canal esquerdo

  err = i2s_channel_init_std_mode(rx, &cfg);
  if (err != ESP_OK) {
    Serial.printf("ERRO init_std_mode: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }
  err = i2s_channel_enable(rx);
  if (err != ESP_OK) {
    Serial.printf("ERRO channel_enable: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }

  Serial.println(F("Microfone inicializado. Lendo...\n"));
}

void loop() {
  int32_t pico = 0;
  double rms16 = 0, rms12 = 0;
  if (!lerBloco(pico, rms16, rms12)) {
    Serial.println(F("[!] Nenhum dado lido do I2S (timeout)."));
    delay(200);
    return;
  }

  // Veredito automatico baseado no pico bruto de 24 bits.
  // Silencio tipico fica abaixo de ~500 mil; fala sobe para varios milhoes.
  const char* veredito;
  if (pico < 50000)        veredito = "SEM SINAL (mic mudo?)";
  else if (pico < 800000)  veredito = "so ruido de fundo";
  else if (pico < 4000000) veredito = "captando som fraco";
  else                     veredito = ">>> VOZ DETECTADA <<<";

  // Barra proporcional ao RMS com ganho >>12 (escala ate ~3000).
  barra(rms12, 3000.0, 40);
  Serial.printf(" pico=%8ld  RMS12=%5.0f  %s\n", (long) pico, rms12, veredito);

  delay(120);   // ~8 atualizacoes por segundo, legivel no Serial
}
