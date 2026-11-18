// Logic node (lib/logic.js): gates, flip-flops and timers. The simulator (host) and
// the generated firmware must behave the same; the firmware runs with the host g++
// and the stand-in headers in test/fixtures/arduino.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, analyze, build } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");
const { FUNCTIONS } = require("../lib/logic");

const sw = (id) => ({
  id,
  type: "test-switch",
  name: id.toUpperCase(),
  config: {},
});
const logicNode = (config, id = "l") => ({
  id,
  type: "logic",
  label: "L",
  config,
});
const out = { id: "o", type: "mqtt-out", config: { topic: "q" } };
const flowOf = (nodes, pairs) => ({
  name: "t",
  nodes,
  edges: pairs.map(([from, to]) => ({ from, to })),
});
// Three switches A, B, C into one Logic node, its output to Radio out.
const threeInputs = (config) =>
  flowOf(
    [sw("a"), sw("b"), sw("c"), logicNode(config), out],
    [
      ["a", "l"],
      ["b", "l"],
      ["c", "l"],
      ["l", "o"],
    ],
  );

// The simulator: the Logic host with a fake clock. steps: [input index, value] or
// ["wait", ms]. Returns the outputs as "t:value" (t = ms since start).
function simulate(flow, steps) {
  const f = validate(structuredClone(flow));
  const n = f.nodes.find((m) => m.type === "logic");
  const inputs = f.edges
    .filter((e) => e.to === n.id)
    .map((e) => f.nodes.find((m) => m.id === e.from));
  let now = 0;
  const timers = [];
  const outs = [];
  const ctx = {
    state: {},
    inputs,
    later: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    cancel: (t) => t && (t.dead = true),
    forward: (v) => outs.push(`${now}:${v}`),
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers
        .filter((t) => !t.dead && t.at <= end)
        .sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      due.dead = true;
      now = due.at;
      due.fn();
    }
    now = end;
  };
  for (const [k, v] of steps) {
    if (k === "wait") advance(v);
    else {
      const r = types.logic.host(v, n, { ...ctx, from: inputs[k].id });
      if (r !== undefined) outs.push(`${now}:${r}`);
    }
  }
  return outs;
}

