// Raspberry Pi Pico boards (RP2040 / RP2350, family "rp2040"): the generated firmware
// is written for the ESP Arduino cores; port() maps the ESP-only calls it uses to
// Earle Philhower's Arduino core (rp2040:rp2040). Checked by compiling with that core
// (5.4.4) for the Pico, Pico W, Pico 2 and Pico 2 W.
//   ESP.getFreeHeap / ESP.restart / ESP.getEfuseMac → a small ESP stand-in (rp2040.*,
//                                                      the flash chip's unique ID)
//   Serial.setTxTimeoutMs                           → not needed (removed)
//   Wire.begin(sda, scl)                            → Wire.setSDA / setSCL, Wire.begin()
//   WiFi scan: SSID(i) is a char*

const CORE = "rp2040:rp2040";
const INDEX_URL =
  "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json";

const COMPAT = `// Raspberry Pi Pico: the ESP calls this firmware uses, on the Pico core.
#include <pico/unique_id.h>
struct MfPicoEsp {
  uint32_t getFreeHeap() { return (uint32_t)rp2040.getFreeHeap(); }
  void restart() { rp2040.reboot(); }
  // A board ID from the flash chip's unique ID (set a Device ID to choose your own).
  uint64_t getEfuseMac() {
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    uint64_t v = 0;
    for (int i = 0; i < PICO_UNIQUE_BOARD_ID_SIZE_BYTES; i++) v = (v << 8) | id.id[i];
    return v;
  }
} ESP;
`;

function port(source) {
  const s = source
    .replace(/^.*Serial\.setTxTimeoutMs\(.*\n/gm, "")
    .replace(
      /Wire\.begin\(\s*(\d+)\s*,\s*(\d+)\s*\)/g,
      "(Wire.setSDA($1), Wire.setSCL($2), Wire.begin())",
    )
    .replace(/"\\n" \+ WiFi\.SSID\(i\)/g, '"\\n" + String(WiFi.SSID(i))')
    // Analog reads at 12 bits, like the ESP32 (the core's default is 10).
    .replace(/Serial\.begin\(115200\);/, (m) =>
      /\banalogRead\(/.test(source)
        ? m + "\n  analogReadResolution(12); // Pico: 12-bit analog reads"
        : m,
    );
  // The stand-in goes after the #include lines.
  const lines = s.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (/^#include\s/.test(l)) last = i;
  });
  lines.splice(last + 1, 0, COMPAT);
  return lines.join("\n");
}

// The RP2040 / RP2350 I2C0 controller (Wire) reaches only these pins.
const I2C0 = { sda: [0, 4, 8, 12, 16, 20], scl: [1, 5, 9, 13, 17, 21] };

// Flow checks for Pico boards: what the ESP-only parts of Microflow cannot do here.
// (Bluetooth, ESP-NOW, local broker, speech and camera are board features.)
function check(flow, board) {
  const errors = [];
  if (board?.family !== "rp2040") return errors;
  const { pinsOf } = require("./nodes");
  for (const n of flow.nodes) {
    const used = new Set(pinsOf(n).map((p) => p.pin));
    const radioI2c =
      (n.type === "mqtt-in" || n.type === "mqtt-out") && n.config?.protocol === "i2c";
    for (const key of ["sda", "scl"]) {
      const pin = n.config?.[key];
      if (Number.isInteger(pin) && (used.has(pin) || radioI2c) && !I2C0[key].includes(pin))
        errors.push(
          `${n.label}: on ${board.label} I2C ${key.toUpperCase()} must be GP${I2C0[key].join(", GP")} (I2C0); GP4 / GP5 are the usual pair.`,
        );
    }
  }
  return [...new Set(errors)];
}

module.exports = { port, check, CORE, INDEX_URL };
