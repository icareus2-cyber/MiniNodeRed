// Realtek RTL8720DN (BW16) boards: board facts, flow checks and the firmware port
// (lib/amebafw.js). The generated firmware was compiled with Realtek's core
// realtek:AmebaD 3.1.9 for these cases (debug, release, Node-RED language, PC
// emulation, sensors, servo, OLED / LCD, stepper, I2C radio).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze } = require("../lib/flow");
const { boards, publicBoards, uploadFailure, checkPin } = require("../lib/boards");
const amebafw = require("../lib/amebafw");
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
const settings = {
  board: "bw16",
  ssid: "net",
  password: "pw",
  host: "broker.local",
};

test("board list: BW16 (Type-C and Burn button) with Realtek's core", () => {
  const list = publicBoards().filter((b) => b.family === "ameba");
  assert.deepEqual(
    list.map((b) => b.id),
    ["bw16", "bw16-manual"],
  );
  assert.equal(boards.bw16.fqbn, "realtek:AmebaD:Ai-Thinker_BW16:AutoUploadMode=Enable");
  assert.match(boards["bw16-manual"].fqbn, /AutoUploadMode=Disable$/);
  const b = list[0];
  assert.deepEqual(b.adc, [6]);
  assert.deepEqual(b.pwm, [3, 7, 8, 11, 12]);
  assert.deepEqual(b.i2c, { sda: 8, scl: 7 });
  assert.ok(b.look && b.look.left.includes("PA30:3"));
  assert.match(checkPin("bw16", 10, "out", "LED").warnings[0], /pin 10 is shared with the green LED/);
  assert.match(checkPin("bw16", 4, "pwm", "Dim").errors[0], /cannot output PWM/);
});

test("flow checks: no web server, ESP-NOW or BLE; I2C fixed on 8 / 7", () => {
  const one = (n) => analyze({ nodes: [n], edges: [] }, "bw16").errors.join(" ");
  assert.match(one(node("w", "web-in")), /WebServer library/);
  assert.match(one(node("b", "ble-in")), /Bluetooth/);
  assert.match(one(node("r", "mqtt-out", { protocol: "espnow" })), /ESP-NOW/);
  assert.match(
    one(node("r", "mqtt-out", { protocol: "i2c", sda: 3, scl: 7 })),
    /I2C is fixed on SDA 8/,
  );
  assert.equal(one(node("r", "mqtt-out", { protocol: "i2c", sda: 8, scl: 7 })), "");
});

test("firmware: ESP-only calls mapped to Realtek's core", () => {
  const flow = {
    name: "t",
    nodes: [
      node("i", "inject", { payload: "1", interval: 1000 }),
      node("a", "analog-in", { pin: 6 }),
      node("lcd", "output-device", { device: "i2cdisplay", screen: "lcd1602", sda: 8, scl: 7 }),
      node("d", "debug"),
    ],
    edges: [
      { from: "i", to: "d" },
      { from: "a", to: "lcd" },
    ],
  };
  const fw = build(flow, { ...settings, profile: "debug", ota: true });
  assert.equal(fw.fqbn, boards.bw16.fqbn);
  const src = fw.source;
  assert.match(src, /char MF_SSID\[\] = "net";/);
  assert.doesNotMatch(src, /WiFi\.persistent|WiFi\.mode\(|\.toString\(\)|scanDelete|WiFi\.channel/);
  assert.match(src, /struct MfAmebaEsp \{/);
  assert.match(src, /analogReadResolution\(12\)/);
  assert.match(src, /LiquidCrystal_I2C mfLcd27\(0x27, 2, 1, 0, 4, 5, 6, 7, 3, POSITIVE\);/);
  assert.match(src, /mfLcd27\.begin\(16, 2\);/);
  assert.doesNotMatch(src, /Wire\.begin\(\d/);
  // No remote update on Realtek boards: said once, built without it.
  assert.equal(fw.features.ota, false);
  assert.ok(fw.warnings.some((w) => /Remote update is not available/.test(w)));
  // ESP builds are unchanged by the port.
  const esp = build(
    { name: "t", nodes: flow.nodes.slice(0, 1).concat(flow.nodes[3]), edges: [flow.edges[0]] },
    { ...settings, board: "esp32" },
  ).source;
  assert.match(esp, /WiFi\.persistent\(false\)/);
  assert.doesNotMatch(esp, /MfAmebaEsp/);
});

test("port(): #include order and the IP helper", () => {
  const out = amebafw.port(
    '#include <WiFi.h>\n#include <PubSubClient.h>\nvoid f() { Serial.println(WiFi.localIP().toString()); }\n',
  );
  const lines = out.split("\n");
  assert.ok(lines.indexOf("#include <PubSubClient.h>") < lines.findIndex((l) => l.includes("mfIpText(IPAddress")));
  assert.match(out, /Serial\.println\(mfIpText\(WiFi\.localIP\(\)\)\)/);
});

test("upload: Realtek's tool succeeds only with 'All images are sent successfully'", () => {
  const ok = "Enter Auto Upload Mode\n    Upload Image done.\nAll images are sent successfully!\n";
  assert.equal(uploadFailure(ok, "COM5", "ameba"), null);
  const noPort = "Enter Auto Upload Mode \nerror: Cannot access COM5\nerror: Open serial port \nUploading.\n    Upload Image done.";
  assert.match(uploadFailure(noPort, "COM5", "ameba"), /COM5 could not be opened/);
  assert.match(uploadFailure("Handshake fail!", "COM5", "ameba"), /hold Burn|Hold Burn/);
  assert.match(uploadFailure("Images download fail!", "COM5", "ameba"), /Images download fail/);
  // ESP output keeps the ESP rules.
  assert.equal(uploadFailure("Hash of data verified.", "COM5"), null);
});
