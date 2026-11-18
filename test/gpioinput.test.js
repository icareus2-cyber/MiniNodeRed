// GPIO input (change): input modes (pull-up, pull-down, floating) and the optional
// start-up level, in the firmware and the PC simulation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze, build, validate } = require("../lib/flow");

const flowOf = (config) => ({
  name: "g",
  nodes: [
    { id: "i", type: "gpio-watch", name: "IN2", config: { pin: 2, ...config } },
    { id: "o", type: "digital-write", name: "OUT6", config: { pin: 6 } },
  ],
  edges: [{ from: "i", to: "o" }],
});
const sketch = (config, board = "esp32s3") =>
  build(flowOf(config), { board, ssid: "n", host: "h", profile: "release" }).source;

test("input modes set the pin mode", () => {
  assert.match(sketch({}), /pinMode\(2, INPUT_PULLUP\)/);
  assert.match(sketch({ pull: "pulldown" }), /pinMode\(2, INPUT_PULLDOWN\)/);
  assert.match(sketch({ pull: "none" }), /pinMode\(2, INPUT\)/);
});
test("the ESP8266 has no internal pull-down", () => {
  const f = flowOf({ pin: 4, pull: "pulldown" });
  f.nodes[1].config.pin = 5;
  const { errors } = analyze(f, "esp8266");
  assert.ok(errors.some((e) => /no internal pull-down/.test(e)), errors.join("\n"));
  assert.deepEqual(analyze(flowOf({ pull: "pulldown" }), "esp32s3").errors, []);
});
test("start-up level: sent once only when chosen", () => {
  assert.match(sketch({}), /if \(!boot\) node0/);
  assert.match(sketch({ startup: "level" }), /if \(true\) node0/);
  assert.equal(validate(flowOf({})).nodes[0].config.startup, "change");
});
test("PC simulation sends the start-up level after the debounce", async () => {
  let FlowRuntime;
  try {
    ({ FlowRuntime } = require("../lib/runtime"));
  } catch {
    return; // mqtt not installed
  }
  for (const [config, want] of [
    [{ startup: "level" }, ["GPIO 6 = 1"]], // pull-up: idle HIGH, output follows
    [{ startup: "level", pull: "pulldown" }, ["GPIO 6 = 0"]],
    [{}, []], // only changes
  ]) {
    const seen = [];
    const rt = new FlowRuntime((kind, msg) => kind === "gpio" && /^GPIO 6 = /.test(msg) && seen.push(msg), {});
    rt.start({ flow: validate(flowOf({ debounce: 5, ...config })), offline: true, deviceId: "pc" });
    await new Promise((r) => setTimeout(r, 40));
    rt.stop();
    assert.deepEqual(seen, want, JSON.stringify(config));
  }
});

test("USB test build: WiFi off, pin modes and every value on serial", () => {
  const src = build(flowOf({ startup: "level" }), {
    board: "esp32s3", ssid: "n", host: "h", profile: "debug", usbTest: true,
  }).source;
  assert.doesNotMatch(src, /WiFi\.begin|mqtt\.connect|ArduinoOTA/);
  assert.match(src, /WiFi\.mode\(WIFI_OFF\)/);
  assert.match(src, /GPIO 2: INPUT_PULLUP/);
  assert.match(src, /GPIO 6: OUTPUT/);
  assert.match(src, /mfLog\(0, value, 0\);/);
  assert.match(src, /mfLog\(1, value, 0\);/);
  assert.match(src, /\[pins\]/);
  // Without the option nothing changes.
  const plain = build(flowOf({}), { board: "esp32s3", ssid: "n", host: "h", profile: "debug" }).source;
  assert.doesNotMatch(plain, /mfLog/);
  assert.match(plain, /WiFi\.begin/);
});
test("USB test build refuses boxes that need WiFi", () => {
  const f = flowOf({});
  f.nodes.push({ id: "m", type: "mqtt-out", label: "Radio out", config: { topic: "t" } });
  f.edges.push({ from: "i", to: "m" });
  assert.throws(
    () => build(f, { board: "esp32s3", ssid: "n", host: "h", profile: "debug", usbTest: true }),
    /USB test builds have no WiFi: Radio out/,
  );
});

