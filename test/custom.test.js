// Custom nodes (lib/custom.js): a box expands to its nodes before it runs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze, validate, expandCustom } = require("../lib/flow");

// "Alarm": Threshold ≥ 25 → Template "ALARM {{payload}}"; input Threshold, output Template.
const alarm = {
  nodes: [
    { id: "th", type: "threshold", label: "Hot", name: "HOT", config: { value: 25 }, x: 0, y: 0 },
    { id: "tp", type: "template", label: "Text", name: "TEXT", config: { template: "ALARM {{payload}}" }, x: 200, y: 0 },
  ],
  edges: [{ from: "th", to: "tp" }],
  inputs: ["th"],
  outputs: ["tp"],
};
const flowWith = (...boxes) => ({
  name: "c",
  nodes: [
    { id: "in", type: "inject", config: { payload: "30", interval: 0 } },
    ...boxes.map((b) => ({ type: "custom", label: "Alarm", config: { def: alarm, pins: {} }, ...b })),
    { id: "out", type: "debug", label: "Out", config: {} },
  ],
  edges: [
    { from: "in", to: boxes[0].id },
    ...boxes.slice(1).map((b, k) => ({ from: boxes[k].id, to: b.id })),
    { from: boxes.at(-1).id, to: "out" },
  ],
});

test("a box expands to its nodes, wired in and out, names made unique", () => {
  const f = expandCustom(flowWith({ id: "a", name: "ALARM1" }, { id: "b", name: "ALARM2" }));
  assert.deepEqual(
    f.nodes.map((n) => [n.id, n.name]),
    [["in", undefined], ["out", undefined], ["a__th", "HOT_1"], ["a__tp", "TEXT_1"], ["b__th", "HOT_2"], ["b__tp", "TEXT_2"]],
  );
  const wires = f.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(wires, ["a__th>a__tp", "a__tp>b__th", "b__th>b__tp", "b__tp>out", "in>a__th"].sort());
  assert.equal(f.nodes.find((n) => n.id === "a__th").label, "Alarm · Hot");
  // The flow given keeps its boxes (saved flows are not expanded).
  assert.equal(validate(flowWith({ id: "a" })).nodes[1].type, "custom");
});

test("firmware and analysis see the nodes inside", () => {
  const r = build(flowWith({ id: "a" }), { board: "esp32", ssid: "n", host: "h", profile: "release", ota: false });
  assert.match(r.source, /out \+= "ALARM "/);
  assert.equal(analyze(flowWith({ id: "a" }), "esp32").errors.length, 0);
  assert.throws(() => validate({ nodes: [{ id: "x", type: "custom", config: { def: { nodes: [], edges: [] } } }], edges: [] }), /definition is missing or empty/);
});

test("pins chosen on a box replace the pins inside", () => {
  const led = {
    nodes: [{ id: "o", type: "digital-write", label: "LED", name: "LED", config: { pin: 2 } }],
    edges: [],
    inputs: ["o"],
    outputs: [],
  };
  const f = expandCustom({
    nodes: [
      { id: "s", type: "test-switch", config: {} },
      { id: "b1", type: "custom", label: "Lamp", config: { def: led, pins: { "o.pin": 4 } } },
      { id: "b2", type: "custom", label: "Lamp", config: { def: led, pins: { "o.pin": 5 } } },
    ],
    edges: [{ from: "s", to: "b1" }, { from: "s", to: "b2" }],
  });
  assert.deepEqual(f.nodes.filter((n) => n.type === "digital-write").map((n) => n.config.pin), [4, 5]);
});

test("simulator runs a box (expanded by the server)", async () => {
  const { SimGroup } = require("../lib/simgroup"); // needs the mqtt package
  const events = [];
  const sims = new SimGroup((kind, message, extra = {}) => events.push({ kind, message, ...extra }));
  sims.start({ flow: expandCustom(flowWith({ id: "a" })), mode: "host", offline: true });
  sims.inject("in");
  await new Promise((r) => setTimeout(r, 20));
  sims.stop();
  assert.ok(events.some((e) => e.kind === "debug" && e.payload === "ALARM 30"), JSON.stringify(events));
});
