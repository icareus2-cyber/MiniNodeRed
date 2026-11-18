// Realtek Ameba boards (RTL8720DN · BW16, family "ameba"): the generated firmware is
// written for the ESP Arduino cores; port() maps the few ESP-only calls it uses to
// Realtek's Arduino core (realtek:AmebaD). Checked by compiling with that core.
//   ESP.getFreeHeap / ESP.restart / ESP.getEfuseMac → a small ESP stand-in
//   WiFi.persistent / WiFi.mode                      → not needed (removed)
//   WiFi.begin(const char*, …)                       → the SSID as a char array
//   IPAddress::toString()                            → mfIpText()
//   Wire.begin(sda, scl)                             → Wire.begin() (fixed D8/D7)
//   WiFi scan: SSID(i) as String, no channel(i) / scanDelete()
//   LiquidCrystal_I2C: the core's own (NewLiquidCrystal) constructor and begin()

// Realtek's Arduino core: Boards Manager URL and platform.
const CORE = "realtek:AmebaD";
const INDEX_URL =
  "https://github.com/Ameba-AIoT/ameba-arduino-d/raw/master/Arduino_package/package_realtek_amebad_index.json";
// The image the core builds (in the build folder; uploads take it from its tools).
const IMAGE = "km0_km4_image2.bin";

const COMPAT = `// Realtek Ameba: the ESP calls this firmware uses, on Realtek's core.
static String mfIpText(IPAddress ip) {
  return String(ip[0]) + "." + ip[1] + "." + ip[2] + "." + ip[3];
}
struct MfAmebaEsp {
  uint32_t getFreeHeap() { return (uint32_t)os_get_free_heap_size_arduino(); }
  void restart() { NVIC_SystemReset(); }
  // A board ID from the WiFi MAC address (set a Device ID to choose your own).
  uint64_t getEfuseMac() {
    uint8_t m[6] = {0};
    WiFi.macAddress(m);
    uint64_t v = 0;
    for (int i = 0; i < 6; i++) v = (v << 8) | m[i];
    return v;
  }
} ESP;
`;

function port(source) {
  let s = source
    // The core's WiFi.begin(char* ssid, const char* pass) wants a writable SSID.
    .replace(/const char\* MF_SSID = /g, "char MF_SSID[] = ")
    .replace(/^.*WiFi\.persistent\(false\);.*\n/gm, "")
    .replace(/^\s*WiFi\.mode\(WIFI_STA\);.*\n/gm, "")
    .replace(/WiFi\.mode\(WIFI_OFF\);/g, "WiFi.disconnect();")
    .replace(/^\s*WiFi\.forceSleepBegin\(\);.*\n/gm, "")
    .replace(/(WiFi\.(?:localIP|gatewayIP|subnetMask|dnsIP)\(\))\.toString\(\)/g, "mfIpText($1)")
    .replace(/Wire\.begin\(\s*\d+\s*,\s*\d+\s*\)/g, "Wire.begin()")
    // wifi scan (debug shell): SSID(i) is a char*, and no channel / scanDelete.
    .replace(/"\\n" \+ WiFi\.SSID\(i\)/g, '"\\n" + String(WiFi.SSID(i))')
    .replace(/ \+ " dBm  ch " \+ String\(WiFi\.channel\(i\)\)/g, ' + " dBm"')
    .replace(/^\s*WiFi\.scanDelete\(\);.*\n/gm, "");
  // Character LCDs: the core's Wire library brings its own LiquidCrystal_I2C (the
  // NewLiquidCrystal API): PCF8574 pin map in the constructor, begin(cols, rows).
  const lcdSize = new Map();
  s = s.replace(
    /LiquidCrystal_I2C (mfLcd\w+)\(([^,()]+), (\d+), (\d+)\);/g,
    (_, name, addr, cols, rows) => {
      lcdSize.set(name, [cols, rows]);
      return `LiquidCrystal_I2C ${name}(${addr}, 2, 1, 0, 4, 5, 6, 7, 3, POSITIVE);`;
    },
  );
  for (const [name, [cols, rows]] of lcdSize)
    s = s.split(`${name}.init();`).join(`${name}.begin(${cols}, ${rows});`);
  // Analog reads at 12 bits, like the ESP32 (the core's default is 10).
  if (/\banalogRead\(/.test(s))
    s = s.replace(
      /Serial\.begin\(115200\);/,
      "Serial.begin(115200);\n  analogReadResolution(12); // Realtek: 12-bit analog reads",
    );
  // The stand-ins go after the #include lines (they need WiFi and IPAddress).
  const lines = s.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (/^#include\s/.test(l)) last = i;
  });
  const wifi = lines.some((l) => /^#include <WiFi\.h>/.test(l));
  lines.splice(
    last + 1,
    0,
    (wifi ? "" : "#include <WiFi.h>\n") + COMPAT,
  );
  return lines.join("\n");
}

// Flow checks for Ameba boards: what the ESP-only parts of Microflow cannot do here.
// (Bluetooth, ESP-NOW, local broker, speech and camera are board features.)
function check(flow, board) {
  const errors = [];
  if (board.family !== "ameba") return errors;
  const { pinsOf } = require("./nodes");
  for (const n of flow.nodes) {
    const used = new Set(pinsOf(n).map((p) => p.pin));
    // Radio in/out over I2C keep their bus pins in the radio settings.
    const radioI2c =
      (n.type === "mqtt-in" || n.type === "mqtt-out") && n.config?.protocol === "i2c";
    for (const [key, want] of [
      ["sda", 8],
      ["scl", 7],
    ]) {
      const pin = n.config?.[key];
      if (Number.isInteger(pin) && (used.has(pin) || radioI2c) && pin !== want)
        errors.push(
          `${n.label}: on ${board.label} I2C is fixed on SDA 8 (PA26) and SCL 7 (PA25); set ${key.toUpperCase()} to ${want}.`,
        );
    }
  }
  return [...new Set(errors)];
}

module.exports = { port, check, CORE, INDEX_URL, IMAGE };
