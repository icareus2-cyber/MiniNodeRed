// Logic node: gates, flip-flops and timers on on/off values. The simulator (host)
// and the firmware (C++) below follow the same rules:
//
//  • An input is on for 1, true, on, yes or a non-zero number; anything else is off.
//  • Gates and flip-flops keep each input's last state; inputs not heard yet are off.
//  • Output is 1 or 0. Gates and flip-flops send when the output changes (or, with
//    Output "every input", on every input); timers send when their output changes.
//  • Which input sent a value: in the simulator ctx.from; in the firmware the caller
//    sets mfSlot<i> to the input's position (lib/flow.js) before calling node<i>.
const FUNCTIONS = {
  and: { label: "AND gate", kind: "gate" },
  or: { label: "OR gate", kind: "gate" },
  xor: { label: "XOR gate (odd number on)", kind: "gate" },
  nand: { label: "NAND gate", kind: "gate" },
  nor: { label: "NOR gate", kind: "gate" },
  xnor: { label: "XNOR gate", kind: "gate" },
  not: { label: "NOT (inverter)", kind: "gate" },
  sr: { label: "SR latch (set / reset)", kind: "ff" },
  toggle: { label: "Toggle flip-flop (T)", kind: "ff" },
  d: { label: "D flip-flop (data / clock)", kind: "ff" },
  ton: { label: "On-delay timer (TON)", kind: "timer" },
  tof: { label: "Off-delay timer (TOF)", kind: "timer" },
  tp: { label: "Pulse timer (TP)", kind: "timer" },
};
const kindOf = (c) => FUNCTIONS[c.fn]?.kind || "gate";
const nameField = (key, label, fns) => ({
  key,
  label,
  type: "text",
  default: "",
  empty: true,
  inputChoice: "required", // the editor offers the connected inputs
  when: { fn: fns },
});
const fields = [
  {
    key: "fn",
    label: "Function",
    type: "select",
    default: "and",
    options: Object.fromEntries(
      Object.entries(FUNCTIONS).map(([k, f]) => [k, f.label]),
    ),
  },
  nameField("set", "Set input", ["sr"]),
  nameField("reset", "Reset input", ["sr"]),
  {
    key: "priority",
    label: "Both set and reset on",
    type: "select",
    default: "reset",
    options: { reset: "Reset wins (output 0)", set: "Set wins (output 1)" },
    when: { fn: ["sr"] },
  },
  nameField("data", "Data input", ["d"]),
  nameField("clock", "Clock input", ["d"]),
  {
    key: "time",
    label: "Time (ms)",
    type: "number",
    default: 1000,
    min: 1,
    max: 86400000,
    integer: true,
    when: { fn: ["ton", "tof", "tp"] },
  },
  {
    key: "output",
    label: "Send output",
    type: "select",
    default: "change",
    options: {
      change: "When it changes",
      every: "On every input",
    },
    when: {
      fn: Object.keys(FUNCTIONS).filter((k) => FUNCTIONS[k].kind !== "timer"),
    },
  },
];
const help =
  "Logic on on/off values (1, true, on, or a non-zero number = on). Gates (AND, OR, XOR, NAND, NOR, XNOR) combine every connected input, each with its last state; NOT inverts. Flip-flops: SR latch (Set and Reset inputs, chosen by their variable names), Toggle (each 0→1 of an input flips the output), D (on each 0→1 of Clock, the output takes Data). Timers: on-delay (output 1 once the input has been on for the time, 0 as soon as it goes off), off-delay (1 at once, 0 the time after the input goes off), pulse (each 0→1 gives a 1 for the time). Outputs 1 or 0.";
const summary = Object.fromEntries(
  Object.entries(FUNCTIONS).map(([k, f]) => [
    k,
    f.kind === "timer" ? `${f.label} · {time} ms` : f.label,
  ]),
);
const on = (v) => {
  const t = String(v).trim();
  if (t === "true" || t === "on" || t === "yes") return true;
  const x = Number(t);
  return t !== "" && Number.isFinite(x) && x !== 0;
};
// Position of the input with this variable name, or -1.
const slotOf = (inputs, name) => inputs.findIndex((x) => x.name === name);
// Gate output from the inputs' states (count = how many are on).
function gate(fn, states, value) {
  const count = states.filter(Boolean).length;
  const all = count === states.length;
  return {
    and: all,
    or: count > 0,
    xor: count % 2 === 1,
    nand: !all,
    nor: count === 0,
    xnor: count % 2 === 0,
    not: !value,
  }[fn];
}

