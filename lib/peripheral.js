// Peripheral node: one box for a common Arduino peripheral (servo, stepper motor,
// MPU-6050 gyroscope) that does one operation each time it is triggered.
//
//  • Parameters (e.g. a servo's angle and speed) each have a default value, or come
//    from a connected input chosen by its variable name, so an analog input (through
//    Map range, say) can set them. The latest value received is kept.
//  • The Trigger input starts the operation on its rising edge (off → on, as in the
//    Logic node); its value is not a parameter.
//  • In the firmware the parameters live in a C union: one struct per kind of
//    peripheral, of which a node uses the one for its kind (MfPeripheral below).
//  • The output: servo, the angle once reached; stepper, its position (°) once the
//    turn is done; gyroscope, the reading.
//
// The drivers are the Input / Output device ones (lib/devices.js), so pins, the I2C
// bus, servo channels and checks work the same.
const devices = require("./devices");
const { on } = require("./logic");
const { fl } = devices;

const KINDS = {
  servo: "Servo motor",
  stepper: "Stepper motor",
  gyro: "Gyroscope / accelerometer (MPU-6050)",
};
// The parameters of each kind: union member, C field, label, default, range.
const PARAMS = {
  servo: [
    { key: "angle", label: "Angle (°)", def: 90, min: 0, max: 360 },
    {
      key: "speed",
      label: "Speed (°/s, 0 = full speed)",
      def: 60,
      min: 0,
      max: 2000,
    },
  ],
  stepper: [
    { key: "turn", label: "Turn by (°, + / −)", def: 90, min: -1e6, max: 1e6 },
    { key: "rpm", label: "Speed (RPM)", def: 30, min: 0.1, max: 3000 },
  ],
  gyro: [
    { key: "samples", label: "Readings to average", def: 1, min: 1, max: 50 },
  ],
};
// Device fields reused, with `device` conditions turned into `kind` ones.
const toKind = (w) =>
  !w
    ? w
    : Array.isArray(w)
      ? w.map(toKind)
      : Object.fromEntries(
          Object.entries(w).map(([k, v]) => [k === "device" ? "kind" : k, v]),
        );
const reuse = (list, keys) =>
  keys.map((key) => {
    const f = list.find((x) => x.key === key);
    return {
      ...f,
      when: toKind(f.when),
      ...(f.labelBy ? { labelBy: { ...f.labelBy, key: "kind" } } : {}),
    };
  });
const paramFields = Object.entries(PARAMS).flatMap(([kind, list]) =>
  list.flatMap((p) => [
    {
      key: p.key + "From",
      label: `${p.label.split(" (")[0]}: from`,
      type: "text",
      default: "",
      empty: true,
      inputChoice: "optional", // "" = the default value below
      when: { kind: [kind] },
    },
    {
      key: p.key,
      label: `${p.label} · default`,
      type: "number",
      default: p.def,
      min: p.min,
      max: p.max,
      when: { kind: [kind] },
    },
  ]),
);
const fields = [
  {
    key: "kind",
    label: "Peripheral",
    type: "select",
    default: "servo",
    options: KINDS,
  },
  {
    key: "trigger",
    label: "Trigger input (starts on its rising edge)",
    type: "text",
    default: "",
    empty: true,
    inputChoice: "required",
  },
  ...paramFields,
  ...reuse(devices.outputFields, [
    "driver",
    "pin",
    "dirPin",
    "enPin",
    "in1",
    "in2",
    "in3",
    "in4",
    "range",
    "minUs",
    "maxUs",
    "start",
    "stepsPerRev",
    "microsteps",
    "ulnSteps",
    "accel",
    "idle",
    "reverse",
  ]),
  ...reuse(devices.inputFields, [
    "sda",
    "scl",
    "address",
    "gyroOut",
    "gyroRange",
    "accelRange",
    "calibrate",
    "decimals",
  ]),
].map((f) => {
  // Conditions on settings this node does not have (e.g. the servo's input mode).
  const keys = new Set(["kind", "driver"]);
  const keep = (w) =>
    Object.fromEntries(Object.entries(w).filter(([k]) => keys.has(k)));
  return f.when
    ? { ...f, when: Array.isArray(f.when) ? f.when.map(keep) : keep(f.when) }
    : f;
});
const KIND_SET = new Set(Object.keys(KINDS));
const pinSpec = [...devices.outputPins, ...devices.inputPins]
  .map((p) => ({ ...p, when: toKind(p.when) }))
  .filter((p) =>
    [p.when].flat().some((w) => w.kind?.some((k) => KIND_SET.has(k))),
  );
