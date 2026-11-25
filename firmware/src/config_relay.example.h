// =====================================================================
//  Configuração do M5 Voz — MODELO
//  Copie para config_relay.h e preencha:   cp config_relay.example.h config_relay.h
//  config_relay.h está no .gitignore e NUNCA deve ser commitado.
//  Aqui ficam só: redes Wi-Fi, URL do relay e o token do dispositivo.
//  Nenhuma chave de provedor (OpenAI, xAI, ElevenLabs) vai no firmware.
// =====================================================================
#pragma once

// --- Redes Wi-Fi (2,4 GHz; o ESP32-S3 não enxerga 5 GHz) -------------
// O relógio conecta automaticamente na melhor disponível (WiFiMulti).
// Inclua a de casa e os hotspots do celular e do Mac para usar na rua.
#define WIFI_NETWORKS {                         \
  { "NOME-DA-REDE-DE-CASA", "senha-de-casa" },  \
  { "Hotspot-do-celular",   "senha-do-hotspot" }, \
  { "Hotspot-do-Mac",       "senha-do-hotspot-mac" }, \
}

// --- Relay ------------------------------------------------------------
// Principal: Vercel (HTTPS). Ex.: "https://m5-voz.vercel.app/api/voz"
// O modo Grok Bot (botão B) usa a mesma base: /api/agent, /api/job/<id>.
#define RELAY_URL      "https://SEU-PROJETO.vercel.app/api/voz"
// Opcional: relay na LAN (MacBook/Desktop). Usado se o principal falhar
// na conexão. Deixe "" para desativar. Ex.: "http://192.168.100.50:8787/api/voz"
#define RELAY_URL_LAN  ""

// Token compartilhado — igual ao DEVICE_TOKEN do relay (gere com: openssl rand -hex 24)
#define DEVICE_TOKEN   "troque-por-um-token-aleatorio"

// 0 = valida o certificado HTTPS (recomendado). 1 = não valida (só para teste).
#define RELAY_TLS_INSECURE 0

// --- Áudio / UI ---------------------------------------------------------
// Volume, brilho, voz, vibração e "apagar tela" agora ficam no menu de AJUSTES do relógio
// (segure a tela ou aperte A+B juntos) e são salvos na memória do relógio.
// SPEAKER_VOLUME e SCREEN_DIM_AFTER_MS abaixo não são mais usados (podem ficar).
#define SPEAKER_VOLUME       255
#define MAX_RECORD_SECONDS   30    // limite de gravação (30 s ≈ 960 KB em PSRAM)
#define SCREEN_DIM_AFTER_MS  20000 // escurece a tela após inatividade
#define TZ_POSIX             "<-03>3" // fuso do relógio no topo (Brasília)

// --- Modo Grok Bot (botão B) ------------------------------------------
#define JOB_POLL_MS          1500                     // consulta o andamento a cada 1,5 s
#define JOB_TIMEOUT_MS       (15UL * 60UL * 1000UL)   // desiste após 15 min
