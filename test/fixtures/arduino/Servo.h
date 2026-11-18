// Stand-in for tests (ESP8266 core's Servo).
#pragma once
inline int mfServoUs = 0;
struct Servo {
  uint8_t attach(int, int, int) { return 1; }
  void writeMicroseconds(int us) { mfServoUs = us; }
};
