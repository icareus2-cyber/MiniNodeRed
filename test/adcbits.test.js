// Analog sample → Resolution: the reading is shifted from the board's ADC bits
// (ESP8266 10, ESP32 12) to the chosen 8, 10 or 12 bits.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, validate } = require("../lib/flow");

const flowWith = (bits) => ({
  name: "adc",
  nodes: [
    {
      id: "a",
      type: "analog-in",
      config: { pin: 34, interval: 500, ...(bits ? { bits } : {}) },
    },
    { id: "d", type: "debug", config: {} },
  ],
  edges: [{ from: "a", to: "d" }],
});
const source = (bits, board = "esp32") =>
  build(flowWith(bits), {
    board,
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  }).source;

test("default resolution reads the ADC as is", () => {
  assert.equal(validate(flowWith()).nodes[0].config.bits, "native");
  assert.match(source(), /String\(analogRead\(34\)\)/);
});
test("ESP32: 8 and 10 bits shift the 12-bit reading down", () => {
  assert.match(source("8"), /String\(\(\(int\)\(analogRead\(34\)\) >> 4\)\)/);
  assert.match(source("10"), /String\(\(\(int\)\(analogRead\(34\)\) >> 2\)\)/);
  assert.match(source("12"), /String\(analogRead\(34\)\)/);
});
test("ESP8266: 12 bits scale the 10-bit reading up", () => {
  const f = flowWith("12");
  f.nodes[0].config.pin = 17;
  const s = build(f, {
    board: "esp8266",
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  }).source;
  assert.match(s, /\(\(int\)\(analogRead\(17\)\) << 2\)/);
});
test("other resolutions are refused", () => {
  assert.throws(() => validate(flowWith("16")), /valid resolution/);
});
