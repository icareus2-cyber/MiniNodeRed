// ── Node help: a ready example flow for the selected node ────────────
// "❓ Help example" at the bottom of Node properties shows a small example flow for
// that node on the canvas, in place of your flow (which is kept as it is, unsaved
// edits included), always on one screen. A floating help window explains the node
// and the example, lets you choose how to run it (Simulate on this PC, Real board
// (monitor), Real board + PC inputs) and start / stop it. ⧉ Copy into my flow takes
// the example's nodes along; ✕ Back to my flow (or Esc in the window) restores
// your flow, screen layout, chip and tab. While the example is shown, Save, Saved
// flows, Import, Revisions and Tests wait (so the example never overwrites a flow).

// Columns and rows of the example boxes.
const HX = [30, 210, 390],
  HY = [50, 160, 270];
// One box: [key, type, column, row, config, name?, label?]
const hb = (key, type, col, row, config = {}, name, label) => ({
  key,
  type,
  col,
  row,
  config,
  name,
  label,
});
const SRC = (cfg = {}) => hb("in", "inject", 0, 0, { interval: 0, ...cfg }, "INJ1");
const DBG = (col = 2, row = 0) => hb("dbg", "debug", col, row, {}, "DEBUG1");
const PRESS_INJECT = "Click ▶ on the Inject box (left) to send its payload.";
// A GPIO input used as a button or switch (PUSH / SWITCH on its box while running).
// "Floating / external resistor": pressed reads 1 (a button to 3.3 V with a pull-down).
const GPIN = (key, col, row, pin, name) =>
  hb(key, "gpio-watch", col, row, { pin, pull: "none" }, name);
