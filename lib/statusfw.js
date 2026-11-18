// Status node: one I2C display (a character LCD with a PCF8574 backpack, or an
// SSD1306 OLED) that shows the state of every node whose "Show on the Status
// display" box is ticked in Properties (n.status), one line each: "GPIO 13 HIGH",
// "GPIO 5 PWM 128", "TIMER1 ON", "TEMP1 21.5". A line changes when its node handles
// a new value and stays as it is until then; with more ticked nodes than lines, the
// screen pages through them. The node has no wires.
//
// The screen is an Output device I2C display as far as the rest of the flow is
// concerned (devices.asDevice), so its libraries, Wire.begin, the shared I2C bus
// and the address checks are those of lib/devices.js.
const devices = require("./devices");

// How a node's value reads on the display (anything else: the value itself).
const KINDS = {
  "digital-write": "level",
  "digital-read": "level",
  "gpio-watch": "level",
  "pwm-write": "pwm",
  pulse: "onoff",
  "pulse-train": "onoff",
  logic: "onoff",
  timer: "onoff",
  counter: "onoff",
  "test-switch": "onoff",
  "test-button": "onoff",
};
// Nodes named by their pin ("GPIO 13"); the others by their variable name.
const PIN_TYPES = new Set([
  "digital-write",
  "digital-read",
  "gpio-watch",
  "pwm-write",
  "pulse",
]);
// Nodes that cannot show their status: the display itself, the simulation-only
// Screen, and custom boxes (their inner nodes run in their place).
const NOT_SHOWN = new Set(["status", "test-screen", "custom"]);
const canShow = (type) => !NOT_SHOWN.has(type);
const kindOf = (type) => KINDS[type] || "value";

// The line's first words: "GPIO 13", or the variable name; "COUNT1 out2" for one
// output of a node with several (Counter).
function headOf(n, port) {
  const head = PIN_TYPES.has(n.type)
    ? `GPIO ${n.config.pin}`
    : n.name || n.label;
  return port === undefined ? head : `${head} out${port + 1}`;
}
const isOff = (v) => v === "0" || v === "false";
// The status line for a value (the simulator and the IDE; the firmware's mfStatus
// calls build the same text in C++).
function text(n, value, port) {
  const v = String(value);
  const head = headOf(n, port);
  const kind = kindOf(n.type);
  if (kind === "level") return `${head} ${isOff(v) ? "LOW" : "HIGH"}`;
  if (kind === "onoff") return `${head} ${isOff(v) ? "OFF" : "ON"}`;
  if (kind === "pwm") return `${head} PWM ${v}`;
  return `${head} ${v}`;
}
const BLANK = (n) => `${headOf(n)} -`; // before the node has handled a value

// A C string literal of printable ASCII (a display shows nothing else).
const cStr = (s) =>
  '"' +
  String(s)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "'")
    .replace(/\?/g, "_") +
  '"';
// C++ expression for the status line of `v` (a String), as text() builds it.
function cExpr(n, v, port) {
  const head = headOf(n, port);
  const off = `(${v} == "0" || ${v} == "false")`;
  const kind = kindOf(n.type);
  if (kind === "level")
    return `String(${cStr(head + " ")}) + (${off} ? "LOW" : "HIGH")`;
  if (kind === "onoff")
    return `String(${cStr(head + " ")}) + (${off} ? "OFF" : "ON")`;
  if (kind === "pwm") return `String(${cStr(head + " PWM ")}) + ${v}`;
  return `String(${cStr(head + " ")}) + ${v}`;
}

const screenOf = (nodes) => nodes.find((n) => n.type === "status");
// The nodes shown, in flow order (line k of the display is shown()[k]); none
// without a Status node.
const shown = (nodes) =>
  screenOf(nodes) ? nodes.filter((n) => n.status && canShow(n.type)) : [];
// The C++ statement that reports node n's value `v` (or "" when n is not shown).
function call(nodes, n, v = "value", port) {
  const k = shown(nodes).indexOf(n);
  return k < 0 ? "" : `mfStatus(${k}, ${cExpr(n, v, port)});`;
}
// The Status node as an Output device I2C display (lib/devices.js).
const asDisplay = (n) => ({
  ...n,
  type: "output-device",
  config: { ...n.config, device: "i2cdisplay" },
});
// Lines on the display and characters per line.
const gridOf = (c) => devices.displayGrid(c);

