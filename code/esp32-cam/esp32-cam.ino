// =====================================================================
// Cogni - Firmware ESP32-CAM (Visao) - PROXIMA FASE
// Plataforma : AI-Thinker ESP32-CAM (ESP32-S + OV2640)
// Funcao     : Captura frames JPEG e envia ao servidor Cogni via
//              WebSocket binario em /ws/cam.
// Stack 2026 :
//   - Arduino-ESP32 core 3.3.8 (Espressif)
//   - WebSockets (Links2004) 2.6.1
//   - ArduinoJson 7.4.3
// =====================================================================

#include "config.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"

WebSocketsClient ws;
static bool wsConectado = false;
static unsigned long ultimoStatusMs = 0;
static unsigned long ultimoFrameMs  = 0;

static void logInfo(const String& tag, const String& msg) {
  Serial.printf("[%s] %s\n", tag.c_str(), msg.c_str());
}

// ---------------------------------------------------------------------
// Inicializa a camera OV2640
// ---------------------------------------------------------------------
static bool iniciarCamera() {
  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0       = Y2_GPIO_NUM;
  cfg.pin_d1       = Y3_GPIO_NUM;
  cfg.pin_d2       = Y4_GPIO_NUM;
  cfg.pin_d3       = Y5_GPIO_NUM;
  cfg.pin_d4       = Y6_GPIO_NUM;
  cfg.pin_d5       = Y7_GPIO_NUM;
  cfg.pin_d6       = Y8_GPIO_NUM;
  cfg.pin_d7       = Y9_GPIO_NUM;
  cfg.pin_xclk     = XCLK_GPIO_NUM;
  cfg.pin_pclk     = PCLK_GPIO_NUM;
  cfg.pin_vsync    = VSYNC_GPIO_NUM;
  cfg.pin_href     = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn     = PWDN_GPIO_NUM;
  cfg.pin_reset    = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size   = COGNI_FRAME_SIZE;
  cfg.jpeg_quality = COGNI_JPEG_QUALIDADE;
  cfg.fb_count     = psramFound() ? 2 : 1;
  cfg.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  cfg.grab_mode    = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    logInfo("Cam", String("Falha no esp_camera_init: 0x") + String((uint32_t)err, HEX));
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, 0);
    s->set_hmirror(s, 0);
    s->set_brightness(s, 0);
    s->set_saturation(s, 0);
  }
  logInfo("Cam", "OV2640 inicializada");
  return true;
}

// ---------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------
static bool conectarWiFi() {
  logInfo("WiFi", String("Conectando em ") + COGNI_WIFI_SSID + " ...");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(COGNI_WIFI_SSID, COGNI_WIFI_PASSWORD);

  const unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - inicio > COGNI_WIFI_TIMEOUT_MS) {
      logInfo("WiFi", "Timeout. Reiniciando em 5 s...");
      delay(5000);
      ESP.restart();
      return false;
    }
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  logInfo("WiFi", String("Conectado. IP=") + WiFi.localIP().toString() + " RSSI=" + WiFi.RSSI());
  return true;
}

// ---------------------------------------------------------------------
// Mensageria
// ---------------------------------------------------------------------
static void enviarStatus() {
  if (!wsConectado) return;
  JsonDocument doc;
  doc["tipo"] = "status";
  JsonObject p = doc["payload"].to<JsonObject>();
  p["id"]       = COGNI_ROBO_ID;
  p["ip"]       = WiFi.localIP().toString();
  p["rssi"]     = WiFi.RSSI();
  p["uptimeMs"] = (uint32_t) millis();
  p["heap"]     = (uint32_t) ESP.getFreeHeap();
  p["psram"]    = (uint32_t) ESP.getFreePsram();
  p["fps_alvo"] = COGNI_FPS_ALVO;
  String saida;
  serializeJson(doc, saida);
  ws.sendTXT(saida);
}

// ---------------------------------------------------------------------
// WebSocket events
// ---------------------------------------------------------------------
static void onWsEvent(WStype_t tipo, uint8_t* payload, size_t length) {
  switch (tipo) {
    case WStype_CONNECTED:
      wsConectado = true;
      logInfo("WS", String("Conectado em ") + (const char*) payload);
      enviarStatus();
      break;
    case WStype_DISCONNECTED:
      wsConectado = false;
      logInfo("WS", "Desconectado");
      break;
    case WStype_TEXT:
      logInfo("WS", String("Texto recebido (informativo): ") + String((char*) payload).substring(0, 120));
      break;
    case WStype_ERROR:
      logInfo("WS", "Erro no socket");
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------
// Captura e envia 1 frame JPEG
// ---------------------------------------------------------------------
static void enviarFrame() {
  if (!wsConectado) return;

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    logInfo("Cam", "Falha em esp_camera_fb_get");
    return;
  }
  // O servidor descarta frames acima de 200 KB. Mantenha COGNI_FRAME_SIZE
  // em VGA ou menor para nao estourar esse limite com facilidade.
  ws.sendBIN(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

// ---------------------------------------------------------------------
// Setup / Loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(COGNI_SERIAL_BAUD);
  delay(200);
  Serial.println();
  Serial.println(F("==========================================="));
  Serial.println(F("  Cogni - ESP32-CAM (Visao)                "));
  Serial.println(F("==========================================="));

  if (!iniciarCamera()) {
    logInfo("Cam", "Sem camera. Reiniciando em 5 s...");
    delay(5000);
    ESP.restart();
  }

  conectarWiFi();

  String caminho = String("/ws/cam?token=") + COGNI_ESP_TOKEN;
  ws.begin(COGNI_SERVER_HOST, COGNI_SERVER_PORT, caminho.c_str());
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(COGNI_WS_RECONNECT_MS);
  ws.enableHeartbeat(15000, 3000, 2);
  logInfo("WS", String("Apontado para ws://") + COGNI_SERVER_HOST + ":" + COGNI_SERVER_PORT + caminho);
}

void loop() {
  ws.loop();

  const unsigned long agora = millis();
  const unsigned long intervaloFrameMs = 1000UL / max(1, (int) COGNI_FPS_ALVO);

  if (agora - ultimoFrameMs >= intervaloFrameMs) {
    ultimoFrameMs = agora;
    enviarFrame();
  }

  if (agora - ultimoStatusMs > COGNI_STATUS_INTERVAL_MS) {
    ultimoStatusMs = agora;
    enviarStatus();
  }
}