const WATCH_DEBUG = "Watch the Debug box and the console (bottom) show what arrives.";
// Each node type's example. about: what the example shows; steps: what to try.
const HELP_EXAMPLES = {
  inject: {
    boxes: [SRC({ payload: "hello", interval: 0 }), DBG(1)],
    edges: [["in", "dbg"]],
    about: "An Inject box sends a value when clicked (or every interval); Debug shows it.",
    steps: [
      PRESS_INJECT,
      WATCH_DEBUG,
      "In Properties of the Inject box, set Repeat interval (ms) to 1000 and start again: it sends every second.",
    ],
  },
  "mqtt-in": {
    boxes: [
      SRC({ payload: "21.5" }),
      hb("out", "mqtt-out", 1, 0, { topic: "help/demo" }, "RADIOOUT1"),
      hb("rin", "mqtt-in", 0, 1, { topic: "help/demo" }, "RADIO1"),
      DBG(1, 1),
    ],
    edges: [
      ["in", "out"],
      ["rin", "dbg"],
    ],
    about:
      "Radio out publishes to the topic help/demo; Radio in listens to the same topic and passes what it receives on.",
    steps: [
      "Needs the MQTT broker (Device panel → MQTT connection) for MQTT; choose Local MQTT or ESP-NOW in both Radio boxes to try other protocols.",
      PRESS_INJECT,
      "Radio in receives it from the broker; Debug shows 21.5.",
    ],
  },
  "mqtt-out": null, // same example as Radio in
  "ble-in": {
    boxes: [
      SRC({ payload: "ping" }),
      hb("bout", "ble-out", 1, 0, { link: "link1" }, "BLEOUT1"),
      hb("bin", "ble-in", 0, 1, { link: "link1" }, "BLE1"),
      DBG(1, 1),
    ],
    edges: [
      ["in", "bout"],
      ["bin", "dbg"],
    ],
    about:
      "Bluetooth out sends on link1; Bluetooth in with the same link name receives. On real boards they are two ESP32 boards, one with each box.",
    steps: [PRESS_INJECT, WATCH_DEBUG],
  },
  "ble-out": null,
  terminal: {
    boxes: [hb("term", "terminal", 0, 0, { command: "say" }, "TERM1"), DBG(1)],
    edges: [["term", "dbg"]],
    about:
      "Terminal adds a command to the board's USB / web terminal: “say hello” sends hello on.",
    steps: [
      "Start, then type say hello in the test terminal (⌨ Terminal in the console).",
      WATCH_DEBUG,
    ],
  },
  "web-in": {
    boxes: [
      hb("win", "web-in", 0, 0, { name: "input" }, "WEB1"),
      DBG(1),
      SRC({ payload: "42" }),
      hb("wout", "web-out", 1, 1, { name: "output" }, "WEBOUT1"),
    ],
    edges: [
      ["win", "dbg"],
      ["in", "wout"],
    ],
    about:
      "Web in is a value a browser can POST to the board's web API; Web out is a value it can read.",
    steps: [
      "Start; the Web in / Web out Properties show their addresses and the page.",
      "Send a value from the page: Debug shows it. Click ▶ on Inject: the page shows 42.",
    ],
  },
  "web-out": null,
  "gpio-watch": {
    boxes: [hb("gpio", "gpio-watch", 0, 0, { pin: 4, pull: "pullup" }), DBG(1)],
    edges: [["gpio", "dbg"]],
    about:
      "GPIO input sends 1 or 0 each time the pin changes (a button from GPIO 4 to GND, with the pull-up).",
    steps: [
      "Simulate: click the pin control on the GPIO input box to press and release.",
      "Real board: press the button wired to GPIO 4.",
      WATCH_DEBUG,
    ],
  },
  "pulse-train": {
    boxes: [
      hb("train", "pulse-train", 0, 0, { high: 500, low: 500, count: 0 }),
      DBG(1),
      hb("scope", "test-scope", 1, 1, { window: 10 }),
    ],
    edges: [
      ["train", "dbg"],
      ["train", "scope"],
    ],
    about: "Pulse train sends 1 for 500 ms, then 0 for 500 ms, again and again.",
    steps: [
      "Start: the Oscilloscope box draws the square wave; Debug shows each 1 and 0.",
      "Change High / Low (ms) in Properties and start again.",
    ],
  },
  "input-device": {
    boxes: [hb("dev", "input-device", 0, 0, {}), DBG(1)],
    edges: [["dev", "dbg"]],
    about:
      "Input device reads a sensor (temperature, gyro, voltage…) and sends its value.",
    steps: [
      "Choose the device and its pins in Properties (the wiring help is shown there).",
      "Start: the simulator sends sample readings; a real board sends the sensor's.",
      WATCH_DEBUG,
    ],
  },
  "analog-in": {
    boxes: [
      hb("adc", "analog-in", 0, 0, { interval: 500 }),
      hb("map", "scale", 1, 0, { inMin: 0, inMax: 4095, outMin: 0, outMax: 100 }),
      DBG(2),
    ],
    edges: [
      ["adc", "map"],
      ["map", "dbg"],
    ],
    about:
      "Analog sample reads the pin every 500 ms; Map range turns 0…4095 into 0…100 %.",
    steps: [
      "Simulate: drag the analog slider in the Virtual pins strip (under the run bar).",
      "Real board: turn a potentiometer on the pin.",
      "Change the resolution (bits) in Properties; set Map range's input maximum to match.",
    ],
  },
  threshold: {
    boxes: [
      SRC({ payload: "28" }),
      hb("cold", "inject", 0, 1, { payload: "20", interval: 0 }, "INJ2"),
      hb("th", "threshold", 1, 0, { value: 25 }),
      DBG(2),
    ],
    edges: [
      ["in", "th"],
      ["cold", "th"],
      ["th", "dbg"],
    ],
    about: "Threshold passes values of at least 25 (the minimum) and drops smaller ones.",
    steps: [
      "Click ▶ on the upper Inject (28): it passes, Debug shows 28.",
      "Click ▶ on the lower Inject (20): nothing passes.",
    ],
  },
  compare: {
    boxes: [
      SRC({ payload: "1" }),
      hb("b", "inject", 0, 1, { payload: "5", interval: 0 }, "INJ2"),
      hb("cmp", "compare", 1, 0, { op: "eq", value: "1" }),
      DBG(2),
    ],
    edges: [
      ["in", "cmp"],
      ["b", "cmp"],
      ["cmp", "dbg"],
    ],
    about: "Compare passes a value on only when it matches the rule (here: equals 1).",
    steps: [
      "Click ▶ on the upper Inject (1): it passes to Debug.",
      "Click ▶ on the lower Inject (5): nothing passes.",
    ],
  },
  scale: {
    boxes: [
      SRC({ payload: "500" }),
      hb("map", "scale", 1, 0, { inMin: 0, inMax: 1000, outMin: 0, outMax: 100 }),
      DBG(2),
    ],
    edges: [
      ["in", "map"],
      ["map", "dbg"],
    ],
    about: "Map range turns 0…1000 into 0…100: 500 becomes 50.0.",
    steps: [PRESS_INJECT, "Debug shows 50.0. Try other payloads in the Inject box."],
  },
  throttle: {
    boxes: [
      SRC({ payload: "tick", interval: 200 }),
      hb("thr", "throttle", 1, 0, { interval: 1000 }),
      DBG(2),
    ],
    edges: [
      ["in", "thr"],
      ["thr", "dbg"],
    ],
    about:
      "Inject sends 5 times a second; Throttle lets at most one value per second through.",
    steps: ["Start: the Inject box flashes 5 times for each Debug line."],
  },
  logic: {
    boxes: [
      GPIN("a", 0, 0, 4, "BTN1"),
      GPIN("b", 0, 1, 5, "SW1"),
      hb("and", "logic", 1, 0, { fn: "and" }),
      DBG(2),
    ],
    edges: [
      ["a", "and"],
      ["b", "and"],
      ["and", "dbg"],
    ],
    about: "Logic (AND) sends 1 only while both inputs are on.",
    steps: [
      "Start, then turn SWITCH on on the SW1 box and hold PUSH on the BTN1 box: Debug shows 1.",
      "Release PUSH: 0. Try OR, XOR, SR latch or D flip-flop in Properties. (On the real circuit: buttons from GPIO 4 / 5 to 3.3 V with pull-down resistors.)",
    ],
  },
  timer: {
    boxes: [
      GPIN("set", 0, 0, 4, "SET"),
      GPIN("reset", 0, 1, 5, "RESET"),
      hb(
        "tmr",
        "timer",
        1,
        0,
        { t1: 0, t2: 5, set: "SET", reset: "RESET", setEdge: "rising", resetEdge: "rising" },
      ),
      hb("led", "digital-write", 2, 0, { pin: 2 }),
      DBG(2, 1),
    ],
    edges: [
      ["set", "tmr"],
      ["reset", "tmr"],
      ["tmr", "led"],
      ["tmr", "dbg"],
    ],
    about:
      "Pressing SET switches the LED (GPIO 2) on for 5 s; pressing RESET switches it off at once.",
    steps: [
      "Start, then press PUSH on the SET box (GPIO 4): the LED goes on, then off after 5 s.",
      "Press SET, then PUSH on RESET (GPIO 5) before 5 s: the LED goes off at once.",
      "In Properties choose which input is Set / Reset and the edge of each.",
    ],
  },
  counter: {
    boxes: [
      GPIN("cnt", 0, 0, 4, "CNT"),
      GPIN("rst", 0, 1, 5, "RST"),
      hb("ctr", "counter", 1, 0, {
        count: "CNT",
        reset: "RST",
        countOn: "rising",
        preset1: 3,
        preset2: 5,
        preset3: 10,
        width: 1000,
        after: "keep",
      }),
      hb("led1", "digital-write", 2, 0, { pin: 2 }),
      hb("led2", "digital-write", 2, 1, { pin: 12 }),
      hb("led3", "digital-write", 2, 2, { pin: 13 }),
    ],
    edges: [
      ["cnt", "ctr"],
      ["rst", "ctr"],
      ["ctr", "led1", 1],
      ["ctr", "led2", 2],
      ["ctr", "led3", 3],
    ],
    about:
      "Each press of CNT adds 1 (the count shows on the Counter box). At 3 presses output 1 pulses the LED on GPIO 2 for 1 s, at 5 output 2 pulses GPIO 12, at 10 output 3 pulses GPIO 13. RST sets the count back to 0.",
    steps: [
      "Start, then press PUSH on the CNT box (GPIO 4) three times: the GPIO 2 LED lights for 1 s.",
      "Keep pressing: at 5 the GPIO 12 LED, at 10 the GPIO 13 LED. Press PUSH on RST (GPIO 5) to start again from 0.",
      "In Properties set each output's preset, the pulse width, and 'Start again at 0' to repeat the pulses.",
    ],
  },
  template: {
    boxes: [
      SRC({ payload: "23" }),
      hb("tpl", "template", 1, 0, { template: "Temperature: {{payload}} °C" }),
      DBG(2),
    ],
    edges: [
      ["in", "tpl"],
      ["tpl", "dbg"],
    ],
    about: "Template builds a text from the value: {{payload}} is replaced by it.",
    steps: [PRESS_INJECT, "Debug shows Temperature: 23 °C."],
  },
  "link-in": {
    boxes: [
      SRC({ payload: "via link" }),
      hb("lout", "link-out", 1, 0, { link: "link1" }),
      hb("lin", "link-in", 0, 1, { link: "link1" }),
      DBG(1, 1),
    ],
    edges: [
      ["in", "lout"],
      ["lin", "dbg"],
    ],
    about:
      "Link out jumps to every Link in with the same link name (here link1), also on other flow tabs.",
    steps: [PRESS_INJECT, WATCH_DEBUG],
  },
  "link-out": null,
  arduino: {
    boxes: [SRC({ payload: "1" }), hb("code", "arduino", 1, 0, {}), DBG(2)],
    edges: [
      ["in", "code"],
      ["code", "dbg"],
    ],
    about:
      "C/C++ runs your code for each value: this one counts (count++) and sends the count.",
    steps: [
      "Click ▶ on Inject a few times: Debug shows 1, 2, 3…",
      "Open the code in Properties (✎ wide editor) and change it.",
    ],
  },
  "digital-read": {
    boxes: [
      hb("rd", "digital-read", 0, 0, { pin: 4, pull: "pullup", interval: 1000 }),
      DBG(1),
    ],
    edges: [["rd", "dbg"]],
    about: "GPIO input reads the pin's level (1 or 0) by itself, here every second, and sends it on. It has an output connection only: the other end is the pin.",
    steps: [
      "Start; simulate: click the pin control on the GPIO read box to change the level.",
      WATCH_DEBUG,
    ],
  },
  "digital-write": {
    boxes: [GPIN("sw", 0, 0, 4, "SW1"), hb("led", "digital-write", 1, 0, { pin: 2 })],
    edges: [["sw", "led"]],
    about: "GPIO output sets the pin high for on (1) and low for off (0): GPIO 2 is the onboard LED on many boards.",
    steps: [
      "Start, then click SWITCH on the GPIO input box: the LED on the output box (and on the board) follows.",
    ],
  },
  "pwm-write": {
    boxes: [
      SRC({ payload: "64" }),
      hb("full", "inject", 0, 1, { payload: "255", interval: 0 }, "INJ2"),
      hb("pwm", "pwm-write", 1, 0, { pin: 2 }),
    ],
    edges: [
      ["in", "pwm"],
      ["full", "pwm"],
    ],
    about: "PWM out sets the brightness (duty 0…255) of an LED on GPIO 2.",
    steps: ["Click ▶ on 64 (dim) or 255 (full) and watch the LED."],
  },
  pulse: {
    boxes: [GPIN("btn", 0, 0, 4, "BTN1"), hb("pls", "pulse", 1, 0, { pin: 2, width: 500 })],
    edges: [["btn", "pls"]],
    about: "Pulse out gives one pulse of 500 ms on GPIO 2 for each trigger.",
    steps: ["Start, then press PUSH on the GPIO input box: the LED flashes for half a second."],
  },
  display: {
    boxes: [SRC({ payload: "Hello" }), hb("lcd", "display", 1, 0, { row: 0, label: "Msg" })],
    edges: [["in", "lcd"]],
    about: "Display writes the value on a row of the board's screen (TTGO T-Display and others).",
    steps: [PRESS_INJECT, "The screen preview (Virtual pins strip) shows Msg Hello."],
  },
  peripheral: {
    boxes: [
      GPIN("btn", 0, 0, 4, "BTN1"),
      hb("per", "peripheral", 1, 0, { kind: "servo", trigger: "BTN1", angle: 90 }),
    ],
    edges: [["btn", "per"]],
    about:
      "Peripheral does one operation each time its Trigger input rises: here a servo turns to 90°.",
    steps: [
      "Start, then press PUSH on the GPIO input box: the servo turns to 90° (shown on the box).",
      "Change Angle in Properties, or take it from another connected input.",
    ],
  },
  "output-device": {
    boxes: [
      SRC({ payload: "0" }),
      hb("b", "inject", 0, 1, { payload: "180", interval: 0 }, "INJ2"),
      hb("out", "output-device", 1, 0, {}),
    ],
    edges: [
      ["in", "out"],
      ["b", "out"],
    ],
    about: "Output device moves a servo or stepper (or shows on a display) from the value it gets.",
    steps: [
      "Choose the device and pins in Properties (the wiring help is shown there).",
      "Click ▶ on 0 or 180.",
    ],
  },
  pwa: {
    boxes: [
      hb("kb", "pwa", 0, 0, {}, "PWA1"),
      DBG(1),
      hb("tpl", "template", 1, 1, { template: '{"text":"You pressed {{payload}}"}' }),
    ],
    edges: [
      ["kb", "dbg"],
      ["kb", "tpl"],
      ["tpl", "kb"],
    ],
    about:
      "A phone page with a keyboard: each key goes to Debug, and the Template answers back on the page.",
    steps: [
      "Select the PWA box and click 📱 Publish test page in Properties.",
      "Start, then press keys on the page: Debug shows them, and the page shows “You pressed …”.",
    ],
  },
  "voice-in": {
    boxes: [hb("voice", "voice-in", 0, 0, {}), DBG(1)],
    edges: [["voice", "dbg"]],
    about:
      "Voice command (ESP32-S3 with a PDM microphone) sends the command it heard as text.",
    steps: [
      "Simulate: click 🎤 on the box and speak (the browser's speech recognition), or type a phrase on the box.",
      "Real board: say the wake word, then a command from the list in Properties.",
    ],
  },
  speak: {
    boxes: [SRC({ payload: "hello world" }), hb("say", "speak", 1, 0, {})],
    edges: [["in", "say"]],
    about: "Speak says the text through an I2S amplifier and speaker.",
    steps: [PRESS_INJECT, "Simulate: this PC says it through its speakers; a board says it through the amplifier."],
  },
  camera: {
    boxes: [
      GPIN("btn", 0, 0, 4, "BTN1"),
      hb("cam", "camera", 1, 0, {}),
      hb("scr", "test-screen", 2, 0, {}),
    ],
    edges: [
      ["btn", "cam"],
      ["cam", "scr"],
    ],
    about: "Camera takes a still picture for each press (Freenove ESP32-S3 CAM board).",
    steps: ["Start, then press PUSH on the GPIO input box: the Screen box shows the picture."],
  },
  debug: {
    boxes: [SRC({ payload: '{"temp":21.5}' }), DBG(1)],
    edges: [["in", "dbg"]],
    about: "Debug shows each value it gets, in the box and in the console.",
    steps: [PRESS_INJECT, "In Properties choose to show the payload or the whole message."],
  },
  // Switch / Push button (older flows): their replacement, a GPIO input.
  "test-switch": {
    boxes: [GPIN("sw", 0, 0, 4, "SW1"), DBG(1)],
    edges: [["sw", "dbg"]],
    about:
      "Switch is replaced by GPIO input: its box has SWITCH (and PUSH) while simulating or emulating, and the same box reads the real switch on the circuit.",
    steps: ["Start, then click SWITCH on the GPIO input box: Debug shows 1 and 0."],
  },
  "test-button": {
    boxes: [GPIN("btn", 0, 0, 4, "BTN1"), DBG(1)],
    edges: [["btn", "dbg"]],
    about:
      "Push button is replaced by GPIO input: its box has PUSH (held = pressed) while simulating or emulating, and the same box reads the real button on the circuit.",
    steps: ["Start, then press and release PUSH on the GPIO input box: Debug shows 1, then 0."],
  },
  "test-scope": {
    boxes: [hb("gen", "func-gen", 0, 0, { wave: "sine", freq: 0.5 }), hb("scope", "test-scope", 1, 0, {})],
    edges: [["gen", "scope"]],
    about: "Oscilloscope draws the values it gets over time; here a 0.5 Hz sine from the Function generator.",
    steps: ["Start: the scope draws the sine wave. Change the generator's waveform (square, triangle, sawtooth) and start again."],
  },
  "func-gen": {
    boxes: [
      hb("gen", "func-gen", 0, 0, { wave: "sine", freq: 0.5, amplitude: 127.5, offset: 127.5, decimals: 0 }),
      hb("scope", "test-scope", 1, 0, {}),
      hb("pwm", "pwm-write", 1, 2, { pin: 2 }),
    ],
    edges: [
      ["gen", "scope"],
      ["gen", "pwm"],
    ],
    about:
      "A 0.5 Hz sine between 0 and 255 (amplitude 127.5, offset 127.5): the Oscilloscope draws it and PWM out fades the LED on GPIO 2 up and down.",
    steps: [
      "Start: the scope draws the wave; the PWM box shows the duty (and the board's LED breathes).",
      "Try Square (with a duty cycle), Triangle or Sawtooth, or another frequency.",
    ],
  },
  "test-screen": {
    boxes: [
      SRC({
        payload:
          "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90'><rect width='160' height='90' fill='%232563eb'/><text x='80' y='56' font-size='26' fill='white' text-anchor='middle'>Hello</text></svg>",
      }),
      hb("scr", "test-screen", 1, 0, {}),
    ],
    edges: [["in", "scr"]],
    about:
      "Screen shows the picture it gets (a Camera's, a picture address or a data: URL), in the simulation only.",
    steps: [PRESS_INJECT, "The Screen box shows the picture; click it to see it full size."],
  },
  // No wires: the switch and the LED have "Show on the Status display" ticked.
  status: {
    boxes: [
      { ...GPIN("sw", 0, 0, 4, "SW1"), status: true },
      { ...hb("led", "digital-write", 1, 0, { pin: 13 }), status: true },
      hb("st", "status", 0, 2, {}), // below the switch's PUSH / SWITCH
    ],
    edges: [["sw", "led"]],
    about:
      'Status is an I2C display (here a 16×2 LCD) for the state of other nodes. The GPIO input and the GPIO output have "Show on the Status display" ticked in Properties, so each has a line: GPIO 4 and GPIO 13, HIGH or LOW.',
    steps: [
      "Start, then click SWITCH on the GPIO input box: both lines of the Status box change to HIGH, and back to LOW.",
      'Select any other box and tick "Show on the Status display" in Properties to give it a line too; with more lines than the display has, it pages through them.',
    ],
  },
};
// Pairs share one example.
for (const [a, b] of [
  ["mqtt-out", "mqtt-in"],
  ["ble-out", "ble-in"],
  ["web-out", "web-in"],
  ["link-out", "link-in"],
])
  HELP_EXAMPLES[a] = HELP_EXAMPLES[b];

