// =====================================================================
// Cogni - Sketch de TESTE de Conexao (ESP <-> servidor Cogni)
// Plataforma : ESP32 DevKit V1
// Stack 2026 :
//   - Arduino-ESP32 core 3.3.8
//   - WebSockets (Links2004) 2.6.1
//   - ArduinoJson 7.4.3
//
// O que ele faz:
//   1. Conecta no Wi-Fi (timeout configuravel)
//   2. Conecta no endpoint WebSocket do servidor (controle ou camera)
//   3. Loga TUDO no Serial em 115200 baud:
//       - SSID, IP local, RSSI
//       - eventos do WebSocket (connected, disconnected, mensagens)
//       - confirmacao do "bem-vindo" enviado pelo servidor
//   4. Manda um ping JSON a cada COGNI_PING_INTERVAL_MS e mostra a
//      resposta. Se voce ver no console "bem-vindo recebido" -> sucesso.
//
// Como usar:
//   1. Edite config.h com SSID, senha, IP do notebook e ESP_TOKEN
//   2. Selecione board "DOIT ESP32 DEVKIT V1" na Arduino IDE
//   3. Carregue este sketch
//   4. Abra o Monitor Serial em 115200
//   5. No notebook, deixe o servidor rodando (cd server && npm run dev)
// =====================================================================

#include "config.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

WebSocketsClient ws;
static bool          wsConectado    = false;
static unsigned long ultimoPingMs   = 0;
static uint32_t      contadorPing   = 0;
static uint32_t      contadorBemVindo = 0;

// ---------------------------------------------------------------------
static void log(const char* tag, const String& msg) {
  Serial.printf("[%s] %s\n", tag, msg.c_str());
}

static void imprimirCabecalho() {
  Serial.println();
  Serial.println(F("================================================="));
  Serial.println(F("   Cogni - TESTE DE CONEXAO ESP <-> Servidor    "));
  Serial.println(F("================================================="));
  Serial.printf("SSID alvo        : %s\n", COGNI_WIFI_SSID);
  Serial.printf("Servidor         : %s:%u\n", COGNI_SERVER_HOST, (unsigned) COGNI_SERVER_PORT);
  Serial.printf("Endpoint         : %s\n", COGNI_TESTE_CONTROLE ? "/ws/esp" : "/ws/cam");
  Serial.printf("Token (primeiros)::%c%c%c%c%c...\n",
    COGNI_ESP_TOKEN[0], COGNI_ESP_TOKEN[1], COGNI_ESP_TOKEN[2], COGNI_ESP_TOKEN[3], COGNI_ESP_TOKEN[4]);
  Serial.println(F("-------------------------------------------------"));
}

// ---------------------------------------------------------------------
static bool conectarWiFi() {
  log("WiFi", "Iniciando conexao...");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(COGNI_WIFI_SSID, COGNI_WIFI_PASSWORD);

  const unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - inicio > COGNI_WIFI_TIMEOUT_MS) {
      log("WiFi", "FALHA: timeout. Verifique SSID, senha e se a rede e 2,4 GHz.");
      return false;
    }
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  log("WiFi", String("OK. IP = ") + WiFi.localIP().toString() + "  RSSI = " + WiFi.RSSI() + " dBm");
  return true;
}

// ---------------------------------------------------------------------
static void enviarPing() {
  if (!wsConectado) return;
  contadorPing++;

  JsonDocument doc;
  doc["tipo"] = "status";              // o servidor aceita "status" e "log"
  JsonObject p = doc["payload"].to<JsonObject>();
  p["id"]        = "teste-conexao";
  p["sequencia"] = contadorPing;
  p["uptimeMs"]  = (uint32_t) millis();
  p["heap"]      = (uint32_t) ESP.getFreeHeap();
  p["rssi"]      = WiFi.RSSI();

  String saida;
  serializeJson(doc, saida);
  bool ok = ws.sendTXT(saida);
  log("TX", String("status #") + contadorPing + (ok ? " enviado" : " FALHA no envio"));
}

// ---------------------------------------------------------------------
static void onWsEvent(WStype_t tipo, uint8_t* payload, size_t length) {
  switch (tipo) {
    case WStype_CONNECTED: {
      wsConectado = true;
      log("WS", String("CONECTADO em ") + (const char*) payload);
      break;
    }

    case WStype_DISCONNECTED: {
      wsConectado = false;
      log("WS", "DESCONECTADO (vou reconectar automaticamente)");
      log("Dica", "Se desconectar logo de cara: cheque o ESP_TOKEN e se o ESP_ENABLED esta true no .env.");
      break;
    }

    case WStype_TEXT: {
      String texto;
      texto.reserve(length + 1);
      for (size_t i = 0; i < length; i++) texto += (char) payload[i];
      log("RX", String("texto: ") + texto);

      // Tenta decodificar pra mostrar amigavel
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, texto);
      if (!err) {
        const char* t = doc["tipo"] | "";
        if (strcmp(t, "bem-vindo") == 0) {
          contadorBemVindo++;
          const char* id = doc["payload"]["id"] | "";
          log("OK", String("SUCESSO! 'bem-vindo' recebido. id=") + id + "  total=" + contadorBemVindo);
          log("OK", "Servidor Cogni respondeu corretamente. Conexao validada.");
        } else if (strcmp(t, "audio-inicio") == 0) {
          const size_t tamanho = doc["payload"]["tamanho"] | 0;
          log("RX", String("o servidor mandou audio (") + tamanho + " bytes). Este sketch nao toca audio.");
        } else if (strcmp(t, "audio-fim") == 0) {
          log("RX", "audio-fim recebido (fim de stream).");
        }
      }
      break;
    }

    case WStype_BIN: {
      log("RX", String("binario: ") + length + " bytes (PCM do TTS; este sketch nao toca audio).");
      break;
    }

    case WStype_PING:
      log("WS", "ping recebido do servidor");
      break;

    case WStype_PONG:
      log("WS", "pong do servidor");
      break;

    case WStype_ERROR: {
      log("WS", "ERRO no socket");
      log("Dica", "Erros comuns: token errado (401), porta errada, IP do servidor incorreto.");
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------
void setup() {
  Serial.begin(COGNI_SERIAL_BAUD);
  delay(300);
  imprimirCabecalho();

  if (!conectarWiFi()) {
    log("Fatal", "Sem Wi-Fi -> reiniciando em 10 s.");
    delay(10000);
    ESP.restart();
  }

  const char* caminhoBase = COGNI_TESTE_CONTROLE ? "/ws/esp" : "/ws/cam";
  String caminho = String(caminhoBase) + "?token=" + COGNI_ESP_TOKEN;
  log("WS", String("Conectando em ws://") + COGNI_SERVER_HOST + ":" + COGNI_SERVER_PORT + caminho);

  ws.begin(COGNI_SERVER_HOST, COGNI_SERVER_PORT, caminho.c_str());
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(COGNI_WS_RECONNECT_MS);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();

  if (millis() - ultimoPingMs > COGNI_PING_INTERVAL_MS) {
    ultimoPingMs = millis();
    enviarPing();
  }
}
