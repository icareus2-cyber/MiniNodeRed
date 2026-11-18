// Stand-in for tests.
#pragma once
#define DHT11 11
#define DHT22 22
inline float mfDhtTemp = 23.25f, mfDhtHumidity = 48.5f;
struct DHT {
  DHT(uint8_t, uint8_t) {}
  void begin() {}
  float readTemperature() { return mfDhtTemp; }
  float readHumidity() { return mfDhtHumidity; }
};
