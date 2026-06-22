// =====================================================================
// TESTE ISOLADO DO ALTO-FALANTE (MAX98357A) - Cogni
// ---------------------------------------------------------------------
// Objetivo: provar, SEM Wi-Fi, SEM microfone, SEM MP3 e SEM LittleFS, se o
// alto-falante toca um som LIMPO. Gera uma onda senoidal (um "bip" musical)
// diretamente pelo I2S e manda pro MAX98357A.
//
// O QUE ESTE TESTE PROVA:
//   - Se sair um BIP LIMPO  -> hardware do alto-falante e ligacao I2S estao OK.
//                              O chiado no firmware real e por OUTRA causa
//                              (conflito com o microfone I2S, ou o MP3).
//   - Se sair CHIADO/RUIDO  -> o problema e a ligacao fisica (DIN/BCLK/LRC),
//                              o modulo, ou a alimentacao. Nao e software.
//
// Como usar:
//   1. Abra ESTE sketch (pasta code/teste-alto-falante).
//   2. Placa: "ESP32 Dev Module". Porta: a COM do seu ESP.
//   3. Carregar (->).
//   4. Abra o Monitor Serial em 115200 baud.
//   5. Escute o alto-falante: deve tocar bips alternados (La 440Hz e La 880Hz),
//      1 segundo cada, com pausas de silencio entre eles.
//
// Pinagem (mesma do projeto):
//   MAX98357A: VIN->5V | GND->GND | DIN->GPIO22 | BCLK->GPIO27 | LRC->GPIO14
//   SD (shutdown) -> GPIO32
// =====================================================================

#include <Arduino.h>
#include "driver/i2s_std.h"
#include <math.h>

// ---- Pinos (iguais ao config.h do projeto) ----
static const gpio_num_t PIN_BCLK = GPIO_NUM_27;
static const gpio_num_t PIN_LRC  = GPIO_NUM_14;
static const gpio_num_t PIN_DOUT = GPIO_NUM_22;
static const int        PIN_SD   = 32;     // shutdown do amp (HIGH = ligado)

static const uint32_t SAMPLE_RATE = 44100;

static i2s_chan_handle_t tx = nullptr;

// Gera e envia 'duracaoMs' de uma senoide na frequencia 'freq'. Usa amplitude
// moderada (~30% do fundo de escala) para nao saturar.
static void tocarTom(double freq, uint32_t duracaoMs) {
  const int N = 256;
  int16_t buf[N * 2];                 // estereo (L e R iguais = mono)
  const double passo = 2.0 * PI * freq / SAMPLE_RATE;
  static double fase = 0.0;
  const int16_t amplitude = 10000;    // ~30% de 32767

  uint32_t amostrasTotais = (uint64_t) SAMPLE_RATE * duracaoMs / 1000;
  size_t escrito = 0;

  while (amostrasTotais > 0) {
    int n = (amostrasTotais > (uint32_t) N) ? N : amostrasTotais;
    for (int i = 0; i < n; i++) {
      int16_t v = (int16_t) (sin(fase) * amplitude);
      fase += passo;
      if (fase > 2.0 * PI) fase -= 2.0 * PI;
      buf[i * 2]     = v;   // canal esquerdo
      buf[i * 2 + 1] = v;   // canal direito
    }
    i2s_channel_write(tx, buf, n * 2 * sizeof(int16_t), &escrito, portMAX_DELAY);
    amostrasTotais -= n;
  }
}

// Envia silencio (zeros) por um tempo - mantem o clock I2S rodando sem som.
static void tocarSilencio(uint32_t duracaoMs) {
  const int N = 256;
  int16_t buf[N * 2];
  memset(buf, 0, sizeof(buf));
  uint32_t amostrasTotais = (uint64_t) SAMPLE_RATE * duracaoMs / 1000;
  size_t escrito = 0;
  while (amostrasTotais > 0) {
    int n = (amostrasTotais > (uint32_t) N) ? N : amostrasTotais;
    i2s_channel_write(tx, buf, n * 2 * sizeof(int16_t), &escrito, portMAX_DELAY);
    amostrasTotais -= n;
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println(F("==================================================="));
  Serial.println(F("   TESTE ISOLADO DO ALTO-FALANTE MAX98357A (Cogni) "));
  Serial.println(F("==================================================="));
  Serial.println(F("Pinos: BCLK=27  LRC=14  DIN=22  SD=32  | VIN=5V GND=GND"));
  Serial.println(F("Deve tocar bips alternados (440Hz e 880Hz)."));
  Serial.println(F("Se sair LIMPO -> hardware OK. Se CHIAR -> problema fisico.\n"));

  // Liga o amplificador (SD em HIGH)
  pinMode(PIN_SD, OUTPUT);
  digitalWrite(PIN_SD, HIGH);
  delay(50);

  // --- Cria canal TX no driver I2S novo (mesmo driver da lib de audio) ---
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  esp_err_t err = i2s_new_channel(&chanCfg, &tx, nullptr);
  if (err != ESP_OK) {
    Serial.printf("ERRO i2s_new_channel: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }

  i2s_std_config_t cfg = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = PIN_BCLK,
      .ws   = PIN_LRC,
      .dout = PIN_DOUT,
      .din  = I2S_GPIO_UNUSED,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };

  err = i2s_channel_init_std_mode(tx, &cfg);
  if (err != ESP_OK) {
    Serial.printf("ERRO init_std_mode: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }
  err = i2s_channel_enable(tx);
  if (err != ESP_OK) {
    Serial.printf("ERRO channel_enable: %s\n", esp_err_to_name(err));
    while (true) delay(1000);
  }

  Serial.println(F("I2S inicializado. Tocando bips...\n"));
}

void loop() {
  Serial.println(F("BIP 1 - 440 Hz (La)"));
  tocarTom(440.0, 1000);
  tocarSilencio(500);

  Serial.println(F("BIP 2 - 880 Hz (La agudo)"));
  tocarTom(880.0, 1000);
  tocarSilencio(500);

  Serial.println(F("--- pausa 1.5s ---\n"));
  tocarSilencio(1500);
}