// Any other type: Inject → node → Debug (as far as it has inputs and outputs).
function genericExample(type) {
  const c = catalog[type] || {};
  const boxes = [],
    edges = [];
  if (!c.source) boxes.push(SRC({ payload: c.inType === "String" ? "hello" : "1" }));
  boxes.push(hb("node", type, c.source ? 0 : 1, 0, {}));
  if (!c.sink) boxes.push(DBG(c.source ? 1 : 2));
  if (!c.source) edges.push(["in", "node"]);
  if (!c.sink) edges.push(["node", "dbg"]);
  return {
    boxes,
    edges,
    about: `${c.label} with ${c.source ? "" : "an Inject box before it"}${!c.source && !c.sink ? " and " : ""}${c.sink ? "" : "a Debug box after it"}.`,
    steps: [c.source ? "Start the example." : PRESS_INJECT, ...(c.sink ? [] : [WATCH_DEBUG])],
  };
}
function helpFlowOf(type) {
  const ex = HELP_EXAMPLES[type] || genericExample(type);
  const ids = new Map(ex.boxes.map((b) => [b.key, newNodeId()]));
  const nodes = ex.boxes.map((b) => {
    const c = catalog[b.type];
    return {
      id: ids.get(b.key),
      type: b.type,
      label: b.label || c.label,
      x: HX[b.col],
      y: HY[b.row],
      config: {
        ...Object.fromEntries(c.fields.map((f) => [f.key, f.default])),
        ...b.config,
      },
      ...(b.name ? { name: b.name } : {}),
      ...(b.status ? { status: true } : {}), // shown on the Status display
    };
  });
  return {
    example: ex,
    flow: {
      name: `Help · ${catalog[type].label}`,
      language: flow.language,
      nodes,
      // [from, to, output?]: output 1, 2, … for boxes with several outputs (Counter).
      edges: ex.edges.map(([a, b, out]) => ({
        from: ids.get(a),
        to: ids.get(b),
        ...(out > 1 ? { port: out - 1 } : {}),
      })),
    },
  };
}