// ── Simulator ──
function host(v, n, ctx) {
  const c = n.config;
  const st = ctx.state;
  const inputs = ctx.inputs || [];
  const k = Math.max(
    0,
    inputs.findIndex((x) => x.id === ctx.from),
  );
  const b = on(v);
  st.in ||= [];
  st.prev ||= [];
  st.q ??= false;
  const emit = (q) => {
    st.q = q;
    if (c.output !== "every" && q === st.sent) return undefined;
    st.sent = q;
    return q ? "1" : "0";
  };
  const kind = kindOf(c);
  if (kind === "gate") {
    st.in[k] = b;
    const states = Array.from(
      { length: Math.max(1, inputs.length) },
      (_, j) => !!st.in[j],
    );
    return emit(gate(c.fn, states, b));
  }
  if (kind === "ff") {
    const rising = b && !st.prev[k];
    st.prev[k] = b;
    st.in[k] = b;
    let q = st.q;
    if (c.fn === "sr") {
      const s = !!st.in[slotOf(inputs, c.set)];
      const r = !!st.in[slotOf(inputs, c.reset)];
      q = s && r ? c.priority === "set" : r ? false : s ? true : q;
    } else if (c.fn === "toggle") {
      if (rising) q = !q;
    } else if (k === slotOf(inputs, c.clock) && rising)
      q = !!st.in[slotOf(inputs, c.data)];
    return emit(q);
  }
  // Timers: the output changes now or after the time (sent with ctx.forward).
  const later = (q) => {
    ctx.cancel?.(st.timer);
    st.timer = ctx.later(c.time, () => {
      st.timer = null;
      st.q = q;
      ctx.forward(q ? "1" : "0");
    });
  };
  const stop = () => {
    ctx.cancel?.(st.timer);
    st.timer = null;
  };
  const rising = b && !st.prev[0];
  st.prev[0] = b;
  if (c.fn === "ton") {
    if (b) {
      if (!st.q && !st.timer) later(true);
      return undefined;
    }
    stop();
    if (!st.q) return undefined;
    st.q = false;
    return "0";
  }
  if (c.fn === "tof") {
    if (b) {
      stop();
      if (st.q) return undefined;
      st.q = true;
      return "1";
    }
    if (st.q && !st.timer) later(false);
    return undefined;
  }
  // tp: a 0→1 starts a pulse unless one is running.
  if (!rising || st.q) return undefined;
  st.q = true;
  later(false);
  return "1";
}