// Globals: the line texts, mfStatus() for the node functions and mfStatusDraw()
// for loop(). Drawn at most 10 times a second; only changed lines are rewritten,
// except when the page turns.
function globals(nodes) {
  const screen = screenOf(nodes);
  if (!screen) return "";
  const c = screen.config;
  const list = shown(nodes);
  const lines = list.length ? list.map(BLANK) : ["No status"];
  const [rows, cols] = gridOf(c);
  const oled = devices.isOled(c);
  const a = devices.displayAddr(c).slice(2);
  const size = Number(c.textSize) || 1;
  const put = oled
    ? `mfOled${a}.fillRect(0, r * ${8 * size}, 128, ${8 * size}, SSD1306_BLACK); mfOled${a}.setTextSize(${size}); mfOled${a}.setTextColor(SSD1306_WHITE); mfOled${a}.setCursor(0, r * ${8 * size}); mfOled${a}.print(t); any = true;`
    : `while (t.length() < ${cols}) t += ' '; mfLcd${a}.setCursor(0, r); mfLcd${a}.print(t);`;
  return `// Status display (${screen.label.replace(/[^\x20-\x7e]/g, "?")}): one line per node that shows its status.
const uint8_t MF_STATUS_N = ${lines.length};
String mfStatusText[MF_STATUS_N] = { ${lines.map(cStr).join(", ")} };
bool mfStatusDirty[MF_STATUS_N];
void mfStatus(uint8_t k, const String& t) {
  if (k < MF_STATUS_N && mfStatusText[k] != t) { mfStatusText[k] = t; mfStatusDirty[k] = true; }
}
void mfStatusDraw() {
  static unsigned long drawn = 0, turned = 0;
  static uint8_t page = 0, onScreen = 255;
  if (millis() - drawn < 100UL) return;
  drawn = millis();${oled ? `\n  if (!mfOledOk${a}) return;\n  bool any = false;` : ""}
  const uint8_t pages = (MF_STATUS_N + ${rows - 1}) / ${rows};
  if (pages > 1 && millis() - turned >= ${c.page}UL) { turned = millis(); page = (page + 1) % pages; }
  bool all = page != onScreen; // a new page: every line
  onScreen = page;
  for (uint8_t r = 0; r < ${rows}; r++) {
    uint8_t k = page * ${rows} + r;
    if (!all && (k >= MF_STATUS_N || !mfStatusDirty[k])) continue;
    String t = k < MF_STATUS_N ? mfStatusText[k] : String();
    if (k < MF_STATUS_N) mfStatusDirty[k] = false;
    if (t.length() > ${cols}) t = t.substring(0, ${cols});
    ${put}
  }${oled ? `\n  if (any) mfOled${a}.display();` : ""}
}`;
}
const loop = (nodes) => (screenOf(nodes) ? ["mfStatusDraw();"] : []);

// Flow checks (lib/flow.js analyze()).
function check(flow) {
  const errors = [],
    warnings = [];
  const screens = flow.nodes.filter((n) => n.type === "status");
  const ticked = flow.nodes.filter((n) => n.status && canShow(n.type));
  if (screens.length > 1)
    errors.push(
      `A board has one Status display: keep one of ${screens.map((n) => n.label).join(", ")}.`,
    );
  if (!screens.length && ticked.length)
    warnings.push(
      `${ticked.map((n) => n.name || n.label).join(", ")}: "Show on the Status display" is ticked, but the flow has no Status node, so nothing shows it.`,
    );
  if (screens.length && !ticked.length)
    warnings.push(
      `${screens[0].label}: no node shows its status yet. Tick "Show on the Status display" in a node's Properties.`,
    );
  if (screens.length) {
    const a = devices.displayAddr(screens[0].config);
    const other = flow.nodes.find(
      (n) =>
        n.type === "output-device" &&
        n.config.device === "i2cdisplay" &&
        devices.displayAddr(n.config) === a,
    );
    if (other)
      errors.push(
        `${screens[0].label} and ${other.label} use the same I2C display at ${a}: the Status display needs a screen of its own. Give one of them another address (e.g. a second LCD at 0x3F).`,
      );
  }
  return { errors, warnings };
}

const fields = [
  {
    key: "screen",
    label: "Display",
    type: "select",
    default: "lcd1602",
    options: devices.DISPLAYS,
  },
  {
    key: "sda",
    label: "SDA pin",
    type: "number",
    default: 21,
    min: 0,
    max: 54,
    integer: true,
  },
  {
    key: "scl",
    label: "SCL pin",
    type: "number",
    default: 22,
    min: 0,
    max: 54,
    integer: true,
  },
  {
    key: "addr",
    label: "I2C address",
    type: "select",
    default: "auto",
    options: devices.DISPLAY_ADDR,
  },
  {
    key: "textSize",
    label: "Text size (OLED)",
    type: "select",
    default: "1",
    options: {
      1: "Small (21 characters × 8 lines on 128×64)",
      2: "Medium (10 × 4)",
    },
    when: { screen: ["oled64", "oled32"] },
  },
  {
    key: "page",
    label: "Next page every (ms, when more nodes than lines)",
    type: "number",
    default: 3000,
    min: 500,
    max: 60000,
    integer: true,
  },
];
const node = {
  label: "Status",
  icon: "☰",
  color: "#4d8a6e",
  tint: "#e4f1ea",
  group: "OUTPUT",
  sink: true,
  standalone: true, // no wires: nodes report to it through their Properties
  help: 'An I2C display that shows the status of other nodes, one line each, e.g. "GPIO 13 HIGH". Tick "Show on the Status display" in the Properties of any node to give it a line; the line changes when the node handles a new value, and stays until then. GPIO boxes show HIGH / LOW (PWM out its duty), Logic, Timer, Counter and Pulse ON / OFF, other nodes their variable name and value. With more nodes than lines, the display pages through them. Wiring: VCC to 3.3 V (or 5 V for most LCD backpacks), GND, SDA and SCL to the pins set here. 16×2 / 20×4 character LCD with a PCF8574 backpack (address 0x27, sometimes 0x3F) or an SSD1306 OLED (0x3C). One Status node per board; it shares the I2C bus with other I2C displays and gyroscopes but needs an address of its own.',
  fields,
  pinSpec: [
    { key: "sda", use: "out", sim: false, shared: "i2c" },
    { key: "scl", use: "out", sim: false, shared: "i2c" },
  ],
  validate(c) {
    if (c.sda === c.scl)
      throw Error("Status: SDA and SCL must be different pins.");
  },
  summary: "I2C display · SDA {sda} · SCL {scl}",
  fw: {
    globals: (n) => devices.displayGlobals(asDisplay(n)),
    setup: (n) => devices.outputSetup(asDisplay(n)),
  },
};

module.exports = {
  node,
  KINDS,
  PIN_TYPES,
  canShow,
  kindOf,
  text,
  shown,
  call,
  globals,
  loop,
  check,
  gridOf,
};
