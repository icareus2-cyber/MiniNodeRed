// Status node: an I2C display that shows the status of every node with "Show on
// the Status display" ticked (n.status), one line each (lib/statusfw.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze, validate } = require("../lib/flow");
const { FlowRuntime } = require("../lib/runtime");
const statusfw = require("../lib/statusfw");
const { catalog } = require("../lib/nodes");

const settings = { board: "esp32", ssid: "n", host: "h", profile: "release", ota: false };
const status = (config = {}) => ({ id: "st", type: "status", label: "Status", config });
// A switch on GPIO 4 drives an LED on GPIO 13; both are shown.
const flowOf = (config, extra = []) => ({
  name: "s",
  nodes: [
    { id: "sw", type: "gpio-watch", config: { pin: 4 }, status: true },
    { id: "led", type: "digital-write", config: { pin: 13 }, status: true },
    status(config),
    ...extra,
  ],
  edges: [{ from: "sw", to: "led" }],
});

test("LCD 16×2: one line per shown node, GPIO lines read HIGH / LOW", () => {
  const r = build(flowOf(), settings);
  assert.deepEqual(r.libraries, ["LiquidCrystal I2C"]);
  assert.match(r.source, /LiquidCrystal_I2C mfLcd27\(0x27, 16, 2\)/);
  assert.match(r.source, /Wire\.begin\(21, 22\); \/\/ I2C for the display/);
  assert.match(r.source, /mfLcd27\.init\(\); mfLcd27\.backlight\(\);/);
  assert.match(r.source, /const uint8_t MF_STATUS_N = 2;/);
  assert.match(r.source, /String mfStatusText\[MF_STATUS_N\] = \{ "GPIO 4 -", "GPIO 13 -" \};/);
  assert.match(
    r.source,
    /mfStatus\(1, String\("GPIO 13 "\) \+ \(\(value == "0" \|\| value == "false"\) \? "LOW" : "HIGH"\)\);/,
  );
  assert.match(r.source, /void loop\(\) \{[\s\S]*mfStatusDraw\(\);/);
  assert.match(r.source, /while \(t\.length\(\) < 16\) t \+= ' '; mfLcd27\.setCursor\(0, r\);/);
  // No "output is not connected" for a node whose value goes to the display.
  assert.ok(!r.warnings.some((w) => /output is not connected/.test(w)), r.warnings.join("\n"));
});

test("how lines read: PWM duty, on / off, counter outputs, C/C++ send()", () => {
  const r = build(
    {
      name: "s",
      nodes: [
        { id: "in", type: "inject", config: { payload: "1", interval: 1000 } },
        { id: "pwm", type: "pwm-write", config: { pin: 5 }, status: true },
        { id: "tm", type: "timer", config: {}, status: true },
        { id: "cnt", type: "counter", config: {}, status: true },
        { id: "code", type: "arduino", config: { message: "send(value);" }, status: true },
        { id: "map", type: "scale", config: {}, status: true },
        status({ screen: "lcd2004" }),
      ],
      edges: ["pwm", "tm", "cnt", "code", "map"].map((to) => ({ from: "in", to })),
    },
    settings,
  );
  assert.match(r.source, /mfStatus\(0, String\("GPIO 5 PWM "\) \+ value\);/);
  assert.match(r.source, /mfStatus\(1, String\("TIMER1 "\) \+ \(.*\? "OFF" : "ON"\)\);/);
  // Each Counter output reports on the Counter's line.
  assert.match(r.source, /mfStatus\(2, String\("COUNT1 out3 "\)/);
  assert.match(r.source, /void send\(const String& v\) \{ mfStatus\(3, String\("CODE1 "\) \+ v\);/);
  assert.match(r.source, /mfStatus\(4, String\("MAP1 "\) \+ value\);/);
  assert.match(r.source, /LiquidCrystal_I2C mfLcd27\(0x27, 20, 4\)/);
  // The simulator / IDE text is the same.
  const n = (type, config = {}, name) => ({ type, config, name });
  assert.equal(statusfw.text(n("digital-write", { pin: 13 }), "1"), "GPIO 13 HIGH");
  assert.equal(statusfw.text(n("gpio-watch", { pin: 4 }), "0"), "GPIO 4 LOW");
  assert.equal(statusfw.text(n("pwm-write", { pin: 5 }), "128"), "GPIO 5 PWM 128");
  assert.equal(statusfw.text(n("timer", {}, "TIMER1"), "0"), "TIMER1 OFF");
  assert.equal(statusfw.text(n("counter", {}, "COUNT1"), "1", 1), "COUNT1 out2 ON");
  assert.equal(statusfw.text(n("input-device", {}, "TEMP1"), "21.5"), "TEMP1 21.5");
  // The IDE gets what it needs to build the same lines.
  assert.equal(catalog().status.standalone, true);
  assert.equal(catalog()["digital-write"].statusKind, "level");
  assert.equal(catalog()["digital-write"].statusPin, true);
  assert.equal(catalog()["test-screen"].statusOk, false);
});

test("OLED: more nodes than lines page through, the screen is redrawn only on change", () => {
  const extra = [25, 26, 27, 32].map((pin, k) => ({
    id: "d" + k,
    type: "digital-write",
    config: { pin },
    status: true,
  }));
  const flow = flowOf({ screen: "oled32", textSize: "2", page: 2000 }, extra);
  flow.edges.push(...extra.map((n) => ({ from: "sw", to: n.id })));
  const r = build(flow, settings);
  assert.deepEqual(r.libraries, ["Adafruit SSD1306", "Adafruit GFX Library"]);
  assert.match(r.source, /const uint8_t MF_STATUS_N = 6;/);
  assert.match(r.source, /const uint8_t pages = \(MF_STATUS_N \+ 1\) \/ 2;/); // 2 lines of size 2
  assert.match(r.source, /millis\(\) - turned >= 2000UL/);
  assert.match(r.source, /if \(!mfOledOk3C\) return;/);
  assert.match(r.source, /mfOled3C\.setTextSize\(2\)/);
  assert.match(r.source, /if \(any\) mfOled3C\.display\(\);/);
  assert.match(r.source, /if \(!all && \(k >= MF_STATUS_N \|\| !mfStatusDirty\[k\]\)\) continue;/);
});

test("checks: no wires, one per board, its own address, ticked nodes", () => {
  const wired = flowOf();
  wired.edges.push({ from: "sw", to: "st" });
  assert.throws(() => validate(wired), /Status has no wires/);
  const two = flowOf({}, [{ ...status(), id: "st2", label: "Status 2" }]);
  assert.match(analyze(two, "esp32").errors.join(" "), /one Status display/);
  const shared = flowOf({}, [
    { id: "lcd", type: "output-device", label: "LCD", config: { device: "i2cdisplay", screen: "lcd1602" } },
  ]);
  shared.edges.push({ from: "sw", to: "lcd" });
  assert.match(analyze(shared, "esp32").errors.join(" "), /needs a screen of its own/);
  // Without a Status node, a ticked node only warns (and builds no display).
  const none = flowOf();
  none.nodes = none.nodes.filter((n) => n.type !== "status");
  const r = analyze(none, "esp32");
  assert.equal(r.errors.length, 0);
  assert.match(r.warnings.join(" "), /no Status node/);
  assert.doesNotMatch(build(none, settings).source, /mfStatus/);
  // A Status node with nothing ticked: a warning, and "No status" on the screen.
  const empty = flowOf();
  for (const n of empty.nodes) delete n.status;
  assert.match(analyze(empty, "esp32").warnings.join(" "), /no node shows its status yet/);
  assert.match(build(empty, settings).source, /\{ "No status" \}/);
  // No "never runs" warning for the Status box itself.
  assert.ok(!analyze(flowOf(), "esp32").warnings.some((w) => /Status has no incoming/.test(w)));
  // The flag is true or left out, and only on nodes that can show a status.
  const f = flowOf({}, [{ id: "scr", type: "test-screen", config: {}, status: true }]);
  f.nodes[0].status = "yes";
  f.edges.push({ from: "sw", to: "scr" });
  validate(f);
  assert.equal(f.nodes[0].status, undefined);
  assert.equal(f.nodes.find((n) => n.id === "scr").status, undefined);
  assert.equal(f.nodes[1].status, true);
});

test("simulator: a value that ends later (Pulse) is reported too", async () => {
  const events = [];
  const runtime = new FlowRuntime((kind, message, extra) =>
    events.push({ kind, message, ...extra }),
  );
  runtime.start({
    flow: {
      name: "p",
      nodes: [
        { id: "in", type: "inject", config: { payload: "1", interval: 0 } },
        { id: "p", type: "pulse", config: { pin: 2, width: 30 }, status: true },
        status(),
      ],
      edges: [{ from: "in", to: "p" }],
    },
    offline: true,
  });
  try {
    runtime.run("in", "1");
    const traces = () => events.filter((e) => e.kind === "trace" && e.message === "p");
    assert.deepEqual(traces().map((e) => e.payload), ["1"]);
    const end = Date.now() + 2000;
    while (traces().length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(traces().map((e) => e.payload), ["1", "0"]);
    assert.equal(traces()[1].port, undefined); // one output: no port
  } finally {
    runtime.stop();
  }
});