// ── Firmware ──
// State per node i: input states and previous states (for 0→1), the output, the
// output last sent, and for timers a running flag and start time.
function globals(n, i, build, wire) {
  const size = Math.max(1, wire.inputs.length);
  return `// Logic "${n.label.replace(/[^\x20-\x7e]/g, "?")}" (${FUNCTIONS[n.config.fn].label}).
int mfSlot${i} = -1;
bool mfLIn${i}[${size}] = {false}, mfLPrev${i}[${size}] = {false};
bool mfLQ${i} = false, mfLRun${i} = false;
int mfLSent${i} = -1;
unsigned long mfLAt${i} = 0;`;
}
// The input states as a C++ expression for gates.
function gateExpr(fn, i, size) {
  const ins = Array.from({ length: size }, (_, j) => `mfLIn${i}[${j}]`);
  const count = `(${ins.map((x) => `(int)${x}`).join(" + ")})`;
  return {
    and: ins.join(" && "),
    or: ins.join(" || "),
    xor: `${count} % 2 == 1`,
    nand: `!(${ins.join(" && ")})`,
    nor: `!(${ins.join(" || ")})`,
    xnor: `${count} % 2 == 0`,
    not: "!b",
  }[fn];
}
function body(n, i, build, wire) {
  const c = n.config;
  const size = Math.max(1, wire.inputs.length);
  const slot = (name) => Math.max(0, slotOf(wire.inputs, name));
  // A value from loop() (a timer ending): a 1-character 0x1F, like Pulse.
  const head = `if (value.length() == 1 && value[0] == 31) { value = mfLQ${i} ? "1" : "0"; } else {
  int k = mfSlot${i} < 0 ? 0 : mfSlot${i}; mfSlot${i} = -1;
  bool b = mfJson::asBool(value);
  bool rising = b && !mfLPrev${i}[k]; mfLPrev${i}[k] = b; mfLIn${i}[k] = b; (void)rising;`;
  const emit = `
  bool changed = (int)q != mfLSent${i}; mfLQ${i} = q;
  if (!changed${c.output === "every" ? " && false" : ""}) return;
  mfLSent${i} = q; value = q ? "1" : "0"; }`;
  const kind = kindOf(c);
  if (kind === "gate")
    return `${head}
  bool q = ${gateExpr(c.fn, i, size)};${emit}`;
  if (kind === "ff") {
    let q;
    if (c.fn === "sr") {
      const s = `mfLIn${i}[${slot(c.set)}]`;
      const r = `mfLIn${i}[${slot(c.reset)}]`;
      q = `(${s} && ${r}) ? ${c.priority === "set"} : ${r} ? false : ${s} ? true : mfLQ${i}`;
    } else if (c.fn === "toggle") q = `rising ? !mfLQ${i} : mfLQ${i}`;
    else
      q = `(k == ${slot(c.clock)} && rising) ? mfLIn${i}[${slot(c.data)}] : mfLQ${i}`;
    return `${head}
  bool q = ${q};${emit}`;
  }
  // Timers: change the output now (and send), or start / stop the timer (no output).
  const now = (q) =>
    `mfLQ${i} = ${q}; mfLSent${i} = ${q ? 1 : 0}; value = "${q ? 1 : 0}";`;
  const start = `if (!mfLRun${i}) { mfLRun${i} = true; mfLAt${i} = millis(); }`;
  if (c.fn === "ton")
    return `${head}
  if (b) { if (!mfLQ${i}) ${start} return; }
  mfLRun${i} = false;
  if (!mfLQ${i}) return;
  ${now(false)} }`;
  if (c.fn === "tof")
    return `${head}
  if (b) { mfLRun${i} = false; if (mfLQ${i}) return; ${now(true)} }
  else { if (mfLQ${i}) ${start} return; } }`;
  return `${head}
  if (!rising || mfLQ${i}) return;
  ${now(true)} mfLRun${i} = true; mfLAt${i} = millis(); }`;
}
// Timers end in loop(): the output flips and node<i> sends it.
function loop(n, i) {
  if (kindOf(n.config) !== "timer") return "";
  const end = n.config.fn === "ton" ? "true" : "false";
  return `if (mfLRun${i} && millis() - mfLAt${i} >= ${n.config.time}UL) { mfLRun${i} = false; mfLQ${i} = ${end}; mfLSent${i} = ${end === "true" ? 1 : 0}; node${i}(String((char)31)); }`;
}
// Board checks: named inputs must be connected; gates want inputs.
function warnings(n, inputs) {
  const c = n.config;
  const errors = [];
  const out = [];
  const need = (key, what) => {
    if (!c[key])
      errors.push(
        `${n.label}: choose the ${what} input (variable name of a connected node).`,
      );
    else if (slotOf(inputs, c[key]) < 0)
      errors.push(
        `${n.label}: ${what} input ${c[key]} is not connected to it${inputs.length ? ` (connected: ${inputs.map((x) => x.name).join(", ")})` : ""}.`,
      );
  };
  if (c.fn === "sr") {
    need("set", "Set");
    need("reset", "Reset");
    if (c.set && c.set === c.reset)
      errors.push(`${n.label}: Set and Reset must be different inputs.`);
  }
  if (c.fn === "d") {
    need("data", "Data");
    need("clock", "Clock");
    if (c.data && c.data === c.clock)
      errors.push(`${n.label}: Data and Clock must be different inputs.`);
  }
  const kind = kindOf(c);
  if (kind === "gate" && c.fn !== "not" && inputs.length === 1)
    out.push(
      `${n.label}: a ${FUNCTIONS[c.fn].label} usually has two or more inputs; it has one.`,
    );
  if ((c.fn === "not" || kind === "timer") && inputs.length > 1)
    out.push(
      `${n.label}: ${FUNCTIONS[c.fn].label} uses one input; ${inputs.length} are connected and each one counts as that input.`,
    );
  return { errors, warnings: out };
}
module.exports = {
  FUNCTIONS,
  fields,
  help,
  summary,
  host,
  globals,
  body,
  loop,
  warnings,
  on,
};
