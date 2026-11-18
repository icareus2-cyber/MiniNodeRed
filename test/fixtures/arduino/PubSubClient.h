// Stand-in for tests (see Arduino.h).
#pragma once
#include <functional>
extern std::string published;
struct PubSubClient {
  bool up = true;
  explicit PubSubClient(WiFiClient&) {}
  void setServer(const char*, int) {}
  void setBufferSize(int) {}
  void setCallback(void (*)(char*, byte*, unsigned int)) {}
  bool connected() { return up; }
  bool connect(const char*, const char*, const char*) { return true; }
  bool connect(const char*, const char*, const char*, const char*, int, bool, const char*) { return true; }
  bool publish(const char* t, const char* p, bool r = false) { published += std::string(t) + " " + p + (r ? " (retained)" : "") + "\n"; return true; }
  bool subscribe(const char*) { return true; }
  bool loop() { return true; }
  int state() { return 0; }
};
