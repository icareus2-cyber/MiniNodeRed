// Single source of truth for node types: editor metadata, validation,
// host-simulator behaviour (host) and Arduino C++ generation (fw).
// host(value, node, ctx) returns the payload to forward, or undefined to stop.
// fw.body(node, i) emits C++ that may modify `value` or `return;` to stop.
const blefw = require("./blefw");
const webfw = require("./webfw");
const termfw = require("./termfw");
const logic = require("./logic");
const devices = require("./devices");
const timer = require("./timer");
const counter = require("./counter");
const peripheral = require("./peripheral");
const camerafw = require("./camerafw");
const speechfw = require("./speechfw");
const customfw = require("./custom");
const pwafw = require("./pwafw");
const statusfw = require("./statusfw");
const quoted = (value) =>
  '"' +
  Array.from(Buffer.from(String(value ?? ""), "utf8"), (byte) =>
    byte === 34
      ? '\\"'
      : byte === 92
        ? "\\\\"
        : byte >= 32 && byte < 127 && byte !== 63 // escape ? to avoid trigraphs
          ? String.fromCharCode(byte)
          : "\\" + byte.toString(8).padStart(3, "0"),
  ).join("") +
  '"';
const toNumber = (value) => {
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
const cNumber = (n) => {
  const s = String(Number(n));
  return /[.e]/i.test(s) ? s : s + ".0";
};
const isOff = (value) => value === "0" || value === "false";
// Input mode → pinMode(). Pressed reads 0 only with the pull-up (a button to GND).
const pinModeOf = (pull) =>
  pull === "pullup" ? "INPUT_PULLUP" : pull === "pulldown" ? "INPUT_PULLDOWN" : "INPUT";
// Pin reads of input nodes; PC input emulation builds read through emufw's wrappers.
const readDigital = (build) =>
  build?.emulate ? "mfDigitalRead" : "digitalRead";
const readAnalog = (build) => (build?.emulate ? "mfAnalogRead" : "analogRead");
// Analog sample resolution: the board's own ADC (ESP8266 10 bits, ESP32 12 bits)
// or a chosen number of bits; the reading is shifted to that range.
const ADC_BITS = {
  native: "Board default (ESP8266 10 bits, ESP32 12 bits)",
  8: "8 bits (0–255)",
  10: "10 bits (0–1023)",
  12: "12 bits (0–4095)",
};
const adcNativeBits = (family) => (family === "esp8266" ? 10 : 12);
function adcBits(bits, family) {
  return bits && bits !== "native" ? Number(bits) : adcNativeBits(family);
}
// C++ expression: a raw reading shifted from the board's bits to the chosen ones.
function adcScaled(expr, bits, family) {
  const shift = adcNativeBits(family) - adcBits(bits, family);
  if (!shift) return expr;
  return shift > 0
    ? `((int)(${expr}) >> ${shift})`
    : `((int)(${expr}) << ${-shift})`;
}
// {{device}} in a topic is replaced with the Device ID at runtime (firmware, simulator, tests).
const DEVICE = "{{device}}";
// C++ expression for a topic: a literal, or mfTopic(...) when it contains {{device}}.
const cTopic = (topic) =>
  topic.includes(DEVICE) ? `mfTopic(${quoted(topic)}).c_str()` : quoted(topic);
function checkTopic(topic, wildcards) {
  if (typeof topic === "string") topic = topic.replaceAll(DEVICE, "x");
  if (
    typeof topic !== "string" ||
    !topic ||
    topic.length > 128 ||
    topic.includes("\0")
  )
    throw Error("Invalid MQTT topic.");
  if (!wildcards && /[+#]/.test(topic))
    throw Error("Output topics cannot contain + or #.");
  if (
    topic
      .split("/")
      .some(
        (part, i, parts) =>
          (part.includes("+") && part !== "+") ||
          (part.includes("#") && (part !== "#" || i !== parts.length - 1)),
      )
  )
    throw Error("MQTT wildcards must occupy an entire level; # must be last.");
}
// Bluetooth link name: boards using the same name hear each other.
const linkField = {
  key: "link",
  label: "Link name",
  type: "text",
  default: "link1",
};
function checkLink(c) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(c.link))
    throw Error("Link name may use letters, digits, - and _ (max 32).");
}
// Web in/out name: the URL path /api/<name>.
const webName = (def) => ({
  key: "name",
  label: "Name (URL /api/<name>)",
  type: "text",
  default: def,
});
function checkWebName(c) {
  if (!webfw.NAME.test(c.name))
    throw Error(
      "Web name may use lowercase letters, digits, - and _ (max 32), starting with a letter or digit.",
    );
}
const pinField = (def) => ({
  key: "pin",
  label: "GPIO number",
  type: "number",
  default: def,
  min: 0,
  max: 54, // ESP32-P4 has GPIO 0–54; each board's own pins are checked
  integer: true,
});
// Display colours (Adafruit ST77XX palette).
const LCD_COLORS = {
  white: "ST77XX_WHITE",
  green: "ST77XX_GREEN",
  yellow: "ST77XX_YELLOW",
  cyan: "ST77XX_CYAN",
  orange: "ST77XX_ORANGE",
  red: "ST77XX_RED",
  magenta: "ST77XX_MAGENTA",
};
// ── Radio in/out: one box per direction, the transport chosen in Properties ──
const PROTOCOLS = {
  mqtt: "MQTT (WiFi + broker)",
  espnow: "ESP-NOW (ESP32, no router)",
  i2c: "I2C (wire, short range)",
  local: "Local MQTT (this board is the broker)",
};
const protocolOf = (c) => c?.protocol || "mqtt";
// Fields with `when` show only for those values of other fields (Properties).
const radioFields = (dir) => [
  {
    key: "protocol",
    label: "Protocol",
    type: "select",
    default: "mqtt",
    options: PROTOCOLS,
  },
  {
    key: "topic",
    label: "Topic",
    type: "text",
    default: dir === "in" ? "workshop/sensor" : "workshop/status",
    when: { protocol: ["mqtt", "espnow", "local"] },
  },
  ...(dir === "out"
    ? [
        {
          key: "retain",
          label: "Retain",
          type: "select",
          default: "no",
          options: { no: "No", yes: "Yes" },
          when: { protocol: ["mqtt", "local"] },
        },
      ]
    : []),
  {
    key: "channel",
    label:
      "ESP-NOW channel (boards without WiFi; WiFi boards use the router's)",
    type: "number",
    default: 1,
    min: 1,
    max: 13,
    integer: true,
    when: { protocol: ["espnow"] },
  },
  {
    key: "i2cRole",
    label: "I2C role",
    type: "select",
    default: "controller",
    options:
      dir === "in"
        ? {
            controller: "Controller: poll a peripheral",
            peripheral: "Peripheral: receive from the controller",
          }
        : {
            controller: "Controller: write to a peripheral",
            peripheral: "Peripheral: reply to the controller's polls",
          },
    when: { protocol: ["i2c"] },
  },
  {
    key: "address",
    label: "I2C address (8–119)",
    type: "number",
    default: 8,
    min: 8,
    max: 119,
    integer: true,
    when: { protocol: ["i2c"] },
  },
  {
    ...pinField(21),
    key: "sda",
    label: "SDA pin",
    when: { protocol: ["i2c"] },
  },
  {
    ...pinField(22),
    key: "scl",
    label: "SCL pin",
    when: { protocol: ["i2c"] },
  },
  ...(dir === "in"
    ? [
        {
          key: "interval",
          label: "Poll every (ms)",
          type: "number",
          default: 200,
          min: 20,
          max: 60000,
          integer: true,
          when: { protocol: ["i2c"], i2cRole: ["controller"] },
        },
      ]
    : []),
  // Local MQTT: the broker this board runs (the same for all its Radio boxes).
  {
    key: "localPort",
    label: "Broker port on this board",
    type: "number",
    default: 1883,
    min: 1,
    max: 65535,
    integer: true,
    when: { protocol: ["local"] },
  },
  {
    key: "localUser",
    label: "Broker login: username (optional)",
    type: "text",
    default: "",
    empty: true,
    when: { protocol: ["local"] },
  },
  {
    key: "localPass",
    label: "Broker login: password",
    type: "secret",
    default: "",
    empty: true,
    when: { protocol: ["local"] },
  },
  ...(dir === "out" ? radioOutAdvanced : []),
];
// Radio out (MQTT), Advanced: its own broker and login, and what it publishes.
const radioOutAdvanced = [
  {
    key: "broker",
    label:
      "Broker (blank = the flow's broker) · host, host:port or mqtt://host:port",
    type: "text",
    default: "",
    empty: true,
    advanced: true,
    when: { protocol: ["mqtt"] },
  },
  {
    key: "clientId",
    label: "Client ID (blank = <Device ID>-<node id>)",
    type: "text",
    default: "",
    empty: true,
    advanced: true,
    when: { protocol: ["mqtt"] },
  },
  {
    key: "username",
    label: "Username (own broker)",
    type: "text",
    default: "",
    empty: true,
    advanced: true,
    when: { protocol: ["mqtt"] },
  },
  {
    key: "password",
    label: "Password (own broker)",
    type: "secret",
    default: "",
    empty: true,
    advanced: true,
    when: { protocol: ["mqtt"] },
  },
  {
    key: "payloadMode",
    label: "Payload",
    type: "select",
    default: "payload",
    options: {
      payload: "msg.payload (the incoming value)",
      text: "Fixed text",
      template: "Template: {{payload}} = incoming value",
      msg: "Complete msg object (Node-RED language)",
    },
    advanced: true,
    when: { protocol: ["mqtt"] },
  },
  {
    key: "payloadText",
    label: "Payload text",
    type: "text",
    default: "{{payload}}",
    empty: true,
    advanced: true,
    when: { protocol: ["mqtt"], payloadMode: ["text", "template"] },
  },
];
// "host", "host:port" or "mqtt://host:port" → { host, port }, or null when blank.
function parseBroker(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (/^(mqtts|wss?|https?):\/\//i.test(t))
    throw Error(
      "Broker: the board connects without TLS; use mqtt://host:port (or host:port).",
    );
  const m = /^(?:mqtt:\/\/)?([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?\/?$/i.exec(t);
  if (!m) throw Error("Broker must be a host, host:port or mqtt://host:port.");
  const port = m[2] ? Number(m[2]) : 1883;
  if (port < 1 || port > 65535) throw Error("Broker port must be 1–65535.");
  return { host: m[1], port };
}
// The Payload option as C++ (value = the incoming payload; mfIn = the whole message
// in the Node-RED language).
function payloadExpr(c, build, n) {
  const mode = c.payloadMode || "payload";
  if (mode === "text") return quoted(c.payloadText);
  if (mode === "template") {
    const parts = String(c.payloadText).split("{{payload}}");
    return parts.length === 1
      ? quoted(parts[0])
      : "(" +
          parts
            .map((p, i) => (i ? "value + " : "") + `String(${quoted(p)})`)
            .join(" + ") +
          ")";
  }
  if (mode === "msg" && build?.language === "nodered")
    return `mfMsg::out(mfIn, value, ${quoted(n?.msg ? require("./msg").checkFields(n.msg) : "{}")})`;
  return "value";
}
// The same in the simulator: v = payload text, msg = whole message (Node-RED language).
function payloadText(c, v, msg, n) {
  const mode = c.payloadMode || "payload";
  if (mode === "text") return c.payloadText;
  if (mode === "template")
    return String(c.payloadText).split("{{payload}}").join(String(v));
  if (mode === "msg" && msg) {
    const { msgOut, checkFields } = require("./msg");
    return msgOut(msg, String(v), n?.msg ? checkFields(n.msg) : "{}");
  }
  return String(v);
}
function checkRadio(c, wildcards) {
  if (c.broker !== undefined) parseBroker(c.broker);
  if (c.clientId && !/^[A-Za-z0-9_-]{1,64}$/.test(c.clientId))
    throw Error("Client ID may use letters, digits, - and _ (max 64).");
  if (c.clientId && !c.broker)
    throw Error("Client ID needs a broker of its own (Advanced → Broker).");
  if ((c.username || c.password) && !c.broker)
    throw Error(
      "Username and password are for a broker of its own (Advanced → Broker); the flow's broker login is in the Device panel.",
    );
  if (c.protocol === "i2c") {
    if (c.sda === c.scl) throw Error("SDA and SCL must be different pins.");
    return;
  }
  if (c.protocol === "local") {
    if (!/^[\x21-\x7e]{0,64}$/.test(c.localUser || ""))
      throw Error(
        "Local MQTT username: letters, digits and symbols without spaces (max 64).",
      );
    if (c.localPass && !c.localUser)
      throw Error("Local MQTT: a password needs a username too.");
  }
  checkTopic(c.topic, wildcards);
  if (c.protocol === "espnow" && Buffer.byteLength(c.topic) > 64)
    throw Error("ESP-NOW topics are limited to 64 bytes.");
}
// MQTT needs WiFi; ESP-NOW an ESP32-family radio; I2C runs on any board.
const radioNeeds = (c) =>
  ({ mqtt: "wifi", espnow: "espnow", local: "localbroker" })[protocolOf(c)] ||
  null;
const RADIO_SUMMARY = {
  mqtt: "MQTT · {topic}",
  espnow: "ESP-NOW · {topic}",
  i2c: "I2C · address {address}",
  local: "Local MQTT · {topic}",
};
// Radio in/out boxes that use MQTT (the broker, subscriptions, tests).
const isMqttRadio = (n) =>
  (n.type === "mqtt-in" || n.type === "mqtt-out") &&
  protocolOf(n.config) === "mqtt";
// ── C/C++ node (type "arduino"): the user's own C++ in a namespace of its own ──
// It computes; hardware (pins, Serial, WiFi, …) is done by the other nodes, wired in
// and out. These names are refused in its code, with the node to use instead.
const HARDWARE = [
  {
    names:
      "pinMode digitalRead digitalWrite digitalPinToInterrupt attachInterrupt detachInterrupt interrupts noInterrupts pulseIn pulseInLong shiftIn shiftOut tone noTone touchRead hallRead temperatureRead",
    use: "Use GPIO input, GPIO input (change), GPIO output or Pulse nodes and wire them to this node.",
  },
  {
    names:
      "analogRead analogReadMilliVolts analogReadResolution analogSetAttenuation analogSetPinAttenuation analogSetWidth adcAttachPin analogWrite analogWriteRange analogWriteFreq analogWriteResolution dacWrite ledcSetup ledcAttach ledcAttachPin ledcDetachPin ledcWrite ledcWriteTone",
    use: "Use Analog sample or PWM out nodes and wire them to this node.",
  },
  {
    names: "Serial Serial1 Serial2 HardwareSerial SoftwareSerial",
    use: "To show a value, send(…) it to a Debug node.",
  },
  {
    names:
      "Wire Wire1 TwoWire SPI SPIClass WiFi WiFiClient WiFiServer WiFiUDP mqtt PubSubClient BLEDevice esp_now Update ArduinoOTA ESP",
    use: "Use Radio in / Radio out (MQTT, ESP-NOW, I2C), BLE or Web nodes; WiFi and MQTT are managed by Microflow.",
  },
  {
    names: "EEPROM Preferences SPIFFS LittleFS SD",
    use: "Storage is not available in code yet; it will come as special functions.",
  },
  {
    names:
      "REG_WRITE REG_READ REG_SET_BIT REG_CLR_BIT REG_SET_FIELD REG_GET_FIELD WRITE_PERI_REG READ_PERI_REG SET_PERI_REG_MASK CLEAR_PERI_REG_MASK GPIO GPOS GPOC GPES GPEC volatile asm __asm__",
    use: "Chip registers are not accessible from code; use the hardware nodes.",
  },
];
const HARDWARE_NAMES = new Map(
  HARDWARE.flatMap((h) => h.names.split(" ").map((name) => [name, h.use])),
);
// ESP-IDF driver calls such as gpio_set_level(…) or esp_restart().
const HARDWARE_CALL =
  /\b((?:gpio|ledc|uart|i2c|spi|adc1|adc2|dac|rtc|esp|rmt|mcpwm|pcnt|i2s|touch_pad)_\w+)\s*\(/;
const MAX_CODE = 4000;
// Names a pin may not take: Arduino macros/constants and C++ keywords.
const RESERVED = new Set(
  (
    "HIGH LOW INPUT OUTPUT INPUT_PULLUP INPUT_PULLDOWN LED_BUILTIN PI DEG_TO_RAD RAD_TO_DEG " +
    "true false value send setup loop mfSetup mfLoop mfMessage String Serial " +
    "auto bool break case char class const continue default delete do double else enum extern " +
    "float for goto if inline int long new operator private protected public register return " +
    "short signed sizeof static struct switch template this typedef union unsigned using virtual void " +
    "volatile while namespace from " +
    "millis micros delay delayMicroseconds digitalRead digitalWrite analogRead analogWrite pinMode " +
    "map constrain min max abs random WiFi mqtt ESP"
  )
    .split(" ")
    .concat([...HARDWARE_NAMES.keys()]),
);
// ── Variable names: every node has one (n.name), unique in the flow ──
// Shown under the node's label. In an Arduino node, each connected input is a String
// variable with that name, holding the input's latest value.
const VAR_NAMES = {
  inject: "INJ",
  "mqtt-in": "RADIO",
  "ble-in": "BLE",
  terminal: "TERM",
  "web-in": "WEB",
  "gpio-watch": "GPIO{pin}",
  "pulse-train": "TRAIN",
  "analog-in": "ADC{pin}",
  threshold: "THRESH",
  compare: "CMP",
  scale: "MAP",
  throttle: "THROTTLE",
  template: "TPL",
  logic: "LOGIC",
  timer: "TIMER",
  counter: "COUNT",
  "link-in": "LINK",
  "link-out": "LINKOUT",
  arduino: "CODE",
  "digital-read": "GPIO{pin}",
  "digital-write": "OUT{pin}",
  "pwm-write": "PWM{pin}",
  pulse: "PULSE{pin}",
  display: "LCD",
  "mqtt-out": "RADIOOUT",
  "ble-out": "BLEOUT",
  "web-out": "WEBOUT",
  debug: "DEBUG",
  "test-switch": "SW",
  "test-button": "BTN",
  "func-gen": "FGEN",
  "test-scope": "SCOPE",
  "test-screen": "SCREEN",
  "input-device": "DEVICE",
  "output-device": "MOTOR",
  pwa: "PWA",
  "voice-in": "VOICE",
  speak: "SPEAK",
  peripheral: "PERIPH",
  camera: "CAMERA",
  status: "STATUS",
};
// C++ type of a node's variable in Arduino nodes it is wired into, when its Variable
// type is "auto": fixed per kind, from the inject payload, or the same as its input
// ("inherit", for nodes that pass values on).
const VAR_TYPES = {
  inject: "payload",
  "mqtt-in": "String",
  "ble-in": "String",
  terminal: "String",
  "web-in": "String",
  "gpio-watch": "bool",
  "pulse-train": "bool",
  "analog-in": "int",
  threshold: "double",
  compare: "inherit",
  scale: "double",
  throttle: "inherit",
  template: "String",
  logic: "bool",
  timer: "bool",
  counter: "bool",
  "link-in": "inherit",
  "link-out": "inherit",
  arduino: "String",
  "digital-read": "bool",
  "digital-write": "inherit",
  "pwm-write": "inherit",
  pulse: "bool",
  display: "inherit",
  "mqtt-out": "inherit",
  "ble-out": "inherit",
  "web-out": "inherit",
  debug: "inherit",
  "test-switch": "bool",
  "test-button": "bool",
  "func-gen": "double",
  "test-scope": "inherit",
  "test-screen": "inherit",
  "input-device": "double",
  "output-device": "double",
  peripheral: "double",
  camera: "String",
};
// Type of the value a node takes in, when its Input type is "auto" ("inherit": the
// type its inputs send). Nodes with no input (sources) have none.
const IN_TYPES = {
  "digital-write": "bool",
  pulse: "bool",
  logic: "bool",
  timer: "bool",
  counter: "bool",
  camera: "bool",
  "pwm-write": "int",
  threshold: "double",
  compare: "inherit",
  scale: "double",
  "test-scope": "double",
  "test-screen": "String",
  "output-device": "double",
  peripheral: "double",
  throttle: "inherit",
  "link-out": "inherit",
  template: "String",
  display: "String",
  "mqtt-out": "String",
  "ble-out": "String",
  "web-out": "String",
  debug: "String",
  "digital-read": "String", // any value triggers a reading
  "input-device": "String",
};
// ── Signal kinds: analog values do not go straight into logic, nor on / off
// values straight into analog outputs; a converting node goes between them.
const SIGNALS = {
  "analog-in": "analog", // ADC reading
  "input-device": "analog", // sensor readings
  "pwm-write": "analog-out", // analog output (duty)
  "output-device": "analog-out", // servo angle, stepper position
  logic: "logic",
  timer: "logic",
  counter: "logic",
  camera: "trigger", // takes on / off, sends JSON
  throttle: "pass", // pass values on unchanged
  "link-in": "pass",
  "link-out": "pass",
};
// Does node n send `kind` ("analog" / "logic") values, also through pass-on nodes?
// upstream(n) lists the nodes feeding n.
function sends_(n, kind, upstream, seen = new Set()) {
  const s = SIGNALS[n.type];
  if (s === kind) return true;
  if (s !== "pass" || seen.has(n.id)) return false;
  seen.add(n.id);
  return upstream(n).some((m) => sends_(m, kind, upstream, seen));
}
// Why a connection from a to b is not allowed, or "".
function wireProblem(a, b, upstream) {
  // An I2C display shows any value (text), unlike a motor.
  const to =
    b.type === "output-device" && b.config?.device === "i2cdisplay"
      ? null
      : SIGNALS[b.type];
  const name = (n) => n.label || types[n.type]?.label || n.type;
  if ((to === "logic" || to === "trigger") && sends_(a, "analog", upstream))
    return `${name(a)} → ${name(b)}: an analog value is not on / off, so it cannot go into ${name(b)} directly. Convert it first: put a Threshold (on from a level) or a Compare between them.`;
  if (to === "analog-out" && sends_(a, "logic", upstream))
    return `${name(a)} → ${name(b)}: an on / off value (0 / 1) is not an analog level for ${name(b)}. Convert it first: put a Map range between them (e.g. 0–1 → 0–255 for PWM, 0–1 → 0–180 for a servo).`;
  return "";
}
const TYPES = ["bool", "int", "double", "String"];
// C++ start value of each type, and the conversion from a received text v.
const TYPE_ZERO = { bool: "false", int: "0", double: "0", String: '""' };
const TYPE_FROM = {
  bool: (v) => `mfJson::asBool(${v})`,
  int: (v) => `mfJson::asInt(${v})`,
  double: (v) => `mfJson::asDouble(${v})`,
  String: (v) => v,
};
// The type an inject payload suggests: 1 → int, 2.5 → double, true → bool, else String.
function payloadType(text) {
  const t = String(text ?? "").trim();
  if (t === "true" || t === "false") return "bool";
  if (/^-?\d{1,9}$/.test(t)) return "int";
  if (t !== "" && Number.isFinite(Number(t))) return "double";
  return "String";
}
// C++ type of node n's variable. inputsOf(n) lists the nodes feeding n.
function varType(n, inputsOf, seen = new Set()) {
  if (TYPES.includes(n.vtype)) return n.vtype;
  const kind =
    ruled(devices.varTypes, n, "type") || VAR_TYPES[n.type] || "String";
  if (kind === "payload") return payloadType(n.config?.payload);
  if (kind !== "inherit") return kind;
  if (seen.has(n.id)) return "String";
  seen.add(n.id);
  const types = [
    ...new Set(inputsOf(n).map((m) => varType(m, inputsOf, seen))),
  ];
  return types.length === 1 ? types[0] : "String";
}
// C++ type of the value node n takes in (null: no input, or a C/C++ node, whose
// inputs are variables of their own).
function inType(n, inputsOf, seen = new Set()) {
  if (types[n.type]?.source || types[n.type]?.standalone || n.type === "arduino")
    return null;
  if (TYPES.includes(n.itype)) return n.itype;
  const kind = IN_TYPES[n.type] || "String";
  if (kind !== "inherit") return kind;
  const from = [...new Set(inputsOf(n).map((m) => varType(m, inputsOf, seen)))];
  return from.length === 1 ? from[0] : "String";
}
// A value as type (the node's Input or Output type): bool "1" / "0", int, a decimal
// number (up to 6 places), or the text unchanged. Same rules as mfJson::to() in
// the firmware (lib/jsonfw.js). Private signals (starting with char 31) pass as they are.
function asNumber(t) {
  const x = parseFloat(t);
  if (Number.isNaN(x)) return asBoolean(t) ? 1 : 0;
  return x;
}
function asBoolean(t) {
  if (t === "true" || t === "on" || t === "yes") return true;
  const x = parseFloat(t);
  return !Number.isNaN(x) && x !== 0;
}
function convertValue(value, type) {
  const t = String(value);
  if (t.startsWith("\x1f")) return t;
  if (type === "bool") return asBoolean(t) ? "1" : "0";
  if (type === "int") {
    const x = asNumber(t);
    if (!Number.isFinite(x)) return "0";
    return String(Math.trunc(Math.max(-2147483648, Math.min(2147483647, x))));
  }
  if (type === "double") {
    const x = asNumber(t);
    if (!Number.isFinite(x)) return "0";
    const s = x.toFixed(6).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  }
  return t;
}
// What changes when a value of type `from` goes into an input of type `to`, or "".
// Only conversions that can lose information or meaning are reported.
function conversionNote(from, to) {
  if (!from || !to || from === to || to === "String") return "";
  if (to === "bool")
    return `${TYPE_LABEL[from]} → bool: true when not 0${from === "String" ? " (or the text true / on / yes)" : ""}, else false`;
  if (from === "String")
    return `String → ${TYPE_LABEL[to]}: text that is not a number becomes 0`;
  if (from === "double" && to === "int")
    return "float → int: the decimals are cut off";
  return "";
}
// Types as the IDE names them (C++ double is shown as float: a decimal number).
const TYPE_LABEL = {
  bool: "bool",
  int: "int",
  double: "float",
  String: "String",
};
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
// Why a name cannot be a variable, or null. Binary constants (B0…B11111111) are
// Arduino macros.
function varNameProblem(name) {
  if (!VAR_NAME.test(name))
    return "use letters, digits and _ (max 32), starting with a letter";
  if (RESERVED.has(name) || /^mf/i.test(name) || /^B[01]{1,8}$/.test(name))
    return "it is reserved in Arduino C++";
  return null;
}
// A unique default name: GPIO4 for a pin node, else SW1, SW2, …
// Per-setting names and types (Input / Output device): the first rule that matches.
function ruled(rules, n, what) {
  const fields = types[n.type]?.fields || [];
  return (rules[n.type] || []).find((r) =>
    devices.whenMatches(n.config || {}, r.when, fields),
  )?.[what];
}
function autoName(n, taken) {
  const template =
    ruled(devices.varNames, n, "name") || VAR_NAMES[n.type] || "NODE";
  const pin = n.config?.pin;
  if (template.includes("{pin}") && Number.isInteger(pin)) {
    const base = template.replace("{pin}", pin);
    if (!taken.has(base)) return base;
    for (let k = 2; ; k++)
      if (!taken.has(`${base}_${k}`)) return `${base}_${k}`;
  }
  const base = template.replace("{pin}", "");
  for (let k = 1; ; k++) if (!taken.has(base + k)) return base + k;
}
// C++ with comments, strings and character literals blanked out (same length),
// so checks only look at code.
function codeOnly(code) {
  return String(code).replace(
    /\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$)|"(\\.|[^"\\\n])*"?|'(\\.|[^'\\\n])*'?/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}
// Brackets must balance inside each section, or the code would close (or swallow)
// the function Microflow wraps it in.
function checkBrackets(code, where) {
  const open = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  const text = codeOnly(code);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const line = () => text.slice(0, i).split("\n").length;
    if (open[c]) stack.push([open[c], line()]);
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || top[0] !== c)
        throw Error(`${where}, line ${line()}: unexpected "${c}".`);
    }
  }
  if (stack.length) {
    const [close, line] = stack.pop();
    throw Error(`${where}, line ${line}: missing "${close}".`);
  }
}
const CODE_SECTIONS = {
  vars: "variables",
  setup: "setup",
  message: "on message",
  loop: "loop",
};
// The first hardware name in code (comments and strings ignored), as
// { name, use, line }, or null.
function hardwareUse(code) {
  const text = codeOnly(code);
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g))
    if (HARDWARE_NAMES.has(m[0]))
      return {
        name: m[0],
        use: HARDWARE_NAMES.get(m[0]),
        line: lineAt(m.index),
      };
  const call = HARDWARE_CALL.exec(text);
  return call
    ? {
        name: call[1],
        use: "Chip drivers are not accessible from code; use the hardware nodes.",
        line: lineAt(call.index),
      }
    : null;
}
function checkArduino(c, n) {
  const who = n?.label || "C/C++";
  delete c.pins; // named pins (removed): hardware is done by other nodes
  for (const [key, name] of Object.entries(CODE_SECTIONS)) {
    const code = codeOnly(c[key]);
    if (/^\s*#\s*(include|line)\b/m.test(code))
      throw Error(
        `${who}, ${name}: #include and #line are not supported inside a node (the libraries Microflow includes are available).`,
      );
    checkBrackets(c[key], `${who}, ${name}`);
    const hw = hardwareUse(c[key]);
    if (hw)
      throw Error(
        `${who}, ${name}, line ${hw.line}: ${hw.name} accesses hardware, which C/C++ nodes do not allow. ${hw.use}`,
      );
  }
}
const sends = (c) => /\bsend\s*\(/.test(codeOnly(c.message + c.loop + c.setup));
// Advice about code that compiles but misbehaves inside a flow (analyze() warnings).
function arduinoWarnings(n) {
  const c = n.config;
  const all = codeOnly([c.vars, c.setup, c.message, c.loop].join("\n"));
  const out = [];
  const say = (text) => out.push(`${n.label}: ${text}`);
  if (/\bdelay\s*\(/.test(all))
    say(
      "delay() pauses the whole board (WiFi, MQTT and every other node). Use millis() in loop instead, e.g. if (millis() - last >= 500) { last = millis(); … }.",
    );
  if (/\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/.test(all))
    say(
      "an endless loop never returns, so the rest of the flow stops. loop runs repeatedly by itself.",
    );
  if (!c.message.trim() && !c.loop.trim() && !c.setup.trim())
    say("has no code yet.");
  return out;
}
// The pins a node uses, for board checks and conflicts: [{ pin, use, label }].
// Device nodes list their pins in pinSpec (which pin for which setting); pins below 0
// (an optional pin not wired) are left out. sim: shown in the simulator's pin strip.
function pinsOf(n) {
  const def = types[n.type];
  if (def?.pinSpec)
    return def.pinSpec
      .filter((p) => devices.whenMatches(n.config, p.when, def.fields))
      .map((p) => ({
        pin: n.config[p.key],
        use: p.use,
        label: n.label,
        name: n.name,
        sim: p.sim,
        shared: p.shared, // e.g. "i2c": the same bus pin for several nodes
      }))
      .filter((p) => Number.isInteger(p.pin) && p.pin >= 0);
  const use = def?.pin;
  return use
    ? [{ pin: n.config.pin, use, label: n.label, name: n.name, sim: true }]
    : [];
}
// Printable ASCII for C++ comments and #line file names.
const ascii = (s) =>
  String(s)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "'");
const ops = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  neq: "≠",
  contains: "contains",
};
const types = {
  inject: {
    label: "Inject",
    icon: "↗",
    color: "#8b9d57",
    tint: "#eff3df",
    group: "INPUT",
    source: true,
    help: "Repeats at the interval. With interval 0 it fires from the ▶ button or MQTT topic microflow/<device>/inject/<node id> (a non-empty MQTT payload overrides the configured one).",
    fields: [
      { key: "payload", label: "Payload", type: "text", default: "12345ABCDE" },
      {
        key: "interval",
        label: "Repeat interval (ms, 0 = manual)",
        type: "number",
        default: 1000,
        min: 0,
        max: 86400000,
      },
    ],
    validate(c) {
      if (c.interval !== 0 && c.interval < 100)
        throw Error("Repeat interval must be 0 (manual) or at least 100 ms.");
    },
    summary: "Every {interval} ms",
    manualSummary: "Manual · MQTT trigger",
  },
  // Radio in/out keep their original type IDs (mqtt-in/out) so saved flows still load.
  "mqtt-in": {
    label: "Radio in",
    icon: "⇥",
    color: "#a286b2",
    tint: "#f2eaf7",
    group: "INPUT",
    needs: radioNeeds,
    source: true,
    help: "Receives values from other boards. MQTT: subscribes to a topic on the broker (+ and # wildcards). ESP-NOW: hears ESP32 boards nearby without a router; the topic filters messages as in MQTT. I2C: as controller it polls a peripheral's address and passes on each new value; as peripheral (ESP32 boards) it receives what the controller writes. Local MQTT (ESP32 boards): this board runs its own MQTT broker on the LAN (mqtt://<board IP>:1883, shown on USB serial); it receives what other boards, PCs or this board's Radio out publish there (+ and # wildcards).",
    fields: radioFields("in"),
    validate: (c) => checkRadio(c, true),
    summary: RADIO_SUMMARY,
  },
  "ble-in": {
    label: "BLE in",
    icon: "ᛒ",
    color: "#5b8fc7",
    tint: "#e6eff9",
    group: "INPUT",
    source: true,
    needs: "bluetooth",
    help: `Receives values sent by BLE out nodes with the same link name on other boards nearby (Bluetooth LE, about 10–30 m indoors). No pairing: any number of boards can share a link. ESP32 boards only. Values are short text (up to ${blefw.MAX_PAYLOAD} bytes). Bluetooth runs on the board only; in the simulator this node never fires.`,
    fields: [linkField],
    validate: checkLink,
    summary: "BLE link {link}",
  },
  terminal: {
    label: "Terminal",
    icon: ">_",
    color: "#8b9d57",
    tint: "#eff3df",
    group: "INPUT",
    source: true,
    help: "Like Inject, but you type the data: '<command> <data>' in any terminal (USB serial, the test terminal over USB or MQTT, or the board's web page) sends <data> into the flow. Example: command 'led', type 'led on'. Works on every board and in the simulator's test terminal.",
    fields: [
      { key: "command", label: "Command word", type: "text", default: "say" },
    ],
    validate(c) {
      c.command = c.command.toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,23}$/.test(c.command))
        throw Error(
          "Command word may use letters, digits, - and _ (max 24), starting with a letter.",
        );
      if (termfw.RESERVED.includes(c.command))
        throw Error(
          `“${c.command}” is a built-in terminal command; choose another word.`,
        );
    },
    summary: "type: {command} <data>",
  },
  "web-in": {
    label: "Web in",
    icon: "⇲",
    color: "#c08a3e",
    tint: "#f8eedd",
    group: "INPUT",
    source: true,
    needs: "webserver",
    web: "POST",
    help: "The board serves http://<board IP>/api/<name>. A POST with a JSON body sends that JSON into the flow; the reply is the JSON of all Web out values after the flow ran. The board's page http://<board IP>/ has an input box for it. No login: anyone on the network can post.",
    fields: [webName("input")],
    validate: checkWebName,
    summary: "POST /api/{name}",
  },
  "gpio-watch": {
    label: "GPIO input (change)",
    icon: "⎍",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "INPUT",
    source: true,
    pin: "in",
    help: "Emits 0 or 1 when a debounced digital input changes (and, if chosen, its level once at start-up, so e.g. a GPIO output follows it from the start). While simulating (or emulating with a real board over USB) its box has PUSH (held = pressed) and SWITCH, so it also stands in for a test button or switch; the same box reads the real button on the circuit. Wiring: internal pull-up = a button from the pin to GND (pressed reads 0); internal pull-down = a button from the pin to 3.3 V (pressed reads 1; ESP32 and BW16, not ESP8266); Floating / external resistor = your own resistor (pressed reads 1 with a pull-down). A button to 3.3 V with the pull-up never changes the pin, so nothing is sent.",
    fields: [
      pinField(4),
      {
        key: "pull",
        label: "Input mode",
        type: "select",
        default: "pullup",
        options: {
          pullup: "Internal pull-up (button to GND: pressed = 0)",
          pulldown: "Internal pull-down (button to 3.3 V: pressed = 1, ESP32 / BW16)",
          none: "Floating / external resistor",
        },
      },
      {
        key: "debounce",
        label: "Debounce (ms)",
        type: "number",
        default: 50,
        min: 0,
        max: 5000,
        integer: true,
      },
      {
        key: "startup",
        label: "At start-up",
        type: "select",
        default: "change",
        options: {
          change: "Send nothing (only changes)",
          level: "Send the current level once",
        },
      },
    ],
    summary: "GPIO {pin} on change",
    fw: {
      setup: (n) =>
        `pinMode(${n.config.pin}, ${pinModeOf(n.config.pull)});`,
      // The first stable level is the start-up level: sent only if chosen.
      loop: (n, i, build) =>
        `{ static int raw${i} = -1, stable${i} = -1; static unsigned long since${i} = 0; int r = ${readDigital(build)}(${n.config.pin}); if (r != raw${i}) { raw${i} = r; since${i} = millis(); } else if (r != stable${i} && millis() - since${i} >= ${n.config.debounce}UL) { bool boot = stable${i} < 0; stable${i} = r; if (${n.config.startup === "level" ? "true" : "!boot"}) node${i}(String(r)); } }`,
    },
  },
  "pulse-train": {
    label: "Pulse train",
    icon: "⎍⎍",
    color: "#8b9d57",
    tint: "#eff3df",
    group: "INPUT",
    source: true,
    help: "Pulse generator: sends 1, waits the ON time, sends 0, waits the OFF time, and repeats (0 pulses = forever). Connect it to GPIO output to blink a pin, or to Radio out to test timing. Timed with millis(), so the chip keeps running.",
    fields: [
      {
        key: "high",
        label: "ON time (ms)",
        type: "number",
        default: 500,
        min: 10,
        max: 3600000,
        integer: true,
      },
      {
        key: "low",
        label: "OFF time (ms)",
        type: "number",
        default: 500,
        min: 10,
        max: 3600000,
        integer: true,
      },
      {
        key: "count",
        label: "Pulses (0 = forever)",
        type: "number",
        default: 0,
        min: 0,
        max: 1000000,
        integer: true,
      },
      {
        key: "delay",
        label: "Start after (ms)",
        type: "number",
        default: 0,
        min: 0,
        max: 3600000,
        integer: true,
      },
    ],
    summary: "{high} ms on / {low} ms off",
    fw: {
      loop: (n, i) => {
        const { high, low, count, delay } = n.config;
        return `{ static bool begun${i} = false, on${i} = false; static unsigned long t${i} = 0; static uint32_t done${i} = 0;
    if (!begun${i}) { if (millis() >= ${delay}UL) { begun${i} = true; on${i} = true; t${i} = millis(); node${i}(String("1")); } }
    else if (on${i} && millis() - t${i} >= ${high}UL) { on${i} = false; t${i} = millis(); done${i}++; node${i}(String("0")); }
    else if (!on${i} && ${count ? `done${i} < ${count}UL && ` : ""}millis() - t${i} >= ${low}UL) { on${i} = true; t${i} = millis(); node${i}(String("1")); } }`;
      },
    },
  },
  // Sensors (lib/devices.js): the device is chosen in Properties.
  "input-device": devices.inputDevice,
  "analog-in": {
    label: "Analog sample",
    icon: "∿",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "INPUT",
    source: true,
    pin: "adc",
    help: "Reads the ADC at a fixed interval (ESP8266: A0 = 17, 0–1023; ESP32: ADC1 pins, 0–4095). Resolution: the board's own (ESP8266 10 bits, ESP32 12 bits) or 8, 10 or 12 bits; fewer bits give smaller, steadier numbers (more bits than the board has only scale the value up).",
    fields: [
      pinField(17),
      {
        key: "interval",
        label: "Sample interval (ms)",
        type: "number",
        default: 1000,
        min: 50,
        max: 86400000,
        integer: true,
      },
      {
        key: "bits",
        label: "Resolution",
        type: "select",
        default: "native",
        options: ADC_BITS,
      },
    ],
    summaryBy: "bits",
    summary: {
      native: "ADC {pin} · every {interval} ms",
      8: "ADC {pin} · 8-bit · every {interval} ms",
      10: "ADC {pin} · 10-bit · every {interval} ms",
      12: "ADC {pin} · 12-bit · every {interval} ms",
    },
    fw: {
      loop: (n, i, build) =>
        `{ static unsigned long tick${i} = 0; if (millis() - tick${i} >= ${n.config.interval}UL) { tick${i} = millis(); node${i}(String(${adcScaled(`${readAnalog(build)}(${n.config.pin})`, n.config.bits, build?.family)})); } }`,
    },
  },
  threshold: {
    label: "Threshold",
    icon: "≥",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: "Passes numeric payloads greater than or equal to the minimum. Advanced → Refresh: every so many ms it checks the last value it received again and, if that still passes, sends it again (0 = only when a value arrives), so receivers keep getting it.",
    fields: [
      { key: "value", label: "Minimum value", type: "number", default: 25 },
      {
        key: "refresh",
        label: "Refresh every (ms, 0 = off; at least 100)",
        type: "number",
        default: 0,
        min: 0,
        max: 86400000,
        integer: true,
        advanced: true,
      },
    ],
    validate(c) {
      if (c.refresh > 0 && c.refresh < 100)
        throw Error("Threshold: Refresh must be 0 (off) or at least 100 ms.");
    },
    summary: "payload ≥ {value}",
    host(v, n, ctx) {
      const x = toNumber(v);
      const passes = (y) => y !== null && y >= n.config.value;
      // Refresh: re-check the last value after the period; restarts on each value.
      if (n.config.refresh > 0) {
        const st = ctx.state;
        st.last = v;
        ctx.cancel?.(st.timer);
        const tick = () => {
          if (passes(toNumber(st.last))) ctx.forward(st.last);
          st.timer = ctx.later(n.config.refresh, tick);
        };
        st.timer = ctx.later(n.config.refresh, tick);
      }
      return passes(x) ? v : undefined;
    },
    fw: {
      // Refresh: the last message received, re-run through this node after the period.
      globals: (n, i) =>
        n.config.refresh > 0
          ? `String mfThLast${i}; bool mfThHas${i} = false; unsigned long mfThAt${i} = 0;`
          : "",
      loop: (n, i) =>
        n.config.refresh > 0
          ? `if (mfThHas${i} && millis() - mfThAt${i} >= ${n.config.refresh}UL) node${i}(mfThLast${i});`
          : "",
      body: (n, i, build) =>
        (n.config.refresh > 0
          ? `mfThLast${i} = ${build?.language === "nodered" ? "mfIn" : "value"}; mfThHas${i} = true; mfThAt${i} = millis(); `
          : "") +
        `double x; if (!mfNumber(value, x) || x < ${cNumber(n.config.value)}) return;`,
    },
  },
  compare: {
    label: "Compare",
    icon: "⋚",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: "Passes the payload when the comparison is true. <, ≤, >, ≥ compare numbers; = and ≠ compare numbers when both sides are numeric, otherwise text.",
    fields: [
      {
        key: "op",
        label: "Operator",
        type: "select",
        default: "eq",
        options: ops,
      },
      { key: "value", label: "Value", type: "text", default: "1" },
    ],
    validate(c) {
      if (
        ["gt", "gte", "lt", "lte"].includes(c.op) &&
        toNumber(c.value) === null
      )
        throw Error("Numeric comparisons need a numeric value.");
    },
    summary: "payload {op} {value}",
    host(v, n) {
      const { op, value } = n.config;
      if (op === "contains") return String(v).includes(value) ? v : undefined;
      const a = toNumber(v),
        b = toNumber(value);
      if (op === "eq" || op === "neq") {
        const same = a !== null && b !== null ? a === b : String(v) === value;
        return same === (op === "eq") ? v : undefined;
      }
      if (a === null) return undefined;
      const pass = { gt: a > b, gte: a >= b, lt: a < b, lte: a <= b }[op];
      return pass ? v : undefined;
    },
    fw: {
      body(n) {
        const { op, value } = n.config;
        if (op === "contains")
          return `if (value.indexOf(${quoted(value)}) < 0) return;`;
        const b = toNumber(value);
        if (op === "eq" || op === "neq") {
          const test =
            b === null
              ? `value == ${quoted(value)}`
              : `(mfNumber(value, x) ? x == ${cNumber(b)} : value == ${quoted(value)})`;
          return `double x; bool same = ${test}; if (${op === "eq" ? "!same" : "same"}) return;`;
        }
        const cmp = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
        return `double x; if (!mfNumber(value, x) || !(x ${cmp} ${cNumber(b)})) return;`;
      },
    },
  },
  scale: {
    label: "Map range",
    icon: "⇲",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: "Linearly maps a numeric payload, for example ADC 0–1023 to 0–100 %. Non-numeric payloads are dropped.",
    fields: [
      { key: "inMin", label: "Input min", type: "number", default: 0 },
      { key: "inMax", label: "Input max", type: "number", default: 1023 },
      { key: "outMin", label: "Output min", type: "number", default: 0 },
      { key: "outMax", label: "Output max", type: "number", default: 100 },
      {
        key: "decimals",
        label: "Decimals",
        type: "number",
        default: 1,
        min: 0,
        max: 6,
        integer: true,
      },
      {
        key: "clamp",
        label: "Clamp to output range",
        type: "select",
        default: "yes",
        options: { yes: "Yes", no: "No" },
      },
    ],
    validate(c) {
      if (c.inMin === c.inMax) throw Error("Input min and max must differ.");
    },
    summary: "{inMin}–{inMax} → {outMin}–{outMax}",
    host(v, n) {
      const { inMin, inMax, outMin, outMax, decimals, clamp } = n.config;
      const x = toNumber(v);
      if (x === null) return undefined;
      let y = outMin + ((x - inMin) * (outMax - outMin)) / (inMax - inMin);
      if (clamp === "yes")
        y = Math.min(
          Math.max(y, Math.min(outMin, outMax)),
          Math.max(outMin, outMax),
        );
      return y.toFixed(decimals);
    },
    fw: {
      body(n) {
        const { inMin, inMax, outMin, outMax, decimals, clamp } = n.config;
        const lo = cNumber(Math.min(outMin, outMax)),
          hi = cNumber(Math.max(outMin, outMax));
        return `double x; if (!mfNumber(value, x)) return; double y = ${cNumber(outMin)} + (x - ${cNumber(inMin)}) * ${cNumber(outMax - outMin)} / ${cNumber(inMax - inMin)};${clamp === "yes" ? ` if (y < ${lo}) y = ${lo}; if (y > ${hi}) y = ${hi};` : ""} value = String(y, ${decimals});`;
      },
    },
  },
  throttle: {
    label: "Throttle",
    icon: "⏱",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: "Drops messages that arrive sooner than the interval after the last one passed. Protects brokers and battery-powered boards from floods.",
    fields: [
      {
        key: "interval",
        label: "Minimum gap (ms)",
        type: "number",
        default: 1000,
        min: 1,
        max: 86400000,
        integer: true,
      },
    ],
    summary: "≤ 1 msg / {interval} ms",
    host(v, n, ctx) {
      const now = ctx.now();
      if (
        ctx.state.last !== undefined &&
        now - ctx.state.last < n.config.interval
      )
        return undefined;
      ctx.state.last = now;
      return v;
    },
    fw: {
      body: (n) =>
        `static unsigned long last = 0; static bool seen = false; if (seen && millis() - last < ${n.config.interval}UL) return; seen = true; last = millis();`,
    },
  },
  // Gates, flip-flops and timers (lib/logic.js). Knows which input sent a value.
  logic: {
    label: "Logic",
    icon: "&",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: logic.help,
    fields: logic.fields,
    summary: logic.summary,
    summaryBy: "fn",
    slots: true,
    host: logic.host,
    fw: {
      globals: logic.globals,
      body: logic.body,
      loop: logic.loop,
    },
  },
  // Edge-triggered timer: T1 delay, then 1 for T2 (lib/timer.js).
  timer: {
    label: "Timer",
    icon: "⏱",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: timer.help,
    slots: true, // tells Set and Reset apart
    fields: timer.fields,
    summary: "T1 {t1} s · T2 {t2} s",
    host: timer.host,
    fw: {
      globals: timer.globals,
      body: timer.body,
      loop: timer.loop,
    },
  },
  // Counter: Count and Reset inputs, three outputs that each pulse at their own
  // preset (lib/counter.js).
  counter: {
    label: "Counter",
    icon: "#",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: counter.help,
    slots: true, // tells Count and Reset apart
    outputs: counter.OUTPUT_LABELS, // three output ports (edge.port 0, 1, 2)
    fields: counter.fields,
    summary: "{preset1} / {preset2} / {preset3} · {width} ms",
    host: counter.host,
    fw: {
      globals: counter.globals,
      body: counter.body,
      loop: counter.loop,
    },
  },
  template: {
    label: "Template",
    icon: "❝",
    color: "#c59c60",
    tint: "#faf0df",
    group: "LOGIC",
    help: 'Replaces the payload with this text. {{payload}} inserts the incoming payload, e.g. {"temp":{{payload}}}.',
    fields: [
      {
        key: "template",
        label: "Template",
        type: "text",
        default: "{{payload}}",
      },
    ],
    summary: "{template}",
    host: (v, n) => n.config.template.split("{{payload}}").join(String(v)),
    fw: {
      body(n) {
        const parts = n.config.template.split("{{payload}}");
        const fixed = parts.reduce((sum, p) => sum + Buffer.byteLength(p), 0);
        return `String out; out.reserve(${fixed} + value.length() * ${parts.length - 1}); ${parts
          .map(
            (p, i) =>
              (i ? "out += value; " : "") + (p ? `out += ${quoted(p)}; ` : ""),
          )
          .join("")}value = out;`;
      },
    },
  },
  // Link out passes its value to every Link in with the same link name, usually on
  // another flow tab (flow.js adds these hidden connections). No code of their own.
  "link-in": {
    label: "Link in",
    icon: "↪",
    color: "#8c7fb0",
    tint: "#efecf6",
    group: "LOGIC",
    source: true,
    help: "Receives every value sent into a Link out node with the same link name. Use a Link out / Link in pair to connect nodes on different flow tabs. Any number of Link out and Link in nodes can share a name; all tabs run together on one board.",
    fields: [linkField],
    validate: checkLink,
    summary: "from link {link}",
  },
  "link-out": {
    label: "Link out",
    icon: "⇢",
    color: "#8c7fb0",
    tint: "#efecf6",
    group: "LOGIC",
    sink: true,
    help: "Sends its input to every Link in node with the same link name, on any flow tab. It has no output of its own.",
    fields: [linkField],
    validate: checkLink,
    summary: "to link {link}",
  },
  // Your own C/C++ (type "arduino" in saved flows). Each node's code sits in a
  // namespace of its own, so its variables and functions are private to it; values
  // enter as `value` (and as input variables) and leave only through send(…).
  // No hardware access: pins, Serial, WiFi, … belong to the other nodes.
  arduino: {
    label: "C/C++",
    icon: "{}",
    color: "#3f8f8c",
    tint: "#e3f3f2",
    group: "CODE",
    help: 'Your own C/C++ for calculations and decisions. "On message" runs for every value that arrives: the payload is the String `value`, and send(x) passes x (text or a number) to the connected nodes; nothing goes on unless you call send. Every node wired into this one is a typed variable named as shown on its box (e.g. bool SW1, int ADC34) holding its latest value, and `from` names the input that just sent: if (SW1 && SW2) send(1);. JSON: jsonNumber(value, "sensor.temp"), jsonText(value, "name"), jsonBool(value, "on"), jsonHas(value, "list[0]") read fields; send(Json().add("temp", t).add("ok", true)) sends {"temp":…,"ok":true}. "setup" runs once at boot and "loop" repeatedly, so the node can also send by itself (count, time something with millis()). Variables and functions are private to this node. No hardware: pins, analog, PWM, Serial, WiFi and radios are done by the other nodes (GPIO, Analog sample, PWM out, Debug, Radio in/out); wire their values in and out. Avoid delay(): it stops the whole board. The code runs on the board only; the PC simulation passes values straight through.',
    fields: [
      {
        key: "vars",
        label: "Variables and functions (private to this node)",
        type: "code",
        empty: true,
        default: "int count = 0;",
      },
      {
        key: "setup",
        label: "setup() · runs once at boot",
        type: "code",
        empty: true,
        default: "",
      },
      {
        key: "message",
        label: "On message · `value` = incoming payload, send(x) = output",
        type: "code",
        empty: true,
        default: "count++;\nsend(count);",
      },
      {
        key: "loop",
        label: "loop() · runs repeatedly; keep it short, no delay()",
        type: "code",
        empty: true,
        default: "",
      },
    ],
    validate: checkArduino,
    summary: "C/C++ code",
    // C++ cannot run on the PC: the simulation forwards values unchanged (when the
    // code sends at all) and says so once.
    host(v, n, ctx) {
      if (!ctx.state.warned) {
        ctx.state.warned = true;
        ctx.warn?.(
          `${n.label}: C/C++ code runs on the board only; the simulation passes values through unchanged.`,
        );
      }
      return sends(n.config) ? v : undefined;
    },
    fw: {
      // After every other global and node prototype, so send() can call the next nodes.
      // wire.send: C++ calls passing `v` to the connected nodes; wire.inputs: the
      // nodes wired into this one, [{ i, name }].
      defs(n, i, build, wire) {
        const c = n.config;
        const red = wire.language === "nodered";
        const name = ascii(n.label).slice(0, 40) || "C/C++";
        const section = (key) =>
          `#line 1 "${name}: ${CODE_SECTIONS[key]}"\n${c[key]}\n#line MF_RESUME`;
        return `// C/C++ node "${name}" (${n.id}): its variables and functions are private to it.
namespace mfArduino${i} {
using namespace ::mfJson; // jsonText(), jsonNumber(), Json(), … (your own names win)
${
  wire.inputs.length
    ? `// Connected inputs: each holds the latest ${red ? "payload" : "value"} that node sent, as its type.
${wire.inputs.map((x) => `${x.type} ${x.name} = ${TYPE_ZERO[x.type]};`).join("\n")}
`
    : ""
}// The input that sent \`value\` ("" when it came another way, e.g. the test terminal).
String from = "";
${
  red
    ? `// The message being handled, e.g. {"payload":1,"topic":"SW1"} ("{}" in setup and loop).
String msg = "{}";
// send(x): sends msg with payload x (and this node's Message fields) to the connected nodes.
void send(const String& v) { String mfOut = mfMsg::out(msg, v, ${quoted(wire.fields)});${build.emulate ? ` mfTrace(${i}, v);` : ""}${wire.send.map((call) => " " + call).join("")}${wire.send.length ? "" : " (void)mfOut;"} }
// sendMsg(m): sends a whole message, e.g. sendMsg(Json().add("payload", 1).add("topic", "x")).
void sendMsg(const String& m) { String mfOut = mfMsg::in(m, false);${build.emulate ? ` mfTrace(${i}, mfMsg::payload(mfOut));` : ""}${wire.send.map((call) => " " + call).join("")}${wire.send.length ? "" : " (void)mfOut;"} }
void sendMsg(const Json& m) { sendMsg(m.text()); }`
    : `// send(x): passes x to the nodes connected to this one's output.
void send(const String& v) {${build.emulate ? ` mfTrace(${i}, v);` : ""}${wire.send.map((call) => " " + call).join("")}${wire.send.length || build.emulate ? "" : " (void)v;"} }`
}
void send(double v, unsigned int decimals) { send(String(v, decimals)); }
void send(const Json& v) { send(v.text()); }
template <typename T> void send(const T& v) { send(String(v)); }
${section("vars")}
void mfSetup() {
${section("setup")}
}
void mfLoopCode() {
${section("loop")}
}
void mfLoop() {${red ? ` msg = "{}";` : ""} mfLoopCode(); }
void mfMessage(String value) {
  (void)value;
${section("message")}
}
${
  red
    ? `void mfReceive(const String& m) { msg = mfMsg::in(m, false); from = ""; mfMessage(mfMsg::payload(msg)); }
${wire.inputs.map((x) => `void mfFrom${x.i}(const String& m) { msg = mfMsg::in(m, false); String p = mfMsg::payload(msg); ${x.name} = ${TYPE_FROM[x.type]("p")}; from = "${x.name}"; mfMessage(p); }`).join("\n")}`
    : wire.inputs
        .map(
          (x) =>
            `void mfFrom${x.i}(const String& v) { ${x.name} = ${TYPE_FROM[x.type]("v")}; from = "${x.name}"; mfMessage(v); }`,
        )
        .join("\n")
}
} // namespace mfArduino${i}`;
      },
      setup: (n, i) => `mfArduino${i}::mfSetup();`,
      loop: (n, i) => (n.config.loop.trim() ? `mfArduino${i}::mfLoop();` : ""),
      // Values continue only through send(), from inside the node's code.
      body: (n, i, build) =>
        build.language === "nodered"
          ? `mfArduino${i}::mfReceive(value);`
          : `mfArduino${i}::from = ""; mfArduino${i}::mfMessage(value);`,
    },
  },
  "digital-read": {
    label: "GPIO input",
    icon: "◉",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    source: true,
    pin: "in",
    help: "Reads the pin by itself and sends its level (0/1) at the chosen interval, whether it changed or not. It has an output connection only: the other end is the pin on the circuit. To send only when the level changes, use GPIO input (change). Pins without an internal pull-up (ESP32 GPIO 34–39) need an external resistor.",
    fields: [
      pinField(4),
      {
        key: "interval",
        label: "Read every (ms)",
        type: "number",
        default: 100,
        min: 10,
        max: 86400000,
        integer: true,
      },
      {
        key: "pull",
        label: "Input mode",
        type: "select",
        default: "pullup",
        options: {
          pullup: "Internal pull-up (button to GND: pressed = 0)",
          pulldown: "Internal pull-down (button to 3.3 V: pressed = 1, ESP32 / BW16)",
          none: "Floating / external resistor",
        },
      },
    ],
    summary: "read GPIO {pin} every {interval} ms",
    host: (v, n, ctx) => String(ctx.readPin(n.config.pin)),
    fw: {
      setup: (n) =>
        `pinMode(${n.config.pin}, ${pinModeOf(n.config.pull)});`,
      loop: (n, i, build) =>
        `{ static unsigned long tick${i} = 0; if (millis() - tick${i} >= ${n.config.interval}UL) { tick${i} = millis(); node${i}(String(${readDigital(build)}(${n.config.pin}))); } }`,
    },
  },
  "digital-write": {
    label: "GPIO output",
    icon: "◈",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    sink: true,
    pin: "out",
    help: "Writes LOW for 0 or false and HIGH for anything else. It has an input connection only: the other end is the pin on the circuit.",
    fields: [pinField(2)],
    summary: "write GPIO {pin}",
    host(v, n, ctx) {
      ctx.writePin(n.config.pin, isOff(String(v)) ? 0 : 1);
      return v;
    },
    fw: {
      setup: (n) => `pinMode(${n.config.pin}, OUTPUT);`,
      body: (n) =>
        `digitalWrite(${n.config.pin}, (value == "0" || value == "false") ? LOW : HIGH);`,
    },
  },
  "pwm-write": {
    label: "PWM out",
    icon: "⊓",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    pin: "pwm",
    help: "Writes a numeric payload 0–255 as PWM duty (LED brightness, motor speed). Values are clamped; non-numeric payloads are dropped.",
    fields: [pinField(2)],
    summary: "PWM GPIO {pin}",
    host(v, n, ctx) {
      const x = toNumber(v);
      if (x === null) return undefined;
      ctx.writePin(n.config.pin, Math.max(0, Math.min(255, Math.trunc(x))));
      return v;
    },
    fw: {
      setup: (n) => `pinMode(${n.config.pin}, OUTPUT);`,
      body: (n) =>
        `double x; if (!mfNumber(value, x)) return; analogWrite(${n.config.pin}, x < 0 ? 0 : x > 255 ? 255 : (int)x);`,
    },
  },
  pulse: {
    label: "Pulse",
    icon: "⊓",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    pin: "out",
    help: "One-shot pulse: each incoming message drives the pin active for the set width, then back. Sends 1 when the pulse starts and 0 when it ends. Optionally takes the width (ms) from a numeric payload. Non-blocking.",
    fields: [
      pinField(2),
      {
        key: "width",
        label: "Width (ms)",
        type: "number",
        default: 500,
        min: 1,
        max: 3600000,
        integer: true,
      },
      {
        key: "active",
        label: "Active level",
        type: "select",
        default: "high",
        options: {
          high: "HIGH (active-high)",
          low: "LOW (e.g. NodeMCU LED on GPIO 2)",
        },
      },
      {
        key: "retrigger",
        label: "Triggered while on",
        type: "select",
        default: "restart",
        options: {
          restart: "Restart the pulse",
          ignore: "Ignore until it ends",
        },
      },
      {
        key: "fromPayload",
        label: "Width from numeric payload",
        type: "select",
        default: "no",
        options: {
          no: "No, always use Width",
          yes: "Yes, payload = ms (1–3600000)",
        },
      },
    ],
    summary: "GPIO {pin} pulse {width} ms",
    host(v, n, ctx) {
      const { pin, width, active, retrigger, fromPayload } = n.config;
      const st = ctx.state;
      if (st.on && retrigger === "ignore") return undefined;
      const x = toNumber(v);
      const ms =
        fromPayload === "yes" && x !== null && x >= 1 && x <= 3600000
          ? Math.trunc(x)
          : width;
      const on = active === "high" ? 1 : 0;
      ctx.writePin(pin, on);
      st.on = true;
      ctx.cancel(st.timer);
      st.timer = ctx.later(ms, () => {
        st.on = false;
        ctx.writePin(pin, 1 - on);
        ctx.forward("0");
      });
      return "1";
    },
    fw: {
      // State shared between the node function (start) and loop() (end).
      globals: (n, i) =>
        `bool mfPulseOn${i} = false; unsigned long mfPulseStart${i} = 0, mfPulseWidth${i} = ${n.config.width};`,
      setup: (n) =>
        `pinMode(${n.config.pin}, OUTPUT); digitalWrite(${n.config.pin}, ${n.config.active === "high" ? "LOW" : "HIGH"});`,
      // A 1-character value of 0x1F is loop()'s private "pulse ended" signal.
      body: (n, i) => {
        const { pin, width, active, retrigger, fromPayload } = n.config;
        return `if (value.length() == 1 && value[0] == 31) { value = "0"; } else {${retrigger === "ignore" ? ` if (mfPulseOn${i}) return;` : ""} mfPulseWidth${i} = ${width};${fromPayload === "yes" ? ` double x; if (mfNumber(value, x) && x >= 1 && x <= 3600000) mfPulseWidth${i} = (unsigned long)x;` : ""} digitalWrite(${pin}, ${active === "high" ? "HIGH" : "LOW"}); mfPulseOn${i} = true; mfPulseStart${i} = millis(); value = "1"; }`;
      },
      loop: (n, i) =>
        `if (mfPulseOn${i} && millis() - mfPulseStart${i} >= mfPulseWidth${i}) { mfPulseOn${i} = false; digitalWrite(${n.config.pin}, ${n.config.active === "high" ? "LOW" : "HIGH"}); node${i}(String((char)31)); }`,
    },
  },
  display: {
    label: "Display",
    icon: "▭",
    color: "#78a47a",
    tint: "#eaf4e7",
    group: "OUTPUT",
    needs: "display",
    help: "Shows the payload on one line of the board's built-in screen (TTGO T-Display LCD, or the 0.96″ OLED of a Heltec WiFi Kit 32 or Lolin32 OLED), after an optional label. Rows are 0–6 from the top (on the LCD medium text fills one row and large text uses about two; the OLED shows small text only, 21 characters a row, in white). Optional text appears at boot. The payload passes through, so you can also report it over MQTT.",
    fields: [
      {
        key: "row",
        label: "Row (0 = top … 6)",
        type: "number",
        default: 0,
        min: 0,
        max: 6,
        integer: true,
      },
      {
        key: "label",
        label: "Label before the value",
        type: "text",
        default: "",
      },
      {
        key: "size",
        label: "Text size",
        type: "select",
        default: "2",
        options: { 1: "Small (8 px)", 2: "Medium (16 px)", 3: "Large (24 px)" },
      },
      {
        key: "color",
        label: "Colour",
        type: "select",
        default: "white",
        options: {
          white: "White",
          green: "Green",
          yellow: "Yellow",
          cyan: "Cyan",
          orange: "Orange",
          red: "Red",
          magenta: "Magenta",
        },
      },
      {
        key: "initial",
        label: "Text shown at boot (optional)",
        type: "text",
        default: "",
      },
    ],
    summary: "LCD row {row} · {label}…",
    host(v, n, ctx) {
      const { row, label, size, color } = n.config;
      ctx.display({ row, size: Number(size), color, text: label + String(v) });
      return v;
    },
    fw: {
      body: (n) => {
        const { row, label, size, color } = n.config;
        return `mfLcd(${row}, ${size}, ${LCD_COLORS[color]}, ${label ? `String(${quoted(label)}) + value` : "value"});`;
      },
    },
  },
  "mqtt-out": {
    label: "Radio out",
    icon: "⇤",
    color: "#a286b2",
    tint: "#f2eaf7",
    group: "OUTPUT",
    needs: radioNeeds,
    help: "Sends the payload to other boards. MQTT: publishes to a topic on the broker (QoS 0, optionally retained). ESP-NOW: broadcasts topic + payload to ESP32 boards nearby, no router (up to about 180 bytes). I2C: as controller it writes the value to a peripheral's address; as peripheral (ESP32 boards) it sets the reply the controller reads when it polls. Local MQTT (ESP32 boards): publishes on the MQTT broker this board runs itself, for other boards and PCs on the LAN that connect to it, and for this board's own Radio in boxes.",
    fields: radioFields("out"),
    validate: (c) => checkRadio(c, false),
    summary: RADIO_SUMMARY,
    host(v, n, ctx) {
      const c = n.config;
      if ((c.protocol || "mqtt") === "mqtt") {
        const text = payloadText(c, v, ctx.msg, n);
        const own = parseBroker(c.broker);
        if (own) ctx.publishTo(own, c, c.topic, text, c.retain === "yes");
        else ctx.publish(c.topic, text, c.retain === "yes");
      } else if (c.protocol === "espnow") ctx.espnow(c.topic, String(v));
      else if (c.protocol === "local") ctx.localMqtt(c.topic, String(v));
      else ctx.i2c(n, String(v));
      return v;
    },
    fw: {
      // A broker of its own: a second MQTT client, connected (and reconnected with
      // back-off) from loop(); messages sent while it is offline are dropped (QoS 0).
      globals(n, i, build) {
        const c = n.config;
        const own = protocolOf(c) === "mqtt" && parseBroker(c.broker);
        if (!own || !build?.net) return "";
        const id = c.clientId
          ? quoted(c.clientId)
          : `mfId + ${quoted("-" + n.id)}`;
        const login = (v) => (v ? quoted(v) : "NULL");
        return `// Radio out "${ascii(n.label)}": its own MQTT broker ${ascii(own.host)}:${own.port}.
WiFiClient mfNet${i};
PubSubClient mfMqtt${i}(mfNet${i});
bool mfBroker${i}() {
  static unsigned long last = 0, wait = 5000;
  static bool tried = false;
  if (mfMqtt${i}.connected()) return true;
  if (WiFi.status() != WL_CONNECTED || (tried && millis() - last < wait)) return false;
  tried = true;
  last = millis();
  mfMqtt${i}.setServer(${quoted(own.host)}, ${own.port});
  String id = ${id};
  if (mfMqtt${i}.connect(id.c_str(), ${login(c.username)}, ${login(c.password)})) { wait = 5000; return true; }
  if (wait < 30000) wait *= 2; // connect() blocks while the broker is unreachable
  return false;
}`;
      },
      loop: (n, i, build) =>
        protocolOf(n.config) === "mqtt" &&
        parseBroker(n.config.broker) &&
        build?.net
          ? `if (mfBroker${i}()) mfMqtt${i}.loop();`
          : "",
      body: (n, i, build) => {
        const c = n.config;
        if (c.protocol === "espnow")
          return `mfNowSend(${cTopic(c.topic)}, value);`;
        if (c.protocol === "local")
          return `mfLocalPublish(${cTopic(c.topic)}, value, ${c.retain === "yes"});`;
        if (c.protocol === "i2c")
          return c.i2cRole === "peripheral"
            ? "mfI2cReply(value);"
            : `mfI2cWrite(${c.address}, value);`;
        const payload = payloadExpr(c, build, n);
        const out = payload === "value" ? "value" : `mfPayload`;
        const prep =
          payload === "value" ? "" : `String mfPayload = ${payload}; `;
        return parseBroker(c.broker)
          ? `${prep}if (mfBroker${i}()) mfMqtt${i}.publish(${cTopic(c.topic)}, ${out}.c_str(), ${c.retain === "yes"});`
          : `${prep}mqtt.publish(${cTopic(c.topic)}, ${out}.c_str(), ${c.retain === "yes"});`;
      },
    },
  },
  "ble-out": {
    label: "BLE out",
    icon: "ᛒ",
    color: "#5b8fc7",
    tint: "#e6eff9",
    group: "OUTPUT",
    needs: "bluetooth",
    help: `Broadcasts the payload over Bluetooth LE to every board nearby with a BLE in node on the same link name. ESP32 boards only. Up to ${blefw.MAX_PAYLOAD} bytes (longer values are cut). Each value is sent for ${blefw.BURST_MS} ms, so it suits a few values per second (buttons, readings, commands), not streaming. A board does not hear its own messages. In the simulator the value is only logged.`,
    fields: [linkField],
    validate: checkLink,
    summary: "BLE link {link}",
    host(v, n, ctx) {
      ctx.ble(n.config.link, String(v).slice(0, blefw.MAX_PAYLOAD));
      return v;
    },
    fw: {
      body: (n) => `mfBleSend(${blefw.sendArgs(n.config.link)}, value);`,
    },
  },
  "web-out": {
    label: "Web out",
    icon: "⇱",
    color: "#c08a3e",
    tint: "#f8eedd",
    group: "OUTPUT",
    needs: "webserver",
    web: "GET",
    help: 'Publishes the payload as a JSON variable: GET http://<board IP>/api/<name> returns {"<name>": value}, and GET /api returns all Web out values. JSON payloads (numbers, true/false, objects, arrays) pass unchanged; other text becomes a JSON string. Use the same name as a Web in node for a read/write variable.',
    fields: [webName("output")],
    validate: checkWebName,
    summary: "GET /api/{name}",
    host(v, n, ctx) {
      ctx.web(n.config.name, String(v));
      return v;
    },
    fw: {
      body: (n, i, build) =>
        `mfWebSet(${build.webOuts.indexOf(n.config.name)}, value);`,
    },
  },
  // A peripheral doing one operation per trigger, its parameters set by inputs
  // or defaults and kept in a C union (lib/peripheral.js).
  peripheral: {
    label: "Peripheral",
    icon: "⚡",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    slots: true, // knows which input sent a value
    quietOutput: true,
    help: peripheral.help,
    helpBy: peripheral.helpBy,
    fields: peripheral.fields,
    pinSpec: peripheral.pinSpec,
    validate: peripheral.validate,
    summary: {
      servo: "Servo · GPIO {pin}",
      stepper: "Stepper · {driver}",
      gyro: "MPU-6050 · {gyroOut}",
    },
    summaryBy: "kind",
    host: peripheral.host,
    fw: {
      globals: peripheral.globals,
      setup: peripheral.setup,
      body: peripheral.body,
      loop: peripheral.loop,
    },
  },
  // Still pictures as PNG files (lib/camerafw.js): Freenove ESP32-S3 WROOM CAM.
  // Phone keyboard page over MQTT (lib/pwafw.js).
  pwa: {
    label: "PWA",
    icon: "📱",
    color: "#4f7fa8",
    tint: "#e6eff8",
    group: "INPUT",
    needs: "wifi",
    help: 'A phone page (PWA) that looks like a keyboard, linked to the board over MQTT with JSON. Its output: each key pressed on the phone ("7", "Enter", or the JSON {"key":"7"}). Its input: what the phone shows: JSON {"text":"…","image":"name"} or plain text; images are static ones carried by the page (Images JSON), or a small data URI. Publish test page writes the page to the project folder pwa/<name>/ and opens it: served by Microflow it talks through the simulator or the monitored board; copied to any HTTPS static host it uses the broker WebSocket URL. Topics: microflow/<device>/pwa/<node id>/in and /out.',
    fields: pwafw.fields,
    validate: (c) => pwafw.validate(c),
    summary: "{title}",
    host: pwafw.host,
    fw: { body: (n) => pwafw.body(n) },
  },
  // A group of nodes saved as one box (lib/custom.js): expanded before it runs.
  custom: {
    label: "Custom",
    icon: "◈",
    color: "#5d6f9e",
    tint: "#e9edf7",
    group: "CUSTOM",
    help: "A custom node: nodes you combined and saved to the library (select nodes, then Save as custom node). Wires into it go to its input nodes, wires out of it come from its output nodes. Unpack it in Properties to see or change what is inside.",
    fields: [],
    validate: (c) => customfw.checkDef(c.def),
    summary: "custom node",
  },
  // Speech (lib/speechfw.js): voice commands from a PDM microphone (ESP32-S3),
  // and text-to-speech through an I2S amplifier.
  "voice-in": {
    label: "Voice command",
    icon: "🎤",
    color: "#8a6db0",
    tint: "#f0eaf7",
    group: "INPUT",
    source: true,
    manual: true, // the simulator (and a debug build's inject topic) can send a command
    needs: "speech",
    help: "Recognises spoken commands offline on an ESP32-S3 (16 MB flash, PSRAM) with a PDM microphone on two pins (CLK, DATA; e.g. SPM1423 / MP34DT01, XIAO ESP32S3 Sense: CLK 42, DATA 41). Each line of Commands is one command, | separates phrases that mean the same. It sends the command (its first phrase) or its number. With Listening = wake word, say \"Hi ESP\" first. In the PC simulation, use 🎤 (the browser's speech recognition) or type a phrase on the box.",
    fields: speechfw.voiceFields,
    pinSpec: [
      { key: "clk", use: "out", sim: false },
      { key: "data", use: "in", sim: false },
    ],
    validate: (c) => speechfw.checkCommands(c),
    summaryBy: "wake",
    summary: {
      wakeword: "Hi ESP · mic {clk}/{data}",
      always: "always listening · mic {clk}/{data}",
    },
    fw: speechfw.voiceFw,
  },
  speak: {
    label: "Speak",
    icon: "🔊",
    color: "#8a6db0",
    tint: "#f0eaf7",
    group: "OUTPUT",
    sink: true,
    needs: "i2sout",
    help: "Says the text it receives (English, SAM speech synthesizer) through an I2S amplifier such as MAX98357A: BCLK, LRC (WS) and DIN pins. The flow pauses while it talks (up to 250 characters). In the PC simulation it talks through this PC's speakers.",
    fields: speechfw.speakFields,
    pinSpec: [
      { key: "bclk", use: "out", sim: false, shared: "speaker" },
      { key: "lrc", use: "out", sim: false, shared: "speaker" },
      { key: "din", use: "out", sim: false, shared: "speaker" },
    ],
    summary: "{voice} · amp {bclk}/{lrc}/{din}",
    host(v, n, ctx) {
      ctx.speak(n, speechfw.sayText(n.config, v));
      return v;
    },
    fw: speechfw.speakFw,
  },
  camera: {
    label: "Camera",
    icon: "📷",
    color: "#6d9baa",
    tint: "#e8f2f6",
    group: "HARDWARE",
    needs: "stillcam",
    quietOutput: true,
    help: camerafw.help,
    fields: camerafw.fields,
    summary: "{sensor} · {size} · PNG",
    host: camerafw.host,
    fw: {
      globals: camerafw.globals,
      setup: camerafw.setup,
      body: camerafw.body,
    },
  },
  // Motors (lib/devices.js): servo or stepper.
  "output-device": devices.outputDevice,
  debug: {
    label: "Debug",
    icon: "≡",
    color: "#78a47a",
    tint: "#eaf4e7",
    group: "OUTPUT",
    help: "Prints to serial and, with telemetry on, publishes to microflow/<device>/debug/<node id> so tests and the console can see it. In a flow in Node-RED language it can show the complete message (payload, topic and other fields) instead of msg.payload.",
    fields: [
      {
        key: "show",
        label: "Output",
        type: "select",
        default: "payload",
        options: {
          payload: "msg.payload",
          msg: "complete msg object (Node-RED language)",
        },
      },
    ],
    summary: "{show}",
    host(v, n, ctx) {
      ctx.debug(n, n.config.show === "msg" && ctx.msg ? ctx.msg : String(v));
      return v;
    },
    fw: {
      // Debug output exists only in debug builds; release builds drop it entirely.
      body: (n, i, build) => {
        if (!build.debug) return "";
        // The complete message: what arrived, with the payload as it is now.
        const out =
          n.config.show === "msg" && build.language === "nodered"
            ? 'mfMsg::out(mfIn, value, "{}")'
            : "value";
        return `{ String mfShow = ${out}; Serial.print(${quoted((n.label || "debug") + ": ")}); Serial.println(mfShow);${build.net ? ` if (mfTelemetry && mqtt.connected()) mqtt.publish((mfBase + ${quoted("/debug/" + n.id)}).c_str(), mfShow.c_str());` : ""} }`;
      },
    },
  },
  // Status: an I2C display for the status of other nodes (lib/statusfw.js).
  status: statusfw.node,
  // Test devices: virtual controls and instruments for trying a flow out. Switch and
  // Push button fire like a manual Inject (from the box in the IDE, or over the inject
  // MQTT topic on a debug build); the Oscilloscope plots what reaches it.
  "test-switch": {
    label: "Switch",
    icon: "⏻",
    color: "#c08a3e",
    tint: "#f8efe1",
    group: "TEST",
    source: true,
    manual: true,
    legacy: true, // replaced by GPIO input, whose box has PUSH and SWITCH
    help: "On/off switch for testing (no longer in the node library: a GPIO input box has PUSH and SWITCH while simulating or emulating, and works unchanged on the real circuit). Click ON/OFF on the box to flip it: it sends 1 when switched on and 0 when switched off. Works in the PC simulation, and on a board with a debug build (sent over MQTT like a manual Inject).",
    fields: [],
    summary: "click to toggle",
  },
  "test-button": {
    label: "Push button",
    icon: "◎",
    color: "#c08a3e",
    tint: "#f8efe1",
    group: "TEST",
    source: true,
    manual: true,
    legacy: true, // replaced by GPIO input, whose box has PUSH and SWITCH
    help: "Momentary push button for testing (no longer in the node library: a GPIO input box has PUSH and SWITCH while simulating or emulating, and works unchanged on the real circuit): sends 1 when pressed and 0 when released. Works in the PC simulation, and on a board with a debug build (sent over MQTT like a manual Inject).",
    fields: [],
    summary: "hold to press",
  },
  // Function generator: a test signal (sine, square, triangle, sawtooth) as numbers.
  "func-gen": {
    label: "Function generator",
    icon: "≋",
    color: "#c08a3e",
    tint: "#f8efe1",
    group: "TEST",
    source: true,
    help: "Test signal generator: every sample interval it sends offset + amplitude × the waveform (sine, square, triangle or sawtooth, between −1 and 1) at the chosen frequency. Connect it to an Oscilloscope to see it, to PWM out (amplitude 127.5, offset 127.5 for 0–255) to dim an LED in a wave, or to Threshold / Logic / C/C++ to test them with a known signal. Runs on the board too (timed with millis(), so the chip keeps running) and in the PC simulation.",
    fields: [
      {
        key: "wave",
        label: "Waveform",
        type: "select",
        default: "sine",
        options: {
          sine: "Sine",
          square: "Square",
          triangle: "Triangle",
          sawtooth: "Sawtooth (ramp up)",
        },
      },
      {
        key: "freq",
        label: "Frequency (Hz)",
        type: "number",
        default: 0.5,
        min: 0.001,
        max: 50,
      },
      {
        key: "amplitude",
        label: "Amplitude (peak)",
        type: "number",
        default: 1,
        min: 0,
        max: 1000000,
      },
      {
        key: "offset",
        label: "Offset",
        type: "number",
        default: 0,
        min: -1000000,
        max: 1000000,
      },
      {
        key: "duty",
        label: "Duty cycle (%)",
        type: "number",
        default: 50,
        min: 1,
        max: 99,
        integer: true,
        when: { wave: ["square"] },
      },
      {
        key: "interval",
        label: "Sample interval (ms)",
        type: "number",
        default: 50,
        min: 10,
        max: 60000,
        integer: true,
      },
      {
        key: "decimals",
        label: "Decimals",
        type: "number",
        default: 2,
        min: 0,
        max: 6,
        integer: true,
        advanced: true,
      },
    ],
    validate(c) {
      // At least 2 samples per period, or the wave cannot be seen.
      if ((1000 / c.freq) / c.interval < 2)
        throw Error(
          `Function generator: at ${c.freq} Hz the sample interval must be at most ${Math.floor(500 / c.freq)} ms (two samples per period); 10 or more samples per period draw a smooth wave.`,
        );
    },
    summary: "{wave} · {freq} Hz",
    simulate(n, sim) {
      const t0 = Date.now();
      sim.every(n.config.interval, () =>
        sim.send(funcGenValue(n.config, Date.now() - t0)),
      );
    },
    fw: {
      loop: (n, i) => {
        const c = n.config;
        const period = Math.max(1, Math.round(1000 / c.freq)); // ms
        const shape = {
          sine: "sin(6.283185307179586 * ph)",
          square: `(ph < ${c.duty / 100} ? 1.0 : -1.0)`,
          triangle: "(ph < 0.5 ? 4.0 * ph - 1.0 : 3.0 - 4.0 * ph)",
          sawtooth: "(2.0 * ph - 1.0)",
        }[c.wave];
        return `{ static unsigned long t${i} = 0;
    if (millis() - t${i} >= ${c.interval}UL) {
      t${i} = millis();
      double ph = (double)(millis() % ${period}UL) / ${period}.0; // phase 0…1
      node${i}(String(${Number(c.offset)} + ${Number(c.amplitude)} * ${shape}, ${c.decimals}));
    } }`;
      },
    },
  },
  "test-scope": {
    label: "Oscilloscope",
    icon: "∿",
    color: "#c08a3e",
    tint: "#f8efe1",
    group: "TEST",
    sink: true,
    help: "Plots the values it receives over time, like a scope probe. on/true count as 1 and off/false as 0; other text is skipped. With a real board it needs a debug build with telemetry on, because the values arrive over MQTT.",
    fields: [
      {
        key: "window",
        label: "Time window (s)",
        type: "number",
        default: 10,
        min: 1,
        max: 120,
        integer: true,
      },
    ],
    summary: "last {window} s",
    host(v, n, ctx) {
      ctx.scope(n, String(v));
    },
    fw: {
      // Same channel as Debug: the IDE draws the values it sees on the debug topic.
      body: (n, i, build) =>
        build.debug && build.net
          ? `if (mfTelemetry && mqtt.connected()) mqtt.publish((mfBase + ${quoted("/debug/" + n.id)}).c_str(), value.c_str());`
          : "",
    },
  },
  // Screen: shows the pictures it receives on its box, in the PC simulator only.
  "test-screen": {
    label: "Screen",
    icon: "▭",
    color: "#c08a3e",
    tint: "#f8efe1",
    group: "TEST",
    sink: true,
    simOnly: true,
    help: "Shows the picture it receives on its box: a Camera node's output ({\"image\": …}), a picture address (http://… or /api/…), or a data: URL. Click the picture to see it full size. Simulation only: it works with ▶ Simulate, and adds nothing to the board's firmware.",
    fields: [
      {
        key: "size",
        label: "Screen size",
        type: "select",
        default: "medium",
        options: {
          small: "Small (192 × 144)",
          medium: "Medium (288 × 216)",
          large: "Large (384 × 288)",
        },
      },
      {
        key: "info",
        label: "Show picture details",
        type: "select",
        default: "yes",
        options: { yes: "Yes: size and shot number", no: "No" },
      },
    ],
    summary: "{size} · simulation only",
    host(v, n, ctx) {
      ctx.screen?.(n, String(v));
    },
    // Simulation only: nothing on the board.
    fw: { body: () => "" },
  },
};
// Nodes fired on demand: manual Inject, Switch and Push button.
const isManual = (n) =>
  !!types[n.type]?.manual ||
  (n.type === "inject" && !Number(n.config.interval));
