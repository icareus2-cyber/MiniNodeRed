// Timer node: started by a rising edge (off → on) on its input, it waits T1, then
// sends 1, keeps it for T2 and sends 0. Simulator (host) and firmware (fw) follow
// the same rules:
//
//  • On / off as in the Logic node (lib/logic.js on(): 1, true, on, yes or a
//    non-zero number is on).
//  • A rising edge counts as a trigger only if the input stays on for the trigger
//    pulse width (default 1 ms); a shorter blip is ignored.
//  • Triggers do not add up: a trigger while the timer runs (during T1 or T2) is
//    ignored, not queued; a new trigger needs a new rising edge after it ends.
//  • Each trigger is shown: on the node's box in the IDE and in the console (and
//    on USB serial on a board).
//  • Set and Reset inputs (Properties): Set starts the timer as above (blank = any
//    input that is not Reset). Each chooses its edge: rising (off → on) or falling
//    (on → off). An edge on Reset whose new level stays for the trigger
//    pulse width stops the timer: during T2 it sends 0 at once, during T1 nothing
//    is sent. While Reset is on, triggers on Set are ignored.
const { on } = require("./logic");

const quoted = (s) =>
  '"' +
  String(s)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "'")
    .replace(/\?/g, "_") +
  '"';
// The edge that counts: rising (off → on, e.g. a button to 3.3 V) or falling
// (on → off, e.g. a button to GND with a pull-up). The input must then stay in
// its new state for the trigger pulse width.
const EDGES = {
  rising: "Rising edge (off → on)",
  falling: "Falling edge (on → off)",
};
// "Active" level: on for a rising edge, off for a falling one.
const active = (v, edge) => (edge === "falling" ? !on(v) : on(v));
const fields = [
  {
    key: "t1",
    label: "T1 · time before activation (s)",
    type: "number",
    default: 0,
    min: 0,
    max: 86400,
  },
  {
    key: "t2",
    label: "T2 · activation time (s)",
    type: "number",
    default: 1,
    min: 0.001,
    max: 86400,
  },
  {
    key: "set",
    label: "Set input (starts the timer)",
    type: "text",
    default: "",
    empty: true,
    inputChoice: "optional",
    noneLabel: "— any input that is not Reset —",
  },
  {
    key: "setEdge",
    label: "Set triggers on",
    type: "select",
    default: "rising",
    options: EDGES,
  },
  {
    key: "reset",
    label: "Reset input (stops the timer: output off)",
    type: "text",
    default: "",
    empty: true,
    inputChoice: "optional",
    noneLabel: "— no reset —",
  },
  {
    key: "resetEdge",
    label: "Reset triggers on",
    type: "select",
    default: "rising",
    options: EDGES,
  },
  {
    key: "width",
    label: "Trigger pulse width (ms): Set and Reset must keep their new level this long",
    type: "number",
    default: 1,
    min: 0,
    max: 60000,
    integer: true,
  },
];
const ms = (s) => Math.round(s * 1000);
const help =
  "Starts on a rising edge (off → on), or a falling edge (on → off) if chosen, of its Set input; the input must keep its new level for at least the trigger pulse width. It waits T1, sends 1, keeps it for T2, then sends 0. A trigger while the timer runs is ignored (triggers do not add up); the next one needs a new rising edge. Reset (optional, a second input, e.g. a second GPIO pin): its rising (or falling) edge, held for the trigger pulse width, stops the timer at once and its output goes off (0 during T2; during T1 nothing is sent); while Reset is on, Set is ignored. Choose which connected input (GPIO pin) is Set and which is Reset, and the edge of each, in Properties. On and off as in the Logic node: 1, true, on, yes or a non-zero number is on. Each trigger shows on the box and in the console (on a board: on USB serial, and in the IDE with a debug build).";
