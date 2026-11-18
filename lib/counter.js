// Counter node: two inputs (Count, Reset) and three outputs. Each output has its
// own preset; when the count reaches it, that output sends a pulse: 1, then 0 after
// the pulse width. Simulator (host) and firmware (fw) follow the same rules:
//
//  • Count input: each rising edge (off → on) adds 1, or each falling edge, or every
//    message (Properties). On / off as in the Logic node: 1, true, on, yes or a
//    non-zero number is on.
//  • Reset input: a value that is on sets the count to 0 (any running pulses end
//    normally). While Reset is on, Count is ignored.
//  • Outputs 1, 2, 3: a pulse when the count becomes equal to that output's preset.
//    A new pulse while one is running starts it again (the 0 comes later).
//  • After the highest preset: keep counting, or start again at 0 (Properties).
//  • Count and Reset are chosen in Properties by the connected inputs' names, as in
//    the Timer node; blank Count = any input that is not Reset.
const { on } = require("./logic");

const OUTPUTS = 3;
const quoted = (s) =>
  '"' +
  String(s)
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "'") +
  '"';
const COUNT_ON = {
  rising: "Rising edge (off → on), e.g. a button press",
  falling: "Falling edge (on → off)",
  any: "Every message",
};
const preset = (k, def) => ({
  key: "preset" + k,
  label: `Output ${k}: pulse when the count reaches`,
  type: "number",
  default: def,
  min: 1,
  max: 1000000,
  integer: true,
});
const fields = [
  {
    key: "count",
    label: "Count input",
    type: "text",
    default: "",
    empty: true,
    inputChoice: "optional",
    noneLabel: "— any input that is not Reset —",
  },
  {
    key: "countOn",
    label: "Count on",
    type: "select",
    default: "rising",
    options: COUNT_ON,
  },
  {
    key: "reset",
    label: "Reset input (count back to 0)",
    type: "text",
    default: "",
    empty: true,
    inputChoice: "optional",
    noneLabel: "— no reset —",
  },
  preset(1, 3),
  preset(2, 5),
  preset(3, 10),
  {
    key: "width",
    label: "Pulse width (ms)",
    type: "number",
    default: 500,
    min: 1,
    max: 600000,
    integer: true,
  },
  {
    key: "after",
    label: "After the highest preset",
    type: "select",
    default: "keep",
    options: {
      keep: "Keep counting (outputs stay quiet)",
      restart: "Start again at 0 (repeats)",
    },
  },
];
const help =
  "Counts and sends pulses. Two inputs: Count (each rising edge off → on adds 1; or each falling edge, or every message) and Reset (a value that is on sets the count back to 0). Three outputs (the dots on the right, 1 at the top): each has its own preset, and when the count reaches it that output sends a pulse: 1, then 0 after the pulse width. After the highest preset it keeps counting, or starts again at 0 so the pulses repeat. Choose which connected input is Count and which is Reset in Properties (as in the Timer). The count shows on the box. On and off as in the Logic node: 1, true, on, yes or a non-zero number is on.";