// Validates config against field definitions, normalising numbers and filling defaults.
function normalizeConfig(n) {
  const def = types[n.type];
  const c = n.config;
  for (const f of def.fields) {
    // Code may be left empty on purpose; other empty fields take their default.
    if (c[f.key] === undefined || (c[f.key] === "" && !f.empty))
      c[f.key] = f.default;
    if (f.type === "number") {
      const x = Number(c[f.key]);
      if (!Number.isFinite(x) || (f.integer && !Number.isInteger(x)))
        throw Error(
          `${n.label}: ${f.label} must be ${f.integer ? "an integer" : "numeric"}.`,
        );
      if (
        (f.min !== undefined && x < f.min) ||
        (f.max !== undefined && x > f.max)
      )
        throw Error(
          `${n.label}: ${f.label} must be between ${f.min} and ${f.max}.`,
        );
      c[f.key] = x;
    } else if (f.type === "select") {
      if (!Object.hasOwn(f.options, c[f.key]))
        throw Error(`${n.label}: choose a valid ${f.label.toLowerCase()}.`);
    } else if (f.type === "secret") {
      c[f.key] = String(c[f.key] ?? "");
      if (c[f.key].length > 64)
        throw Error(`${n.label}: ${f.label} is limited to 64 characters.`);
    } else if (f.type === "textarea") {
      c[f.key] = String(c[f.key] ?? "").replace(/\r\n?/g, "\n");
      if (c[f.key].length > 4000)
        throw Error(`${n.label}: ${f.label} is limited to 4000 characters.`);
    } else if (f.type === "code") {
      c[f.key] = String(c[f.key] ?? "").replace(/\r\n?/g, "\n");
      if (c[f.key].length > MAX_CODE)
        throw Error(
          `${n.label}: ${f.label.split(" ·")[0]} is limited to ${MAX_CODE} characters.`,
        );
    } else {
      c[f.key] = String(c[f.key]);
      if (c[f.key].length > 256)
        throw Error(`${n.label}: ${f.label} is limited to 256 characters.`);
    }
  }
  def.validate?.(c, n);
}
const catalog = () =>
  Object.fromEntries(
    Object.entries(types).map(([type, d]) => [
      type,
      {
        label: d.label,
        icon: d.icon,
        color: d.color,
        tint: d.tint,
        group: d.group,
        help: d.help,
        fields: d.fields,
        summary: d.summary,
        // Protocol-dependent needs (Radio in/out) are checked per node in analyze().
        needs: typeof d.needs === "function" ? null : d.needs || null,
        web: d.web || null,
        manualSummary: d.manualSummary,
        summaryBy: d.summaryBy || null,
        source: !!d.source,
        sink: !!d.sink,
        // No wires at all (Status: nodes report to it through their Properties).
        standalone: !!d.standalone,
        // "Show on the Status display": whether the node can, and how its line reads
        // (lib/statusfw.js text(), which the IDE repeats).
        statusOk: statusfw.canShow(type),
        statusKind: statusfw.kindOf(type),
        statusPin: statusfw.PIN_TYPES.has(type),
        // Several output ports (Counter): their names, top to bottom.
        outputs: d.outputs || null,
        // Kept for older flows, no longer offered in the node library.
        legacy: !!d.legacy,
        simOnly: !!d.simOnly,
        pin: d.pin || null,
        manual: !!d.manual,
        varName: VAR_NAMES[type] || "NODE",
        varType: VAR_TYPES[type] || "String",
        inType:
          d.source || d.standalone || type === "arduino"
            ? null
            : IN_TYPES[type] || "String",
        signal: SIGNALS[type] || null,
        // Device nodes: pins, help, names and types that depend on the settings.
        pinSpec: d.pinSpec || null,
        helpBy: d.helpBy || null,
        varNames: devices.varNames[type] || null,
        varTypes: devices.varTypes[type] || null,
      },
    ]),
  );
