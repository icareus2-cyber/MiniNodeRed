// Output device → I2C display: SSD1306 OLED or PCF8574 character LCD, one screen
// per address shared by several boxes (each writes its own line).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze, validate } = require("../lib/flow");

const settings = { board: "esp32", ssid: "n", host: "h", profile: "release", ota: false };
const screen = (id, config) => ({
  id,
  type: "output-device",
  label: id,
  config: { device: "i2cdisplay", ...config },
});
const flowOf = (...screens) => ({
  name: "d",
  nodes: [
    { id: "b", type: "test-button", config: {} },
    { id: "t", type: "inject", config: { payload: "21.5", interval: 0 } },
    ...screens,
  ],
  edges: screens.map((s, k) => ({ from: k ? "t" : "b", to: s.id })),
});

test("OLED: two boxes share one screen at 0x3C, each on its own line", () => {
  const r = build(
    flowOf(
      screen("Btn", { line: 0, text: "Button {{payload}}" }),
      screen("Temp", { line: 2, text: "T = {{payload}} C", textSize: "2" }),
    ),
    settings,
  );
  assert.deepEqual(r.libraries, ["Adafruit SSD1306", "Adafruit GFX Library"]);
  assert.match(r.source, /#include <Adafruit_SSD1306.h>/);
  assert.equal(r.source.match(/Adafruit_SSD1306 mfOled3C\(128, 64, &Wire, -1\)/g).length, 2); // guarded by #ifndef
  assert.match(r.source, /#ifndef MF_OLED_3C/);
  assert.equal(r.source.match(/mfOled3C\.begin\(SSD1306_SWITCHCAPVCC, 0x3C\)/g).length, 1); // one setup
  assert.match(r.source, /Wire\.begin\(21, 22\); \/\/ I2C for the display/);
  assert.match(r.source, /mfOled3C\.fillRect\(0, 32, 128, 16, SSD1306_BLACK\)/); // line 2, size 2
  assert.match(r.source, /t\.replace\("\{\{payload\}\}", value\)/);
});

test("LCD 16×2 at 0x27: padded line, a logic value is allowed", () => {
  const r = build(flowOf(screen("Lcd", { screen: "lcd1602", line: 1 })), settings);
  assert.deepEqual(r.libraries, ["LiquidCrystal I2C"]);
  assert.match(r.source, /LiquidCrystal_I2C mfLcd27\(0x27, 16, 2\)/);
  assert.match(r.source, /mfLcd27\.init\(\); mfLcd27\.backlight\(\);/);
  assert.match(r.source, /while \(t\.length\(\) < 16\) t \+= ' ';/);
  assert.match(r.source, /mfLcd27\.setCursor\(0, 1\)/);
  // A push button (on / off) may feed a display (not a motor).
  assert.equal(analyze(flowOf(screen("Lcd", { screen: "lcd1602" })), "esp32").errors.length, 0);
});

test("checks: lines, shared bus and addresses", () => {
  assert.throws(() => validate(flowOf(screen("S", { screen: "lcd1602", line: 2 }))), /Line must be 0 to 1/);
  assert.throws(() => validate(flowOf(screen("S", { textSize: "3", line: 2 }))), /Line must be 0 to 1/);
  const e = analyze(
    flowOf(screen("A", { sda: 21, scl: 22 }), screen("B", { sda: 16, scl: 17, addr: "0x3D" })),
    "esp32",
  ).errors.join(" ");
  assert.match(e, /share one bus/);
  const mixed = analyze(flowOf(screen("A", {}), screen("B", { screen: "lcd1602", addr: "0x3C" })), "esp32");
  assert.match(mixed.errors.join(" "), /same I2C address 0x3C but different displays/);
  const same = analyze(flowOf(screen("A", {}), screen("B", {})), "esp32");
  assert.match(same.warnings.join(" "), /write the same line 0/);
});
