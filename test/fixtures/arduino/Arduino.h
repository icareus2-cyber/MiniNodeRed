// Minimal Arduino/ESP stand-in so tests can compile generated sketches with the host
// g++ (test/advanced.test.js). Only what release builds use; not a real core.
#pragma once
#include <string>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
using std::isfinite;
struct String {
  std::string s;
  String() {}
  String(const char* c) : s(c) {}
  String(const std::string& c) : s(c) {}
  explicit String(char c) : s(1, c) {}
  explicit String(int v) : s(std::to_string(v)) {}
  explicit String(unsigned int v) : s(std::to_string(v)) {}
  explicit String(long v) : s(std::to_string(v)) {}
  explicit String(unsigned long v) : s(std::to_string(v)) {}
  String(unsigned long v, unsigned char base) { char b[24]; snprintf(b, 24, base == 16 ? "%lx" : "%lu", v); s = b; }
  String(uint32_t v, unsigned char base) : String((unsigned long)v, base) {}
  void replace(const char* a, const String& b) { size_t p; std::string x(a); while ((p = s.find(x)) != std::string::npos) s.replace(p, x.size(), b.s); }
  bool startsWith(const char* x) const { return s.rfind(x, 0) == 0; }
  String substring(unsigned int a) const { return String(s.substr(a)); }
  String substring(unsigned int a, unsigned int b) const { return String(s.substr(a, b - a)); }
  void trim() { size_t a = s.find_first_not_of(" \t\r\n"); if (a == std::string::npos) { s.clear(); return; } s = s.substr(a, s.find_last_not_of(" \t\r\n") - a + 1); }
  void toLowerCase() { for (auto& ch : s) ch = (char)tolower((unsigned char)ch); }
  bool operator!=(const char* o) const { return s != o; }
  explicit String(double v, unsigned int d = 2) { char b[64]; snprintf(b, 64, "%.*f", (int)d, v); s = b; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* o) { s += o; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  bool operator==(const char* o) const { return s == o; }
  bool operator==(const String& o) const { return s == o.s; }
  char operator[](unsigned int i) const { return s[i]; }
  float toFloat() const { return atof(s.c_str()); }
  int indexOf(char c) const { auto p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(const char* x) const { auto p = s.find(x); return p == std::string::npos ? -1 : (int)p; }
  bool endsWith(const char* x) const { size_t n = strlen(x); return s.size() >= n && s.compare(s.size() - n, n, x) == 0; }
  void remove(unsigned int i) { s.erase(i); }
  unsigned int length() const { return s.size(); }
  void reserve(unsigned int n) { s.reserve(n); }
  int toInt() const { return atoi(s.c_str()); }
  const char* c_str() const { return s.c_str(); }
};
inline String operator+(const String& a, const String& b) { return String(a.s + b.s); }
inline String operator+(const char* a, const String& b) { return String(std::string(a) + b.s); }
inline String operator+(const String& a, const char* b) { return String(a.s + b); }
#include <cctype>
#include <cstdarg>
typedef uint8_t byte;
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define INPUT_PULLDOWN 9
#define HEX 16
inline void pinMode(uint8_t, uint8_t) {}
// Tests can watch pin writes and feed analog readings (test/devices.test.js).
inline void (*mfOnWrite)(uint8_t, uint8_t) = nullptr;
inline int (*mfOnAnalog)(uint8_t) = nullptr;
inline void digitalWrite(uint8_t p, uint8_t v) { if (mfOnWrite) mfOnWrite(p, v); }
inline int digitalRead(uint8_t) { return 0; }
inline int analogRead(uint8_t p) { return mfOnAnalog ? mfOnAnalog(p) : 0; }
inline uint32_t analogReadMilliVolts(uint8_t p) { return analogRead(p) * 3300UL / 4095; }
inline void analogWrite(uint8_t, int) {}
using std::isnan;
// millis(): advances 10 ms per call, or stays at mfFakeNow when mfFakeAuto is false
// (tests that control time).
inline unsigned long mfFakeNow = 0;
inline bool mfFakeAuto = true;
inline unsigned long millis() { return mfFakeAuto ? (mfFakeNow += 10) : mfFakeNow; }
// micros(): when time is controlled, mfFakeMicros, which each call moves on by
// mfMicrosStep (so busy-wait loops end); else it follows millis().
inline unsigned long mfFakeMicros = 0, mfMicrosStep = 0;
inline unsigned long micros() { return mfFakeAuto ? millis() * 1000 : (mfFakeMicros += mfMicrosStep); }
inline void delay(unsigned long) {}
inline void delayMicroseconds(unsigned int) {}
// ESP32 LEDC (servos): the last duty per channel (core 2.x) or pin (core 3.x).
inline uint32_t mfLedc[64];
inline double ledcSetup(uint8_t, double f, uint8_t) { return f; }
inline void ledcAttachPin(uint8_t, uint8_t) {}
inline bool ledcAttach(uint8_t, uint32_t, uint8_t) { return true; }
inline void ledcWrite(uint8_t ch, uint32_t duty) { mfLedc[ch] = duty; }
struct SerialT {
  void begin(long) {}
  int available() { return 0; }
  int read() { return -1; }
  template <class T> void print(const T&) {}
  template <class T> void println(const T&) {}
  void println() {}
  void setTxTimeoutMs(int) {}
  void flush() {}
} Serial;
inline uint32_t mfPsramSize = 8388608, mfPsramFree = 8100000, mfFlashSize = 16777216;
struct EspT { uint32_t getPsramSize() { return mfPsramSize; } uint32_t getFreePsram() { return mfPsramFree; } uint32_t getFlashChipSize() { return mfFlashSize; } uint32_t getFreeHeap() { return 1; } uint64_t getEfuseMac() { return 1; } void restart() {} uint32_t getChipId() { return 1; } } ESP;
