// Peripheral node (lib/peripheral.js): parameters from inputs or defaults (kept in
// a C union), an operation per rising edge of the Trigger input. Board checks, the
// simulator, and the firmware run with the host g++ and the stand-in headers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, analyze, build } = require("../lib/flow");
const { types, catalog, autoName } = require("../lib/nodes");

// Three manual injects (parameters and trigger, in this order = slots 0, 1, 2) into
// a Peripheral, its output to Radio out ("q <value>").
const flowOf = (config, names = ["P1", "P2", "GO"], extra = {}) => ({
  name: "t",
  nodes: [
    ...names.map((name, k) => ({
      id: "i" + k,
      type: "inject",
      name,
      config: { payload: "1", interval: 0 },
    })),
    { id: "p", type: "peripheral", label: "Periph", config, ...extra },
    { id: "o", type: "mqtt-out", config: { topic: "q" } },
  ],
  edges: [
    ...names.map((_, k) => ({ from: "i" + k, to: "p" })),
    { from: "p", to: "o" },
  ],
});
const servo = (c = {}) => ({ kind: "servo", trigger: "GO", ...c });
const errors = (flow) => analyze(flow, "esp32").errors.join(" ");

test("catalog: Peripheral in HARDWARE with a kind, a trigger and parameters", () => {
  const c = catalog().peripheral;
  assert.equal(c.group, "HARDWARE");
  assert.deepEqual(Object.keys(c.fields[0].options), [
    "servo",
    "stepper",
    "gyro",
  ]);
  const keys = c.fields.map((f) => f.key);
  for (const k of [
    "trigger",
    "angleFrom",
    "angle",
    "speedFrom",
    "speed",
    "turnFrom",
    "turn",
    "rpmFrom",
    "rpm",
    "samplesFrom",
    "samples",
    "pin",
    "sda",
  ])
    assert.ok(keys.includes(k), k);
  assert.equal(
    c.fields.find((f) => f.key === "angleFrom").inputChoice,
    "optional",
  );
  assert.equal(
    c.fields.find((f) => f.key === "trigger").inputChoice,
    "required",
  );
  assert.equal(c.fields.find((f) => f.key === "angle").default, 90);
  assert.equal(
    autoName({ type: "peripheral", config: { kind: "stepper" } }, new Set()),
    "STEPPER1",
  );
});

test("board checks: trigger chosen, connected and on / off; parameter inputs connected", () => {
  assert.equal(errors(flowOf(servo({ angleFrom: "P1", speedFrom: "P2" }))), "");
  assert.match(
    errors(flowOf(servo({ trigger: "" }))),
    /choose the Trigger input/,
  );
  assert.match(
    errors(flowOf(servo({ trigger: "X" }))),
    /Trigger input X is not connected to it \(connected: P1, P2, GO\)/,
  );
  assert.match(
    errors(flowOf(servo({ angleFrom: "NOPE" }))),
    /Angle comes from NOPE, which is not connected/,
  );
  // An analog trigger needs a Threshold first; analog parameters are fine.
  const analogTrigger = flowOf(servo({ trigger: "ADC" }), ["P1", "P2"]);
  analogTrigger.nodes.push({
    id: "a",
    type: "analog-in",
    name: "ADC",
    config: { pin: 34 },
  });
  analogTrigger.edges.push({ from: "a", to: "p" });
  assert.match(
    errors(analogTrigger),
    /Trigger input ADC sends an analog value/,
  );
  const analogAngle = flowOf(servo({ angleFrom: "ADC" }), ["P1", "P2", "GO"]);
  analogAngle.nodes.push({
    id: "a",
    type: "analog-in",
    name: "ADC",
    config: { pin: 34 },
  });
  analogAngle.edges.push({ from: "a", to: "p" });
  assert.equal(errors(analogAngle), "");
  // Pins are checked like the devices'.
  assert.match(errors(flowOf(servo({ pin: 34 }))), /GPIO 34 is input-only/);
  // The C union of parameters, one struct per kind.
  const { source } = build(flowOf(servo()), {
    board: "esp32",
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  });
  assert.match(
    source,
    /union MfPeripheralParams \{ MfServoParams servo; MfStepperParams stepper; MfGyroParams gyro; \};/,
  );
  assert.match(
    source,
    /mfPeriph3\.kind = MF_SERVO; mfPeriph3\.p\.servo\.angle = 90\.0f; mfPeriph3\.p\.servo\.speed = 60\.0f;/,
  );
});

// ── Simulator ──
test("simulator: parameters from inputs, operation on the rising edge", () => {
  const run = (config, steps) => {
    const f = validate(flowOf(config));
    const n = f.nodes.find((m) => m.type === "peripheral");
    const inputs = f.nodes.filter((m) => m.type === "inject");
    let now = 0;
    const later = [];
    const out = [];
    const ctx = {
      state: {},
      inputs,
      later: (ms, fn) => (later.push({ at: now + ms, fn }), later.length),
      cancel: () => {},
      forward: (v) => out.push(`${v}@${now}`),
      log: () => {},
    };
    for (const [k, v] of steps) {
      if (k === "wait") {
        now += v;
        for (const t of later.filter((t) => !t.done && t.at <= now))
          ((t.done = true), t.fn());
        continue;
      }
      const r = types.peripheral.host(v, n, { ...ctx, from: inputs[k].id });
      if (r !== undefined) out.push(`${r}@${now}`);
    }
    return out;
  };
  // Servo: angle from P1, speed from P2, trigger GO.
  const s = servo({ angleFrom: "P1", speedFrom: "P2" });
  assert.deepEqual(
    run(s, [
      [0, "120"],
      [2, "1"],
      ["wait", 2000],
    ]),
    ["120.0@2000"],
  ); // 30° at 60°/s: 500 ms
  assert.deepEqual(
    run(s, [
      [0, "45"],
      [1, "0"],
      [2, "1"],
    ]),
    ["45.0@0"],
  ); // speed 0: at once
  assert.deepEqual(
    run(s, [
      [0, "45"],
      [1, "0"],
    ]),
    [],
  ); // no trigger: nothing
  assert.deepEqual(
    run(s, [
      [1, "0"],
      [2, "1"],
      [2, "1"],
      [2, "0"],
      [2, "1"],
    ]),
    ["90.0@0", "90.0@0"],
  ); // edges only
  // Stepper: turn 90° at 30 RPM (200 steps per turn).
  assert.deepEqual(
    run({ kind: "stepper", trigger: "GO", accel: 0 }, [
      [2, "1"],
      ["wait", 2000],
    ]),
    ["90.0@2000"],
  );
  // Gyroscope: a reading per trigger.
  assert.match(
    run({ kind: "gyro", trigger: "GO" }, [[2, "1"]])[0],
    /^\{"ax":.*"roll":-?[\d.]+\}@0$/,
  );
});