// The Function generator's value t ms after it started (same as its firmware).
function funcGenValue(c, t) {
  const period = Math.max(1, Math.round(1000 / c.freq));
  const ph = (t % period) / period;
  const y = {
    sine: Math.sin(2 * Math.PI * ph),
    square: ph < c.duty / 100 ? 1 : -1,
    triangle: ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph,
    sawtooth: 2 * ph - 1,
  }[c.wave];
  return (c.offset + c.amplitude * y).toFixed(c.decimals);
}
module.exports = {
  funcGenValue,
  LCD_COLORS,
  types,
  normalizeConfig,
  catalog,
  quoted,
  toNumber,
  checkTopic,
  cTopic,
  DEVICE,
  isManual,
  isMqttRadio,
  protocolOf,
  PROTOCOLS,
  pinsOf,
  hardwareUse,
  parseBroker,
  autoName,
  varNameProblem,
  varType,
  inType,
  convertValue,
  conversionNote,
  TYPE_LABEL,
  IN_TYPES,
  payloadType,
  TYPES,
  RESERVED,
  arduinoWarnings,
  wireProblem,
  sendsSignal: sends_,
  SIGNALS,
  codeOnly,
  sends,
  // What a node needs from the board ("wifi", "espnow", …), given its settings.
  needsOf: (n) => {
    const needs = types[n.type].needs;
    return typeof needs === "function" ? needs(n.config) : needs || null;
  },
};
