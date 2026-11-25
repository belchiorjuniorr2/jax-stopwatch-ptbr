#include "RelayVoice.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiMulti.h>
#include <cmath>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/platform.h>
#include <time.h>

#include "AppState.h"
#include "AudioController.h"
#include "FaceController.h"
#include "RelayCerts.h"
#include "config.h"

#if __has_include("config_relay.h")
#include "config_relay.h"
#else
#warning "config_relay.h missing: copy config_relay.example.h and fill it in"
#include "config_relay.example.h"
#define RELAY_UNCONFIGURED 1
#endif

#ifndef RELAY_URL_LAN
#define RELAY_URL_LAN ""
#endif
#ifndef RELAY_TLS_INSECURE
#define RELAY_TLS_INSECURE 0
#endif
#ifndef MAX_RECORD_SECONDS
#define MAX_RECORD_SECONDS 30
#endif
#ifndef TZ_POSIX
#define TZ_POSIX "<-03>3"
#endif
#ifndef JOB_POLL_MS
#define JOB_POLL_MS 1500
#endif
#ifndef JOB_TIMEOUT_MS
#define JOB_TIMEOUT_MS (15UL * 60UL * 1000UL)
#endif

extern FaceController faceController;
extern AudioController audioController;
extern bool displayOn;
extern bool infoScreenVisible;
void setState(ChanState state);
void setInfoScreenVisible(bool visible);
void setDisplayOn(bool on);
void pulseHaptic(uint8_t level, unsigned long durationMs, unsigned long now);

// settingsPage is an enum in main.cpp; we only need the Audio value via a helper.
extern void selectAudioSettingsPage();
extern void openDeviceSettings();
extern void pauseStreetPassRadio(const char* reason);
extern void resumeStreetPassRadio();
extern void cycleAvatarFromSettings(int step);

