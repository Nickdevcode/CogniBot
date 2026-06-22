#pragma once

// =======================================================================
// Cogni - Sketch de TESTE de Conexao ESP <-> Servidor
// Arquivo de configuracao - MODELO.
//
// COMO USAR: copie este arquivo para "config.h" (na mesma pasta) e
// preencha com os seus valores reais. O "config.h" NAO vai para o Git
// (esta no .gitignore) para nao expor a senha do Wi-Fi e o token.
//
// Funcao do sketch: validar Wi-Fi + WebSocket + token, sem audio nem
// hardware extra. Use ANTES de gravar o firmware completo no robo.
// =======================================================================

#define COGNI_WIFI_SSID       "NOME_DA_SUA_REDE_2_4GHZ"
#define COGNI_WIFI_PASSWORD   "SENHA_DA_SUA_REDE"

#define COGNI_SERVER_HOST     "192.168.0.100"
#define COGNI_SERVER_PORT     3000

#define COGNI_ESP_TOKEN       "defina-um-token-secreto-aqui"

// Quais endpoints testar:
//   true  -> WebSocket de controle (/ws/esp)
//   false -> WebSocket da camera   (/ws/cam)
#define COGNI_TESTE_CONTROLE  true

// Manda um ping JSON a cada N ms para confirmar o canal
#define COGNI_PING_INTERVAL_MS  5000UL

#define COGNI_WIFI_TIMEOUT_MS    30000UL
#define COGNI_WS_RECONNECT_MS    3000UL
#define COGNI_SERIAL_BAUD        115200
