const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate, wiring, analyze, build, generate } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");
const { parseSize } = require("../lib/boards");
const node = (id, type, config = {}, extra = {}) => ({
  id,
  type,
  config,
  ...extra,
});
const edges = (...pairs) => pairs.map(([from, to]) => ({ from, to }));
// Runs a node's host implementation the way the runtime does.
const host = (type, config, value, ctx = {}) => {
  const n = validate({ nodes: [node("n", type, config)], edges: [] }).nodes[0];
  return types[type].host(value, n, { state: {}, now: Date.now, ...ctx });
};
test("config is normalised to typed values with defaults", () => {
  const flow = validate({
    nodes: [node("a", "scale", { inMax: "4095" }), node("b", "inject")],
    edges: [],
  });
  assert.equal(flow.nodes[0].config.inMax, 4095);
  assert.equal(flow.nodes[0].config.outMax, 100);
  assert.deepEqual(flow.nodes[1].config, { payload: "12345ABCDE", interval: 1000 });
  assert.throws(
    () =>
      validate({ nodes: [node("a", "inject", { interval: 50 })], edges: [] }),
    /at least 100/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [node("a", "compare", { op: "gt", value: "abc" })],
        edges: [],
      }),
    /numeric value/,
  );
  assert.throws(
    () =>
      validate({ nodes: [node("a", "compare", { op: "nope" })], edges: [] }),
    /valid operator/,
  );
  assert.throws(
    () =>
      validate({ nodes: [node("a", "mqtt-out", { topic: "a/#" })], edges: [] }),
    /cannot contain/,
  );
  assert.throws(
    () =>
      validate({ nodes: [node("a", "mqtt-in", { topic: "a/b#" })], edges: [] }),
    /entire level/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [node("a", "debug"), node("b", "debug")],
        edges: edges(["a", "b"], ["a", "b"]),
      }),
    /Duplicate/,
  );
});
test("logic nodes behave the same way the firmware does", () => {
  assert.equal(host("threshold", { value: 25 }, "25"), "25");
  assert.equal(host("threshold", { value: 25 }, " 24.9 "), undefined);
  assert.equal(host("threshold", { value: 25 }, "hot"), undefined);
  assert.equal(host("compare", { op: "eq", value: "1" }, "1.0"), "1.0");
  assert.equal(host("compare", { op: "eq", value: "on" }, "on"), "on");
  assert.equal(host("compare", { op: "neq", value: "on" }, "on"), undefined);
  assert.equal(host("compare", { op: "lt", value: "10" }, "9"), "9");
  assert.equal(host("compare", { op: "lt", value: "10" }, "x"), undefined);
  assert.equal(
    host("compare", { op: "contains", value: "err" }, "an error"),
    "an error",
  );
  assert.equal(
    host(
      "scale",
      { inMin: 0, inMax: 1023, outMin: 0, outMax: 100, decimals: 1 },
      "511.5",
    ),
    "50.0",
  );
  assert.equal(host("scale", { clamp: "yes" }, "5000"), "100.0");
  assert.equal(host("scale", { clamp: "no", decimals: 0 }, "2046"), "200");
  assert.equal(
    host("scale", { outMin: 100, outMax: 0, decimals: 0 }, "1023"),
    "0",
  );
  assert.equal(
    host("template", { template: '{"t":{{payload}}}' }, "21.5"),
    '{"t":21.5}',
  );
  let t = 0;
  const state = {};
  const throttle = (v) =>
    host("throttle", { interval: 1000 }, v, { state, now: () => t });
  assert.equal(throttle("a"), "a");
  t = 999;
  assert.equal(throttle("b"), undefined);
  t = 1000;
  assert.equal(throttle("c"), "c");
});
test("hardware nodes drive virtual pins on the host", () => {
  const pins = new Map([[5, 1]]);
  const ctx = {
    readPin: (p) => pins.get(p),
    writePin: (p, v) => pins.set(p, v),
  };
  assert.equal(host("digital-read", { pin: 5 }, "x", ctx), "1");
  host("digital-write", { pin: 2 }, "false", ctx);
  assert.equal(pins.get(2), 0);
  host("digital-write", { pin: 2 }, "on", ctx);
  assert.equal(pins.get(2), 1);
  host("pwm-write", { pin: 4 }, "300", ctx);
  assert.equal(pins.get(4), 255);
  assert.equal(host("pwm-write", { pin: 4 }, "dim", ctx), undefined);
});
test("board pin rules catch flash, input-only and ADC2 mistakes", () => {
  const one = (type, pin) => ({
    nodes: [node("i", "inject"), node("p", type, { pin })],
    edges: edges(["i", "p"]),
  });
  const source = (type, pin) => ({
    nodes: [node("p", type, { pin })],
    edges: [],
  });
  assert.match(
    analyze(one("digital-write", 7), "esp8266").errors[0],
    /flash, missing or reserved/,
  );
  assert.match(
    analyze(one("digital-write", 35), "esp32").errors[0],
    /input-only/,
  );
  assert.equal(analyze(one("digital-read", 35), "esp32").errors.length, 0);
  assert.match(
    analyze(source("analog-in", 4), "esp32").errors[0],
    /not an analog input/,
  );
  assert.equal(analyze(source("analog-in", 17), "esp8266").errors.length, 0);
  assert.match(
    analyze(source("analog-in", 17), "esp01").errors[0],
    /no usable analog/,
  );
  assert.match(
    analyze(one("digital-write", 0), "esp8266").warnings[0],
    /strapping/,
  );
  assert.match(
    analyze(one("digital-write", 40), "esp32s3").warnings.join(),
    /^$/,
  );
  const orphan = analyze({ nodes: [node("d", "debug")], edges: [] }, "esp32");
  assert.match(orphan.warnings[0], /never run/);
  assert.throws(
    () => build(one("digital-write", 7), { board: "esp8266" }),
    /GPIO 7/,
  );
});
test("firmware wires telemetry, MQTT injects and safe credentials", () => {
  const flow = {
    name: 'Lab "A"',
    nodes: [
      node("go", "inject", { payload: "28", interval: 0 }),
      node("in", "mqtt-in", { topic: "lab/+/temp" }),
      node("gate", "threshold", { value: 25 }),
      node("out", "mqtt-out", { topic: "lab/alert", retain: "yes" }),
      node("log", "debug"),
    ],
    edges: edges(
      ["go", "gate"],
      ["in", "gate"],
      ["gate", "out"],
      ["gate", "log"],
    ),
  };
  const a = build(flow, {
    board: "esp32",
    ssid: "net",
    deviceId: "lab-1",
    username: "",
    mqttPassword: "",
  });
  assert.match(a.source, /mfId = "lab-1";/);
  assert.match(
    a.source,
    /mqtt\.subscribe\(\(mfBase \+ "\/inject\/go"\)\.c_str\(\)\)/,
  );
  assert.match(
    a.source,
    /if \(\(mfBase \+ "\/inject\/go"\) == topicCopy\) node0\(length \? value : String\("28"\)\)/,
  );
  assert.match(
    a.source,
    /mqtt\.connect\(mfId\.c_str\(\), NULL, NULL, will\.c_str\(\), 0, true, "offline"\)/,
  );
  assert.match(
    a.source,
    /mqtt\.publish\("lab\/alert", value\.c_str\(\), true\)/,
  );
  assert.match(a.source, /\/debug\/log/);
  assert.match(a.source, /\\"Lab \\\\\\"A\\\\\\"\\"/); // JSON-in-C escaping of the flow name
  assert.ok(
    !/node0\(String\("28"\)\); \}/.test(a.source),
    "manual inject must not run on a timer",
  );
  assert.equal(a.fqbn, "esp32:esp32:esp32");
  const b = build(flow, {
    board: "esp32",
    ssid: "net",
    deviceId: "lab-1",
    password: "changed",
  });
  assert.equal(a.build, b.build, "secrets do not change the build id");
  assert.notEqual(
    a.build,
    build(flow, { board: "esp8266", ssid: "net" }).build,
  );
  assert.match(
    generate(flow, {
      board: "d1mini",
      ssid: "n",
      username: "u",
      mqttPassword: "p",
    }),
    /"u", "p", will/,
  );
  assert.match(
    generate(flow, { board: "esp8266", ssid: "n" }),
    /ESP\.getChipId\(\)/,
  );
  assert.throws(
    () => build(flow, { board: "esp32", deviceId: "bad id" }),
    /Device ID/,
  );
  assert.throws(() => build(flow, { board: "esp32", host: "a b" }), /hostname/);
  assert.throws(() => build(flow, { board: "avr" }), /supported board/);
});
test("catalog is serialisable for the browser", () => {
  const c = JSON.parse(JSON.stringify(catalog()));
  for (const [type, meta] of Object.entries(c)) {
    assert.ok(
      meta.label && meta.summary !== undefined && Array.isArray(meta.fields),
      type,
    );
  }
  assert.equal(c["gpio-watch"].source, true);
  assert.equal(c["pwm-write"].pin, "pwm");
});
test("compile output is parsed for both ESP cores", () => {
  const esp8266 = `. Variables and constants in RAM (global, static), used 28316 / 80192 bytes (35%)
. Code in flash (default, ICACHE_FLASH_ATTR), used 250324 / 1048576 bytes (23%)`;
  assert.deepEqual(parseSize(esp8266), {
    flash: { used: 250324, max: 1048576 },
    ram: { used: 28316, max: 80192 },
  });
  const esp32 = `Sketch uses 935139 bytes (71%) of program storage space. Maximum is 1310720 bytes.
Global variables use 45136 bytes (13%) of dynamic memory, leaving 282544 bytes for local variables. Maximum is 327680 bytes.`;
  assert.deepEqual(parseSize(esp32), {
    flash: { used: 935139, max: 1310720 },
    ram: { used: 45136, max: 327680 },
  });
});