namespace RelayVoice {
namespace {

enum class Mode : uint8_t { Fast, Agent };

static constexpr uint32_t REC_RATE = 16000;
static constexpr size_t REC_CHUNK = 800;
static constexpr size_t REC_MAX = (size_t)REC_RATE * MAX_RECORD_SECONDS;
static constexpr size_t WAV_HDR = 44;
static const char* const VOICES[] = {
  "padrao", "alloy", "nova", "shimmer", "coral", "echo", "onyx", "sage", "ash", "ballad", "verse", "fable"
};

struct WifiCred { const char* ssid; const char* pass; };
static const WifiCred WIFI_LIST[] = WIFI_NETWORKS;
static constexpr size_t WIFI_COUNT = sizeof(WIFI_LIST) / sizeof(WIFI_LIST[0]);

static WiFiMulti wifiMulti;
static uint8_t* recBuf = nullptr;
static const int16_t* playPcm = nullptr;
static size_t playSamples = 0;
static uint32_t playRate = 24000;
static String lastReply, lastTranscript, deviceId, activeBase;
static Mode currentMode = Mode::Fast;
static bool ntpStarted = false;
static bool recording = false;
static bool sessionBusy = false;
static volatile bool cancelRequested = false;
static size_t recSamples = 0;
static uint32_t lastWifiTry = 0;
static uint32_t lastClockMs = 0;
static uint8_t lastLink = 0;

static String relayBase(const char* url) {
  String s = url;
  int i = s.indexOf("/api/");
  return i > 0 ? s.substring(0, i) : s;
}

static void putLE16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void putLE32(uint8_t* p, uint32_t v) {
  p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24;
}
static void writeWavHeader(uint8_t* h, size_t pcmBytes, uint32_t rate) {
  memcpy(h, "RIFF", 4);
  putLE32(h + 4, 36 + pcmBytes);
  memcpy(h + 8, "WAVEfmt ", 8);
  putLE32(h + 16, 16);
  putLE16(h + 20, 1);
  putLE16(h + 22, 1);
  putLE32(h + 24, rate);
  putLE32(h + 28, rate * 2);
  putLE16(h + 32, 2);
  putLE16(h + 34, 16);
  memcpy(h + 36, "data", 4);
  putLE32(h + 40, pcmBytes);
}

static bool parseWav(const uint8_t* b, size_t n, const int16_t** pcm, size_t* samples, uint32_t* rate) {
  if (!b || n < 44 || memcmp(b, "RIFF", 4) || memcmp(b + 8, "WAVE", 4)) return false;
  size_t i = 12;
  while (i + 8 <= n) {
    uint32_t sz = (uint32_t)b[i + 4] | ((uint32_t)b[i + 5] << 8) | ((uint32_t)b[i + 6] << 16) | ((uint32_t)b[i + 7] << 24);
    if (!memcmp(b + i, "fmt ", 4) && i + 8 + sz <= n && rate) {
      *rate = (uint32_t)b[i + 12] | ((uint32_t)b[i + 13] << 8) | ((uint32_t)b[i + 14] << 16) | ((uint32_t)b[i + 15] << 24);
    }
    if (!memcmp(b + i, "data", 4) && i + 8 + sz <= n) {
      *pcm = (const int16_t*)(b + i + 8);
      *samples = sz / 2;
      return *samples > 0;
    }
    i += 8 + ((sz + 1) & ~1u);
  }
  return false;
}

static String urlDecode(const String& in) {
  String out;
  out.reserve(in.length());
  for (size_t i = 0; i < in.length(); ++i) {
    char c = in[i];
    if (c == '%' && i + 2 < in.length()) {
      char h[3] = {in[i + 1], in[i + 2], 0};
      out += (char)strtol(h, nullptr, 16);
      i += 2;
    } else if (c == '+') out += ' ';
    else out += c;
  }
  return out;
}

static void tickFace() {
  unsigned long now = millis();
  faceController.update(now);
}

static void showBubble(const String& text) {
  faceController.setSpeechBubbleText(text.c_str());
  tickFace();
}

static void clearBubble() { faceController.clearSpeechBubble(); }

static void setVoiceUi(const char* status, const char* bubble = nullptr) {
  faceController.setVoiceStatus(status);
  if (bubble && bubble[0]) {
    showBubble(bubble);
  } else if (bubble) {
    clearBubble();
  }
}

static void endVoiceUi() {
  faceController.setVoiceStatus("");
  clearBubble();
}

static void haptic(uint8_t level = 160, unsigned long ms = 80) {
  pulseHaptic(level, ms, millis());
}

static void takeAudio() {
  // stopForDisplayOff() forces Idle and CLEARS interactionMicBlocked_.
  // Re-assert the block afterwards so the background mic_capture task
  // cannot call M5.Mic.record() in parallel with the relay recorder.
  audioController.setState(ChanState::Idle);
  audioController.stopForDisplayOff();
  audioController.setInteractionMicBlocked(true, "relay");
  M5.Speaker.end();
  M5.Mic.end();
}

static void micMode() {
  takeAudio();
  M5.Speaker.end();
  auto mc = M5.Mic.config();
  mc.sample_rate = REC_RATE;
  // mag=4 clipped hard on real holds (peak=32752, 30-45 clips) and smeared
  // "testando" into "Estreum". Record clean and let normalize() raise the level.
  mc.magnification = 1;
  M5.Mic.config(mc);
  M5.Mic.begin();
  Serial.printf("[audio] relay mic begin rate=%u mag=%u nf=%u over=%u\n",
                (unsigned)mc.sample_rate,
                (unsigned)mc.magnification,
                (unsigned)mc.noise_filter_level,
                (unsigned)mc.over_sampling);
}

static void speakerMode() {
  takeAudio();
  M5.Mic.end();
  M5.Speaker.begin();
  M5.Speaker.setVolume(255);
}

static void restoreAudio() {
  M5.Speaker.end();
  M5.Mic.end();
  audioController.setInteractionMicBlocked(false, "relay");
  audioController.setState(ChanState::Idle);
  resumeStreetPassRadio();
}

class PsramSink : public Stream {
 public:
  static constexpr size_t kMaxBytes = 1024 * 1024;  // cap one TTS reply at 1 MB
  uint8_t* buf = nullptr;
  size_t len = 0, cap = 0;
  bool oom = false;
  void reset() { len = 0; oom = false; }
  void release() {
    if (buf) {
      heap_caps_free(buf);
      buf = nullptr;
    }
    len = 0;
    cap = 0;
    oom = false;
  }
  void compact() {
    if (!buf) return;
    if (len == 0) {
      release();
      return;
    }
    if (cap <= len + 32) return;
    uint8_t* nb = (uint8_t*)heap_caps_realloc(buf, len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (nb) {
      buf = nb;
      cap = len;
    }
  }
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t* d, size_t n) override {
    if (len + n > cap) {
      if (len + n > kMaxBytes) {
        oom = true;
        return 0;
      }
      size_t nc = cap ? cap * 2 : (size_t)128 * 1024;
      while (nc < len + n) nc *= 2;
      if (nc > kMaxBytes) nc = kMaxBytes;
      uint8_t* nb = (uint8_t*)heap_caps_realloc(buf, nc, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!nb) {
        // Doubling needs a new block while the old one is still held.
        faceController.shrinkSpeakingCache();
        nb = (uint8_t*)heap_caps_realloc(buf, nc, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      }
      if (!nb) { oom = true; return 0; }
      buf = nb;
      cap = nc;
    }
    memcpy(buf + len, d, n);
    len += n;
    return n;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};
static PsramSink sink;

static void* tlsCalloc(size_t n, size_t size) {
  const size_t bytes = n * size;
  void* p = nullptr;
  // Large TLS buffers in PSRAM; keep tiny allocs in internal RAM.
  if (bytes >= 1024) {
    p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  if (!p) {
    p = heap_caps_calloc(n, size, MALLOC_CAP_8BIT);
  }
  return p;
}

static void tlsFree(void* p) {
  heap_caps_free(p);
}

static void logMem(const char* where) {
  TaskHandle_t loop = xTaskGetHandle("loopTask");
  TaskHandle_t mic = xTaskGetHandle("mic_capture");
  TaskHandle_t spk = xTaskGetHandle("speaker_play");
  const unsigned loopHw = (unsigned)uxTaskGetStackHighWaterMark(loop ? loop : xTaskGetCurrentTaskHandle());
  const unsigned micHw = mic ? (unsigned)uxTaskGetStackHighWaterMark(mic) : 0;
  const unsigned spkHw = spk ? (unsigned)uxTaskGetStackHighWaterMark(spk) : 0;
  Serial.printf("[mem] %s heap=%u internal=%u largest_int=%u psram=%u largest_psram=%u loop_hw=%u mic_hw=%u spk_hw=%u\n",
                where,
                (unsigned)ESP.getFreeHeap(),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                (unsigned)ESP.getFreePsram(),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),
                loopHw, micHw, spkHw);
}

static void logPcmStats(const char* tag, const int16_t* s, size_t n, uint32_t elapsedMs) {
  int64_t sum = 0, sq = 0;
  int32_t peak = 0;
  unsigned clips = 0;
  for (size_t i = 0; i < n; ++i) {
    const int32_t v = s[i];
    sum += v;
    sq += (int64_t)v * v;
    const int32_t a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a >= 32700) clips++;
  }
  const int32_t dc = n ? (int32_t)(sum / (int64_t)n) : 0;
  const unsigned rms = n ? (unsigned)sqrt((double)sq / (double)n) : 0;
  const unsigned expect = (elapsedMs * (REC_RATE / 1000));
  const unsigned ratio = expect ? (unsigned)((n * 100ull) / expect) : 0;
  Serial.printf("[audio] %s samples=%u expect=%u ms=%u rms=%u peak=%d dc=%d clips=%u ratio=%u%% rate=%u\n",
                tag,
                (unsigned)n,
                expect,
                (unsigned)elapsedMs,
                rms,
                (int)peak,
                (int)dc,
                clips,
                ratio,
                elapsedMs ? (unsigned)((n * 1000ull) / elapsedMs) : 0);
}

struct RadioQuiet {
  RadioQuiet() {
    pauseStreetPassRadio("relay_tls");
    delay(80);
  }
  ~RadioQuiet() { resumeStreetPassRadio(); }
};

struct RelayCall {
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  bool begin(const String& url, uint32_t timeoutMs = 60000) {
    bool https = url.startsWith("https://");
    if (https) {
#if RELAY_TLS_INSECURE
      secure.setInsecure();
#else
      secure.setCACert(ROOT_CA_BUNDLE);
#endif
      // 8s was too short: the 14:59 build (default 120s) reached health 200,
      // while this path always died at ~8s with start_ssl_client -1.
      // Keep the handshake off the setup() path (deferred health) but allow
      // a realistic first-handshake window with BLE coexist + modem sleep.
      secure.setHandshakeTimeout(30);
    }
    http.setReuse(false);
    http.setConnectTimeout(15000);
    http.setTimeout((uint16_t)min<uint32_t>(timeoutMs, 60000));
    if (!(https ? http.begin(secure, url) : http.begin(plain, url))) return false;
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    http.addHeader("X-Device-Id", deviceId);
    return true;
  }
};


static void boostPcm(int16_t* s, size_t n, float g);
static void showTranscriptThenAnswer(const String& answer);

// Fixed triple buffer for streaming TTS. playRaw does not copy, so a buffer
// must stay untouched until that queue slot has finished. 3 x 32 KB ~= 3 s
// at 16 kHz, and never holds a multi-minute WAV in PSRAM.
static constexpr size_t kStreamChunkSamples = 16 * 1024;
static constexpr int kStreamBufCount = 3;
static int16_t* streamPcm[kStreamBufCount] = {};
static bool audioPlayedInFetch = false;

static void releaseStreamBufs() {
  for (int i = 0; i < kStreamBufCount; ++i) {
    if (streamPcm[i]) {
      heap_caps_free(streamPcm[i]);
      streamPcm[i] = nullptr;
    }
  }
}

static bool ensureStreamBufs() {
  faceController.shrinkSpeakingCache();
  for (int i = 0; i < kStreamBufCount; ++i) {
    if (streamPcm[i]) continue;
    streamPcm[i] = (int16_t*)heap_caps_malloc(kStreamChunkSamples * sizeof(int16_t),
                                             MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!streamPcm[i]) {
      faceController.shrinkSpeakingCache();
      streamPcm[i] = (int16_t*)heap_caps_malloc(kStreamChunkSamples * sizeof(int16_t),
                                               MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (!streamPcm[i]) {
      releaseStreamBufs();
      return false;
    }
  }
  return true;
}

static void clipText(String& s, size_t cap) {
  if (s.length() > cap) s.remove(cap);
}

static bool playQueuedChunk(int16_t* pcm, size_t samples, uint32_t rate, bool stereo) {
  if (!pcm || !samples) return true;
  boostPcm(pcm, samples, 1.8f);
  while (M5.Speaker.isPlaying(0) >= 2) {
    M5.update();
    tickFace();
    if (cancelRequested || (M5.BtnB.wasDecideClickCount() && M5.BtnB.getClickCount() >= 2)) {
      M5.Speaker.stop();
      return false;
    }
    delay(4);
  }
  return M5.Speaker.playRaw(pcm, samples, rate, stereo, 1, 0);
}

// Pull a WAV prefix until the data chunk, then stream PCM to the speaker
// through a 3-buffer queue. Never stores the full reply in PSRAM.
static bool streamWavToSpeaker(WiFiClient* s, HTTPClient& http, String& err, uint32_t& outSamples, uint32_t& outRate) {
  outSamples = 0;
  outRate = 16000;
  if (!s) { err = "sem stream"; return false; }
  if (!ensureStreamBufs()) {
    logMem("stream_buf_oom");
    const unsigned ps = (unsigned)ESP.getFreePsram();
    const unsigned lg = (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    Serial.printf("[relay] stream buf oom psram=%u largest_psram=%u\n", ps, lg);
    // Only say "PSRAM cheia" when memory is actually exhausted.
    err = (ps < 64 * 1024 || lg < 16 * 1024) ? "PSRAM cheia" : "Falta memoria pro audio";
    return false;
  }

  // Accumulate header until data starts. Most WAVs have a < 128 byte header
  // (RIFF + fmt + optional fact/LIST). 2 KB is plenty and stays on the stack.
  uint8_t head[2048];
  size_t headLen = 0;
  bool dataStarted = false;
  uint32_t rate = 16000;
  uint16_t channels = 1;
  uint16_t bits = 16;
  bool fmtOk = false;
  uint32_t lastByte = millis();
  const uint32_t hardEnd = millis() + 180000UL;

  auto pull = [&](uint8_t* dst, size_t want) -> int {
    size_t got = 0;
    while (got < want && millis() < hardEnd) {
      if (!s->connected() && s->available() <= 0) break;
      const int av = s->available();
      if (av <= 0) {
        if (millis() - lastByte > 20000) break;
        M5.update();
        tickFace();
        delay(2);
        continue;
      }
      const int n = s->read(dst + got, min((size_t)av, want - got));
      if (n <= 0) {
        delay(2);
        continue;
      }
      got += (size_t)n;
      lastByte = millis();
    }
    return (int)got;
  };

  // Read first bytes and parse chunks without holding the body.
  while (!dataStarted && headLen < sizeof(head) && millis() < hardEnd) {
    const int n = pull(head + headLen, min(sizeof(head) - headLen, (size_t)256));
    if (n <= 0) break;
    headLen += (size_t)n;
    if (headLen < 12) continue;
    if (memcmp(head, "RIFF", 4) || memcmp(head + 8, "WAVE", 4)) {
      err = "resposta sem audio";
      return false;
    }
    size_t i = 12;
    while (i + 8 <= headLen) {
      const uint32_t sz = (uint32_t)head[i + 4] | ((uint32_t)head[i + 5] << 8) |
                          ((uint32_t)head[i + 6] << 16) | ((uint32_t)head[i + 7] << 24);
      if (!memcmp(head + i, "fmt ", 4)) {
        if (i + 8 + 16 > headLen) break;
        const uint16_t format = (uint16_t)(head[i + 8] | (head[i + 9] << 8));
        channels = (uint16_t)(head[i + 10] | (head[i + 11] << 8));
        rate = (uint32_t)head[i + 12] | ((uint32_t)head[i + 13] << 8) |
               ((uint32_t)head[i + 14] << 16) | ((uint32_t)head[i + 15] << 24);
        bits = (uint16_t)(head[i + 22] | (head[i + 23] << 8));
        if (format != 1 || bits != 16 || channels < 1 || channels > 2 || rate < 8000 || rate > 48000) {
          err = "audio incompativel";
          return false;
        }
        fmtOk = true;
      }
      if (!memcmp(head + i, "data", 4)) {
        if (!fmtOk) { err = "resposta sem audio"; return false; }
        dataStarted = true;
        i += 8;
        // Any PCM already in `head` after the data header is the first audio.
        // We copy it into the first stream buffer below.
        // Shift leftover PCM to the start of head for the caller.
        const size_t leftover = headLen - i;
        if (leftover && i > 0) memmove(head, head + i, leftover);
        headLen = leftover;
        break;
      }
      const size_t next = i + 8 + ((sz + 1) & ~1u);
      if (next > headLen) break;
      i = next;
    }
  }
  if (!dataStarted) {
    err = "resposta sem audio";
    return false;
  }
  outRate = rate;
  const bool stereo = channels > 1;
  Serial.printf("[relay] stream wav rate=%u ch=%u leftover=%u\n",
                (unsigned)rate, (unsigned)channels, (unsigned)headLen);

  speakerMode();
  setState(ChanState::Speaking);
  setVoiceUi("Respondendo...", lastReply.length() ? lastReply.c_str() : nullptr);
  logMem("playback");
  audioPlayedInFetch = true;

  int q = 0;
  size_t fillBytes = 0;
  auto* cur = (uint8_t*)streamPcm[0];
  const size_t chunkBytes = kStreamChunkSamples * sizeof(int16_t);
  bool cancelled = false;
  uint32_t lastMem = millis();

  auto flushChunk = [&](bool final) {
    size_t usable = fillBytes;
    if (usable & 1) usable -= 1;  // whole samples
    if (!usable && !final) return true;
    const size_t samples = usable / 2;
    if (samples) {
      if (!playQueuedChunk(streamPcm[q], samples, rate, stereo)) {
        cancelled = true;
        return false;
      }
      outSamples += (uint32_t)(stereo ? samples / 2 : samples);
    }
    q = (q + 1) % kStreamBufCount;
    cur = (uint8_t*)streamPcm[q];
    fillBytes = 0;
    return true;
  };

  // First leftover PCM from the header buffer.
  if (headLen) {
    const size_t n = min(headLen, chunkBytes);
    memcpy(cur, head, n);
    fillBytes = n;
    if (headLen > n) {
      // Extremely unlikely (header leftover > 32 KB); drop extras.
    }
    if (fillBytes >= chunkBytes && !flushChunk(false)) {
      cancelled = true;
    }
  }

  while (!cancelled && millis() < hardEnd) {
    if (fillBytes >= chunkBytes && !flushChunk(false)) break;
    const size_t room = chunkBytes - fillBytes;
    if (!s->connected() && s->available() <= 0) break;
    const int av = s->available();
    if (av <= 0) {
      if (!s->connected()) break;
      if (millis() - lastByte > 20000) break;
      M5.update();
      tickFace();
      delay(2);
      continue;
    }
    const int n = s->read(cur + fillBytes, min((size_t)av, room));
    if (n <= 0) {
      delay(2);
      continue;
    }
    fillBytes += (size_t)n;
    lastByte = millis();
    if (millis() - lastMem >= 2000) {
      logMem("stream");
      lastMem = millis();
    }
  }
  if (!cancelled && fillBytes) flushChunk(true);

  // Drain the speaker queue.
  uint32_t waitStart = millis();
  while (M5.Speaker.isPlaying() && millis() - waitStart < 180000UL) {
    M5.update();
    tickFace();
    if (cancelRequested || (M5.BtnB.wasDecideClickCount() && M5.BtnB.getClickCount() >= 2)) {
      M5.Speaker.stop();
      break;
    }
    delay(10);
  }
  Serial.printf("[relay] stream done samples=%u rate=%u cancelled=%d\n",
                (unsigned)outSamples, (unsigned)rate, cancelled ? 1 : 0);
  return outSamples > 0;
}

static int fetchAudio(const String& url, const uint8_t* body, size_t bodyLen, String& err, bool announce = true) {
  RadioQuiet quiet;
  audioPlayedInFetch = false;
  // Free leftover TTS and the talking-face cache before a new download so a
  // later reply cannot fail with "PSRAM cheia" after the first playback.
  faceController.shrinkSpeakingCache();
  sink.release();
  playPcm = nullptr;
  playSamples = 0;
  logMem("tls_connect");
  RelayCall c;
  if (!c.begin(url, 60000)) { err = "URL invalida"; return -1; }
  static const char* keys[] = {"X-Reply", "X-Transcript", "X-Sample-Rate"};
  c.http.collectHeaders(keys, 3);
  int code;
  if (body) {
    c.http.addHeader("Content-Type", "audio/wav");
    code = c.http.POST((uint8_t*)body, bodyLen);
  } else {
    code = c.http.GET();
  }
  if (code <= 0) {
    err = c.http.errorToString(code);
    c.http.end();
    sink.release();
    Serial.printf("[relay] fetch fail code=%d err=%s\n", code, err.c_str());
    return code;
  }
  if (c.http.hasHeader("X-Transcript")) lastTranscript = urlDecode(c.http.header("X-Transcript"));
  if (c.http.hasHeader("X-Reply")) lastReply = urlDecode(c.http.header("X-Reply"));
  clipText(lastTranscript, 8 * 1024);
  clipText(lastReply, 16 * 1024);
  if (code != 200) {
    // Read a short error body only; never buffer a huge page into PSRAM.
    char peek[161];
    int n = 0;
    WiFiClient* s = c.http.getStreamPtr();
    if (s) n = s->readBytes(peek, 160);
    if (n > 0) { peek[n] = 0; err = String("HTTP ") + code + " " + peek; }
    else err = String("HTTP ") + code;
    Serial.printf("[relay] fetch fail code=%d err=%s\n", code, err.c_str());
    c.http.end();
    sink.release();
    return code;
  }
  if (announce) showTranscriptThenAnswer(lastReply);
  uint32_t samples = 0, rate = 0;
  const bool ok = streamWavToSpeaker(c.http.getStreamPtr(), c.http, err, samples, rate);
  c.http.end();
  sink.release();
  playPcm = nullptr;
  playSamples = 0;
  playRate = rate;
  setState(ChanState::Idle);
  restoreAudio();
  endVoiceUi();
  faceController.shrinkSpeakingCache();
  if (!ok) {
    if (!err.length()) err = "resposta sem audio";
    logMem("idle_after_error");
    Serial.printf("[relay] fetch fail code=%d err=%s\n", code, err.c_str());
    return -3;
  }
  logMem("idle_after_play");
  faceController.showHappy(1600);
  delay(400);
  Serial.printf("[relay] fetch ok code=200 streamed_samples=%u rate=%u\n",
                (unsigned)samples, (unsigned)rate);
  return code;
}

static int relayJson(const char* method, const String& url, const uint8_t* body, size_t len,
                     const char* ctype, String& out) {
  RadioQuiet quiet;
  logMem("tls_connect");
  RelayCall c;
  if (!c.begin(url, 90000)) return -1;
  if (ctype) c.http.addHeader("Content-Type", ctype);
  int code = (strcmp(method, "GET") == 0) ? c.http.GET()
           : (strcmp(method, "POST") == 0) ? c.http.POST(body ? (uint8_t*)body : (uint8_t*)"", len)
                                           : -1;
  // Cap job/JSON bodies so a long reply cannot blow the heap.
  const int sz = c.http.getSize();
  const size_t cap = 48 * 1024;
  if (sz > (int)cap) {
    Serial.printf("[relay] json body %d clipped to %u\n", sz, (unsigned)cap);
  }
  out = c.http.getString();
  if (out.length() > cap) out.remove(cap);
  c.http.end();
  return code;
}

static void normalize(int16_t* s, size_t n) {
  int16_t peak = 1;
  for (size_t i = 0; i < n; ++i) peak = max<int16_t>(peak, abs(s[i]));
  if (peak < 256) return;
  float g = min(8.0f, 26000.0f / peak);
  if (g <= 1.05f) return;
  for (size_t i = 0; i < n; ++i) s[i] = (int16_t)constrain((int)(s[i] * g), -32767, 32767);
}

static void boostPcm(int16_t* s, size_t n, float g) {
  if (g <= 1.01f || !s) return;
  for (size_t i = 0; i < n; ++i) {
    float x = s[i] * g / 32767.0f, a = fabsf(x);
    if (a > 0.65f) {
      float e = (a - 0.65f) / 0.35f;
      a = 0.65f + 0.35f * (e / (1.0f + e));
      x = x < 0 ? -a : a;
    }
    s[i] = (int16_t)constrain((int)(x * 32767.0f), -32767, 32767);
  }
}

static bool healthPending = false;
static int lastHealthCode = 0;
static uint8_t healthTries = 0;
static uint32_t lastHealthMs = 0;

static void logTlsPrep(const char* host) {
  logMem("tls_connect");
  if (host && host[0]) {
    IPAddress ip;
    const int ok = WiFi.hostByName(host, ip);
    if (ok) {
      Serial.printf("[relay] dns %s -> %s\n", host, ip.toString().c_str());
      WiFiClient probe;
      const uint32_t t0 = millis();
      const bool tcp = probe.connect(ip, 443, 8000);
      Serial.printf("[relay] tcp %s:443 %s %lums\n",
                    ip.toString().c_str(),
                    tcp ? "ok" : "fail",
                    (unsigned long)(millis() - t0));
      if (tcp) probe.stop();
    } else {
      Serial.printf("[relay] dns fail %s err=%d\n", host, ok);
    }
  }
}

static String relayHost() {
  String base = relayBase(RELAY_URL);
  // base is "https://host" (no trailing path)
  const int scheme = base.indexOf("://");
  String host = scheme >= 0 ? base.substring(scheme + 3) : base;
  const int slash = host.indexOf('/');
  if (slash >= 0) host = host.substring(0, slash);
  const int colon = host.indexOf(':');
  if (colon >= 0) host = host.substring(0, colon);
  return host;
}

static void pingRelayHealth() {
  RadioQuiet quiet;
  String url = relayBase(RELAY_URL) + "/api/health";
  const String host = relayHost();
  logTlsPrep(host.c_str());
  RelayCall c;
  if (!c.begin(url, 35000)) {
    Serial.printf("[relay] health begin fail %s\n", url.c_str());
    showBubble("Wi-Fi ok, relay falhou");
    return;
  }
  int code = c.http.GET();
  String body;
  if (code > 0) {
    body = c.http.getString();
    if (body.length() > 100) body = body.substring(0, 100);
    body.replace('\n', ' ');
  } else {
    body = c.http.errorToString(code);
  }
  c.http.end();
  lastHealthCode = code;
  lastHealthMs = millis();
  healthTries++;
  Serial.printf("[relay] health %s -> %d %s (try=%u)\n", url.c_str(), code, body.c_str(),
                (unsigned)healthTries);
  if (code == 200) {
    showBubble("Relay ok");
  } else if (healthTries < 5) {
    healthPending = true;
    showBubble(String("Wi-Fi ok, tentando relay ") + String(healthTries) + "/5");
  } else {
    showBubble(String("Wi-Fi ok, relay ") + (code > 0 ? String(code) : "falhou"));
  }
}

static bool ensureWifi(bool force) {
  if (WiFi.isConnected()) return true;
  if (!force && lastWifiTry && millis() - lastWifiTry < 10000) return false;
  lastWifiTry = millis();
  lastLink = 4;
  faceController.setLinkState(4);
  showBubble("Procurando Wi-Fi...");
  Serial.printf("[relay] procurando Wi-Fi, %u redes:", (unsigned)WIFI_COUNT);
  for (size_t i = 0; i < WIFI_COUNT; ++i) {
    Serial.printf(" %s", WIFI_LIST[i].ssid);
  }
  Serial.println();
  bool ok = wifiMulti.run(15000) == WL_CONNECTED;
  if (ok) {
    Serial.printf("[relay] wifi ok ssid=%s ip=%s\n",
                  WiFi.SSID().c_str(),
                  WiFi.localIP().toString().c_str());
    if (!ntpStarted) {
      configTzTime(TZ_POSIX, "pool.ntp.org", "time.google.com");
      ntpStarted = true;
    }
    lastLink = 3;
    faceController.setLinkState(3);
    healthPending = true;
  } else {
    lastLink = 5;
    faceController.setLinkState(5);
    Serial.println("[relay] sem Wi-Fi (2.4 GHz)");
    showBubble("Sem Wi-Fi. Confira a rede 2.4 GHz.");
  }
  return ok;
}

static bool playReply() {
  // Streaming playback happens in fetchAudio. Replay is only possible if a
  // leftover PCM pointer is still held (it is released after each turn).
  if (!playPcm || !playSamples) return false;
  logMem("playback");
  speakerMode();
  setState(ChanState::Speaking);
  setVoiceUi("Respondendo...", lastReply.length() ? lastReply.c_str() : nullptr);
  boostPcm(const_cast<int16_t*>(playPcm), playSamples, 1.8f);
  M5.Speaker.playRaw(playPcm, playSamples, playRate, false, 1, 0);
  while (M5.Speaker.isPlaying()) {
    M5.update();
    tickFace();
    if (M5.BtnB.wasDecideClickCount() && M5.BtnB.getClickCount() >= 2) {
      M5.Speaker.stop();
      break;
    }
    delay(10);
  }
  setState(ChanState::Idle);
  restoreAudio();
  endVoiceUi();
  sink.release();
  playPcm = nullptr;
  playSamples = 0;
  faceController.shrinkSpeakingCache();
  logMem("idle_after_play");
  faceController.showHappy(1600);
  delay(400);
  return false;
}

static void showError(const String& err) {
  haptic(220, 80);
  endVoiceUi();
  Serial.printf("[ui] error=%s\n", err.c_str());
  showBubble(err);
  setState(ChanState::Idle);
  restoreAudio();
  faceController.shrinkSpeakingCache();
  logMem("idle_after_error");
}

static int16_t recChunk[REC_CHUNK];  // internal RAM, not the loop stack

static bool recordWhileButton(m5::Button_Class& btn, const char* agentName, const char* releaseHint,
                              uint32_t forcedMs = 0) {
  if (!recBuf) return false;
  logMem("hold_start");
  Serial.printf("[ui] phase=listening agent=%s\n", agentName);
  faceController.setAgentLabel(agentName);
  pauseStreetPassRadio("relay_record");
  // Frozen last frame + bottom status; no JPEG and no bubble during record
  // so the first ~200ms of speech is not delayed.
  (void)releaseHint;
  setVoiceUi("Escutando...", "");
  haptic(80, 35);
  micMode();
  logMem("mic_begin");
  // Keep the background mic_capture task off while we own I2S.
  audioController.setInteractionMicBlocked(true, "relay");
  setState(ChanState::Listening);
  size_t n = 0;
  uint32_t started = millis();
  uint32_t lastMem = started;
  auto stillHeld = [&]() {
    if (forcedMs > 0) return (millis() - started) < forcedMs;
    return btn.isPressed() || btn.isHolding();
  };
  while (stillHeld()) {
    M5.update();
    // The other button cancels the take (and A+B must not reboot).
    if (&btn == &M5.BtnA && M5.BtnB.wasPressed()) { n = 0; break; }
    if (&btn == &M5.BtnB && M5.BtnA.wasPressed()) { n = 0; break; }
    if (n >= REC_MAX) break;
    const size_t got = min((size_t)REC_CHUNK, REC_MAX - n);
    if (M5.Mic.record(recChunk, got, REC_RATE, false)) {
      memcpy((int16_t*)(recBuf + WAV_HDR) + n, recChunk, got * 2);
      n += got;
    }
    const uint32_t now = millis();
    if (now - lastMem >= 1000) {
      logMem("record");
      const unsigned expect = ((now - started) * (REC_RATE / 1000));
      Serial.printf("[audio] record tick samples=%u expect=%u ratio=%u%%\n",
                    (unsigned)n, expect, expect ? (unsigned)((n * 100ull) / expect) : 0);
      lastMem = now;
    }
    if (now - started > (MAX_RECORD_SECONDS * 1000UL + 400)) break;
  }
  const uint32_t elapsed = millis() - started;
  M5.Mic.end();
  Serial.printf("[ui] phase=recorded samples=%u ms=%lu\n",
                static_cast<unsigned>(n),
                static_cast<unsigned long>(elapsed));
  logPcmStats("recorded", (int16_t*)(recBuf + WAV_HDR), n, elapsed);
  logMem("record_end");
  if (forcedMs == 0 && n < REC_RATE / 4) {
    showError("A gravacao ficou curta. Segure o botao e fale a frase.");
    return false;
  }
  if (n > 0) {
    normalize((int16_t*)(recBuf + WAV_HDR), n);
    writeWavHeader(recBuf, n * 2, REC_RATE);
    logPcmStats("normalized", (int16_t*)(recBuf + WAV_HDR), n, elapsed);
  }
  recSamples = n;
  return n > 0;
}

static bool recordWhileA() { return recordWhileButton(M5.BtnA, "ChatGPT", "Solte o A para enviar"); }
static bool recordWhileB() { return recordWhileButton(M5.BtnB, "Grok Bot", "Solte o B para enviar"); }
static bool recordForced(const char* agent, uint32_t ms) {
  return recordWhileButton((agent[0] == 'G') ? M5.BtnB : M5.BtnA, agent, "teste", ms);
}

static void showTranscriptThenAnswer(const String& answer) {
  if (lastTranscript.length()) {
    Serial.printf("[ui] phase=transcript chars=%u text=%s\n",
                  static_cast<unsigned>(lastTranscript.length()),
                  lastTranscript.c_str());
    showBubble(String("Voc\xC3\xAA: ") + lastTranscript);
    const uint32_t until = millis() + 1400;
    while (millis() < until) {
      M5.update();
      tickFace();
      delay(16);
    }
  }
  if (answer.length()) {
    Serial.printf("[ui] phase=answer chars=%u\n", static_cast<unsigned>(answer.length()));
    showBubble(answer);
  }
}

static bool loadWavIntoRecBuf(const uint8_t* data, size_t len, String& err) {
  if (!recBuf || len < 44 || len > WAV_HDR + REC_MAX * 2) {
    err = "wav invalido";
    return false;
  }
  memcpy(recBuf, data, len);
  const int16_t* pcm = nullptr;
  size_t samples = 0;
  uint32_t rate = 0;
  if (!parseWav(recBuf, len, &pcm, &samples, &rate) || rate != REC_RATE) {
    err = "wav precisa ser PCM 16 kHz mono";
    return false;
  }
  recSamples = samples;
  return true;
}

static size_t recordedSamples() { return recSamples; }

static void fastConversation() {
  sessionBusy = true;
  cancelRequested = false;
  if (!ensureWifi(true)) { sessionBusy = false; return; }
  size_t n = recordedSamples();
  Serial.println("[ui] phase=thinking agent=ChatGPT");
  faceController.setAgentLabel("ChatGPT");
  setVoiceUi("Pensando...", lastTranscript.length() ? (String("Voc\xC3\xAA: ") + lastTranscript).c_str() : "");
  setState(ChanState::Idle);
  String err;
  String url = String(RELAY_URL);
  int code = fetchAudio(url, recBuf, WAV_HDR + n * 2, err, true);
  if (code != 200 && RELAY_URL_LAN[0]) {
    url = String(RELAY_URL_LAN);
    code = fetchAudio(url, recBuf, WAV_HDR + n * 2, err, true);
  }
  if (code != 200) {
    showError(err.length() ? err : "O rele nao respondeu");
    sessionBusy = false;
    return;
  }
  activeBase = relayBase(url.c_str());
  sessionBusy = false;
}

struct JobState {
  String id, base, status, text;
  uint32_t seenVersion = 0;
  bool finished = false;
} job;

static void jobPollTask(void*) {
  String out;
  uint32_t start = millis();
  while (!job.finished && !cancelRequested && millis() - start < JOB_TIMEOUT_MS) {
    vTaskDelay(pdMS_TO_TICKS(JOB_POLL_MS));
    if (cancelRequested) {
      relayJson("POST", job.base + "/api/job/" + job.id + "/cancel", (const uint8_t*)"", 0, "application/json", out);
      job.status = "cancelled";
      job.finished = true;
      break;
    }
    int code = relayJson("GET", job.base + "/api/job/" + job.id, nullptr, 0, nullptr, out);
    if (code != 200) continue;
    JsonDocument d;
    if (deserializeJson(d, out)) continue;
    job.status = d["status"] | "";
    job.text = d["text"] | job.text;
    JsonArray steps = d["steps"].as<JsonArray>();
    if (!steps.isNull()) job.seenVersion = steps.size();
    if (job.status == "completed" || job.status == "error" || job.status == "cancelled") {
      job.finished = true;
    }
    // Progress goes into lastReply (marker). Keep lastTranscript as the user's words.
    if (!steps.isNull() && steps.size()) {
      String prog;
      if (d["transcript"].is<const char*>() && lastTranscript.isEmpty()) {
        lastTranscript = (const char*)d["transcript"];
      }
      uint8_t shown = 0;
      int first = max(0, (int)steps.size() - 4);
      for (int i = first; i < (int)steps.size(); ++i) {
        const char* st = steps[i]["text"] | steps[i] | "";
        if (st && *st) {
          if (shown) prog += "\n";
          prog += st;
          shown++;
        }
      }
      if (prog.length()) lastReply = String("\x01") + prog;  // marker: UI should show as progress
    }
  }
  if (!job.finished) {
    job.status = "cancelled";
    job.finished = true;
  }
  vTaskDelete(nullptr);
}

static void agentConversation() {
  sessionBusy = true;
  cancelRequested = false;
  if (!ensureWifi(true)) { sessionBusy = false; return; }
  size_t n = recordedSamples();
  setVoiceUi("Pensando...", lastTranscript.length() ? (String("Voc\xC3\xAA: ") + lastTranscript).c_str() : "");
  String out, base = relayBase(RELAY_URL);
  int code = relayJson("POST", base + "/api/agent", recBuf, WAV_HDR + n * 2, "audio/wav", out);
  if (code <= 0 && RELAY_URL_LAN[0]) {
    base = relayBase(RELAY_URL_LAN);
    code = relayJson("POST", base + "/api/agent", recBuf, WAV_HDR + n * 2, "audio/wav", out);
  }
  if (code != 202 && code != 200) {
    showError(out.length() ? out : (String("HTTP ") + code));
    sessionBusy = false;
    return;
  }
  JsonDocument d;
  if (deserializeJson(d, out) || !d["jobId"].is<const char*>()) {
    showError("O rele nao devolveu um job");
    sessionBusy = false;
    return;
  }
  job = {};
  job.id = d["jobId"].as<const char*>();
  job.base = base;
  job.status = d["status"] | "running";
  lastTranscript = d["transcript"] | "";
  Serial.printf("[ui] phase=thinking agent=Grok Bot job=%s\n", job.id.c_str());
  faceController.setAgentLabel("Grok Bot");
  setVoiceUi("Pensando...", lastTranscript.length() ? (String("Voc\xC3\xAA: ") + lastTranscript).c_str() : "");
  activeBase = base;
  xTaskCreatePinnedToCore(jobPollTask, "job", 8192, nullptr, 1, nullptr, 0);
  uint32_t lastDraw = 0;
  String shown;
  while (!job.finished) {
    M5.update();
    if (M5.BtnB.wasDecideClickCount()) {
      cancelRequested = true;
      showBubble("Cancelando...");
    }
    if (lastReply.startsWith("\x01")) {
      String prog = lastReply.substring(1);
      if (lastTranscript.length() && prog.indexOf("Voce:") < 0) {
        prog = String("Voc\xC3\xAA: ") + lastTranscript + "\n" + prog;
      }
      if (prog != shown && millis() - lastDraw > 200) {
        Serial.println("[ui] phase=progress");
        showBubble(prog);
        shown = prog;
        lastDraw = millis();
      }
    }
    if (M5.BtnA.wasPressed() || (M5.BtnA.isPressed() && M5.BtnB.isPressed())) {
      cancelRequested = true;
      showBubble("Cancelando...");
    }
    tickFace();
    delay(20);
  }
  if (job.status == "cancelled") {
    showError("Cancelei. Se a rotina ja comecou, ela pode terminar no Grok Bot.");
    sessionBusy = false;
    return;
  }
  if (job.status != "completed") {
    showError(job.text.length() ? job.text : String("Nao deu certo."));
    sessionBusy = false;
    return;
  }
  lastReply = job.text;
  clipText(lastReply, 16 * 1024);
  Serial.println("[ui] phase=preparing_voice agent=Grok Bot");
  showTranscriptThenAnswer(lastReply.length() ? lastReply : String("Preparando a voz..."));
  haptic(200, 120);
  String err;
  int ac = fetchAudio(job.base + "/api/job/" + job.id + "/audio", nullptr, 0, err, false);
  if (ac != 200) {
    showBubble(lastReply.length() ? lastReply : err);
    uint32_t until = millis() + 8000;
    while (millis() < until) {
      M5.update();
      tickFace();
      if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed()) break;
      delay(10);
    }
    endVoiceUi();
    setState(ChanState::Idle);
    restoreAudio();
    faceController.shrinkSpeakingCache();
    logMem("idle_after_error");
  }
  sessionBusy = false;
}

static void updateClock() {
  if (!ntpStarted) return;
  uint32_t now = millis();
  if (lastClockMs && now - lastClockMs < 5000) return;
  lastClockMs = now;
  struct tm t = {};
  if (!getLocalTime(&t, 0)) return;
  char text[6];
  snprintf(text, sizeof(text), "%02d:%02d", t.tm_hour, t.tm_min);
  faceController.setClockText(text, true);
}

}  // namespace

void pollDebugSerial();

void begin() {
  mbedtls_platform_set_calloc_free(tlsCalloc, tlsFree);
  deviceId = WiFi.macAddress();
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  // ESP32-S3 coexist aborts if Wi-Fi modem sleep is off while BLE is on:
  // "Should enable WiFi modem sleep when both WiFi and Bluetooth are enabled"
  WiFi.setSleep(true);
  WiFi.setHostname("jax-ptbr");
  for (size_t i = 0; i < WIFI_COUNT; ++i) wifiMulti.addAP(WIFI_LIST[i].ssid, WIFI_LIST[i].pass);
  recBuf = (uint8_t*)heap_caps_malloc(WAV_HDR + REC_MAX * 2 + 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!recBuf) {
    showBubble("PSRAM indisponivel. Compile com PSRAM = OPI.");
  }
#ifdef RELAY_UNCONFIGURED
  showBubble("Falta config_relay.h com Wi-Fi e o token.");
#endif
  auto mc = M5.Mic.config();
  mc.sample_rate = REC_RATE;
  M5.Mic.config(mc);
  M5.BtnA.setHoldThresh(350);
  M5.BtnB.setHoldThresh(350);
  faceController.setAgentLabel("ChatGPT");
  lastLink = 4;
  faceController.setLinkState(4);
  ensureWifi(true);
}

void update(unsigned long now) {
  (void)now;
  pollDebugSerial();
  if (healthPending && WiFi.isConnected() && !sessionBusy &&
      (lastHealthMs == 0 || millis() - lastHealthMs > 2000)) {
    healthPending = false;
    pingRelayHealth();
  }
  if (!sessionBusy) {
    if (!WiFi.isConnected()) {
      lastLink = lastLink == 4 ? 4 : 5;
      if (lastWifiTry == 0 || millis() - lastWifiTry > 15000) ensureWifi(false);
    } else {
      lastLink = 3;
    }
    faceController.setLinkState(lastLink);
    faceController.setAgentLabel(currentMode == Mode::Agent ? "Grok Bot" : "ChatGPT");
  }
  updateClock();
}

bool busy() { return sessionBusy || recording || testWavRemaining() > 0; }

bool wifiConnected() { return WiFi.isConnected(); }

uint8_t linkState() { return lastLink; }

const char* agentLabel() { return currentMode == Mode::Agent ? "Grok Bot" : "ChatGPT"; }

String wifiSsid() { return WiFi.isConnected() ? WiFi.SSID() : String(); }
String wifiIp() { return WiFi.isConnected() ? WiFi.localIP().toString() : String(); }

void resetConversation() {
  String out;
  String base = activeBase.length() ? activeBase : relayBase(RELAY_URL);
  if (WiFi.isConnected()) {
    relayJson("POST", base + "/api/reset", (const uint8_t*)"", 0, "application/json", out);
  }
  lastReply = "";
  lastTranscript = "";
  playSamples = 0;
  showBubble("Nova conversa");
  delay(800);
  clearBubble();
}

static void openSettingsFromButtons() {
  Serial.println("[ui] phase=settings");
  openDeviceSettings();
  haptic(80, 35);
}

static void startTalk(Mode mode) {
  currentMode = mode;
  faceController.setAgentLabel(agentLabel());
  recording = true;
  const bool ok = (mode == Mode::Agent) ? recordWhileB() : recordWhileA();
  recording = false;
  if (!ok) return;
  haptic(80, 35);
  if (mode == Mode::Agent) agentConversation();
  else fastConversation();
}

void startTalkFromWake(bool agent) {
  if (sessionBusy || recording) return;
  startTalk(agent ? Mode::Agent : Mode::Fast);
}

bool handleButtons(unsigned long now) {
  if (!displayOn) return false;
  if (infoScreenVisible) return false;

  // A+B (held together) opens settings; never starts a recording or reboots.
  if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
    if (sessionBusy) {
      cancelRequested = true;
      showBubble("Cancelando...");
      return true;
    }
    if (M5.BtnA.wasHold() || M5.BtnB.wasHold() ||
        (M5.BtnA.isHolding() && M5.BtnB.isHolding())) {
      openSettingsFromButtons();
    }
    return true;
  }

  if (sessionBusy) {
    // Swallow A/B so upstream does not open the old settings mapping mid-job.
    if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed() ||
        (M5.BtnB.wasDecideClickCount() && M5.BtnB.getClickCount() >= 2)) {
      cancelRequested = true;
      showBubble("Cancelando...");
    }
    return true;
  }