const STATES = {
  triggered: "triggered",
  on: "active (1)",
  off: "done (0)",
  ignored: "trigger ignored: timer running",
  short: "pulse too short: ignored",
  reset: "reset: timer stopped (off)",
  resetIdle: "reset (timer was not running)",
  blocked: "trigger ignored: reset is on",
};
// Which input a value came from: "set", "reset" or null (not used).
function roleOf(config, name) {
  if (config.reset && name === config.reset) return "reset";
  if (!config.set || name === config.set) return "set";
  return null;
}
// ── Simulator ──
function host(v, n, ctx) {
  const c = n.config;
  const st = ctx.state;
  const show = (state) => ctx.indicate?.(state, STATES[state]);
  const from = (ctx.inputs || []).find((m) => m.id === ctx.from)?.name;
  const role = from === undefined ? "set" : roleOf(c, from);
  if (role === null) return undefined;
  if (role === "reset") {
    const level = active(v, c.resetEdge);
    const rise = level && !st.resetLevel;
    st.resetLevel = level;
    if (!level && st.resetPending) {
      ctx.cancel(st.resetPending);
      st.resetPending = null;
      show("short");
    }
    if (!rise) return undefined;
    st.resetPending = ctx.later(c.width, () => {
      st.resetPending = null;
      if (!st.resetLevel) return;
      if (st.pending) ctx.cancel(st.pending);
      st.pending = null;
      if (!st.phase) return show("resetIdle");
      if (st.timer) ctx.cancel(st.timer);
      st.timer = null;
      const wasOn = st.phase === 2;
      st.phase = 0;
      show("reset");
      if (wasOn) ctx.forward("0");
    });
    return undefined;
  }
  const level = active(v, c.setEdge);
  const rise = level && !st.level;
  st.level = level;
  if (!level && st.pending) {
    ctx.cancel(st.pending);
    st.pending = null;
    show("short");
  }
  if (!rise) return undefined;
  if (st.resetLevel && c.reset) {
    show("blocked");
    return undefined;
  }
  if (st.phase) {
    show("ignored");
    return undefined;
  }
  const activate = () => {
    st.phase = 2;
    show("on");
    ctx.forward("1");
    st.timer = ctx.later(ms(c.t2), () => {
      st.phase = 0;
      show("off");
      ctx.forward("0");
    });
  };
  st.pending = ctx.later(c.width, () => {
    st.pending = null;
    if (!st.level || st.phase || (c.reset && st.resetLevel)) return;
    st.phase = 1;
    show("triggered");
    if (ms(c.t1) > 0) st.timer = ctx.later(ms(c.t1), activate);
    else activate();
  });
  return undefined;
}
// ── Firmware ──
// The node function takes inputs; loop() keeps the time and sends 1 and 0 through
// the node function as a private 2-character signal (0x1F, then '1' or '0').
function globals(n, i, build) {
  const label = quoted(n.label || "Timer");
  const report =
    build?.debug && build?.net
      ? `\n  if (mfTelemetry && mqtt.connected()) mqtt.publish((mfBase + ${quoted("/debug/" + n.id)}).c_str(), what);`
      : "";
  return `// ${label}: timer, T1 ${n.config.t1} s, T2 ${n.config.t2} s.
uint8_t mfTimer${i} = 0; // 0 idle, 1 waiting T1, 2 active (T2)
bool mfTimerLevel${i} = false, mfTimerPending${i} = false;
bool mfTimerReset${i} = false, mfTimerResetPending${i} = false; // Reset input
unsigned long mfTimerEdge${i} = 0, mfTimerAt${i} = 0, mfTimerResetEdge${i} = 0;
int mfSlot${i} = -1; // which input sent the value (lib/flow.js)
void mfTimerShow${i}(const char* what) {
  Serial.print(${label}); Serial.print(": "); Serial.println(what);${report}
}`;
}
// wire.inputs: the nodes wired in, in slot order; Set / Reset by variable name.
function body(n, i, build, wire = { inputs: [] }) {
  const c = n.config;
  const names = wire.inputs.map((m) => m.name);
  const resetSlot = c.reset ? names.indexOf(c.reset) : -1;
  const setSlot = c.set ? names.indexOf(c.set) : -1;
  // Slots that act as Set: the chosen one, or every input but Reset.
  const setTest = c.set
    ? `slot == ${setSlot}`
    : resetSlot >= 0
      ? `slot != ${resetSlot}`
      : "true";
  const reset =
    resetSlot >= 0
      ? `if (slot == ${resetSlot}) {
    bool level = ${c.resetEdge === "falling" ? "!" : ""}mfJson::asBool(value);
    bool rise = level && !mfTimerReset${i};
    mfTimerReset${i} = level;
    if (!level && mfTimerResetPending${i}) { mfTimerResetPending${i} = false; mfTimerShow${i}("${STATES.short}"); }
    if (rise) { mfTimerResetPending${i} = true; mfTimerResetEdge${i} = millis(); }
    return;
  }
  `
      : "";
  return `if (value.length() == 2 && value[0] == 31) { value = String(value[1]); } else {
  int slot = mfSlot${i}; mfSlot${i} = -1;
  ${reset}if (!(${setTest})) return;
  bool level = ${c.setEdge === "falling" ? "!" : ""}mfJson::asBool(value);
  bool rise = level && !mfTimerLevel${i};
  mfTimerLevel${i} = level;
  if (!level && mfTimerPending${i}) { mfTimerPending${i} = false; mfTimerShow${i}("${STATES.short}"); }
  if (rise) {
    if (mfTimerReset${i}) mfTimerShow${i}("${STATES.blocked}");
    else if (mfTimer${i}) mfTimerShow${i}("${STATES.ignored}");
    else { mfTimerPending${i} = true; mfTimerEdge${i} = millis(); }
  }
  return; }`;
}
function loop(n, i) {
  const c = n.config;
  return `{ unsigned long now = millis();
    if (mfTimerResetPending${i} && now - mfTimerResetEdge${i} >= ${c.width}UL) {
      mfTimerResetPending${i} = false; mfTimerPending${i} = false;
      if (mfTimerReset${i}) {
        if (mfTimer${i} == 2) { mfTimer${i} = 0; mfTimerShow${i}("${STATES.reset}"); node${i}(String((char)31) + "0"); }
        else if (mfTimer${i} == 1) { mfTimer${i} = 0; mfTimerShow${i}("${STATES.reset}"); }
        else mfTimerShow${i}("${STATES.resetIdle}");
      }
    }
    if (mfTimerPending${i} && now - mfTimerEdge${i} >= ${c.width}UL) {
      mfTimerPending${i} = false;
      if (mfTimerLevel${i} && !mfTimer${i} && !mfTimerReset${i}) { mfTimer${i} = 1; mfTimerAt${i} = now; mfTimerShow${i}("${STATES.triggered}"); }
    }
    if (mfTimer${i} == 1 && now - mfTimerAt${i} >= ${ms(c.t1)}UL) { mfTimer${i} = 2; mfTimerAt${i} = now; mfTimerShow${i}("${STATES.on}"); node${i}(String((char)31) + "1"); }
    if (mfTimer${i} == 2 && now - mfTimerAt${i} >= ${ms(c.t2)}UL) { mfTimer${i} = 0; mfTimerShow${i}("${STATES.off}"); node${i}(String((char)31) + "0"); } }`;
}
// Set / Reset name connected inputs, and not the same one.
function check(n, inputs) {
  const c = n.config;
  const names = inputs.map((m) => m.name);
  const listed = names.length ? ` (connected: ${names.join(", ")})` : "";
  const errors = [];
  for (const [key, what] of [
    ["set", "Set"],
    ["reset", "Reset"],
  ])
    if (c[key] && !names.includes(c[key]))
      errors.push(`${n.label}: ${what} input ${c[key]} is not connected to it${listed}.`);
  if (c.set && c.set === c.reset)
    errors.push(`${n.label}: Set and Reset must be different inputs.`);
  if (c.reset && !c.set && names.filter((x) => x !== c.reset).length === 0)
    errors.push(`${n.label}: connect a Set input too (only Reset is connected).`);
  return errors;
}
module.exports = { fields, help, host, globals, body, loop, check, STATES };
