// Function generator (TEST group) and the Switch / Push button that GPIO input replaces.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, validate } = require("../lib/flow");
const { catalog, funcGenValue } = require("../lib/nodes");

const gen = (config = {}) => ({
  name: "g",
  nodes: [
    { id: "g", type: "func-gen", config },
    { id: "s", type: "test-scope", config: {} },
  ],
  edges: [{ from: "g", to: "s" }],
});

test("waveforms: offset + amplitude × wave between −1 and 1", () => {
  const at = (wave, t, more = {}) =>
    Number(funcGenValue({ wave, freq: 1, amplitude: 2, offset: 1, duty: 50, decimals: 3, ...more }, t));
  assert.deepEqual([0, 250, 500, 750].map((t) => at("sine", t)), [1, 3, 1, -1]);
  assert.deepEqual([0, 499, 500, 999].map((t) => at("square", t)), [3, 3, -1, -1]);
  assert.deepEqual([0, 100, 999].map((t) => at("square", t, { duty: 10 })), [3, -1, -1]);
  assert.deepEqual([0, 250, 500, 750].map((t) => at("triangle", t)), [-1, 1, 3, 1]);
  assert.deepEqual([0, 500].map((t) => at("sawtooth", t)), [-1, 1]);
});

test("settings: defaults, and at least two samples per period", () => {
  const n = validate(gen()).nodes[0];
  assert.deepEqual(
    { wave: n.config.wave, freq: n.config.freq, interval: n.config.interval },
    { wave: "sine", freq: 0.5, interval: 50 },
  );
  assert.throws(() => validate(gen({ freq: 20, interval: 100 })), /at most 25 ms/);
  assert.equal(validate(gen({ freq: 20, interval: 25 })).nodes[0].config.freq, 20);
});

test("firmware: millis()-timed samples with the wave's formula", () => {
  const src = build(gen({ wave: "square", freq: 2, duty: 25, amplitude: 127.5, offset: 127.5 }), {
    board: "esp32",
    host: "h",
  }).source;
  assert.match(src, /double ph = \(double\)\(millis\(\) % 500UL\) \/ 500\.0;/);
  assert.match(src, /String\(127\.5 \+ 127\.5 \* \(ph < 0\.25 \? 1\.0 : -1\.0\), 2\)/);
});

test("Switch and Push button: kept for older flows, not in the node library", () => {
  const c = catalog();
  assert.equal(c["test-switch"].legacy, true);
  assert.equal(c["test-button"].legacy, true);
  assert.equal(c["func-gen"].legacy, false);
  assert.equal(c["func-gen"].group, "TEST");
  // Older flows with them still build.
  const old = {
    name: "old",
    nodes: [
      { id: "sw", type: "test-switch", config: {} },
      { id: "d", type: "debug", config: {} },
    ],
    edges: [{ from: "sw", to: "d" }],
  };
  assert.ok(build(old, { board: "esp32", host: "h" }).source.includes("void node0"));
});