// ── Firmware ──
const gxx = spawnSync("g++", ["--version"]).status === 0;
function firmware(scenarios, board = "esp32") {
  const parts = scenarios.map(([flow], s) => {
    const { source } = build(structuredClone(flow), {
      board,
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    return `namespace s${s} {\n${source.replace(/^#include .*$/gm, "")}\n}`;
  });
  // The flow calls node3 (the Peripheral) with mfSlot3 = the input's position.
  const runs = scenarios.map(
    ([, script], s) =>
      `  { namespace S = s${s}; published.clear(); mfFakeNow = 0; mfFakeMicros = 0; S::setup();\n${script}\n  printf("%s=\\n", published.c_str()); }`,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-periph-"));
  const file = path.join(dir, "t.cpp");
  fs.writeFileSync(
    file,
    `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "Wire.h"
#include "Servo.h"
void note(const char* fmt, ...) { char b[200]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a); published += b; }
long steps = 0;
void watch(uint8_t p, uint8_t v) { if (p == 13 && v) steps++; }
template <class F> void runFor(F loop, unsigned long ms) {
  for (unsigned long end = mfFakeMicros + ms * 1000; mfFakeMicros < end;) { mfFakeMicros += 20; mfFakeNow = mfFakeMicros / 1000; loop(); }
}
${parts.join("\n")}
int main() {
  mfFakeAuto = false;
  mfOnWrite = watch;
${runs.join("\n")}
}
`,
  );
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
      "-O1",
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
  assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 40).join("\n"));
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
// Sends a value from input k: the flow's own call (node<k>) sets the slot.
const send = (k, v) => `S::node${k}(String("${v}"));`;

test(
  "firmware: servo, stepper and gyroscope as the simulator",
  { skip: !gxx && "g++ not found" },
  () => {
    const s = servo({ angleFrom: "P1", speedFrom: "P2" });
    const got = firmware([
      // 30° at 60°/s: about 500 ms.
      [
        flowOf(s),
        `${send(0, "120")} ${send(2, "1")} runFor(S::loop, 450); note("-\\n"); runFor(S::loop, 200); note("duty %u\\n", mfLedc[0]);`,
      ],
      // Speed 0 from P2: at once. No trigger: nothing.
      [
        flowOf(s),
        `${send(0, "45")} ${send(1, "0")} runFor(S::loop, 50); note("-\\n"); ${send(2, "1")}`,
      ],
      // Rising edges only: 1, 1 (no), 0, 1 (yes).
      [
        flowOf(s),
        `${send(1, "0")} ${send(2, "1")} ${send(2, "1")} ${send(2, "0")} ${send(2, "on")}`,
      ],
      // Stepper: 90° (50 steps of 200) at the default 30 RPM (100 steps/s), no ramps.
      [
        flowOf({ kind: "stepper", trigger: "GO", accel: 0 }),
        `steps = 0; ${send(2, "1")} runFor(S::loop, 450); note("-\\n"); runFor(S::loop, 100); note("steps %ld\\n", steps);`,
      ],
      // Stepper: turn and speed from inputs (-180° at 120 RPM: 100 steps at 400/s).
      [
        flowOf({
          kind: "stepper",
          trigger: "GO",
          accel: 0,
          turnFrom: "P1",
          rpmFrom: "P2",
        }),
        `steps = 0; ${send(0, "-180")} ${send(1, "120")} ${send(2, "1")} runFor(S::loop, 240); note("-\\n"); runFor(S::loop, 40); note("steps %ld\\n", steps);`,
      ],
      // Gyroscope: one reading per trigger (flat, 1 g on Z).
      [
        flowOf({
          kind: "gyro",
          trigger: "GO",
          gyroOut: "az",
          calibrate: "no",
          samplesFrom: "P1",
        }),
        `Wire.regs[0x3F] = 0x40; Wire.regs[0x40] = 0; ${send(0, "4")} runFor(S::loop, 100); note("-\\n"); ${send(2, "1")}`,
      ],
    ]);
    assert.deepEqual(got[0], ["-", "120.0", "duty 1447"]); // 500 + 1900 * 120 / 180 = 1766.7 µs, × 0.8192
    assert.deepEqual(got[1], ["-", "45.0"]);
    assert.deepEqual(got[2], ["90.0", "90.0"]);
    assert.deepEqual(got[3], ["-", "90.0", "steps 50"]);
    assert.deepEqual(got[4], ["-", "-180.0", "steps 100"]);
    assert.deepEqual(got[5], ["-", "1.00"]);
  },
);
