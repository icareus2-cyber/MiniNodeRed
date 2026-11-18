// Screen node (TEST group): shows pictures in the PC simulator only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze, build, validate } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");

const flow = {
  name: "t",
  nodes: [
    { id: "b", type: "test-button", config: {} },
    { id: "c", type: "camera", config: { size: "QVGA" } },
    { id: "s", type: "test-screen", config: {} },
  ],
  edges: [
    { from: "b", to: "c" },
    { from: "c", to: "s" },
  ],
};

test("catalog: in the TEST group, receives only, simulation only", () => {
  const c = catalog()["test-screen"];
  assert.equal(c.label, "Screen");
  assert.equal(c.group, "TEST");
  assert.equal(c.sink, true);
  assert.equal(c.simOnly, true);
  assert.deepEqual(
    c.fields.map((f) => f.key),
    ["size", "info"],
  );
});

test("simulator: the picture goes to the IDE; the board gets nothing", () => {
  const [, , s] = validate(structuredClone(flow)).nodes;
  const shown = [];
  types["test-screen"].host('{"image":"/api/camera/sim/c.png?shot=1"}', s, {
    screen: (n, v) => shown.push([n.id, v]),
  });
  assert.deepEqual(shown, [["s", '{"image":"/api/camera/sim/c.png?shot=1"}']]);
  const w = analyze(structuredClone(flow), "freenove-s3cam").warnings.join(
    "\n",
  );
  assert.match(
    w,
    /Screen \(SCREEN1\): simulation only; on the board it does nothing/,
  );
  const { source } = build(structuredClone(flow), {
    board: "freenove-s3cam",
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  });
  assert.match(source, /void node2\(String value\) \{\n\}/); // an empty node
});