  if (M5.BtnA.wasHold() && !recording) {
    startTalk(Mode::Fast);
    return true;
  }
  if (M5.BtnB.wasHold() && !recording) {
    startTalk(Mode::Agent);
    return true;
  }

  if (M5.BtnB.wasDecideClickCount()) {
    const uint8_t clicks = M5.BtnB.getClickCount();
    if (clicks >= 2) {
      resetConversation();
      haptic(80, 35);
    }
    return true;
  }

  if (M5.BtnA.wasSingleClicked() && lastReply.length() && playPcm && playSamples) {
    Serial.println("[ui] phase=replay");
    faceController.setAgentLabel(agentLabel());
    playReply();
    return true;
  }

  // Stop main.cpp from treating leftover A/B events as settings or display-off.
  if (M5.BtnA.isPressed() || M5.BtnB.isPressed() ||
      M5.BtnA.wasPressed() || M5.BtnB.wasPressed() ||
      M5.BtnA.wasReleased() || M5.BtnB.wasReleased() ||
      M5.BtnA.wasHold() || M5.BtnB.wasHold() ||
      M5.BtnA.wasClicked() || M5.BtnB.wasClicked() ||
      M5.BtnA.wasSingleClicked() || M5.BtnB.wasSingleClicked() ||
      M5.BtnA.wasDecideClickCount() || M5.BtnB.wasDecideClickCount()) {
    return true;
  }