// The device config the shared drivers expect.
const deviceOf = (n) => devices.asDevice(n);
const help =
  "A common Arduino peripheral that does one operation each time its Trigger input rises (off → on): a servo turns to an angle at a speed, a stepper motor turns by an angle at a speed, a gyroscope takes a reading. Each parameter is a default value, or comes from a connected input you choose by its variable name (e.g. an analog input through Map range). In the firmware the parameters are a C union, one struct per kind of peripheral.";
const helpBy = {
  key: "kind",
  texts: {
    servo:
      "Servo: signal wire to the pin, 5 V and GND (shared with the board). On each trigger it turns to Angle at Speed (°/s; 0 = as fast as it can) and then sends the angle on. A new trigger while it turns sets a new target.",
    stepper:
      "Stepper: STEP / DIR driver or ULN2003 board (28BYJ-48). On each trigger it turns by Turn by (° + or −) at Speed (RPM), speeding up and slowing down with the acceleration, then sends its position (°). Triggers while it turns add to the turn.",
    gyro: "MPU-6050 on I2C (SDA, SCL, 3.3 V, GND). On each trigger it takes a reading (the average of Readings to average) and sends it: all values as JSON, or the one chosen in Output.",
  },
};
function validate(c) {
  if (c.kind === "gyro") {
    if (c.sda === c.scl) throw Error("SDA and SCL must be different pins.");
    return;
  }
  devices.validateOutput({
    ...c,
    device: c.kind,
    servoIn: "angle",
    input: "angle",
  });
}
// Connected inputs by name: errors (Trigger missing / not connected, a parameter's
// input not connected). Analog triggers are checked in lib/flow.js.
function check(n, inputs) {
  const c = n.config;
  const errors = [];
  const names = inputs.map((m) => m.name);
  const listed = names.length ? ` (connected: ${names.join(", ")})` : "";
  if (!c.trigger)
    errors.push(
      `${n.label}: choose the Trigger input (a connected node that sends on / off, e.g. a push button).`,
    );
  else if (!names.includes(c.trigger))
    errors.push(
      `${n.label}: Trigger input ${c.trigger} is not connected to it${listed}.`,
    );
  for (const p of PARAMS[c.kind]) {
    const from = c[p.key + "From"];
    if (from && !names.includes(from))
      errors.push(
        `${n.label}: ${p.label.split(" (")[0]} comes from ${from}, which is not connected to it${listed}.`,
      );
  }
  return errors;
}

// ── Firmware ──
// The parameter types: once per sketch (lib/flow.js), before the node globals.
const types = (nodes) =>
  nodes.some((n) => n.type === "peripheral")
    ? `// Peripheral nodes: each keeps its parameters in a tagged union, one struct per kind.
enum MfPeripheralKind : uint8_t { MF_SERVO, MF_STEPPER, MF_GYRO };
struct MfServoParams { float angle; float speed; };   // °, °/s (0 = full speed)
struct MfStepperParams { float turn; float rpm; };    // ° to turn by, RPM
struct MfGyroParams { float samples; };               // readings to average
union MfPeripheralParams { MfServoParams servo; MfStepperParams stepper; MfGyroParams gyro; };
struct MfPeripheral { MfPeripheralKind kind; MfPeripheralParams p; bool level; };
`
    : "";