const presets = (c) => [c.preset1, c.preset2, c.preset3];
const OUTPUT_LABELS = ["Output 1", "Output 2", "Output 3"];
// Which input a value came from: "count", "reset" or null (not used).
function roleOf(c, name) {
  if (c.reset && name === c.reset) return "reset";
  if (!c.count || name === c.count) return "count";
  return null;
}
// Does this value count (edge rules)? Updates the remembered level.
function counts(st, v, mode) {
  if (mode === "any") return true;
  const level = on(v);
  const was = !!st.level;
  st.level = level;
  return mode === "falling" ? was && !level : level && !was;
}
// ── Simulator ──
function host(v, n, ctx) {
  const c = n.config;
  const st = ctx.state;
  st.count ??= 0;
  st.pulses ??= [];
  const from = (ctx.inputs || []).find((m) => m.id === ctx.from)?.name;
  const role = from === undefined ? "count" : roleOf(c, from);
  if (role === null) return undefined;
  if (role === "reset") {
    st.resetOn = on(v);
    if (st.resetOn) {
      st.count = 0;
      ctx.indicate?.("reset", "reset: count 0");
    }
    return undefined;
  }
  if (!counts(st, v, c.countOn)) return undefined;
  if (c.reset && st.resetOn) {
    ctx.indicate?.("blocked", `count ignored: reset is on (count ${st.count})`);
    return undefined;
  }
  st.count++;
  const hit = presets(c)
    .map((p, k) => (st.count === p ? k : -1))
    .filter((k) => k >= 0);
  ctx.indicate?.(
    hit.length ? "pulse" : "count",
    `count ${st.count}${hit.length ? " → pulse on " + hit.map((k) => OUTPUT_LABELS[k]).join(", ") : ""}`,
  );
  for (const k of hit) {
    if (st.pulses[k]) ctx.cancel(st.pulses[k]);
    ctx.forward("1", k);
    st.pulses[k] = ctx.later(c.width, () => {
      st.pulses[k] = null;
      ctx.forward("0", k);
    });
  }
  if (c.after === "restart" && st.count >= Math.max(...presets(c))) st.count = 0;
  return undefined;
}
// ── Firmware ──
function globals(n, i) {
  return `// ${quoted(n.label || "Counter")}: counter, presets ${presets(n.config).join(" / ")}.
long mfCount${i} = 0;
bool mfCountLevel${i} = false, mfCountReset${i} = false;
bool mfCountPulse${i}[${OUTPUTS}] = {false, false, false};
unsigned long mfCountAt${i}[${OUTPUTS}] = {0, 0, 0};
int mfSlot${i} = -1; // which input sent the value (lib/flow.js)`;
}
// wire.inputs: the nodes wired in, in slot order; Count / Reset by variable name.
function body(n, i, build, wire = { inputs: [] }) {
  const c = n.config;
  const names = wire.inputs.map((m) => m.name);
  const resetSlot = c.reset ? names.indexOf(c.reset) : -1;
  const countSlot = c.count ? names.indexOf(c.count) : -1;
  const countTest = c.count
    ? `slot == ${countSlot}`
    : resetSlot >= 0
      ? `slot != ${resetSlot}`
      : "true";
  const reset =
    resetSlot >= 0
      ? `if (slot == ${resetSlot}) {
    mfCountReset${i} = mfJson::asBool(value);
    if (mfCountReset${i}) { mfCount${i} = 0; Serial.println(${quoted((n.label || "Counter") + ": reset, count 0")}); }
    return;
  }
  `
      : "";
  const edge =
    c.countOn === "any"
      ? ""
      : `bool level = mfJson::asBool(value);
  bool was = mfCountLevel${i}; mfCountLevel${i} = level;
  if (!(${c.countOn === "falling" ? "was && !level" : "level && !was"})) return;
  `;
  const fire = presets(c)
    .map(
      (p, k) =>
        `if (mfCount${i} == ${p}L) { mfCountPulse${i}[${k}] = true; mfCountAt${i}[${k}] = millis(); node${i}_out${k}("1"); }`,
    )
    .join("\n  ");
  const restart =
    c.after === "restart"
      ? `\n  if (mfCount${i} >= ${Math.max(...presets(c))}L) mfCount${i} = 0;`
      : "";
  return `int slot = mfSlot${i}; mfSlot${i} = -1;
  ${reset}if (!(${countTest})) return;
  ${edge}if (mfCountReset${i}) return;
  mfCount${i}++;
  Serial.print(${quoted((n.label || "Counter") + ": count ")}); Serial.println(mfCount${i});
  ${fire}${restart}
  return;`;
}
// Ends the pulses: 0 after the pulse width.
function loop(n, i) {
  return `for (int k = 0; k < ${OUTPUTS}; k++)
    if (mfCountPulse${i}[k] && millis() - mfCountAt${i}[k] >= ${n.config.width}UL) {
      mfCountPulse${i}[k] = false;
      if (k == 0) node${i}_out0("0"); else if (k == 1) node${i}_out1("0"); else node${i}_out2("0");
    }`;
}
// Count / Reset name connected inputs, and not the same one.
function check(n, inputs) {
  const c = n.config;
  const names = inputs.map((m) => m.name);
  const listed = names.length ? ` (connected: ${names.join(", ")})` : "";
  const errors = [];
  for (const [key, what] of [
    ["count", "Count"],
    ["reset", "Reset"],
  ])
    if (c[key] && !names.includes(c[key]))
      errors.push(`${n.label}: ${what} input ${c[key]} is not connected to it${listed}.`);
  if (c.count && c.count === c.reset)
    errors.push(`${n.label}: Count and Reset must be different inputs.`);
  if (c.reset && !c.count && names.filter((x) => x !== c.reset).length === 0)
    errors.push(`${n.label}: connect a Count input too (only Reset is connected).`);
  return errors;
}
module.exports = {
  OUTPUTS,
  OUTPUT_LABELS,
  fields,
  help,
  host,
  globals,
  body,
  loop,
  check,
  presets,
};
