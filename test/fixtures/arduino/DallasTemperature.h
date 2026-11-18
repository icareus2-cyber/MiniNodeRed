// Stand-in for tests: the sensor reads mfDsTemp (°C).
#pragma once
#define DEVICE_DISCONNECTED_C -127
inline float mfDsTemp = 21.5f;
struct DallasTemperature {
  explicit DallasTemperature(OneWire*) {}
  void begin() {}
  void setWaitForConversion(bool) {}
  void requestTemperatures() {}
  float getTempCByIndex(int) { return mfDsTemp; }
};
