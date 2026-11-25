#pragma once

#include <Arduino.h>

// Voice path through the M5 Voz Vercel relay (no Mac, no Codex).
// Hold A = ChatGPT rapido, hold B = Grok Bot, A+B or long-press the clock
// band = settings, short A = replay, double B = new conversation, other
// button while busy = cancel.
namespace RelayVoice {
  void begin();
  void update(unsigned long now);
  // Returns true if the StopWatch A/B events were consumed.
  bool handleButtons(unsigned long now);
  bool busy();
  // Start a hold-to-talk session after a display wake (A = ChatGPT, B = Grok Bot).
  void startTalkFromWake(bool agent);
  bool wifiConnected();
  uint8_t linkState();          // FaceController: 2 LAN, 3 internet, 4 connecting, 5 no Wi-Fi, 6 error
  const char* agentLabel();
  String wifiSsid();
  String wifiIp();
  void resetConversation();
  // USB test hook. The Mac-bridge parser owns Serial.read(), so commands
  // arrive here from handleUsbSerialLine / updateUsbSerial.
  void handleTestCommand(const char* line);
  size_t testWavRemaining();
  size_t acceptTestWavBytes(const uint8_t* data, size_t length);
}