test("{{device}} topics resolve to the board's Device ID in firmware", () => {
  const flow = {
    nodes: [
      { id: "in", type: "mqtt-in", config: { topic: "lab/{{device}}/cmd" } },
      { id: "out", type: "mqtt-out", config: { topic: "lab/{{device}}/echo" } },
    ],
    edges: [{ from: "in", to: "out" }],
  };
  const src = generate(flow, { board: "esp8266", ssid: "n" });
  assert.ok(
    src.includes('mqtt.subscribe(mfTopic("lab/{{device}}/cmd").c_str());'),
  );
  assert.ok(
    src.includes(
      'mqttTopicMatch(mfTopic("lab/{{device}}/cmd").c_str(), topic)',
    ),
  );
  assert.ok(
    src.includes(
      'mqtt.publish(mfTopic("lab/{{device}}/echo").c_str(), value.c_str(), false);',
    ),
  );
  assert.ok(src.includes('t.replace("{{device}}", mfId);'));
  assert.throws(
    () =>
      validate({
        nodes: [
          { id: "o", type: "mqtt-out", config: { topic: "{{device}}/#" } },
        ],
        edges: [],
      }),
    /cannot contain/,
  );
});
test("failed serial uploads are detected even when the tool exits 0", () => {
  const { uploadFailure } = require("../lib/boards");
  assert.equal(
    uploadFailure(
      "Writing at 0x00040000... (100 %)\nHard resetting via RTS pin...",
      "COM4",
    ),
    null,
  );
  assert.match(
    uploadFailure(
      "A fatal esptool.py error occurred: could not open port 'COM4': PermissionError(13, 'Access is denied.', None, 5)",
      "COM4",
    ),
    /COM4 is in use by another program.*not changed/,
  );
  assert.match(
    uploadFailure(
      "A fatal esptool.py error occurred: Failed to connect to ESP8266: Timed out waiting for packet header",
      "COM9",
    ),
    /did not enter upload mode/,
  );
  assert.match(
    uploadFailure("A fatal error occurred: Invalid head of packet", "COM3"),
    /Upload failed: Invalid head of packet/,
  );
});
test("a missing upload port is not reported as busy", () => {
  const { uploadFailure } = require("../lib/boards");
  assert.match(
    uploadFailure(
      "A fatal esptool.py error occurred: could not open port 'COM250': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)",
      "COM250",
    ),
    /COM250 was not found/,
  );
});
test("pulse node: retrigger rule and width from payload", async () => {
  const pins = new Map();
  const later = [];
  const ctx = {
    state: {},
    writePin: (p, v) => pins.set(p, v),
    later: (ms, fn) => (later.push({ ms, fn }), later.length),
    cancel: () => {},
    forward: (v) => pins.set("out", v),
  };
  const n = (config) =>
    validate({ nodes: [node("p", "pulse", config)], edges: [] }).nodes[0];
  const ignore = n({
    pin: 5,
    width: 300,
    retrigger: "ignore",
    fromPayload: "yes",
  });
  assert.equal(types.pulse.host("750", ignore, ctx), "1");
  assert.equal(pins.get(5), 1);
  assert.equal(later[0].ms, 750, "numeric payload sets the width");
  assert.equal(
    types.pulse.host("go", ignore, ctx),
    undefined,
    "ignored while on",
  );
  later[0].fn();
  assert.equal(pins.get(5), 0);
  assert.equal(pins.get("out"), "0", "end of pulse is forwarded");
  const low = n({ pin: 2, width: 100, active: "low" });
  types.pulse.host("x", low, { ...ctx, state: {} });
  assert.equal(pins.get(2), 0, "active-low drives LOW");
  assert.equal(later.at(-1).ms, 100, "non-numeric payload uses Width");
  const src = generate(
    {
      nodes: [
        node("t", "pulse-train", { high: 200, low: 800, count: 3 }),
        node("p", "pulse", { pin: 14 }),
      ],
      edges: [],
    },
    { board: "esp8266", ssid: "n", host: "h" },
  );
  assert.match(
    src,
    /bool mfPulseOn1 = false; unsigned long mfPulseStart1 = 0, mfPulseWidth1 = 500;/,
  );
  assert.match(src, /done0 < 3UL && millis\(\) - t0 >= 800UL/);
});
test("BLE link nodes: ESP32 only, link ids and generated firmware", () => {
  const { linkId } = require("../lib/blefw");
  const pair = {
    nodes: [
      node("btn", "gpio-watch", { pin: 4 }),
      node("tx", "ble-out", { link: "pair1" }),
      node("rx", "ble-in", { link: "pair1" }),
      node("rx2", "ble-in", { link: "other" }),
      node("led", "digital-write", { pin: 2 }),
      node("log", "debug"),
    ],
    edges: edges(["btn", "tx"], ["rx", "led"], ["rx2", "log"]),
  };
  assert.match(
    analyze(structuredClone(pair), "esp8266").errors.join(),
    /no Bluetooth/,
  );
  assert.deepEqual(analyze(structuredClone(pair), "esp32c3").errors, []);
  assert.throws(
    () =>
      validate({ nodes: [node("x", "ble-in", { link: "a b" })], edges: [] }),
    /Link name/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [node("x", "ble-out"), node("y", "ble-in")],
        edges: edges(["x", "y"]),
      }),
    /cannot receive/,
  );
  // Deterministic, distinct per name, never a zero byte.
  assert.deepEqual(linkId("pair1"), linkId("pair1"));
  assert.notDeepEqual(linkId("pair1"), linkId("pair2"));
  for (const name of ["a", "b", "pair1", "x".repeat(32)])
    assert.ok(linkId(name).every((b) => b > 0 && b < 256));
  const hex = (name) =>
    linkId(name)
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(", ");
  const fw = build(structuredClone(pair), { board: "esp32", ssid: "n" });
  assert.equal(fw.fqbn, "esp32:esp32:esp32:PartitionScheme=min_spiffs");
  assert.match(fw.warnings.join(), /Upload over USB the first time/);
  assert.match(fw.source, /#include <BLEDevice\.h>/);
  assert.ok(fw.source.includes(`mfBleSend(${hex("pair1")}, value);`));
  // Received links are dispatched to their own nodes (rx = node2, rx2 = node3).
  assert.match(fw.source, /if \(m\.link == 0\) node2\(v\);/);
  assert.match(fw.source, /if \(m\.link == 1\) node3\(v\);/);
  assert.match(fw.source, /scan->setWindow\(50\)/); // shares the radio with WiFi
  assert.match(fw.source, /mfBleAdvertise\(\);\n {2}mfBleReceive\(\);/);
  // Prototypes come before the BLE dispatcher that calls them.
  assert.ok(
    fw.source.indexOf("void node2(String value);") <
      fw.source.indexOf("void mfBleReceive()"),
  );
  // Send-only flows do not scan; flows without BLE are unchanged.
  const sendOnly = build(
    {
      nodes: [node("i", "inject"), node("tx", "ble-out")],
      edges: edges(["i", "tx"]),
    },
    { board: "esp32", profile: "release", ota: false },
  );
  assert.doesNotMatch(sendOnly.source, /mfBleReceive|MfBleScan/);
  assert.match(sendOnly.source, /mfBleAdvertise/);
  assert.equal(
    build(
      {
        nodes: [node("i", "inject"), node("o", "digital-write", { pin: 2 })],
        edges: edges(["i", "o"]),
      },
      { board: "esp32", ssid: "n" },
    ).fqbn,
    "esp32:esp32:esp32",
  );
  // Simulator: BLE out only logs, cut to the 20-byte payload limit.
  let sent;
  assert.equal(
    host("ble-out", { link: "pair1" }, "x".repeat(30), {
      ble: (link, payload) => (sent = [link, payload]),
    }),
    "x".repeat(30),
  );
  assert.deepEqual(sent, ["pair1", "x".repeat(20)]);
});
test("palette support: node needs match board features", () => {
  const { publicBoards } = require("../lib/boards");
  const c = catalog();
  const has = (id) => publicBoards().find((b) => b.id === id).features;
  assert.equal(c["ble-in"].needs, "bluetooth");
  assert.equal(c["ble-out"].needs, "bluetooth");
  assert.equal(c.display.needs, "display");
  assert.equal(c.inject.needs, null);
  assert.deepEqual(has("esp8266"), ["wifi", "webserver"]);
  // Realtek BW16: WiFi + MQTT, no ESP-only features (web server, ESP-NOW, BLE nodes…).
  assert.deepEqual(has("bw16"), ["wifi"]);
  assert.equal(c["web-in"].needs, "webserver");
  assert.deepEqual(has("esp32"), [
    "wifi",
    "webserver",
    "espnow",
    "localbroker",
    "i2sout",
    "bluetooth",
  ]);
  assert.deepEqual(has("ttgo-t-display"), [
    "display",
    "wifi",
    "webserver",
    "espnow",
    "localbroker",
    "i2sout",
    "bluetooth",
  ]);
  assert.ok(has("esp32s3").includes("speech"));
  assert.equal(c["voice-in"].needs, "speech");
  // Radio in/out: what a board needs depends on the protocol.
  assert.equal(c["mqtt-in"].label, "Radio in");
  assert.equal(c["mqtt-out"].label, "Radio out");
  assert.equal(c["mqtt-in"].needs, null, "the palette offers Radio everywhere");
  const radio = (protocol, extra = {}) => ({
    nodes: [node("r", "mqtt-out", { protocol, ...extra }, { label: "Send" })],
    edges: [],
  });
  assert.equal(analyze(radio("mqtt"), "esp8266").errors.length, 0);
  assert.match(analyze(radio("espnow"), "esp8266").errors[0], /ESP-NOW/);
  assert.equal(analyze(radio("espnow"), "esp32").errors.length, 0);
  // I2C runs anywhere, on pins the board has (ESP8266: GPIO 4/5, not 21/22).
  assert.equal(
    analyze(radio("i2c", { sda: 4, scl: 5 }), "esp8266").errors.length,
    0,
  );
  assert.match(
    analyze(radio("i2c"), "esp8266").errors.join(" "),
    /GPIO 21 is not available/,
  );
  // Every board the palette enables a node for also passes the firmware check.
  for (const b of publicBoards())
    for (const [type, d] of Object.entries(c))
      if (d.needs) {
        const flow = { nodes: [node("n", type)], edges: [] };
        // Pins chosen for the board, as the editor does when adding the node.
        if (d.pinSpec && b.features.includes(d.needs)) {
          const ok = (pin) =>
            analyze(
              { nodes: [node("p", "digital-write", { pin })], edges: [] },
              b.id,
            ).errors.length === 0;
          const free = b.gpio.filter(ok);
          d.pinSpec.forEach((p, k) => (flow.nodes[0].config[p.key] = free[k]));
        }
        assert.equal(
          analyze(flow, b.id).errors.length === 0,
          b.features.includes(d.needs),
          `${type} on ${b.id}`,
        );
      }
});
test("Web and Terminal nodes: validation and generated firmware", () => {
  const { toJson } = require("../lib/webfw");
  for (const [v, want] of [
    ["12", "12"],
    ["-3.5e2", "-3.5e2"],
    ["1.", '"1."'],
    ["+5", '"+5"'],
    [" on ", '"on"'],
    ['{"a":1}', '{"a":1}'],
    ["[1,2]", "[1,2]"],
    ["true", "true"],
    ['a"b', '"a\\"b"'],
  ])
    assert.equal(toJson(v), want, v);
  assert.throws(
    () =>
      validate({
        nodes: [node("t", "terminal", { command: "gpio" })],
        edges: [],
      }),
    /built-in terminal command/,
  );
  assert.throws(
    () =>
      validate({ nodes: [node("w", "web-in", { name: "A B" })], edges: [] }),
    /Web name/,
  );
  assert.equal(
    validate({ nodes: [node("t", "terminal", { command: "LED" })], edges: [] })
      .nodes[0].config.command,
    "led",
  );
  const flow = {
    nodes: [
      node("tin", "terminal", { command: "led" }),
      node("win", "web-in", { name: "led" }),
      node("wout", "web-out", { name: "state" }),
      node("w2", "web-out", { name: "led" }),
    ],
    edges: edges(["tin", "wout"], ["win", "w2"]),
  };
  const debug = build(structuredClone(flow), { board: "esp32", ssid: "n" });
  assert.equal(debug.features.web, true);
  assert.match(debug.source, /#include <WebServer\.h>/);
  assert.match(debug.source, /mfWebSet\(0, value\);/); // state
  assert.match(debug.source, /mfWebSet\(1, value\);/); // led
  assert.match(
    debug.source,
    /if \(name == "led"\) \{ hit = true; node1\(body\); \}/,
  );
  assert.match(debug.source, /if \(cmd == "led"\) \{ node0\(data\);/);
  assert.match(debug.source, /String t = mfTerminal\(line\)/); // via the test terminal
  assert.match(
    debug.source,
    /mfWebSend\(200, "text\/plain; charset=utf-8", mfCommand\(line\)\)/,
  );
  assert.doesNotMatch(debug.source, /mfTerminalPoll/);
  // The server starts after WiFi.begin().
  assert.ok(
    debug.source.indexOf("mfWeb.begin();") >
      debug.source.indexOf("WiFi.begin(MF_SSID"),
  );
  const release = build(structuredClone(flow), {
    board: "esp8266",
    ssid: "n",
    profile: "release",
    ota: false,
  });
  assert.equal(release.features.net, true); // web needs WiFi even in release
  assert.match(release.source, /#include <ESP8266WebServer\.h>/);
  assert.match(release.source, /mfTerminalPoll\(\);/);
  assert.match(release.source, /String r = mfTerminal\(line\)/);
  // Terminal alone works offline, on any board.
  const offline = build(
    {
      nodes: [node("t", "terminal"), node("d", "digital-write", { pin: 2 })],
      edges: edges(["t", "d"]),
    },
    { board: "esp32", profile: "release", ota: false },
  );
  assert.match(offline.source, /mfTerminalPoll\(\);/);
  assert.doesNotMatch(offline.source, /WebServer/);
});
test("flow tabs connect through Link out / Link in nodes", () => {
  const flow = validate({
    name: "Tabs",
    tabs: [
      { id: "t1", name: "Inputs" },
      { id: "t2", name: "Outputs" },
    ],
    nodes: [
      node("go", "inject", { payload: "1", interval: 0 }),
      node("send", "link-out", { link: "led" }),
      node("recv", "link-in", { link: "led" }, { tab: "t2" }),
      node("pin", "digital-write", { pin: 2 }, { tab: "t2" }),
      node("lost", "debug", {}, { tab: "gone" }),
    ],
    edges: edges(["go", "send"], ["recv", "pin"]),
  });
  assert.equal(flow.nodes[2].tab, "t2");
  assert.equal(flow.nodes[4].tab, undefined, "unknown tab → first tab");
  assert.deepEqual(wiring(flow).at(-1), { from: "send", to: "recv" });
  // Link out (node1) calls Link in (node2), which drives the pin (node3).
  const source = generate(flow, { board: "esp32", ssid: "x" });
  assert.match(source, /void node1\(String value\) \{\n  node2\(value\);\n\}/);
  assert.match(source, /void node2\(String value\) \{\n  node3\(value\);\n\}/);
  const { warnings } = analyze(
    {
      nodes: [node("o", "link-out", { link: "nowhere" }), node("i", "link-in")],
      edges: [],
    },
    "esp32",
  );
  assert.ok(
    warnings.some((w) => /no Link in uses link name "nowhere"/.test(w)),
  );
  assert.ok(warnings.some((w) => /no Link out uses link name "link1"/.test(w)));
  // A loop through a link is still a cycle.
  assert.throws(
    () =>
      validate({
        nodes: [
          node("i", "link-in", { link: "x" }),
          node("t", "template"),
          node("o", "link-out", { link: "x" }),
        ],
        edges: edges(["i", "t"], ["t", "o"]),
      }),
    /Cycles/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [node("o", "link-out"), node("d", "debug")],
        edges: edges(["o", "d"]),
      }),
    /no output/,
  );
  assert.throws(
    () => validate({ tabs: [{ id: "a" }, { id: "a" }], nodes: [], edges: [] }),
    /duplicate flow tab/,
  );
});
test("test devices: switch and push button fire like manual injects, scope reports values", () => {
  const flow = {
    name: "Test bench",
    nodes: [
      node("sw", "test-switch", {}, { label: "Switch" }),
      node("push", "test-button", {}, { label: "Push button" }),
      node("scope", "test-scope", {}, { label: "Oscilloscope" }),
    ],
    edges: edges(["sw", "scope"], ["push", "scope"]),
  };
  const debug = build(structuredClone(flow), {
    board: "esp32",
    ssid: "net",
    host: "broker",
  });
  for (const id of ["sw", "push"]) {
    assert.ok(
      debug.source.includes(`mqtt.subscribe((mfBase + "/inject/${id}")`),
    );
    assert.match(
      debug.source,
      new RegExp(
        String.raw`"/inject/${id}"\) == topicCopy\) node\d+\(length \? value : String\("1"\)\)`,
      ),
    );
  }
  assert.match(
    debug.source,
    /"\/debug\/scope"/,
    "scope values go to its debug topic",
  );
  const release = build(structuredClone(flow), {
    board: "esp32",
    ssid: "net",
    host: "broker",
    profile: "release",
  });
  assert.doesNotMatch(release.source, /\/inject\/sw|\/debug\/scope/);
  assert.ok(
    release.warnings.some((w) => /switch and push button nodes/.test(w)),
  );
  assert.equal(catalog()["test-scope"].sink, true);
  assert.equal(catalog()["test-switch"].manual, true);
});
test("an Oscilloscope at the end of a flow is not flagged as unconnected", () => {
  const { warnings } = analyze(
    {
      nodes: [
        node("sw", "test-switch", {}, { label: "Switch" }),
        node("scope", "test-scope", { window: 10 }, { label: "Scope" }),
      ],
      edges: edges(["sw", "scope"]),
    },
    "esp32",
  );
  assert.ok(
    !warnings.some((w) => /not connected/.test(w)),
    warnings.join("\n"),
  );
});
test("PC input emulation: inputs read through overrides, every node reports, debug only", () => {
  const flow = {
    name: "Bench",
    nodes: [
      node("btn", "gpio-watch", { pin: 4 }, { label: "Button" }),
      node("rd", "digital-read", { pin: 5 }, { label: "Read" }),
      node("adc", "analog-in", { pin: 34 }, { label: "Knob" }),
      node("hot", "threshold", { value: 2000 }, { label: "Hot" }),
      node("led", "digital-write", { pin: 2 }, { label: "LED" }),
    ],
    edges: edges(["btn", "led"], ["rd", "hot"], ["adc", "hot"]),
  };
  const settings = { board: "esp32", ssid: "net", host: "broker" };
  const emu = build(structuredClone(flow), { ...settings, emulate: true });
  const src = emu.source;
  assert.equal(emu.features.emulate, true);
  assert.match(src, /int r = mfDigitalRead\(4\);/, "GPIO input (change)");
  assert.match(src, /node1\(String\(mfDigitalRead\(5\)\)\)/, "GPIO input");
  assert.match(src, /String\(mfAnalogRead\(34\)\)/, "Analog sample");
  assert.match(src, /digitalWrite\(2,/, "outputs stay real");
  // Reports follow the node's body, so a filtered message is not reported.
  assert.match(
    src,
    /void node3\(String value\) \{\n {2}double x; if \(!mfNumber\(value, x\) \|\| x < 2000\.0\) return;\n {2}mfTrace\(3, value\);/,
  );
  assert.match(
    src,
    /MF_TRACE_IDS\[\] = \{ "btn", "rd", "adc", "hot", "led" \}/,
  );
  assert.match(src, /if \(cmd == "emu"\)/);
  assert.match(src, /emu \[<pin> <0-4095\|off>\]/, "help lists emu");
  assert.match(
    src,
    /void setup\(\) \{\n {2}Serial\.begin\(115200\);\n {2}for \(size_t p = 0; p < 55; p\+\+\) mfEmu\[p\] = -1;/,
  );
  assert.match(src, /\\"emu\\":1/, "status reports the emulation build");
  const plain = build(structuredClone(flow), settings);
  assert.doesNotMatch(
    plain.source,
    /mfEmu|mfTrace|mfDigitalRead|mfAnalogRead|"emu"/,
  );
  assert.notEqual(plain.build, emu.build, "emulation changes the build ID");
  const release = build(structuredClone(flow), {
    ...settings,
    emulate: true,
    profile: "release",
  });
  assert.doesNotMatch(release.source, /mfEmu|mfTrace/);
  assert.ok(release.warnings.some((w) => /needs a Debug build/.test(w)));
});
test("the broker host is required only when the firmware uses MQTT", () => {
  const { brokerReason } = require("../lib/flow");
  const s = { board: "esp32", ssid: "net" };
  const mqtt = {
    nodes: [
      node("go", "inject", { payload: "1", interval: 0 }, { label: "Go" }),
      node("out", "mqtt-out", { topic: "a/b" }, { label: "Report" }),
    ],
    edges: edges(["go", "out"]),
  };
  assert.equal(
    brokerReason(validate(structuredClone(mqtt)), s),
    "this flow uses MQTT (Radio out “Report”)",
  );
  const blink = {
    nodes: [
      node("go", "inject", { payload: "1", interval: 500 }, { label: "Go" }),
      node("led", "digital-write", { pin: 2 }, { label: "LED" }),
    ],
    edges: edges(["go", "led"]),
  };
  const plain = () => validate(structuredClone(blink));
  assert.match(brokerReason(plain(), s), /^Debug builds report to the IDE/);
  assert.match(
    brokerReason(plain(), { ...s, profile: "release" }),
    /^Remote update is on/,
  );
  assert.equal(
    brokerReason(plain(), { ...s, profile: "release", ota: false }),
    null,
    "standalone firmware without MQTT needs no broker",
  );
  const web = {
    nodes: [
      node("in", "web-in", { name: "led" }, { label: "Web in" }),
      node("led", "digital-write", { pin: 2 }, { label: "LED" }),
    ],
    edges: edges(["in", "led"]),
  };
  assert.equal(
    brokerReason(validate(structuredClone(web)), {
      ...s,
      profile: "release",
      ota: false,
    }),
    null,
    "Web in/out need WiFi, not a broker",
  );
});