const KIND_ENUM = { servo: "MF_SERVO", stepper: "MF_STEPPER", gyro: "MF_GYRO" };
const MAX_RATE = devices.MAX_STEP_RATE;
function globals(n, i, build) {
  const c = n.config;
  const d = deviceOf(n);
  const spr = devices.stepsPerRev(c);
  const label = (n.label || "Peripheral").replace(/[^\x20-\x7e]/g, "?");
  const own = `// Peripheral "${label}": ${KINDS[c.kind]}; parameters in mfPeriph${i}.p.${c.kind}.
int mfSlot${i} = -1;
MfPeripheral mfPeriph${i};`;
  if (c.kind === "stepper")
    return `${own}
// Top speed in steps per second, from the Speed parameter (RPM).
float mfStepVmax${i}() {
  float v = fabs(mfPeriph${i}.p.stepper.rpm) * ${fl(spr / 60)};
  if (v < ${fl(spr / 600)}) v = ${fl(spr / 600)};
  return v > ${MAX_RATE}.0f ? ${MAX_RATE}.0f : v;
}
${devices.outputGlobals({ ...d, config: { ...d.config, vmaxExpr: `mfStepVmax${i}()` } }, i, build)}`;
  if (c.kind === "servo")
    return `${own}\n${devices.outputGlobals(d, i, build)}`;
  return `${own}\n${devices.inputGlobals(d, i, build)}`;
}
function setup(n, i) {
  const c = n.config;
  const params = PARAMS[c.kind]
    .map((p) => `mfPeriph${i}.p.${c.kind}.${p.key} = ${fl(c[p.key])};`)
    .join(" ");
  const own = `mfPeriph${i}.kind = ${KIND_ENUM[c.kind]}; ${params} mfPeriph${i}.level = false;`;
  if (c.kind === "gyro") return own;
  const d = deviceOf(n);
  return `${own} ${devices.outputSetup({ ...d, config: { ...d.config, servoIn: "angle" } }, i)}`;
}
// The private "done" signal from loop() (as the Output device).
const DONE = "value.length() == 1 && value[0] == 31";
function body(n, i, build, wire) {
  const c = n.config;
  const slot = (name) => wire.inputs.findIndex((m) => m.name === name);
  const p = `mfPeriph${i}.p.${c.kind}`;
  // What each input slot does: set parameters and / or trigger.
  const actions = new Map();
  const add = (s, code) => {
    if (s < 0) return;
    actions.set(s, [...(actions.get(s) || []), code]);
  };
  for (const q of PARAMS[c.kind])
    if (c[q.key + "From"])
      add(
        slot(c[q.key + "From"]),
        `{ double x; if (mfNumber(value, x)) ${p}.${q.key} = (float)x; }`,
      );
  add(
    slot(c.trigger),
    `{ bool level = mfJson::asBool(value); go = level && !mfPeriph${i}.level; mfPeriph${i}.level = level; }`,
  );
  const dispatch = [...actions]
    .map(([s, code]) => `if (slot == ${s}) ${code.join(" ")}`)
    .join("\n  ");
  const done = {
    servo: `String(mfServoNow${i}, 1)`,
    stepper: `String(mfStepPos${i} / mfStepUnit${i}, 1)`,
    gyro: "value",
  }[c.kind];
  const run = {
    servo: `float a = ${p}.angle;
  if (a < 0) a = 0;
  if (a > ${c.range}) a = ${c.range};
  if (${p}.speed > 0 && mfServoNow${i} >= 0) { mfServoTo${i} = a; mfServoMoving${i} = true; mfServoAt${i} = millis(); return; } // sent when it gets there
  mfServoMoving${i} = false; mfServoNow${i} = mfServoTo${i} = a; mfServoAngle${i}(a);
  value = String(a, 1);`,
    stepper: `mfStepTo${i} += lround(${p}.turn * mfStepUnit${i});
  mfStepBusy${i} = true;
  return; // sent when the turn is done`,
    gyro: `if (!mfMpuOk${i}) mfMpuOk${i} = mfMpuBegin${i}();
  int count = (int)${p}.samples;
  if (count < 1) count = 1;
  if (count > 50) count = 50;
  float a[3] = {0, 0, 0}, g[3] = {0, 0, 0}, ra[3], rg[3];
  int got = 0;
  for (int k = 0; k < count && mfMpuOk${i}; k++)
    if (mfMpuRead${i}(ra, rg)) { for (int j = 0; j < 3; j++) { a[j] += ra[j]; g[j] += rg[j]; } got++; }
  if (!got) { mfMpuOk${i} = false; mfComplain${i}("no MPU-6050 answers at 0x${Number(c.address).toString(16)}; check SDA, SCL, 3.3 V and GND"); return; }
  for (int j = 0; j < 3; j++) { a[j] /= got; g[j] /= got; }
  float pitch = atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2])) * 57.29578f + 0.0f;
  float roll = atan2(a[1], a[2]) * 57.29578f + 0.0f;
  value = ${devices.gyroText(c)};`,
  }[c.kind];
  return `if (${DONE}) { value = ${done}; } else {
  int slot = mfSlot${i}; mfSlot${i} = -1;
  bool go = false;
  ${dispatch}
  if (!go) return;
  ${run}
}`;
}
function loop(n, i) {
  const c = n.config;
  if (c.kind === "stepper") return devices.outputLoop(deviceOf(n), i);
  if (c.kind !== "servo") return "";
  // As the Output device's turn speed, with the speed from the parameter.
  return `if (mfServoMoving${i} && millis() - mfServoAt${i} >= 20UL) {
    float step = mfPeriph${i}.p.servo.speed * (millis() - mfServoAt${i}) / 1000.0f;
    mfServoAt${i} = millis();
    float d = mfServoTo${i} - mfServoNow${i};
    if (step <= 0 || fabs(d) <= step) { mfServoNow${i} = mfServoTo${i}; mfServoMoving${i} = false; }
    else mfServoNow${i} += d > 0 ? step : -step;
    mfServoAngle${i}(mfServoNow${i});
    if (!mfServoMoving${i}) node${i}(String((char)31));
  }`;
}

