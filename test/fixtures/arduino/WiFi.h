// Stand-in for tests (see Arduino.h).
#pragma once
#define WL_CONNECTED 3
#define WIFI_STA 1
#define WIFI_OFF 0
struct IPAddressT { String toString() const { return String("1.2.3.4"); } };
struct WiFiT { int status() { return WL_CONNECTED; } void persistent(bool) {} void mode(int) {} void begin(const char*, const char*) {} void disconnect() {} IPAddressT localIP() { return IPAddressT(); } int RSSI(int = 0) { return -50; } int scanNetworks() { return 0; } String SSID(int = 0) { return String(); } int channel(int = 0) { return 1; } void scanDelete() {} } WiFi;
// What a raw web response (e.g. the camera's live video) writes; it stays connected
// for mfClientChecks calls of connected().
inline std::string mfClientOut;
inline int mfClientChecks = 3;
struct WiFiClient {
  bool connected() { return mfClientChecks-- > 0; }
  size_t print(const char* s) { mfClientOut += s; return strlen(s); }
  size_t write(const uint8_t* p, size_t n) { mfClientOut.append((const char*)p, n); return n; }
  void stop() {}
};
