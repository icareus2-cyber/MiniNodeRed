// Multi-chip projects: flow.chips and tab.chip are kept, limits grow per chip, and a
// chip's part of the project (as the IDE sends it) builds on its own.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate, build, analyze } = require("../lib/flow");

const project = () => ({
  name: "Bench",
  chips: [
    { id: "ca", name: "Controller", board: "esp32s3", deviceId: "ctrl-1" },
    { id: "cb", name: "Servo emulator", board: "esp32c3", serialPort: "COM7" },
  ],
  tabs: [
    { id: "t1", name: "Flow 1", chip: "ca" },
    { id: "t2", name: "Flow 1", chip: "cb" },
  ],
  nodes: [
    { id: "a", type: "digital-read", tab: "t1", config: { pin: 4 } },
    { id: "b", type: "mqtt-out", tab: "t1", config: { topic: "bench/angle" } },
    { id: "c", type: "mqtt-in", tab: "t2", config: { topic: "bench/angle" } },
    { id: "d", type: "digital-write", tab: "t2", config: { pin: 4 } },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "c", to: "d" },
  ],
});

test("chips and their tabs are kept; unknown boards and chips are dropped", () => {
  const p = project();
  p.chips[1].board = "no-such-board";
  p.tabs.push({ id: "t3", name: "Lost", chip: "zz" });
  const v = validate(p);
  assert.deepEqual(
    v.chips.map((c) => [c.id, c.name, c.board, c.deviceId, c.serialPort]),
    [
      ["ca", "Controller", "esp32s3", "ctrl-1", ""],
      ["cb", "Servo emulator", "", "", "COM7"],
    ],
  );
  assert.equal(v.tabs[0].chip, "ca");
  assert.equal(v.tabs[2].chip, undefined);
  assert.throws(
    () => validate({ ...project(), chips: [{ id: "x" }, { id: "x" }] }),
    /duplicate chip/,
  );
});

test("limits grow with the number of chips", () => {
  const p = project();
  for (let k = 0; k < 100; k++)
    p.nodes.push({
      id: "n" + k,
      type: "debug",
      tab: k % 2 ? "t1" : "t2",
      config: {},
    });
  assert.doesNotThrow(() => validate(p)); // 104 nodes, 2 chips
  const one = { ...project(), chips: undefined, nodes: p.nodes.slice(0, 70) };
  assert.throws(() => validate(one), /Limit: 64 nodes/);
});

test("one chip's part builds on its own (same GPIO on two chips is fine)", () => {
  const p = validate(project());
  const part = (chip) => {
    const tabs = p.tabs.filter((t) => t.chip === chip);
    const ids = new Set(tabs.map((t) => t.id));
    const nodes = p.nodes.filter((n) => ids.has(n.tab));
    const keep = new Set(nodes.map((n) => n.id));
    const { chips, ...rest } = p;
    return {
      ...rest,
      tabs,
      nodes,
      edges: p.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  };
  assert.deepEqual(analyze(part("ca"), "esp32s3").errors, []);
  assert.deepEqual(analyze(part("cb"), "esp32c3").errors, []);
  const settings = {
    board: "esp32c3",
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  };
  const { source } = build(part("cb"), settings);
  assert.match(source, /bench\/angle/);
  assert.doesNotMatch(source, /digitalRead\(4\)/); // the other chip's input is not here
});

test("a one-chip flow keeps the board it was saved with; a project keeps one per chip", () => {
  const one = { name: "One", board: "esp32c3", nodes: [], edges: [] };
  assert.equal(validate(structuredClone(one)).board, "esp32c3");
  assert.equal(validate({ ...one, board: "nope" }).board, undefined);
  assert.equal(validate({ ...project(), board: "esp32c3" }).board, undefined);
});