// ── Showing an example ──
let helpSaved = null; // { flow, dirty, tab, chip, selected, split, undo, type }
const helpActive = () => !!helpSaved;
function openHelp(type) {
  if (!catalog[type]) return;
  if (helpSaved) closeHelp(false);
  storeChipSettings(); // the chip's Device panel edits stay with your flow
  const { example, flow: ex } = helpFlowOf(type);
  helpSaved = {
    flow,
    dirty,
    tab: currentTab,
    chip: currentChip,
    selected,
    split: typeof split === "object" && split.on,
    undo: undoStack.splice(0),
    type,
    state: $("saveState").textContent,
  };
  // Always one screen: the example in the (only) editor screen.
  if (helpSaved.split) setSplit(false);
  flow = ex;
  currentTab = null;
  currentChip = null;
  ensureNames();
  selected = selectedLink = pending = null;
  alsoSelected = new Set();
  dirty = false;
  undoButton();
  $("flowName").value = flow.name;
  $("flowName").readOnly = true;
  $("saveState").textContent = "Help example · not saved";
  document.body.classList.add("help-mode");
  render();
  $("properties").replaceChildren(
    el("p", "muted", "Help example: select a box to see its settings, or try it with ▶."),
  );
  helpWindow(type, example);
}
// back: restore your flow as it was.
function closeHelp(back = true) {
  if (!helpSaved) return;
  const s = helpSaved;
  helpSaved = null;
  $("helpWindow")?.remove();
  document.body.classList.remove("help-mode");
  $("flowName").readOnly = false;
  // A run of the example stops (it is not your flow).
  api("runtime/status")
    .then((st) => st.running && $("stop").click())
    .catch(() => {});
  if (!back) return;
  flow = s.flow;
  dirty = s.dirty;
  currentTab = s.tab;
  currentChip = s.chip;
  selected = s.selected;
  selectedLink = pending = null;
  alsoSelected = new Set();
  undoStack.splice(0, undoStack.length, ...s.undo);
  undoButton();
  $("flowName").value = flow.name || "";
  $("saveState").textContent = s.state;
  render();
  if (s.split) setSplit(true);
  if (selected && flow.nodes.some((n) => n.id === selected)) showNode();
  else
    $("properties").replaceChildren(
      el("p", "muted", "Select a node on the canvas to configure it."),
    );
}
// Copies the example's nodes into your flow (onto the tab you were on).
function copyHelpIntoFlow() {
  const data = {
    microflow: "nodes",
    nodes: structuredClone(flow.nodes),
    edges: structuredClone(flow.edges),
  };
  closeHelp(true);
  pasteNodes(data);
}

