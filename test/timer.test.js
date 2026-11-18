// Timer node (lib/timer.js): rising-edge trigger with a minimum pulse width, T1
// delay, T2 active time, triggers ignored while running. The simulator and the
// generated firmware (host g++, stand-in headers) must give the same outputs at
// the same times.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, build } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");

// With config.reset: a second switch RST (node 3) wired to the timer's Reset.
const flowOf = (config) => ({
  name: "t",
  nodes: [
    { id: "sw", type: "test-switch", name: "SET", config: {} },
    { id: "tm", type: "timer", label: "Timer", config },
    { id: "o", type: "mqtt-out", config: { topic: "q" } },
    ...(config.reset
      ? [{ id: "rs", type: "test-switch", name: "RST", config: {} }]
      : []),
  ],
  edges: [
    { from: "sw", to: "tm" },
    { from: "tm", to: "o" },
    ...(config.reset ? [{ from: "rs", to: "tm" }] : []),
  ],
});
// A step for the Reset input: { r: "1" }.
const isReset = (s) => s && typeof s === "object" && !Array.isArray(s);
// steps: a value for the input, or ["wait", ms]. Outputs as "value@ms".
function simulate(config, steps) {
  const all = validate(flowOf(config)).nodes;
  const n = all[1];
  const inputs = [all[0], ...(config.reset ? [all[3]] : [])];
  let now = 0;
  const timers = [];
  const outs = [];
  const shown = [];
  const ctx = {
    state: {},
    later: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    cancel: (t) => t && (t.dead = true),
    forward: (v) => outs.push(`${v}@${now}`),
    indicate: (state) => shown.push(`${state}@${now}`),
    inputs,
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
      assert.equal(types.timer.host(isReset(s) ? s.r : s, n, ctx), undefined);
    }
  return { outs, shown };
}
const gxx = spawnSync("g++", ["--version"]).status === 0;
// The whole sketch per scenario; one loop() per millisecond.
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
    const lines = steps.map((x) =>
      Array.isArray(x)
        ? `for (unsigned long e = mfFakeNow + ${x[1]}; mfFakeNow < e;) { mfFakeNow += 1; size_t had = published.size(); s${s}::loop(); if (published.size() != had) published.insert(published.size() - 1, "@" + std::to_string(mfFakeNow)); }`
        : isReset(x)
          ? `s${s}::node3(String(${JSON.stringify(x.r)}));`
          : `s${s}::node0(String(${JSON.stringify(x)}));`,
    );
    return `  published.clear(); mfFakeNow = 0; s${s}::setup();\n  ${lines.join("\n  ")}\n  printf("%s=\\n", published.c_str());`;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-timer-"));
  const file = path.join(dir, "t.cpp");
  fs.writeFileSync(
    file,
    `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include <math.h>
${parts.join("\n")}
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
    .map((b) =>
      b
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^q /, "")),
    );
}

// [config, steps, expected outputs]
const cases = [
  // Defaults: T1 0 s, T2 1 s, width 1 ms.
  [{}, ["1", ["wait", 1500]], ["1@1", "0@1001"]],
  // Triggers do not add up: a new edge while it runs is ignored, not queued.
  [
    {},
    [
      "1",
      ["wait", 100],
      "0",
      ["wait", 100],
      "1",
      ["wait", 1300],
      "0",
      "1",
      ["wait", 1200],
    ],
    ["1@1", "0@1001", "1@1501", "0@2501"],
  ],
  // Input still on after T2: no new start without a new rising edge.
  [
    { t2: 0.2 },
    ["1", ["wait", 1000], "1", "on", ["wait", 500]],
    ["1@1", "0@201"],
  ],
  // Pulse width 50 ms: a 30 ms blip is ignored; a long press starts it after 50 ms.
  [
    { width: 50 },
    ["1", ["wait", 30], "0", ["wait", 70], "1", ["wait", 1200]],
    ["1@150", "0@1150"],
  ],
  // T1 0.5 s before activation, then 0.2 s on.
  [{ t1: 0.5, t2: 0.2 }, ["true", ["wait", 1000]], ["1@501", "0@701"]],
  // Width 0: starts on the edge itself.
  [{ width: 0, t2: 0.01 }, ["1", ["wait", 50]], ["1@0", "0@10"]],
  // Reset during T2 (held for the 1 ms pulse width): output off at once.
  [
    { reset: "RST" },
    ["1", ["wait", 300], { r: "1" }, ["wait", 1000]],
    ["1@1", "0@301"],
  ],
  // Reset during T1: nothing is sent, the timer is idle again.
  [
    { reset: "RST", t1: 0.5, t2: 0.2 },
    ["1", ["wait", 100], { r: "1" }, ["wait", 1000]],
    [],
  ],
  // Reset shorter than the pulse width (50 ms) is ignored; Set while Reset is on too.
  [
    { reset: "RST", width: 50 },
    [
      "1",
      ["wait", 200],
      { r: "1" },
      ["wait", 20],
      { r: "0" },
      ["wait", 1000],
      "0",
      { r: "1" },
      ["wait", 100],
      "1",
      ["wait", 1500],
    ],
    ["1@50", "0@1050"],
  ],
  // Falling edges (buttons to GND with pull-ups: idle 1, pressed 0).
  [
    { reset: "RST", setEdge: "falling", resetEdge: "falling", t2: 0.5 },
    ["1", { r: "1" }, ["wait", 50], "0", ["wait", 100], { r: "0" }, ["wait", 600]],
    ["1@51", "0@151"],
  ],
  // Set and Reset chosen by name: the timer runs again after a reset.
  [
    { set: "SET", reset: "RST", t2: 0.5 },
    ["1", ["wait", 100], { r: "1" }, ["wait", 10], { r: "0" }, "0", "1", ["wait", 1000]],
    ["1@1", "0@101", "1@111", "0@611"],
  ],
];

test("catalog: Timer in LOGIC with T1, T2 and pulse width", () => {
  const c = catalog().timer;
  assert.equal(c.group, "LOGIC");
  assert.deepEqual(
    c.fields.map((f) => [f.key, f.default]),
    [
      ["t1", 0],
      ["t2", 1],
      ["set", ""],
      ["setEdge", "rising"],
      ["reset", ""],
      ["resetEdge", "rising"],
      ["width", 1],
    ],
  );
  assert.equal(c.varType, "bool");
  assert.match(
    (() => {
      try {
        validate({
          nodes: [{ id: "t", type: "timer", config: { t2: 0 } }],
          edges: [],
        });
      } catch (e) {
        return e.message;
      }
    })(),
    /T2 .* must be between 0.001/,
  );
});

test("simulator: edges, T1, T2, ignored triggers and indicators", () => {
  for (const [config, steps, want] of cases)
    assert.deepEqual(
      simulate(config, steps).outs,
      want,
      JSON.stringify(config),
    );
  const { shown } = simulate({ t1: 0.5 }, [
    "1",
    ["wait", 100],
    "0",
    "1",
    ["wait", 2000],
  ]);
  assert.deepEqual(shown, ["triggered@1", "ignored@100", "on@501", "off@1501"]);
  assert.deepEqual(simulate({ width: 50 }, ["1", ["wait", 20], "0"]).shown, [
    "short@20",
  ]);
});

test(
  "firmware: same outputs at the same times as the simulator",
  { skip: !gxx && "g++ not found" },
  () => {
    const got = firmware(cases.map(([c, s]) => [c, s]));
    cases.forEach(([config, , want], k) =>
      assert.deepEqual(
        got[k],
        // Width 0: the board starts on its next loop() (here one per ms).
        config.width === 0 ? ["1@1", "0@11"] : want,
        JSON.stringify(config),
      ),
    );
  },
);
