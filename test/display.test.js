const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const aedes = require("aedes");
const { analyze, build } = require("../lib/flow");
const { FlowRuntime } = require("../lib/runtime");
const { runTest } = require("../lib/testrunner");
const example = require("../examples/ttgo-t-display.json");
const settings = { board: "ttgo-t-display", ssid: "n", host: "broker.local" };
test("the T-Display reserves its LCD pins and only display boards accept Display nodes", () => {
  const write = (pin) => ({
    nodes: [
      { id: "i", type: "inject", config: { interval: 1000 } },
      { id: "w", type: "digital-write", config: { pin } },
    ],
    edges: [{ from: "i", to: "w" }],
  });
  for (const [pin, role] of [
    [19, "MOSI"],
    [18, "SCLK"],
    [5, "CS"],
    [16, "DC"],
    [23, "RST"],
    [4, "BACKLIGHT"],
  ])
    assert.match(
      analyze(write(pin), "ttgo-t-display").errors[0],
      new RegExp(`GPIO ${pin} is used by the built-in display \\(${role}\\)`),
    );
  assert.deepEqual(analyze(write(2), "ttgo-t-display").errors, []);
  assert.match(analyze(write(35), "ttgo-t-display").errors[0], /input-only/);
  assert.match(
    analyze(structuredClone(example.flow), "esp32").errors[0],
    /has no built-in display/,
  );
  assert.deepEqual(
    analyze(structuredClone(example.flow), "ttgo-t-display").errors,
    [],
  );
});
test("display firmware: SPI pins, landscape init, backlight, boot text and row output", () => {
  const src = build(structuredClone(example.flow), settings).source;
  assert.match(src, /#include <Adafruit_ST7789\.h>/);
  assert.match(src, /Adafruit_ST7789 mfTft\(&SPI, 5, 16, 23\);/);
  assert.match(
    src,
    /SPI\.begin\(18, -1, 19, 5\);\n {2}mfTft\.init\(135, 240\);/,
  );
  assert.match(src, /mfTft\.setRotation\(1\);/);
  assert.match(src, /digitalWrite\(4, HIGH\); \/\/ backlight on/);
  assert.match(src, /mfLcd\(0, 3, ST77XX_CYAN, "Microflow"\);/);
  assert.match(
    src,
    /mfLcd\(2, 2, ST77XX_YELLOW, String\("Button 1: "\) \+ value\);/,
  );
  assert.match(
    src,
    /if \(cmd == "lcd"\)/,
    "debug terminal gets the lcd command",
  );
  // Release builds without Display nodes carry no display code at all.
  const plain = build(
    {
      nodes: [
        { id: "i", type: "inject", config: { interval: 1000 } },
        { id: "w", type: "digital-write", config: { pin: 2 } },
      ],
      edges: [{ from: "i", to: "w" }],
    },
    { ...settings, profile: "release", ota: false },
  ).source;
  assert.ok(!/Adafruit_ST7789/.test(plain));
});
let broker, tcp, url;
before(async () => {
  broker = aedes();
  tcp = net.createServer(broker.handle);
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  url = `mqtt://127.0.0.1:${tcp.address().port}`;
});
after(async () => {
  await new Promise((r) => tcp.close(r));
  await new Promise((r) => broker.close(r));
});
test(
  "the example runs on the simulator with a virtual LCD",
  { timeout: 20000 },
  async () => {
    const lcd = new Map();
    const runtime = new FlowRuntime(
      (kind, message, extra) =>
        kind === "display" && !extra.clear && lcd.set(extra.row, extra),
    );
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) =>
          subs.some((s) => s.topic === "microflow/tdisp/display/text") && r(),
      ),
    );
    runtime.start({
      flow: structuredClone(example.flow),
      broker: { url },
      deviceId: "tdisp",
    });
    await ready;
    try {
      assert.equal(lcd.get(0).text, "Microflow", "boot text drawn at start");
      assert.equal(lcd.get(0).size, 3);
      for (const t of example.tests) {
        const r = await runTest(t, { broker: { url }, device: "tdisp" });
        assert.equal(r.passed, true, `${t.name}: ${JSON.stringify(r.steps)}`);
      }
      assert.equal(lcd.get(5).text, "Hello T-Display");
      assert.equal(lcd.get(6).text, "test row");
      runtime.setPin(0, 0); // press button 1
      assert.equal(lcd.get(2).text, "Button 1: 0");
      assert.deepEqual(
        runtime
          .status()
          .lcd.map((l) => l.row)
          .sort(),
        [0, 2, 3, 5, 6],
      );
    } finally {
      runtime.stop();
    }
  },
);
test("GPIO read: unconnected outputs and pins without pull-ups are flagged", () => {
  const flow = {
    nodes: [
      {
        id: "r",
        type: "digital-read",
        label: "GPIO read",
        config: { pin: 38 },
      },
    ],
    edges: [],
  };
  const w = analyze(structuredClone(flow), "ttgo-t-display").warnings.join(
    "\n",
  );
  assert.match(w, /GPIO 38 has no internal pull-up/);
  assert.match(w, /GPIO read's output is not connected/);
  // Floating mode (external resistor) and a connected output: no warnings about either.
  const fixed = structuredClone(flow);
  fixed.nodes[0].config.pull = "none";
  fixed.nodes.push({
    id: "d",
    type: "display",
    label: "Show",
    config: { row: 1 },
  });
  fixed.edges.push({ from: "r", to: "d" });
  assert.deepEqual(analyze(fixed, "ttgo-t-display").warnings, []);
  const src = build(fixed, settings).source;
  assert.match(src, /pinMode\(38, INPUT\);/);
  assert.match(src, /mode pullup, but this pin has no internal pull-up/);
  // GPIO 0 (button 1) does have a pull-up.
  const button = structuredClone(flow);
  button.nodes[0].config.pin = 0;
  assert.ok(
    !/no internal pull-up/.test(
      analyze(button, "ttgo-t-display").warnings.join(),
    ),
  );
});
test("boards with a built-in OLED: Display node rows on the SSD1306, sent from loop()", () => {
  const { build: make } = require("../lib/flow");
  const flow = {
    name: "oled",
    nodes: [
      { id: "i", type: "inject", config: { payload: "hi", interval: 1000 } },
      { id: "d", type: "display", config: { row: 2, size: 2, color: "green", initial: "boot" } },
    ],
    edges: [{ from: "i", to: "d" }],
  };
  for (const [board, wire] of [
    ["heltec-wifi-kit-32", "Wire.begin(4, 15);"],
    ["heltec-wifi-kit-32-v3", "Wire.begin(17, 18);"],
    ["lolin32-oled", "Wire.begin(5, 4);"],
  ]) {
    const fw = make(structuredClone(flow), { board, profile: "release", network: false });
    assert.match(fw.source, /#include <Adafruit_SSD1306\.h>/, board);
    assert.ok(fw.source.includes(wire), board);
    assert.ok(fw.source.includes('mfLcd(2, 2, ST77XX_GREEN, "boot");'), board);
    assert.match(fw.source, /void loop\(\) \{[\s\S]*mfLcdFlush\(\);/, board);
    assert.deepEqual(fw.libraries, ["Adafruit SSD1306", "Adafruit GFX Library"], board);
  }
  // The T-Display's LCD libraries are installed by the first build too.
  const tft = make(structuredClone(flow), { board: "ttgo-t-display", profile: "release", network: false });
  assert.deepEqual(tft.libraries, ["Adafruit ST7735 and ST7789 Library", "Adafruit GFX Library"]);
});
