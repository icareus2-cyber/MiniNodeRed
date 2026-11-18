// public/emulate.js (PC input emulation in the editor), run in a VM with stand-ins
// for the editor's DOM helpers, serial port and API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { catalog } = require("../lib/nodes");
const source = fs.readFileSync(
  path.join(__dirname, "../public/emulate.js"),
  "utf8",
);
// Objects made inside the VM have its own prototypes: compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const element = (props) => ({
  attributes: {},
  children: [],
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute(k, v) {
    this.attributes[k] = v;
  },
  append(...c) {
    this.children.push(...c);
  },
  appendChild(c) {
    this.children.push(c);
    return c;
  },
  replaceChildren(...c) {
    this.children = c;
  },
  ...props,
});
// board: how the fake board behaves on the serial port (Start Real Simulation).
function editor({
  connected = true,
  chip = { emu: 1 },
  busy = 0,
  baud = "115200",
  board = { answers: true, emu: 1, build: "b1", replies: true },
  expectedBuild = "b1",
  garbled = false,
} = {}) {
  const sent = [],
    calls = [],
    elements = {};
  const values = { baudRate: baud, serialTransport: "browser", board: "esp32" };
  const fake = (id) =>
    (elements[id] ||= {
      id,
      value: values[id] ?? "",
      hidden: false,
      textContent: "",
      style: {},
      children: [],
      classList: { add() {}, remove() {} },
      replaceChildren(...c) {
        this.children = c;
      },
      append(...c) {
        this.children.push(...c);
      },
    });
  let failures = busy;
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    flow: {
      nodes: [
        { id: "btn", type: "gpio-watch", config: { pin: 4, pull: "pullup" } },
        { id: "raw", type: "digital-read", config: { pin: 5, pull: "none" } },
        { id: "knob", type: "analog-in", config: { pin: 34 } },
        { id: "led", type: "digital-write", config: { pin: 2 } },
        { id: "dim", type: "pwm-write", config: { pin: 13 } },
        {
          id: "chime",
          type: "pulse",
          config: { pin: 14, active: "low" },
        },
        { id: "scope", type: "test-scope", config: { window: 10 } },
      ],
    },
    catalog: catalog(),
    boards: [{ id: "esp32", family: "esp32" }],
    chipLast: chip,
    consolePaused: false,
    $: fake,
    el: (tag, cls, text) => element({ tag, className: cls, textContent: text }),
    button: (text, onclick, cls) =>
      element({ tag: "button", textContent: text, onclick, className: cls }),
    attempt: (fn) => fn,
    toast: () => {},
    serialConnected: () => connected,
    chipSend: async (text) => {
      if (failures > 0) {
        failures--;
        throw Error("A serial write is already in progress.");
      }
      sent.push(text);
      // The fake board answers the handshake and the emu command.
      if (text === "mf?\n" && board.answers)
        setTimeout(() => {
          ctx.chipLast = {
            id: "esp-a",
            build: board.build,
            emu: board.emu,
            at: Date.now(),
          };
        }, 5);
      if (text === "emu\n" && board.replies)
        setTimeout(
          () =>
            ctx.emuSerialText("» emu: none (inputs read the real pins)\r\n"),
          5,
        );
    },
    api: async (route, body) => {
      calls.push([route, body]);
      if (route === "firmware") return { build: expectedBuild };
    },
    modal: (title, content) => calls.push(["modal", title, content]),
    settings: () => ({ board: "esp32" }),
    saveSettings: () => {},
    chipParser: { garbled: () => garbled },
    resetTestDevices: () => {},
    showSimPins: () => calls.push(["showSimPins"]),
    updatePinLeds: () => {},
    scopeSample: (id, v) => calls.push(["scope", id, v]),
    // Box controls (yellow outline, values on the boxes).
    document: {
      body: {
        classes: new Set(),
        classList: {
          add: (c) => ctx.document.body.classes.add(c),
          remove: (c) => ctx.document.body.classes.delete(c),
        },
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    render: () => calls.push(["render"]),
    nodeValues: new Map(),
  };
  ctx.chipFlow = () => ctx.flow; // one chip: the whole flow (app.js)
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  // Top-level let/const are not context properties: expose them for the tests.
  vm.runInContext(
    "Object.assign(globalThis, { triggerNode, emuControls, emuDevice, emu: { get active() { return emuActive; }, emuInputs, emuLevels, emuDevices, emuPulsing } })",
    ctx,
  );
  return { ctx, sent, calls, elements };
}
test("starting emulation clears overrides and lists the flow's input pins", async () => {
  const { ctx, sent, calls } = editor();
  await ctx.startEmulation();
  assert.equal(ctx.emu.active, true);
  const strip = ctx.$("simPins");
  assert.equal(strip.hidden, false);
  assert.deepEqual(
    strip.children.slice(1).map((chip) => chip.children[0].textContent),
    ["GPIO 4 · real pin", "GPIO 5 · real pin", "ADC 34"],
  );
  assert.deepEqual(sent, ["emu off\n"]);
  assert.deepEqual(plain(calls[0]), ["runtime/stop", {}], "simulator stopped");
  assert.deepEqual(
    [...ctx.emu.emuInputs].map(([pin, i]) => [pin, i.role, i.active, i.value]),
    [
      [4, "in", 0, null], // pull-up button: pressing pulls LOW
      [5, "in", 1, null],
      [34, "adc", 1, null],
    ],
  );
});
test("emulation refuses boards without it and unconnected ports", async () => {
  await assert.rejects(
    editor({ connected: false }).ctx.startEmulation(),
    /Connect the board's serial port/,
  );
  await assert.rejects(
    editor({ chip: { emu: undefined } }).ctx.startEmulation(),
    /no PC input emulation/,
  );
});
test("pins are set and released over serial; triggers use send", async () => {
  const { ctx, sent, calls } = editor();
  await ctx.startEmulation();
  await ctx.emuSet(4, 0);
  await ctx.emuSet(34, 2048);
  await ctx.emuSet(4, null);
  await ctx.triggerNode("sw", "1");
  assert.deepEqual(sent.slice(1), [
    "emu 4 0\n",
    "emu 34 2048\n",
    "emu 4 off\n",
    "send sw 1\n",
  ]);
  assert.equal(ctx.emu.emuInputs.get(34).value, 2048);
  assert.equal(ctx.emu.emuInputs.get(4).value, null);
  await ctx.stopEmulation();
  assert.equal(ctx.emu.active, false);
  assert.equal(sent.at(-1), "emu off\n");
  // Outside emulation, triggers go to the runtime (simulator or MQTT).
  await ctx.triggerNode("sw", "0");
  assert.deepEqual(plain(calls.at(-1)), [
    "runtime/inject",
    { id: "sw", payload: "0" },
  ]);
});
test("serial writes wait for a busy port and keep their order", async () => {
  const { ctx, sent } = editor({ busy: 2 });
  await Promise.all([ctx.emuSend("emu 4 1"), ctx.emuSend("emu 5 0")]);
  assert.deepEqual(sent, ["emu 4 1\n", "emu 5 0\n"]);
});
test("board reports drive pin levels and the oscilloscope", () => {
  const { ctx, calls } = editor();
  ctx.emuTrace("led", "1");
  ctx.emuTrace("btn", "0");
  ctx.emuTrace("dim", "300");
  ctx.emuTrace("chime", "1"); // active-low pulse started: pin LOW
  ctx.emuTrace("scope", "42");
  ctx.emuTrace("unknown", "1");
  assert.deepEqual(Object.fromEntries(ctx.emu.emuLevels), {
    2: 1,
    4: 0,
    13: 255,
    14: 0,
  });
  assert.deepEqual(calls.at(-1), ["scope", "scope", "42"]);
});
// The checklist rows of the Start Real Simulation dialog, as "✓ name: detail".
const rows = (calls) => {
  const box = calls.find((c) => c[0] === "modal")[2];
  const [note, list] = box.children;
  return {
    note: note.textContent,
    steps: list.children.map(
      (r) => `${r.children[0].textContent}: ${r.children[1].textContent}`,
    ),
  };
};
test("Start Real Simulation checks the link and the board, then starts", async () => {
  const { ctx, sent, calls } = editor({ chip: null });
  assert.equal(await ctx.realSimulation(null), true);
  const { note, steps } = rows(calls);
  assert.deepEqual(
    steps.map((s) => s.split(":")[0]),
    [
      "✓ Serial port connected",
      "✓ Baud rate",
      "✓ Device answers (handshake)",
      "✓ Firmware supports PC inputs",
      "✓ Board runs this flow",
      "✓ Commands reach the board",
      "✓ PC inputs active",
    ],
  );
  assert.match(steps[2], /device esp-a · build b1/);
  assert.match(steps[6], /3 input pins ready/);
  assert.match(note, /Real simulation running/);
  assert.equal(ctx.emu.active, true);
  assert.equal(ctx.$("runtimeMode").value, "emulate");
  assert.ok(sent.includes("mf?\n") && sent.includes("emu\n"));
});
test("Start Real Simulation stops at the first failing check", async () => {
  const cases = [
    [{ connected: false }, "✗ Serial port connected", /not connected/],
    [{ baud: "9600" }, "✗ Baud rate", /talks at 115200/],
    [
      { board: { answers: false }, garbled: true },
      "✗ Device answers (handshake)",
      /wrong baud rate or the chip is crash-looping/,
    ],
    [
      { board: { answers: true, emu: undefined, build: "b1" } },
      "✗ Firmware supports PC inputs",
      /tick “PC input emulation \(USB\)”/,
    ],
    [
      { board: { answers: true, emu: 1, build: "b1", replies: false } },
      "✗ Commands reach the board",
      /not the emu command/,
    ],
  ];
  for (const [options, failed, detail] of cases) {
    const { ctx, calls } = editor({ chip: null, ...options });
    assert.equal(await ctx.realSimulation(null), false, failed);
    const { note, steps } = rows(calls);
    assert.ok(steps.at(-1).startsWith(failed), steps.at(-1));
    assert.match(steps.at(-1), detail);
    assert.match(note, /Not started/);
    assert.equal(ctx.emu.active, false);
  }
});
test("an older build on the board is a warning, not a failure", async () => {
  const { ctx, calls } = editor({ chip: null, expectedBuild: "b2" });
  assert.equal(await ctx.realSimulation(null), true);
  const step = rows(calls).steps[4];
  assert.match(
    step,
    /^– Board runs this flow: board has build b1, this flow builds b2/,
  );
});

test("emulating: yellow boxes, controls on the boxes, sensors from the PC", async () => {
  const { ctx, sent, calls } = editor();
  ctx.flow.nodes.push({
    id: "temp",
    type: "input-device",
    label: "Temp",
    config: { device: "temp", sensor: "dht22", pin: 15 },
  });
  await ctx.startEmulation();
  assert.ok(ctx.document.body.classes.has("emulating"));
  assert.ok(calls.some(([c]) => c === "render"), "boxes redrawn with controls");
  // GPIO input box: PUSH, SWITCH and REAL; Input device: value, PC, REAL.
  const box = (id) => {
    const e = ctx.el("div", "flow-node");
    ctx.emuControls(ctx.flow.nodes.find((n) => n.id === id), e);
    return e.children[0];
  };
  assert.deepEqual(
    box("btn").children.map((c) => c.textContent),
    ["PUSH", undefined, "REAL"],
  );
  assert.equal(box("knob").children[0].type, "range");
  assert.deepEqual(
    box("temp").children.slice(1).map((c) => c.textContent),
    ["PC", "REAL"],
  );
  assert.equal(box("led"), undefined, "outputs have no controls (they show the board)");
  await ctx.emuDevice("temp", "23.4");
  await ctx.emuDevice("temp", null);
  assert.deepEqual(sent.slice(-2), ["emu node temp 23.4\n", "emu node temp off\n"]);
  // Reports: values on the boxes, PULSE while the pulse is out.
  ctx.emuTrace("chime", "1");
  assert.ok(ctx.emu.emuPulsing.has(14));
  assert.equal(ctx.nodeValues.get("chime"), "1");
  ctx.emuTrace("chime", "0");
  assert.ok(!ctx.emu.emuPulsing.has(14));
  await ctx.stopEmulation();
  assert.ok(!ctx.document.body.classes.has("emulating"));
  assert.equal(ctx.nodeValues.size, 0);
});

test("firmware: input devices take the PC's value in emulation builds only", () => {
  const { build } = require("../lib/flow");
  const cat = catalog();
  const node = (id, type, config) => ({
    id,
    type,
    config: {
      ...Object.fromEntries(cat[type].fields.map((f) => [f.key, f.default])),
      ...config,
    },
  });
  const flow = {
    name: "t",
    nodes: [
      node("temp", "input-device", { device: "temp", sensor: "dht22", pin: 15, interval: 2000 }),
      node("d", "debug", {}),
    ],
    edges: [{ from: "temp", to: "d" }],
  };
  const s = { board: "esp32", ssid: "n", password: "p", host: "h", profile: "debug" };
  const emu = build(flow, { ...s, emulate: true }).source;
  assert.match(emu, /if \(mfEmuOn\[0\]\) node0\(mfEmuVal\[0\]\);/);
  assert.match(emu, /if \(a == "node"\)/);
  assert.match(emu, /emu node <node id> <value\|off>/);
  const plainBuild = build(flow, s).source;
  assert.doesNotMatch(plainBuild, /mfEmuOn/);
});
