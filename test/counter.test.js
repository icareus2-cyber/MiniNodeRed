// Counter node (lib/counter.js): Count / Reset inputs, three outputs that each
// pulse (1, then 0 after the pulse width) when the count reaches their preset.
// The simulator and the generated firmware (host g++, stand-in headers) must give
// the same outputs at the same times, each on its own output.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, analyze, build } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");

const DEF = { preset1: 2, preset2: 3, preset3: 5, width: 100 };
// Switch CNT (node 0) → Counter (node 1) → Radio out q1, q2, q3 (outputs 1, 2, 3);
// switch RST (node 5) → Counter's Reset.
const flowOf = (config) => ({
  name: "c",
  nodes: [
    { id: "sw", type: "test-switch", name: "CNT", config: {} },
    { id: "ct", type: "counter", label: "Counter", config: { reset: "RST", ...DEF, ...config } },
    { id: "o1", type: "mqtt-out", config: { topic: "q1" } },
    { id: "o2", type: "mqtt-out", config: { topic: "q2" } },
    { id: "o3", type: "mqtt-out", config: { topic: "q3" } },
    { id: "rs", type: "test-switch", name: "RST", config: {} },
  ],
  edges: [
    { from: "sw", to: "ct" },
    { from: "ct", to: "o1" },
    { from: "ct", to: "o2", port: 1 },
    { from: "ct", to: "o3", port: 2 },
    { from: "rs", to: "ct" },
  ],
});
const isReset = (s) => s && typeof s === "object" && !Array.isArray(s);
// steps: a value for Count, { r: value } for Reset, or ["wait", ms].
// Outputs as "q<output> value@ms".
function simulate(config, steps) {
  const all = validate(flowOf(config)).nodes;
  const n = all[1];
  let now = 0;
  const timers = [];
  const outs = [];
  const ctx = {
    state: {},
    later: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    cancel: (t) => t && (t.dead = true),
    forward: (v, port = 0) => outs.push(`q${port + 1} ${v}@${now}`),
    indicate: () => {},
    inputs: [all[0], all[5]],
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers
        .filter((t) => !t.dead && t.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      now = due.at;
      due.fn();
    }
    now = end;
  };
  for (const s of steps)
    if (Array.isArray(s)) advance(s[1]);
    else {
      ctx.from = isReset(s) ? "rs" : "sw";
      assert.equal(types.counter.host(isReset(s) ? s.r : s, n, ctx), undefined);
    }
  return outs;
}
const gxx = spawnSync("g++", ["--version"]).status === 0;
function firmware(scenarios) {
  const parts = scenarios.map(([config], s) => {
    const { source } = build(flowOf(config), {
      board: "esp32",
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    return `namespace s${s} {\n${source.replace(/^#include .*$/gm, "")}\n}`;
  });
  const runs = scenarios.map(([, steps], s) => {
    // Firmware sends at the loop() of that millisecond: compare with the simulator
    // by stepping 1 ms at a time and stamping each new publish.
    const stamp = `stampNew(had);`;
    const lines = steps.map((x) =>
      Array.isArray(x)
        ? `for (unsigned long e = mfFakeNow + ${x[1]}; mfFakeNow < e;) { mfFakeNow += 1; size_t had = published.size(); s${s}::loop(); ${stamp} }`
        : `{ size_t had = published.size(); s${s}::node${isReset(x) ? 5 : 0}(String(${JSON.stringify(isReset(x) ? x.r : x)})); ${stamp.replace(/\n/g, "")} }`,
    );
    return `  published.clear(); mfFakeNow = 0; s${s}::setup();\n  ${lines.join("\n  ")}\n  printf("%s=\\n", published.c_str());`;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-counter-"));
  const file = path.join(dir, "t.cpp");
  fs.writeFileSync(
    file,
    `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include <math.h>
${parts.join("\n")}
// Adds "@<ms>" to each line published since position had.
void stampNew(size_t had) {
  std::string at = "@" + std::to_string(mfFakeNow);
  for (size_t p = published.find('\\n', had); p != std::string::npos; p = published.find('\\n', p + at.size() + 1))
    published.insert(p, at);
}
int main() {
  mfFakeAuto = false;
${runs.join("\n")}
}
`,
  );
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
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
  const run = spawnSync(exe, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout
    .split("=\n")
    .slice(0, scenarios.length)
    .map((b) => b.split("\n").filter(Boolean));
}
// Presses: on, then off 10 ms later; then 10 ms of quiet.
const press = (n) => Array.from({ length: n }, () => ["1", ["wait", 10], "0", ["wait", 10]]).flat();

const cases = [
  // Rising edges count; output 1 at 2, output 2 at 3, output 3 at 5; 100 ms pulses.
  [
    {},
    [...press(5), ["wait", 200]],
    ["q1 1@20", "q2 1@40", "q1 0@120", "q2 0@140", "q3 1@80", "q3 0@180"],
  ],
  // Reset sets the count to 0: two more presses are needed for output 1 again.
  [
    {},
    [...press(1), { r: "1" }, { r: "0" }, ...press(2), ["wait", 200]],
    ["q1 1@40", "q1 0@140"],
  ],
  // While Reset is on, Count is ignored.
  [{}, [{ r: "1" }, ...press(3), ["wait", 200]], []],
  // Every message counts; after the highest preset it starts again at 0.
  [
    { countOn: "any", preset1: 1, preset2: 2, preset3: 2, after: "restart", width: 5 },
    ["x", ["wait", 10], "y", ["wait", 10], "z", ["wait", 10]],
    ["q1 1@0", "q1 0@5", "q2 1@10", "q3 1@10", "q2 0@15", "q3 0@15", "q1 1@20", "q1 0@25"],
  ],
  // Falling edge.
  [{ countOn: "falling", preset1: 1 }, ["1", ["wait", 10], "0", ["wait", 150]], ["q1 1@10", "q1 0@110"]],
];
const sorted = (a) => [...a].sort((x, y) => Number(x.split("@")[1]) - Number(y.split("@")[1]) || x.localeCompare(y));

test("Counter is in the LOGIC group with three outputs", () => {
  const c = catalog().counter;
  assert.equal(c.group, "LOGIC");
  assert.deepEqual(c.outputs, ["Output 1", "Output 2", "Output 3"]);
  assert.equal(c.varName, "COUNT");
});
test("Counter simulator: pulses per output", () => {
  for (const [config, steps, want] of cases)
    assert.deepEqual(sorted(simulate(config, steps)), sorted(want), JSON.stringify(config));
});
test("Counter firmware matches the simulator", { skip: !gxx && "g++ not found" }, () => {
  const got = firmware(cases);
  cases.forEach(([config, steps], k) =>
    assert.deepEqual(sorted(got[k]), sorted(simulate(config, steps)), JSON.stringify(config)),
  );
});
test("connections from an output that does not exist are refused", () => {
  const f = flowOf({});
  f.edges.push({ from: "sw", to: "o2", port: 1 }); // a switch has one output
  assert.throws(() => validate(f), /output that does not exist/);
  const g = flowOf({});
  g.edges[3].port = 3;
  assert.throws(() => validate(g), /output that does not exist/);
  // The same two boxes may be wired from two different outputs.
  const h = flowOf({});
  h.edges.push({ from: "ct", to: "o1", port: 2 });
  assert.doesNotThrow(() => validate(h));
  h.edges.push({ from: "ct", to: "o1", port: 2 });
  assert.throws(() => validate(h), /Duplicate/);
});
test("Count / Reset must be connected inputs", () => {
  const f = flowOf({ count: "NOPE" });
  const { errors } = analyze(f, "esp32");
  assert.ok(errors.some((e) => /Count input NOPE is not connected/.test(e)), errors.join("\n"));
});
test("PC simulation sends each pulse out of its own output", async () => {
  let FlowRuntime;
  try {
    ({ FlowRuntime } = require("../lib/runtime"));
  } catch {
    return; // mqtt / aedes not installed
  }
  const seen = [];
  const runtime = new FlowRuntime(
    (kind, message, extra) => kind === "debug" && seen.push(`${message}:${extra?.payload}`),
    {},
  );
  const flow = {
    name: "c",
    nodes: [
      { id: "i", type: "inject", name: "IN", config: { payload: "1", interval: 0 } },
      { id: "ct", type: "counter", config: { countOn: "any", preset1: 1, preset2: 2, preset3: 3, width: 20 } },
      { id: "d1", type: "debug", label: "D1", config: {} },
      { id: "d3", type: "debug", label: "D3", config: {} },
    ],
    edges: [
      { from: "i", to: "ct" },
      { from: "ct", to: "d1" },
      { from: "ct", to: "d3", port: 2 },
    ],
  };
  runtime.start({ flow: validate(flow), offline: true, deviceId: "pc" });
  try {
    for (let k = 0; k < 3; k++) runtime.run("i", "1");
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    runtime.stop();
  }
  assert.deepEqual(seen, ["D1:1", "D3:1", "D1:0", "D3:0"]);
});