  (void)now;
  return false;
}

static String dbgLine;
static size_t dbgWavWanted = 0;
static size_t dbgWavGot = 0;
static bool dbgWavToAgent = false;
static uint32_t dbgWavLastMs = 0;

static void debugReply(const char* msg) {
  Serial.printf("[test] %s\n", msg);
}

void handleTestCommand(const char* raw) {
  if (raw == nullptr) return;
  String line = raw;
  line.trim();
  if (line.isEmpty()) return;
  Serial.printf("[test] cmd=%s\n", line.c_str());
  if (line == "TEST PING") {
    debugReply("pong");
  } else if (line.startsWith("TEST HOLD_A")) {
    uint32_t ms = 10000;
    if (line.length() > 11) ms = (uint32_t)line.substring(11).toInt() * 1000UL;
    if (ms < 1000) ms = 10000;
    recording = true;
    recordForced("ChatGPT", ms);
    recording = false;
    restoreAudio();
    setState(ChanState::Idle);
    debugReply("hold_a_done");
  } else if (line.startsWith("TEST HOLD_B")) {
    uint32_t ms = 10000;
    if (line.length() > 11) ms = (uint32_t)line.substring(11).toInt() * 1000UL;
    if (ms < 1000) ms = 10000;
    recording = true;
    recordForced("Grok Bot", ms);
    recording = false;
    restoreAudio();
    setState(ChanState::Idle);
    debugReply("hold_b_done");
  } else if (line == "TEST SETTINGS") {
    openSettingsFromButtons();
    debugReply("settings_open");
  } else if (line == "TEST SETTINGS_CLOSE") {
    setInfoScreenVisible(false);
    debugReply("settings_closed");
  } else if (line == "TEST AVATAR") {
    ::cycleAvatarFromSettings(1);
    debugReply("avatar_cycled");
  } else if (line == "TEST REPLAY") {
    if (playPcm && playSamples) playReply();
    debugReply(playSamples ? "replay_ok" : "replay_empty");
  } else if (line == "TEST RESET") {
    resetConversation();
    debugReply("reset_ok");
  } else if (line == "TEST CLOCK") {
    struct tm tmnow = {};
    getLocalTime(&tmnow, 0);
    Serial.printf("[test] clock=%02d:%02d tz=America/Sao_Paulo format=24h haptic=%d\n",
                  tmnow.tm_hour, tmnow.tm_min, 0);
    debugReply("clock_ok");
  } else if (line == "TEST CANCEL") {
    cancelRequested = true;
    debugReply("cancel_set");
  } else if (line.startsWith("TESTWAV ")) {
    const bool agent = line.indexOf("AGENT") > 0;
    const int sp = line.lastIndexOf(' ');
    const size_t nbytes = (size_t)line.substring(sp + 1).toInt();
    if (!recBuf || nbytes < 44 || nbytes > WAV_HDR + REC_MAX * 2) {
      debugReply("wav_bad_size");
    } else {
      dbgWavToAgent = agent;
      dbgWavWanted = nbytes;
      dbgWavGot = 0;
      dbgWavLastMs = millis();
      debugReply("wav_ready");
    }
  } else if (line == "TEST STATUS") {
    Serial.printf("[test] wifi=%d ip=%s agent=%s busy=%d rec=%u\n",
                  WiFi.isConnected() ? 1 : 0,
                  WiFi.localIP().toString().c_str(),
                  agentLabel(),
                  sessionBusy ? 1 : 0,
                  (unsigned)recSamples);
  } else if (line == "TEST MEM") {
    logMem("test_mem");
    debugReply("mem");
  } else if (line == "TEST ACCENT") {
    faceController.showAccentTest();
    debugReply("accent");
  } else {
    debugReply("unknown_cmd");
  }
}

size_t testWavRemaining() {
  return (dbgWavWanted > dbgWavGot) ? (dbgWavWanted - dbgWavGot) : 0;
}

size_t acceptTestWavBytes(const uint8_t* data, size_t length) {
  if (!data || !length || !recBuf || !testWavRemaining()) return 0;
  const size_t n = min(length, testWavRemaining());
  const size_t before = dbgWavGot;
  memcpy(recBuf + dbgWavGot, data, n);
  dbgWavGot += n;
  dbgWavLastMs = millis();
  if ((before / 1024) != (dbgWavGot / 1024) || dbgWavGot >= dbgWavWanted) {
    Serial.printf("[test] wav_got %u/%u\n", (unsigned)dbgWavGot, (unsigned)dbgWavWanted);
  }
  if (dbgWavGot >= dbgWavWanted) {
    String err;
    const size_t total = dbgWavWanted;
    dbgWavWanted = 0;
    if (!loadWavIntoRecBuf(recBuf, total, err)) {
      debugReply(err.c_str());
      return n;
    }
    debugReply(dbgWavToAgent ? "wav_ok agent" : "wav_ok fast");
    sessionBusy = true;
    if (dbgWavToAgent) agentConversation();
    else fastConversation();
  }
  return n;
}

void pollDebugSerial() {
  if (testWavRemaining() && dbgWavLastMs && millis() - dbgWavLastMs > 8000) {
    dbgWavWanted = 0;
    dbgWavGot = 0;
    debugReply("wav_timeout");
  }
  // USB parser usually already consumed the line. This is a fallback when
  // USB_SERIAL_PROTOCOL is off or a byte slipped through.
  if (testWavRemaining() && Serial.available()) {
    uint8_t chunk[256];
    const size_t want = min(sizeof(chunk), testWavRemaining());
    const int got = Serial.readBytes(chunk, want);
    if (got > 0) acceptTestWavBytes(chunk, static_cast<size_t>(got));
    return;
  }
  while (Serial.available()) {
    const int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (dbgLine.length() < 160) dbgLine += char(ch);
      continue;
    }
    dbgLine.trim();
    if (dbgLine.startsWith("TEST")) handleTestCommand(dbgLine.c_str());
    dbgLine = "";
  }
}

}  // namespace RelayVoice
