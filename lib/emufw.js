// C++ for PC input emulation (hardware-in-the-loop), an option of debug builds.
// The flow runs on the real chip with real outputs and communication, but input
// nodes read through mfDigitalRead/mfAnalogRead: "emu <pin> <value>" (USB serial or
// MQTT cmd) makes them see the PC's value instead of the pin. Every node reports
// its output as MF:{"n":"<node id>","v":"<value>"} so the IDE can show what the
// real board does (pin circles, Oscilloscope, flashing nodes).
// Input devices (sensors) can be emulated too: "emu node <node id> <value>" makes the
// node send the PC's value at its own interval instead of reading the sensor, until
// "emu node <node id> off" (or "emu off"). Nothing in the flow changes for this.
const PINS = 55; // GPIO 0–54 (ESP32-P4), as pinField allows
// Highest number of node reports per 100 ms: about 200 lines/s keeps 115200 baud
// USB serial (≈ 11 KB/s) from falling behind.
const REPORTS_PER_100MS = 20;
const MAX_VALUE = 64; // report at most this many characters of a value
const globals = (nodes) => `
// ── PC input emulation (debug build option) ──
int16_t mfEmu[${PINS}]; // -1 = read the real pin
int mfDigitalRead(uint8_t pin) {
  return pin < ${PINS} && mfEmu[pin] >= 0 ? (mfEmu[pin] ? HIGH : LOW) : digitalRead(pin);
}
int mfAnalogRead(uint8_t pin) {
  return pin < ${PINS} && mfEmu[pin] >= 0 ? mfEmu[pin] : analogRead(pin);
}
// Input devices whose reading comes from the PC (per node, in flow order).
bool mfEmuOn[${Math.max(1, nodes.length)}] = { false };
String mfEmuVal[${Math.max(1, nodes.length)}];
const char* const MF_TRACE_IDS[] = { ${nodes.length ? nodes.map((n) => JSON.stringify(n.id)).join(", ") : '""'} };
// Reports a node's output value to the IDE (rate-limited; excess reports are dropped).
void mfTrace(size_t i, const String& value) {
  static unsigned long window = 0;
  static uint8_t sent = 0;
  if (millis() - window >= 100UL) { window = millis(); sent = 0; }
  if (sent >= ${REPORTS_PER_100MS}) return;
  sent++;
  String out = String("MF:{\\"n\\":\\"") + MF_TRACE_IDS[i] + "\\",\\"v\\":\\"";
  for (unsigned int k = 0; k < value.length() && k < ${MAX_VALUE}; k++) {
    char c = value[k];
    if (c == '"' || c == '\\\\') out += '\\\\';
    out += (uint8_t)c < 32 ? ' ' : c;
  }
  Serial.println(out + "\\"}");
}
`;
const setup = `for (size_t p = 0; p < ${PINS}; p++) mfEmu[p] = -1;`;
// In loop(): an input device's reading, or the PC's value while it is emulated.
const deviceRead = (i, read) =>
  `if (mfEmuOn[${i}]) node${i}(mfEmuVal[${i}]); // value from the PC (emulation)
      else { ${read} }`;
// Test terminal command (inside mfCommand, which provides mfWord and mfInt).
const command = `  if (cmd == "emu") {
    String a = mfWord(rest), b = mfWord(rest);
    if (a == "" || a == "list") {
      String out = "emu:";
      for (size_t p = 0; p < ${PINS}; p++) if (mfEmu[p] >= 0) out += String(" ") + p + "=" + mfEmu[p];
      for (size_t i = 0; i < MF_NODE_COUNT; i++) if (mfEmuOn[i]) out += String(" ") + MF_NODES[i].id + "=" + mfEmuVal[i];
      return out == "emu:" ? String("emu: none (inputs read the real pins)") : out;
    }
    if (a == "off") {
      for (size_t p = 0; p < ${PINS}; p++) mfEmu[p] = -1;
      for (size_t i = 0; i < MF_NODE_COUNT; i++) mfEmuOn[i] = false;
      return "emu off: all inputs read the real pins and sensors";
    }
    // emu node <node id> <value…|off>: an input device sends the PC's value.
    if (a == "node") {
      String v = rest;
      v.trim();
      for (size_t i = 0; i < MF_NODE_COUNT; i++) {
        if (b != MF_NODES[i].id) continue;
        if (v == "" || v == "off") { mfEmuOn[i] = false; return String("emu node ") + b + " off"; }
        mfEmuOn[i] = true;
        mfEmuVal[i] = v;
        MF_NODES[i].fn(v); // at once, then at the node's interval
        return String("emu node ") + b + " = " + v;
      }
      return String("error: no node '") + b + "' (try nodes)";
    }
    if (!mfInt(a, pin) || pin < 0 || pin >= ${PINS}) return "error: emu <pin> <0-4095|off>";
    if (b == "off") { mfEmu[pin] = -1; return String("emu ") + pin + " off"; }
    if (!mfInt(b, v) || v < 0 || v > 4095) return "error: emu <pin> <0-4095|off>";
    mfEmu[pin] = v;
    return String("emu ") + pin + " = " + v;
  }
`;
const HELP =
  " | emu [<pin> <0-4095|off>] | emu node <node id> <value|off> | emu off";
module.exports = { globals, setup, command, deviceRead, HELP, PINS };