// ── Simulator ──
const toNumber = (v) => {
  const t = String(v).trim();
  const x = Number(t);
  return t && Number.isFinite(x) ? x : null;
};
function host(v, n, ctx) {
  const c = n.config;
  const st = ctx.state;
  st.p ??= Object.fromEntries(PARAMS[c.kind].map((q) => [q.key, c[q.key]]));
  const from = (ctx.inputs || []).find((m) => m.id === ctx.from)?.name;
  for (const q of PARAMS[c.kind])
    if (from && c[q.key + "From"] === from) {
      const x = toNumber(v);
      if (x !== null) st.p[q.key] = x;
    }
  let go = false;
  if (from && c.trigger === from) {
    const level = on(v);
    go = level && !st.level;
    st.level = level;
  }
  if (!go) return undefined;
  const fixed = (x, d) => Number(x).toFixed(d);
  if (c.kind === "servo") {
    const a = Math.max(0, Math.min(c.range, st.p.angle));
    st.now ??= c.start >= 0 ? c.start : -1;
    ctx.cancel(st.timer);
    const ms =
      st.p.speed > 0 && st.now >= 0
        ? (Math.abs(a - st.now) / st.p.speed) * 1000
        : 0;
    ctx.log?.(
      `${n.label}: servo → ${fixed(a, 1)}° at ${st.p.speed} °/s${ms ? ` (${Math.round(ms)} ms)` : ""}`,
    );
    ctx.motion?.({ angle: a, ms: Math.round(ms) });
    if (!ms) {
      st.now = a;
      return fixed(a, 1);
    }
    st.timer = ctx.later(ms, () => {
      st.now = a;
      ctx.forward(fixed(a, 1));
    });
    return undefined;
  }
  if (c.kind === "stepper") {
    const spr = devices.stepsPerRev(c);
    const per = spr / 360;
    const vmax = Math.min(
      MAX_RATE,
      Math.max(spr / 600, (Math.abs(st.p.rpm) * spr) / 60),
    );
    const acc = (c.accel * spr) / 60;
    const steps = Math.round(st.p.turn * per);
    st.to = (st.to ?? 0) + steps;
    const ms = devices.moveTime(Math.abs(steps), vmax, acc) * 1000;
    ctx.log?.(
      `${n.label}: stepper ${steps >= 0 ? "+" : ""}${steps} steps at ${st.p.rpm} RPM (${Math.round(ms)} ms)`,
    );
    ctx.cancel(st.timer);
    st.timer = ctx.later(ms, () => ctx.forward(fixed(st.to / per, 1)));
    return undefined;
  }
  // Gyroscope: the Input device's simulated reading, taken now.
  let reading;
  let tick;
  devices.simulateInput(deviceOf(n), {
    every: (ms, fn) => (tick = fn),
    send: (x) => (reading = x),
    readPin: () => 0,
    warn: () => {},
  });
  tick();
  return reading;
}
module.exports = {
  KINDS,
  PARAMS,
  fields,
  pinSpec,
  help,
  helpBy,
  validate,
  check,
  types,
  globals,
  setup,
  body,
  loop,
  host,
};
