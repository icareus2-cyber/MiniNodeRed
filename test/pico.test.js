// Raspberry Pi Pico boards (RP2040 / RP2350): board facts, flow checks and the
// firmware port (lib/picofw.js). The generated firmware was compiled with the core
// rp2040:rp2040 5.4.4 for the Pico, Pico W, Pico 2 and Pico 2 W (debug, release
// offline, USB test, MQTT, web server, Node-RED language, PC emulation, servo).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze } = require("../lib/flow");
const { boards, publicBoards, uploadFailure } = require("../lib/boards");
const picofw = require("../lib/picofw");
const { catalog } = require("../lib/nodes");

const cat = catalog();
const node = (id, type, config = {}, extra = {}) => ({
  id,
  type,
  config: {
    ...Object.fromEntries(cat[type].fields.map((f) => [f.key, f.default])),
    ...config,
  },
  ...extra,
});
const settings = { board: "picow", ssid: "net", password: "pw", host: "broker.local" };

test("board list: Pico, Pico W, Pico 2, Pico 2 W on the rp2040 core", () => {
  const list = publicBoards().filter((b) => b.family === "rp2040");
  assert.deepEqual(
    list.map((b) => [b.id, b.fqbn]),
    [
      ["pico", "rp2040:rp2040:rpipico"],
      ["picow", "rp2040:rp2040:rpipicow"],
      ["pico2", "rp2040:rp2040:rpipico2"],
      ["pico2w", "rp2040:rp2040:rpipico2w"],
    ],
  );
  for (const b of list) {
    assert.deepEqual(b.adc, [26, 27, 28]);
    assert.equal(b.gpio.length, 26); // GP0–GP22, GP26–GP28
    assert.deepEqual(b.i2c, { sda: 4, scl: 5 });
    assert.equal(b.usbSerial, true);
    assert.ok(b.look.left.includes("GP0:0") && b.look.right.includes("GP28:28"));
  }
  assert.deepEqual(list.find((b) => b.id === "pico").features, []);
  assert.ok(list.find((b) => b.id === "picow").features.includes("wifi"));
});

test("flow checks: WiFi only on the W boards, I2C on I2C0 pins, no ESP-only radio", () => {
  const one = (n, board) => analyze({ nodes: [n], edges: [] }, board).errors.join(" ");
  assert.match(one(node("w", "web-in"), "pico"), /has no WiFi/);
  assert.equal(one(node("w", "web-in"), "picow"), "");
  assert.match(one(node("r", "mqtt-out"), "pico2"), /no WiFi/);
  assert.match(one(node("b", "ble-in"), "picow"), /Bluetooth/);
  assert.match(one(node("r", "mqtt-out", { protocol: "espnow" }), "picow"), /ESP-NOW/);
  assert.match(one(node("a", "analog-in", { pin: 34 }), "pico"), /Use GPIO 26, 27, 28/);
  assert.match(
    one(node("r", "mqtt-out", { protocol: "i2c", sda: 6, scl: 5 }), "pico"),
    /I2C SDA must be GP0, GP4/,
  );
  assert.equal(one(node("r", "mqtt-out", { protocol: "i2c", sda: 4, scl: 5 }), "pico"), "");
});

test("firmware: ESP-only calls mapped to the Pico core, USB updates only", () => {
  const flow = {
    name: "t",
    nodes: [
      node("i", "inject", { payload: "1", interval: 1000 }),
      node("a", "analog-in", { pin: 26 }),
      node("s", "output-device", { device: "servo", pin: 15 }),
      node("d", "debug"),
    ],
    edges: [
      { from: "i", to: "d" },
      { from: "a", to: "s" },
    ],
  };
  const fw = build(flow, { ...settings, profile: "debug", ota: true });
  assert.equal(fw.fqbn, boards.picow.fqbn);
  const src = fw.source;
  assert.match(src, /struct MfPicoEsp \{/);
  assert.match(src, /#include <pico\/unique_id\.h>/);
  assert.match(src, /analogReadResolution\(12\)/);
  assert.match(src, /#include <Servo\.h>/);
  assert.doesNotMatch(src, /setTxTimeoutMs|ledcAttach|ledcSetup|Update\.h|ArduinoOTA/);
  assert.equal(fw.features.ota, false);
  assert.ok(fw.warnings.some((w) => /Remote update is not available/.test(w)));
  // ESP builds are unchanged by the port.
  const esp = build(
    { name: "t", nodes: [flow.nodes[0], flow.nodes[3]], edges: [flow.edges[0]] },
    { ...settings, board: "esp32" },
  ).source;
  assert.doesNotMatch(esp, /MfPicoEsp/);
});

test("port(): Wire pins and the stand-in after the #include lines", () => {
  const out = picofw.port(
    "#include <WiFi.h>\n#include <Wire.h>\nvoid setup() {\n  Serial.begin(115200);\n  Serial.setTxTimeoutMs(10);\n  Wire.begin(4, 5);\n}\n",
  );
  const lines = out.split("\n");
  assert.ok(lines.indexOf("#include <Wire.h>") < lines.findIndex((l) => l.includes("struct MfPicoEsp")));
  assert.match(out, /\(Wire\.setSDA\(4\), Wire\.setSCL\(5\), Wire\.begin\(\)\)/);
  assert.doesNotMatch(out, /setTxTimeoutMs|analogReadResolution/);
});

test("upload: Pico drive not found, port busy, success", () => {
  assert.match(uploadFailure("No drive to deploy.", "COM5", "rp2040"), /Hold BOOTSEL/);
  assert.match(uploadFailure("could not open port 'COM5'", "COM5", "rp2040"), /in use/);
  assert.equal(uploadFailure("Resetting COM5\nConverting to uf2\nFlashing E: (RPI-RP2)\nWrote 380928 bytes", "COM5", "rp2040"), null);
});
