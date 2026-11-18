// Waveshare ESP32-P4-WIFI6 (ESP32-P4 + ESP32-C6 over ESP-Hosted). Firmware for these
// cases was compiled with arduino-esp32 3.3.11 (debug and release with remote update
// and the web server, BLE, Local MQTT, devices, Speak); ESP-NOW does not link on the
// P4 and the DS18B20's OneWire library does not build for it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze } = require("../lib/flow");
const { boards, publicBoards } = require("../lib/boards");
const { catalog } = require("../lib/nodes");

const cat = catalog();
const node = (id, type, config = {}) => ({
  id,
  type,
  config: {
    ...Object.fromEntries(cat[type].fields.map((f) => [f.key, f.default])),
    ...config,
  },
});
const settings = { board: "esp32p4-wifi6", ssid: "net", password: "pw", host: "broker.local" };

test("board: P4 v3, PSRAM, 32 MB flash with two OTA app slots", () => {
  const b = publicBoards().find((x) => x.id === "esp32p4-wifi6");
  assert.match(b.fqbn, /^esp32:esp32:esp32p4:/);
  assert.match(b.fqbn, /ChipVariant=postv3/);
  assert.match(b.fqbn, /PSRAM=enabled/);
  assert.match(b.fqbn, /PartitionScheme=app5M_fat24M_32MB/);
  assert.equal(b.gpio.length, 27);
  assert.deepEqual(b.i2c, { sda: 7, scl: 8 });
  assert.deepEqual(b.features, ["wifi", "webserver", "localbroker", "i2sout", "bluetooth"]);
  assert.equal(b.look.left.length, 20);
});

test("remote update stays on, BLE keeps the 32 MB partition", () => {
  const flow = {
    name: "t",
    nodes: [node("i", "inject", { interval: 1000 }), node("b", "ble-out"), node("d", "debug")],
    edges: [
      { from: "i", to: "b" },
      { from: "i", to: "d" },
    ],
  };
  const fw = build(flow, { ...settings, ota: true });
  assert.equal(fw.features.ota, true);
  assert.equal(fw.fqbn, boards["esp32p4-wifi6"].fqbn);
  assert.ok(!fw.warnings.some((w) => /Minimal SPIFFS/.test(w)));
});

test("not on the P4: ESP-NOW and the DS18B20", () => {
  const one = (n) => analyze({ nodes: [n], edges: [] }, "esp32p4-wifi6").errors.join(" ");
  assert.match(one(node("r", "mqtt-out", { protocol: "espnow" })), /ESP-NOW/);
  assert.match(one(node("t", "input-device", { device: "temp", sensor: "ds18b20", pin: 4 })), /OneWire/);
  assert.equal(one(node("t", "input-device", { device: "temp", sensor: "dht22", pin: 4, interval: 2000 })), "");
});