const HELP_MODES = {
  host: "Simulate on this PC: nothing to upload; inputs (buttons, switches, pins) are clicked on screen.",
  device:
    "Real board (monitor): upload this example to the board first (↥ Upload to board), then ▶ watches it over MQTT; Inject and on-screen buttons trigger it.",
  emulate:
    "Real board + PC inputs (USB): the board runs the example (upload it first) and this PC's on-screen buttons and switches drive its inputs over USB.",
};
function helpWindow(type, example) {
  const c = catalog[type];
  const box = el("div", "help-window");
  box.id = "helpWindow";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", `Help: ${c.label}`);
  const head = el("div", "help-head");
  const min = el("button", "help-min", "–");
  min.title = "Fold / unfold";
  min.onclick = () => box.classList.toggle("folded");
  const close = el("button", "help-x", "✕");
  close.title = "Back to my flow";
  close.onclick = () => closeHelp(true);
  head.append(el("span", "node-icon", c.icon), el("b", "", `Help · ${c.label}`), min, close);
  const body = el("div", "help-body");
  body.append(
    el("p", "help-about", example.about),
    el("h4", "", "Try it"),
  );
  const ol = el("ol");
  for (const s of [
    "Choose how to run it below, then press ▶ Start.",
    ...example.steps,
    "Select any box of the example to see its settings; change them freely (it is not saved).",
  ])
    ol.append(el("li", "", s));
  body.append(ol);
  // How to run: the same choice as the list beside the start button.
  const mode = el("select");
  for (const [v, t] of [
    ["host", "Simulate on this PC"],
    ["device", "Real board (monitor)"],
    ["emulate", "Real board + PC inputs (USB)"],
  ]) {
    const o = el("option", "", t);
    o.value = v;
    mode.append(o);
  }
  mode.value = "host";
  const note = el("p", "muted help-mode-note");
  const setMode = () => {
    $("runtimeMode").value = mode.value;
    $("runtimeMode").dispatchEvent(new Event("change"));
    note.textContent = HELP_MODES[mode.value];
  };
  mode.onchange = setMode;
  setMode();
  const runRow = el("div", "help-run");
  runRow.append(
    el("label", "", "Run with "),
    mode,
    button("▶ Start", () => $("start").click(), "primary"),
    button("■ Stop", () => $("stop").click()),
  );
  body.append(el("h4", "", "How to run"), runRow, note);
  const more = el("details", "help-more");
  more.append(el("summary", "", `About ${c.label}`), el("p", "muted", c.help));
  body.append(more);
  const end = el("div", "step-row");
  const copy = button("⧉ Copy into my flow", copyHelpIntoFlow);
  copy.title = "Back to your flow, with the example's boxes pasted onto the tab you were on";
  end.append(copy, button("✕ Back to my flow", () => closeHelp(true), "primary"));
  body.append(end);
  box.append(head, body);
  document.body.append(box);
  // Drag by the title bar; kept on screen.
  head.onpointerdown = (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left,
      dy = e.clientY - r.top;
    head.onpointermove = (m) => {
      box.style.left = Math.max(0, Math.min(innerWidth - 120, m.clientX - dx)) + "px";
      box.style.top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) + "px";
      box.style.right = "auto";
    };
    head.onpointerup = () => (head.onpointermove = head.onpointerup = null);
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHelp(true);
  });
}
// The button at the bottom of Node properties (app.js showNode).
function helpButton(n) {
  const b = el("button", "full help-button", `❓ Help example: ${catalog[n.type]?.label || n.type}`);
  b.title =
    "Show a small example flow for this node, with how to try it (your flow is kept and comes back)";
  b.onclick = () => openHelp(n.type);
  return b;
}
// While an example is shown, actions on flows wait for “Back to my flow”.
const HELP_BLOCKED = ["save", "library", "import", "history", "tests", "splitToggle"];
document.addEventListener(
  "click",
  (e) => {
    if (!helpSaved) return;
    const b = e.target.closest?.("button");
    if (!b || !HELP_BLOCKED.includes(b.id)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast("This is a help example: click ✕ Back to my flow first (or ⧉ Copy into my flow).");
  },
  true,
);