// ── One end is the hardware ──
test("GPIO input has an output only, GPIO output an input only", () => {
  const { catalog } = require("../lib/nodes");
  const c = catalog();
  assert.equal(c["digital-read"].source, true);
  assert.equal(c["digital-write"].sink, true);
  const bad = (edge, nodes) =>
    validate({
      name: "x",
      nodes: [
        { id: "a", type: "inject", config: { payload: "1", interval: 0 } },
        { id: "r", type: "digital-read", config: { pin: 4 } },
        { id: "w", type: "digital-write", config: { pin: 2 } },
        { id: "d", type: "debug", config: {} },
      ],
      edges: [edge],
    });
  // Wires from older flows on the pin end are dropped, not an error.
  assert.deepEqual(bad({ from: "a", to: "r" }).edges, []);
  assert.deepEqual(bad({ from: "w", to: "d" }).edges, []);
  assert.equal(bad({ from: "r", to: "w" }).edges.length, 1);
});
test("GPIO input reads the pin by itself every interval", () => {
  const f = {
    name: "r",
    nodes: [
      { id: "r", type: "digital-read", name: "RD4", config: { pin: 4, interval: 250 } },
      { id: "w", type: "digital-write", name: "OUT6", config: { pin: 6 } },
    ],
    edges: [{ from: "r", to: "w" }],
  };
  const src = build(f, { board: "esp32s3", profile: "release", network: false }).source;
  assert.match(src, /millis\(\) - tick0 >= 250UL/);
  assert.match(src, /node0\(String\(digitalRead\(4\)\)\)/);
});

// ── WiFi and MQTT are optional (single chip) ──
test("WiFi and MQTT off: a debug build never starts either", () => {
  const settings = { board: "esp32s3", profile: "debug", network: false };
  const out = build(flowOf({}), settings);
  assert.equal(out.features.net, false);
  assert.equal(out.features.ota, false);
  assert.doesNotMatch(out.source, /WiFi\.begin|mqtt\.connect|PubSubClient|ArduinoOTA|MF_SSID/);
  assert.ok(out.warnings.some((w) => /WiFi and MQTT are off/.test(w)));
  assert.ok(!out.warnings.some((w) => /SSID is empty/.test(w)));
  // On (the default): unchanged, and a different build ID.
  const on = build(flowOf({}), { ...settings, network: true, ssid: "n", host: "h" });
  assert.equal(on.features.net, true);
  assert.notEqual(on.build, out.build);
});
test("WiFi and MQTT off refuses boxes that need them", () => {
  const f = flowOf({});
  f.nodes.push({ id: "m", type: "mqtt-out", label: "Radio out", config: { topic: "t" } });
  f.edges.push({ from: "i", to: "m" });
  assert.throws(
    () => build(f, { board: "esp32s3", profile: "debug", network: false }),
    /WiFi and MQTT are switched off.*Radio out/,
  );
});

// ── ESP32-C3 mini dev board (30 pins, dual Type-C, CH343P) ──
test("ESP32-C3 dual Type-C board: UART0 serial, pins 0–10, 18, 19", () => {
  const { boards } = require("../lib/boards");
  const b = boards["esp32c3-dual"];
  assert.equal(b.fqbn, "esp32:esp32:esp32c3"); // Serial = UART0 = the CH343P socket
  assert.equal(!!b.usbSerial, false);
  assert.deepEqual(b.gpio, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19]);
  // The drawing: 15 pins a side, as printed on the board.
  const { publicBoards } = require("../lib/boards");
  const look = publicBoards().find((x) => x.id === "esp32c3-dual").look;
  assert.equal(look.left.length, 15);
  assert.equal(look.right.length, 15);
  assert.ok(look.right.includes("TX:21") && look.left.includes("10:10"));
  const f = flowOf({ pin: 2 });
  f.nodes[1].config.pin = 6;
  assert.deepEqual(analyze(f, "esp32c3-dual").errors, []);
  f.nodes[1].config.pin = 20; // UART0 to the CH343P
  assert.ok(analyze(f, "esp32c3-dual").errors.length > 0);
});
