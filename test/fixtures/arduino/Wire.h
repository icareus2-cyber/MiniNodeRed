// Stand-in for tests: one MPU-6050 on the bus (test/devices.test.js sets its registers).
#pragma once
struct TwoWire {
  uint8_t addr = 0, reg = 0, regs[128] = {};
  bool first = false;
  int pos = 0, present = 0x68;
  void begin(int, int) {}
  void beginTransmission(uint8_t a) { addr = a; first = true; }
  size_t write(uint8_t v) { if (first) { reg = v; first = false; } else regs[reg++ & 127] = v; return 1; }
  uint8_t endTransmission(bool = true) { return addr == present ? 0 : 2; }
  uint8_t requestFrom(int a, int n) { if (a != present) return 0; pos = reg; return n; }
  int read() { return regs[pos++ & 127]; }
};
inline TwoWire Wire;
