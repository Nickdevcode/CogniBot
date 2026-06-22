#pragma once

// =======================================================================
// Cogni - Firmware ESP32-CAM (Visao do Robo) - PROXIMA FASE
// Arquivo de configuracao - MODELO.
//
// COMO USAR: copie este arquivo para "config.h" (na mesma pasta) e
// preencha com os seus valores reais. O "config.h" NAO vai para o Git
// (esta no .gitignore) para nao expor a senha do Wi-Fi e o token.
//
// Hoje fora do MVP de audio. Deixado pronto para quando a ESP-CAM for
// integrada ao robo. O servidor ja escuta em ws://host:porta/ws/cam.
// =======================================================================

#define COGNI_WIFI_SSID       "NOME_DA_SUA_REDE_2_4GHZ"
#define COGNI_WIFI_PASSWORD   "SENHA_DA_SUA_REDE"

#define COGNI_SERVER_HOST     "192.168.0.100"
#define COGNI_SERVER_PORT     3000

#define COGNI_ESP_TOKEN       "defina-um-token-secreto-aqui"

#define COGNI_ROBO_ID         "cam-cogni-01"

// Frame por segundo desejado (1..10 razoavel para Wi-Fi domestico)
#define COGNI_FPS_ALVO        4

// Qualidade JPEG (0=melhor, 63=pior). 12 e bom equilibrio.
#define COGNI_JPEG_QUALIDADE  12

// Resolucao: ver enum framesize_t no header esp_camera.h
//   FRAMESIZE_QVGA  320x240   (recomendado para baixa latencia)
//   FRAMESIZE_VGA   640x480
//   FRAMESIZE_SVGA  800x600
#define COGNI_FRAME_SIZE      FRAMESIZE_VGA

#define COGNI_WIFI_TIMEOUT_MS    30000UL
#define COGNI_WS_RECONNECT_MS    5000UL
#define COGNI_STATUS_INTERVAL_MS 15000UL
#define COGNI_SERIAL_BAUD        115200

// =======================================================================
// Pinagem da AI-Thinker ESP32-CAM. Se voce usar outra placa (M5Stack,
// XIAO Sense, ESP32-S3 Eye), ajuste os pinos abaixo.
// =======================================================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