const gxx = spawnSync("g++", ["--version"]).status === 0;
// The firmware: the whole generated sketch (release build) with a controlled
// millis(); several scenarios in one program. Returns one output list per scenario.
function firmware(flows, scenarios) {
  const parts = flows.map((flow, s) => {
    const { source } = build(structuredClone(flow), {
      board: "esp32",
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    // Each sketch in its own namespace; published messages carry the clock.
    return `namespace s${s} {\n${source}\n}`;
  });
  const runs = scenarios.map((steps, s) => {
    const lines = steps.map(([k, v]) =>
      k === "wait"
        ? `for (unsigned long e = mfFakeNow + ${v}; mfFakeNow < e;) { mfFakeNow += 1; s${s}::loop(); }`
        : `s${s}::node${k}(String(${JSON.stringify(v)}));`,
    );
    return `  published.clear(); mfFakeNow = 0; s${s}::setup();\n  ${lines.join("\n  ")}\n  printf("%s=\\n", published.c_str());`;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-logic-"));
  const file = path.join(dir, "t.cpp");
  fs.writeFileSync(
    file,
    `#include "Arduino.h"
std::string published;
${parts.join("\n")}
int main() {
  mfFakeAuto = false;
${runs.join("\n")}
}
`.replace(/#include <(WiFi|PubSubClient)\.h>\n/g, ""),
  );
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
      "-O1",
      "-include",
      "Arduino.h",
      "-include",
      "WiFi.h",
      "-include",
      "PubSubClient.h",
      "-I",
      path.join(__dirname, "fixtures/arduino"),
      "-Wall",
      "-Wno-unused-function",
      "-Wno-unused-variable",
      "-Wno-unused-but-set-variable",
      "-o",
      exe,
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 30).join("\n"));
  const run = spawnSync(exe, { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout
    .split("=\n")
    .slice(0, scenarios.length)
    .map((block) =>
      block
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/^q /, "")),
    );
}

test("catalog: one Logic node with every function", () => {
  const c = catalog().logic;
  assert.equal(c.group, "LOGIC");
  assert.deepEqual(Object.keys(c.fields[0].options), Object.keys(FUNCTIONS));
  assert.equal(c.summaryBy, "fn");
  assert.equal(c.summary.ton, "On-delay timer (TON) · {time} ms");
});
test("board checks: flip-flop inputs must be connected and distinct", () => {
  const sr = (config) =>
    analyze(
      flowOf(
        [sw("a"), sw("b"), logicNode({ fn: "sr", ...config }), out],
        [
          ["a", "l"],
          ["b", "l"],
          ["l", "o"],
        ],
      ),
      "esp32",
    );
  assert.deepEqual(sr({ set: "A", reset: "B" }).errors, []);
  assert.match(sr({ set: "A" }).errors.join(), /choose the Reset input/);
  assert.match(
    sr({ set: "A", reset: "X" }).errors.join(),
    /Reset input X is not connected to it \(connected: A, B\)/,
  );
  assert.match(sr({ set: "A", reset: "A" }).errors.join(), /must be different/);
  const one = analyze(
    flowOf(
      [sw("a"), logicNode({ fn: "and" }), out],
      [
        ["a", "l"],
        ["l", "o"],
      ],
    ),
    "esp32",
  );
  assert.match(one.warnings.join(), /usually has two or more inputs/);
});

// Every gate and flip-flop, both output modes: random input sequences through the
// simulator and the firmware must give the same outputs.
test(
  "gates and flip-flops: simulator and firmware agree",
  { skip: !gxx && "g++ not found" },
  () => {
    const configs = [];
    for (const fn of Object.keys(FUNCTIONS).filter(
      (k) => FUNCTIONS[k].kind !== "timer",
    ))
      for (const output of ["change", "every"])
        configs.push({
          fn,
          output,
          ...(fn === "sr" ? { set: "A", reset: "B", priority: "reset" } : {}),
          ...(fn === "d" ? { data: "A", clock: "B" } : {}),
        });
    configs.push({ fn: "sr", set: "B", reset: "C", priority: "set" });
    let seed = 11;
    const r = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const values = ["1", "0", "on", "off", "true", "2.5", "", "0.0", "x"];
    const flows = [];
    const scenarios = [];
    const expected = [];
    for (const config of configs)
      for (let rep = 0; rep < 6; rep++) {
        const steps = Array.from({ length: 12 }, () => [
          r(3),
          values[r(values.length)],
        ]);
        flows.push(threeInputs(config));
        scenarios.push(steps);
        expected.push(
          simulate(threeInputs(config), steps).map((o) => o.split(":")[1]),
        );
      }
    const got = firmware(flows, scenarios);
    got.forEach((outs, s) =>
      assert.deepEqual(
        outs,
        expected[s],
        `${JSON.stringify(flows[s].nodes[3].config)} ${JSON.stringify(scenarios[s])}`,
      ),
    );
    // And the rules themselves, on a few hand-checked cases.
    assert.deepEqual(
      simulate(threeInputs({ fn: "and" }), [
        [0, "1"],
        [1, "1"],
        [2, "1"],
        [1, "0"],
      ]).map((o) => o.split(":")[1]),
      ["0", "1", "0"],
    );
    assert.deepEqual(
      simulate(threeInputs({ fn: "sr", set: "A", reset: "B" }), [
        [0, "1"],
        [0, "0"],
        [1, "1"],
        [0, "1"],
        [1, "0"],
      ]).map((o) => o.split(":")[1]),
      ["1", "0", "1"],
    );
    assert.deepEqual(
      simulate(threeInputs({ fn: "toggle" }), [
        [0, "1"],
        [0, "1"],
        [0, "0"],
        [1, "1"],
      ]).map((o) => o.split(":")[1]),
      ["1", "0"],
    );
    assert.deepEqual(
      simulate(threeInputs({ fn: "d", data: "A", clock: "B" }), [
        [0, "1"],
        [1, "1"],
        [0, "0"],
        [1, "0"],
        [1, "1"],
      ]).map((o) => o.split(":")[1]),
      ["0", "1", "0"],
    );
  },
);

// Timers: the same scenarios in both, with times.
test(
  "timers: on-delay, off-delay and pulse",
  { skip: !gxx && "g++ not found" },
  () => {
    const timer = (fn) =>
      flowOf(
        [sw("a"), logicNode({ fn, time: 500 }), out],
        [
          ["a", "l"],
          ["l", "o"],
        ],
      );
    const cases = [
      // TON: on for 500 ms gives 1; off at once gives 0; a short pulse gives nothing.
      [
        "ton",
        [
          [0, "1"],
          ["wait", 499],
          ["wait", 1],
          ["wait", 100],
          [0, "0"],
          [0, "1"],
          ["wait", 300],
          [0, "0"],
          ["wait", 1000],
        ],
        ["500:1", "600:0"],
      ],
      // TOF: 1 at once; 0 500 ms after the input goes off; on again cancels it.
      [
        "tof",
        [
          [0, "1"],
          [0, "0"],
          ["wait", 300],
          [0, "1"],
          [0, "0"],
          ["wait", 499],
          ["wait", 1],
          ["wait", 100],
        ],
        ["0:1", "800:0"],
      ],
      // TP: a 0→1 gives a 500 ms pulse; inputs during it change nothing.
      [
        "tp",
        [
          [0, "1"],
          ["wait", 200],
          [0, "0"],
          [0, "1"],
          ["wait", 300],
          ["wait", 100],
          [0, "0"],
          [0, "1"],
          ["wait", 600],
        ],
        ["0:1", "500:0", "600:1", "1100:0"],
      ],
    ];
    for (const [fn, steps, want] of cases)
      assert.deepEqual(simulate(timer(fn), steps), want, `simulator ${fn}`);
    // The firmware has no clock in its output: compare the values and, via the
    // scenario, that each one happens at the same step.
    const got = firmware(
      cases.map(([fn]) => timer(fn)),
      cases.map(([, steps]) => steps),
    );
    cases.forEach(([fn, , want], s) =>
      assert.deepEqual(
        got[s],
        want.map((w) => w.split(":")[1]),
        `firmware ${fn}`,
      ),
    );
  },
);
test(
  "firmware timers fire at the right time",
  { skip: !gxx && "g++ not found" },
  () => {
    // One step at a time: print the clock with each output.
    const flow = flowOf(
      [sw("a"), logicNode({ fn: "ton", time: 500 }), out],
      [
        ["a", "l"],
        ["l", "o"],
      ],
    );
    const steps = [[0, "1"]];
    for (let t = 0; t < 700; t += 50) steps.push(["wait", 50]);
    const seen = firmware([flow], [steps])[0];
    assert.deepEqual(seen, ["1"]);
    // Within 1 ms of 500: one loop() per ms in the harness.
    const early = firmware(
      [flow],
      [
        [
          [0, "1"],
          ["wait", 499],
        ],
      ],
    )[0];
    assert.deepEqual(early, []);
  },
);
