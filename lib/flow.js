const camerafw = require("./camerafw");
const { createHash } = require("node:crypto");
const {
  types: defs,
  normalizeConfig,
  quoted,
  cTopic,
  isManual,
  isMqttRadio,
  needsOf,
  pinsOf,
  arduinoWarnings,
  wireProblem,
  sendsSignal,
  sends,
  autoName,
  varNameProblem,
  varType,
  inType,
  conversionNote,
  TYPE_LABEL,
  TYPES,
} = require("./nodes");
const { checkFields } = require("./msg");
const { boards, checkPin, FEATURES } = require("./boards");
const otafw = require("./otafw");
const emufw = require("./emufw");
const shellfw = require("./shellfw");
const displayfw = require("./displayfw");
const blefw = require("./blefw");
const webfw = require("./webfw");
const termfw = require("./termfw");
const radiofw = require("./radiofw");
const jsonfw = require("./jsonfw");
const logic = require("./logic");
const devices = require("./devices");
const speechfw = require("./speechfw");
const timer = require("./timer");
const counter = require("./counter");
const peripheral = require("./peripheral");
const custom = require("./custom");
const pwafw = require("./pwafw");
const amebafw = require("./amebafw");
const picofw = require("./picofw");
// Families whose firmware updates over USB only (no remote update).
const USB_UPDATE_ONLY = new Set(["ameba", "rp2040"]);
const statusfw = require("./statusfw");
const types = Object.keys(defs);
// Custom boxes replaced by their nodes (lib/custom.js); other flows as they are.
const expandCustom = (flow) => custom.expand(flow, defs);
const LIMITS = { nodes: 64, edges: 128, tabs: 16, chips: 8 };
// Connections as the flow runs them: the drawn edges plus one from each Link out
// to every Link in with the same link name (usually on another flow tab).
function wiring(flow) {
  const ins = flow.nodes.filter((n) => n.type === "link-in");
  const links = flow.nodes
    .filter((n) => n.type === "link-out")
    .flatMap((o) =>
      ins
        .filter((i) => i.config.link === o.config.link)
        .map((i) => ({ from: o.id, to: i.id })),
    );
  return links.length ? [...flow.edges, ...links] : flow.edges;
}
// Flow tabs are pages of one flow: { id, name } each, and node.tab names a node's
// tab. Nodes without a (known) tab belong to the first tab.
// Chips (multi-chip projects): { id, name, board, deviceId, serialPort } each, and
// tab.chip names a tab's chip. Each chip compiles on its own (the IDE sends one
// chip's tabs and nodes), so the limits below grow with the number of chips.
function validateChips(flow) {
  if (flow.chips === undefined || flow.chips === null) {
    delete flow.chips;
    return new Set();
  }
  if (!Array.isArray(flow.chips) || flow.chips.length > LIMITS.chips)
    throw Error(`A project has at most ${LIMITS.chips} chips.`);
  const ids = new Set();
  flow.chips = flow.chips.map((c) => {
    if (!c || !/^[a-zA-Z0-9_-]{1,32}$/.test(c.id) || ids.has(c.id))
      throw Error("Invalid or duplicate chip.");
    ids.add(c.id);
    return {
      id: c.id,
      name: String(c.name || "Chip").slice(0, 40),
      board: boards[c.board] ? c.board : "",
      deviceId: String(c.deviceId || "").slice(0, 64),
      serialPort: String(c.serialPort || "").slice(0, 128),
    };
  });
  if (!flow.chips.length) delete flow.chips;
  return ids;
}
function validateTabs(flow, chips) {
  if (flow.tabs === undefined) return new Set();
  const most = LIMITS.tabs * Math.max(1, chips.size);
  if (!Array.isArray(flow.tabs) || flow.tabs.length > most)
    throw Error(`A flow has at most ${LIMITS.tabs} tabs per chip.`);
  const ids = new Set();
  flow.tabs = flow.tabs.map((t) => {
    if (!t || !/^[a-zA-Z0-9_-]{1,32}$/.test(t.id) || ids.has(t.id))
      throw Error("Invalid or duplicate flow tab.");
    ids.add(t.id);
    return {
      id: t.id,
      name: String(t.name || "Flow").slice(0, 40),
      ...(chips.has(t.chip) ? { chip: t.chip } : {}),
    };
  });
  if (!flow.tabs.length) delete flow.tabs;
  return ids;
}
function validate(flow) {
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges))
    throw Error("A flow needs nodes and edges.");
  const chips = validateChips(flow);
  // The board a one-chip flow was saved with (the IDE opens it with that board).
  if (flow.board !== undefined && (chips.size || !boards[flow.board]))
    delete flow.board;
  const per = Math.max(1, chips.size);
  if (
    flow.nodes.length > LIMITS.nodes * per ||
    flow.edges.length > LIMITS.edges * per
  )
    throw Error(
      `Limit: ${LIMITS.nodes} nodes and ${LIMITS.edges} connections${per > 1 ? " per chip" : ""}.`,
    );
  const tabs = validateTabs(flow, chips);
  const ids = new Set();
  for (const n of flow.nodes) {
    if (
      !n ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) ||
      ids.has(n.id) ||
      !types.includes(n.type)
    )
      throw Error("Invalid or duplicate node.");
    ids.add(n.id);
    if (n.tab !== undefined && !tabs.has(n.tab)) delete n.tab;
    n.config ||= {};
    if (typeof n.config !== "object" || Array.isArray(n.config))
      throw Error("Node configuration must be an object.");
    n.label = String(n.label || defs[n.type].label).slice(0, 100);
    n.x = Math.max(30, Math.min(1200, Number(n.x) || 60));
    n.y = Math.max(20, Math.min(750, Number(n.y) || 60));
    normalizeConfig(n);
  }
  // Variable names (shown under each node's label; inputs of Arduino nodes): check
  // the given ones, then give the others a unique default such as GPIO4 or SW1.
  const names = new Set();
  for (const n of flow.nodes) {
    if (n.name === undefined || n.name === null || n.name === "") {
      delete n.name;
      continue;
    }
    n.name = String(n.name);
    const why = varNameProblem(n.name);
    if (why) throw Error(`${n.label}: variable name "${n.name}": ${why}.`);
    if (names.has(n.name))
      throw Error(`Two nodes have the variable name ${n.name}.`);
    names.add(n.name);
  }
  for (const n of flow.nodes)
    if (!n.name) names.add((n.name = autoName(n, names)));
  // Language: "nodered" (JSON messages on every wire) or "arduino" (plain values, the
  // default for flows saved before the choice existed).
  if (flow.language !== "nodered") flow.language = "arduino";
  for (const n of flow.nodes) {
    // Variable type in Arduino nodes: automatic unless chosen.
    if (n.vtype === undefined || n.vtype === "" || n.vtype === "auto")
      delete n.vtype;
    else if (!TYPES.includes(n.vtype))
      throw Error(
        `${n.label}: variable type must be auto, ${TYPES.join(", ")}.`,
      );
    // Input type: what the node converts each value it receives to (auto: none).
    if (n.itype === undefined || n.itype === "" || n.itype === "auto")
      delete n.itype;
    else if (!TYPES.includes(n.itype))
      throw Error(`${n.label}: input type must be auto, ${TYPES.join(", ")}.`);
    // Message fields (Node-RED language): a JSON object the node adds to what it sends.
    if (n.msg === undefined || n.msg === null || n.msg === "") {
      delete n.msg;
      if (flow.language === "nodered") n.msg = defaultFields(n);
    } else {
      n.msg = String(n.msg);
      if (n.msg.length > 256)
        throw Error(`${n.label}: Message is limited to 256 characters.`);
      try {
        checkFields(n.msg);
      } catch (e) {
        throw Error(`${n.label}: ${e.message}`);
      }
    }
    // "Show on the Status display" (lib/statusfw.js): true, or left out.
    if (n.status === true && statusfw.canShow(n.type)) n.status = true;
    else delete n.status;
  }
  const unique = new Set();
  // GPIO input / GPIO output: the pin is one end, so there is no wire on it. Older
  // flows had wires into a GPIO input or out of a GPIO output: they are dropped.
  flow.edges = flow.edges.filter((e) => {
    const from = flow.nodes.find((n) => n.id === e?.from);
    const to = flow.nodes.find((n) => n.id === e?.to);
    return !(from?.type === "digital-write" || to?.type === "digital-read");
  });
  for (const e of flow.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to))
      throw Error("Connection references a missing node.");
    const standalone = [e.from, e.to]
      .map((id) => flow.nodes.find((n) => n.id === id))
      .find((n) => defs[n.type].standalone);
    if (standalone)
      throw Error(
        `${standalone.label} has no wires: to show a node's status on it, tick "Show on the Status display" in that node's Properties.`,
      );
    if (defs[flow.nodes.find((n) => n.id === e.to).type].source)
      throw Error(
        "Input nodes (inject, terminal, Radio in, web in, BLE in, GPIO input, GPIO input (change), analog sample, switch, push button) cannot receive connections.",
      );
    const fromDef = defs[flow.nodes.find((n) => n.id === e.from).type];
    if (fromDef.sink)
      throw Error("Link out nodes have no output connection.");
    // Output port: only nodes with several outputs (Counter) use 1, 2, …
    if (e.port === undefined || e.port === null || e.port === 0) delete e.port;
    else if (
      !Number.isInteger(e.port) ||
      e.port < 0 ||
      e.port >= (fromDef.outputs?.length || 1)
    )
      throw Error("Connection from an output that does not exist.");
    const key = e.from + ">" + e.to + ">" + (e.port || 0);
    if (unique.has(key)) throw Error("Duplicate connection.");
    unique.add(key);
  }
  const seen = new Set(),
    visiting = new Set(),
    all = wiring(flow);
  const visit = (id) => {
    if (visiting.has(id))
      throw Error("Cycles are unsupported (Link out / Link in included).");
    if (seen.has(id)) return;
    visiting.add(id);
    // A PWA node's input only shows on the phone (it never passes on), so a loop
    // back into it (keys → logic → phone screen) is no cycle.
    all
      .filter((e) => e.from === id)
      .filter((e) => flow.nodes.find((n) => n.id === e.to)?.type !== "pwa")
      .forEach((e) => visit(e.to));
    visiting.delete(id);
    seen.add(id);
  };
  flow.nodes.forEach((n) => visit(n.id));
  return flow;
}
const isLink = (type) => type === "link-in" || type === "link-out";
// A node's default Message box: inputs name where a message comes from.
const defaultFields = (n) =>
  defs[n.type].source ? JSON.stringify({ topic: n.name }) : "{}";
// One pin for two nodes: an input and an output, or two outputs, clash (two
// inputs, or nodes sharing an I2C bus, do not). uses: pin → [pinsOf entries].
const pinRole = (use) => (use === "in" || use === "adc" ? "input" : "output");
function pinClashes(uses) {
  const out = [];
  const who = (p) => `${p.name || p.label} (${defs[p.type].label})`;
  for (const [pin, list] of uses) {
    // Nodes on one shared bus count once.
    const own = list.filter(
      (p, k) => !p.shared || list.findIndex((q) => q.shared === p.shared) === k,
    );
    const ins = own.filter((p) => pinRole(p.use) === "input");
    const outs = own.filter((p) => pinRole(p.use) === "output");
    if (ins.length && outs.length)
      out.push(
        `GPIO ${pin} is an input for ${ins.map(who).join(", ")} and an output for ${outs.map(who).join(", ")}. A pin can be an input or an output, not both: choose another pin for one of them.`,
      );
    else if (outs.length > 1)
      out.push(
        `GPIO ${pin} is driven by ${outs.map(who).join(" and ")}: two outputs on one pin fight each other. Choose another pin for one of them.`,
      );
  }
  return out;
}
// Board-specific checks. Errors block firmware generation; warnings are shown to the user.
function analyze(flow, boardId) {
  flow = expandCustom(flow);
  validate(flow);
  if (!boards[boardId]) throw Error("Choose a supported board.");
  const errors = [],
    warnings = [];
  const uses = new Map();
  // ESP32 GPIO 34–39 (and ESP8266 GPIO 16) ignore a pull-up request.
  const noPull = (pin, label) =>
    warnings.push(
      `${label}: GPIO ${pin} has no internal pull-up on ${boards[boardId].label}. Wire an external pull-up (or pull-down) resistor, or the reading floats (often stuck at 0).`,
    );
  // Simulation-only nodes (Screen) build to nothing on the board.
  const simOnly = flow.nodes.filter((n) => defs[n.type].simOnly);
  if (simOnly.length)
    warnings.push(
      `${simOnly.map((n) => `${n.label} (${n.name || n.type})`).join(", ")}: simulation only; on the board ${simOnly.length > 1 ? "they do" : "it does"} nothing.`,
    );
  errors.push(...amebafw.check(flow, boards[boardId]));
  errors.push(...picofw.check(flow, boards[boardId]));
  for (const n of flow.nodes) {
    // One entry per pin of a hardware node.
    for (const { pin, use, label } of pinsOf(n)) {
      const r = checkPin(boardId, pin, use, label);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
    for (const p of pinsOf(n)) {
      if (!uses.has(p.pin)) uses.set(p.pin, []);
      uses.get(p.pin).push({ ...p, type: n.type });
    }
    if (
      (n.type === "digital-read" || n.type === "gpio-watch") &&
      n.config.pull !== "none" &&
      boards[boardId].noPull?.includes(n.config.pin)
    )
      noPull(n.config.pin, n.label);
    // The ESP8266 has internal pull-ups only.
    if (
      (n.type === "digital-read" || n.type === "gpio-watch") &&
      n.config.pull === "pulldown" &&
      boards[boardId].family === "esp8266"
    )
      errors.push(
        `${n.label}: the ESP8266 has no internal pull-down. Choose "Internal pull-up" with the button to GND, or "Floating / external resistor" with a 10 kΩ resistor from the pin to GND and the button to 3.3 V.`,
      );
    if (n.type === "arduino") {
      warnings.push(...arduinoWarnings(n));
    }
  }
  warnings.push(...pinClashes(uses));
  // Analog → Logic / Timer, and Logic / Timer → analog outputs, need a converter.
  {
    const all = wiring(flow);
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const upstream = (n) =>
      all.filter((e) => e.to === n.id).map((e) => byId.get(e.from));
    for (const e of all) {
      const why = wireProblem(byId.get(e.from), byId.get(e.to), upstream);
      if (why) errors.push(why);
    }
    // A chosen Input or Output type that changes a value on its way: a warning.
    for (const e of all) {
      const a = byId.get(e.from),
        b = byId.get(e.to);
      if (!a.vtype && !b.itype) continue;
      const note = conversionNote(varType(a, upstream), inType(b, upstream));
      if (note)
        warnings.push(
          `${a.label} (${a.name}) → ${b.label} (${b.name}): ${note}.`,
        );
    }
  }
  // Logic nodes: named inputs (Set, Reset, Data, Clock) must be connected.
  for (const n of flow.nodes)
    if (n.type === "logic") {
      const inputs = wiring(flow)
        .filter((e) => e.to === n.id)
        .map((e) => flow.nodes.find((m) => m.id === e.from));
      const r = logic.warnings(n, inputs);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
  // Camera: one per board, and not together with an Image sensor (one camera).
  {
    const stills = flow.nodes.filter((n) => n.type === "camera");
    if (stills.length > 1)
      errors.push("A board has one camera: use one Camera node.");
    for (const n of stills) errors.push(...camerafw.problems(n));
    if (
      stills.length &&
      flow.nodes.some(
        (n) => n.type === "input-device" && n.config.device === "camera",
      )
    )
      errors.push(
        "The Camera node and an Input device Image sensor both use the board's camera: keep one of them.",
      );
  }
  // Timers and counters: Set / Reset (Count / Reset) inputs connected.
  for (const n of flow.nodes)
    if (n.type === "timer" || n.type === "counter") {
      const byId = new Map(flow.nodes.map((m) => [m.id, m]));
      const inputs = [
        ...new Set(
          wiring(flow)
            .filter((e) => e.to === n.id)
            .map((e) => e.from),
        ),
      ].map((id) => byId.get(id));
      errors.push(...(n.type === "timer" ? timer : counter).check(n, inputs));
    }
  // Peripherals: Trigger and parameter inputs connected; the trigger is on / off.
  for (const n of flow.nodes)
    if (n.type === "peripheral") {
      const all = wiring(flow);
      const byId = new Map(flow.nodes.map((m) => [m.id, m]));
      const inputs = all
        .filter((e) => e.to === n.id)
        .map((e) => byId.get(e.from));
      errors.push(...peripheral.check(n, inputs));
      const trigger = inputs.find((m) => m.name === n.config.trigger);
      const upstream = (m) =>
        all.filter((e) => e.to === m.id).map((e) => byId.get(e.from));
      if (trigger && sendsSignal(trigger, "analog", upstream))
        errors.push(
          `${n.label}: Trigger input ${trigger.name} sends an analog value, not on / off. Convert it first with a Threshold or Compare, or use a button, switch or Logic node.`,
        );
    }
  // Nodes that produce a value for the next node, but have nothing connected.
  const SINKS = new Set([
    "digital-write",
    "pwm-write",
    "mqtt-out",
    "ble-out",
    "web-out",
    "debug",
    "display",
    "pulse",
    "link-out",
  ]);
  for (const n of flow.nodes)
    if (
      !SINKS.has(n.type) &&
      !defs[n.type].sink &&
      !defs[n.type].quietOutput && // e.g. a motor: sending on is optional
      !(n.type === "arduino" && !sends(n.config)) && // code without send() is an end point
      !statusfw.shown(flow.nodes).includes(n) && // its value shows on the Status display
      !flow.edges.some((e) => e.from === n.id)
    )
      warnings.push(
        `${n.label}'s output is not connected: its value goes nowhere. Connect it to e.g. Display, Radio out or Debug.`,
      );
  for (const n of flow.nodes) {
    const other = n.type === "link-in" ? "link-out" : "link-in";
    if (
      isLink(n.type) &&
      !flow.nodes.some(
        (m) => m.type === other && m.config.link === n.config.link,
      )
    )
      warnings.push(
        n.type === "link-in"
          ? `${n.label}: no Link out uses link name "${n.config.link}", so it never fires.`
          : `${n.label}: no Link in uses link name "${n.config.link}", so its value goes nowhere.`,
      );
  }
  const board = boards[boardId];
  for (const [need, f] of Object.entries(FEATURES))
    if (!f.has(board) && flow.nodes.some((n) => needsOf(n) === need))
      errors.push(f.missing(board));
  // Radio in/out over I2C and ESP-NOW: roles, pins, addresses, channel.
  const radio = radiofw.check(flow, boardId, board);
  errors.push(...radio.errors);
  warnings.push(...radio.warnings);
  // Input / Output devices: shared I2C bus, one camera, servo channels, speeds.
  const dev = devices.check(flow, board);
  errors.push(...dev.errors);
  warnings.push(...dev.warnings);
  // Voice command / Speak (lib/speechfw.js).
  const speech = speechfw.check(flow);
  errors.push(...speech.errors);
  warnings.push(...speech.warnings);
  // Status display: one per board, and the nodes that show on it.
  const status = statusfw.check(flow);
  errors.push(...status.errors);
  warnings.push(...status.warnings);
  for (const n of flow.nodes)
    if (
      !defs[n.type].source &&
      !defs[n.type].standalone && // no wires by design (Status)
      !flow.edges.some((e) => e.to === n.id) &&
      !(n.type === "display" && n.config.initial) && // shows its boot text
      !(n.type === "arduino" && (n.config.loop.trim() || n.config.setup.trim())) // runs by itself
    )
      warnings.push(
        `${n.label} has no incoming connection and will never run.`,
      );
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
function checkSettings(s) {
  if (!boards[s.board]) throw Error("Choose a supported board.");
  const port = Number(s.port || 1883);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid broker port.");
  const host = String(s.host || "192.168.1.10").trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host))
    throw Error("Firmware broker host must be a hostname or IPv4 address.");
  if (s.deviceId && !/^[A-Za-z0-9_-]{1,32}$/.test(s.deviceId))
    throw Error("Device ID may use letters, digits, - and _ (max 32).");
  if (Buffer.byteLength(String(s.ssid || "")) > 32)
    throw Error("WiFi SSID is limited to 32 bytes.");
  if (Buffer.byteLength(String(s.password || "")) > 64)
    throw Error("WiFi password is limited to 64 bytes.");
  if (s.profile && !["debug", "release"].includes(s.profile))
    throw Error("Build profile must be debug or release.");
  return {
    ...s,
    port,
    host,
    telemetry: s.telemetry !== false,
    profile: s.profile || "debug",
    ota: s.ota !== false,
    emulate: s.emulate === true,
    usbTest: s.usbTest === true,
    // false = WiFi and MQTT off (single chip, USB only); true / unset = as needed.
    network: s.network !== false,
  };
}
// What a build contains. Debug builds carry the IDE's debugging hooks (telemetry,
// MQTT debug/inject, USB status). Release builds run on their own: only the flow,
// plus remote update when enabled. Without MQTT nodes and remote update, a release
// build never starts WiFi.
function features(flow, s) {
  const debug = s.profile !== "release";
  const mqttNodes =
    flow.nodes.some(isMqttRadio) || flow.nodes.some((n) => n.type === "pwa");
  // Boards without a radio build without WiFi, MQTT and remote
  // update; debug builds then talk over USB serial only.
  const wifi = boards[s.board].wifi !== false;
  // WiFi and MQTT are optional: the Device panel can switch both off (single chip),
  // and a USB test build has them off as well.
  const offline = s.usbTest || s.network === false;
  const web = webfw.uses(flow.nodes);
  return {
    debug,
    // PC input emulation: debug builds only, never in standalone release firmware.
    emulate: debug && s.emulate === true,
    // Remote update uses the ESP cores' Update / ArduinoOTA (not on Realtek or Pico boards).
    ota: wifi && s.ota && !offline && !USB_UPDATE_ONLY.has(boards[s.board].family),
    // Local MQTT: the board's own broker needs WiFi (but no outside broker).
    // USB test builds keep WiFi off, even in debug builds.
    net:
      wifi &&
      !offline &&
      (debug || s.ota || mqttNodes || web || radiofw.uses(flow.nodes).local),
    // USB test: what each node handles, and the pin levels, on USB serial.
    log: s.usbTest === true,
    offline,
    mqttNodes,
    wifi,
    web,
    webOuts: webfw.outs(flow.nodes),
    language: flow.language === "nodered" ? "nodered" : "arduino",
    // For device nodes (lib/devices.js): chip family, camera pins, servo channels.
    family: boards[s.board].family,
    camera: boards[s.board].camera || null,
    servoChannel: devices.servoChannels(flow.nodes),
  };
}
// Build ID identifies the flow + non-secret settings so telemetry can reveal stale firmware.
const buildId = (flow, s) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        flow.nodes,
        flow.edges,
        s.board,
        s.host,
        s.port,
        s.deviceId || "",
        s.telemetry,
        s.profile,
        s.ota,
        s.emulate,
        flow.language || "arduino",
        ...(s.usbTest ? ["usbTest"] : []), // (older build IDs stay the same)
        ...(s.network === false ? ["noNetwork"] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 10);
const nullable = (v) => (v ? quoted(v) : "NULL");
// Placeholder keys for previews; real keys are added only when compiling.
const PREVIEW_KEYS = {
  enc: Buffer.alloc(32),
  mac: Buffer.alloc(32),
  lan: "inserted-at-compile-time",
};
const lines = (items) => items.filter(Boolean).join("\n");
// ── USB test builds: a readable log on USB serial ──
const ascii = (t) => String(t).replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "'");
// Digital pins of the flow: [pin, what, mode text].
function logPins(nodes) {
  const out = [];
  for (const n of nodes) {
    const who = ascii(`${n.label || n.type}${n.name ? " (" + n.name + ")" : ""}`);
    const p = Number(n.config?.pin);
    if (n.type === "gpio-watch" || n.type === "digital-read")
      out.push([p, who, n.config.pull === "pullup" ? "INPUT_PULLUP" : n.config.pull === "pulldown" ? "INPUT_PULLDOWN" : "INPUT"]);
    else if (["digital-write", "pulse"].includes(n.type)) out.push([p, who, "OUTPUT"]);
  }
  return out.filter(([p]) => Number.isInteger(p));
}
function logGlobals(nodes) {
  const names = nodes.map((n) => `"${ascii(`${n.label || n.type}${n.name ? " (" + n.name + ")" : ""}`)}"`);
  return `// USB test build: each box's value on USB serial.
const char* const MF_LOG_NAMES[] = { ${names.join(", ")} };
void mfLog(size_t i, const String& value, int output) {
  Serial.print("["); Serial.print(millis()); Serial.print(" ms] "); Serial.print(MF_LOG_NAMES[i]);
  if (output) { Serial.print(" output "); Serial.print(output); }
  Serial.print(" -> "); Serial.println(value);
}
`;
}
function logSetup(nodes) {
  const pins = logPins(nodes);
  return [
    '  Serial.println("USB test build: WiFi OFF. Pins:");',
    ...pins.map(([p, who, mode]) => `  Serial.println("  GPIO ${p}: ${mode}  <- ${who}");`),
    ...(pins.length ? [] : ['  Serial.println("  (no GPIO boxes in this flow)");']),
  ].join("\n");
}
function logLoop(nodes) {
  const pins = [...new Set(logPins(nodes).map(([p]) => p))];
  if (!pins.length) return "";
  return `{ static unsigned long mfLogAt = 0; if (millis() - mfLogAt >= 2000UL) { mfLogAt = millis(); Serial.print("[pins]"); ${pins.map((p) => `Serial.print(" GPIO ${p}="); Serial.print(digitalRead(${p}));`).join(" ")} Serial.println(); } }`;
}
// Adds a board menu option to an FQBN that may already carry options (a:b:c:x=1,y=2).
const withOption = (fqbn, option) =>
  fqbn + (fqbn.split(":").length > 3 ? "," : ":") + option;
// Board options set (or replaced) by key: "PSRAM=opi" replaces an earlier PSRAM.
function withOptions(fqbn, options) {
  const [vendor, arch, board, opts = ""] = fqbn.split(":");
  const map = new Map(
    opts
      .split(",")
      .filter(Boolean)
      .map((o) => o.split("=")),
  );
  for (const o of options) {
    const [k, v] = o.split("=");
    map.set(k, v);
  }
  const list = [...map].map(([k, v]) => `${k}=${v}`).join(",");
  return `${vendor}:${arch}:${board}${list ? ":" + list : ""}`;
}
function build(flow, rawSettings = {}) {
  flow = expandCustom(flow);
  const s = checkSettings(rawSettings);
  const report = analyze(flow, s.board);
  if (report.errors.length) throw Error(report.errors.join(" "));
  const f = features(flow, s);
  if (f.net && !s.ssid)
    report.warnings.push(
      "WiFi SSID is empty; the board will not connect. For a single chip that needs no network, untick “WiFi and MQTT” in the Device panel.",
    );
  if (s.ota && USB_UPDATE_ONLY.has(boards[s.board].family) && rawSettings.ota !== undefined)
    report.warnings.push(
      `Remote update is not available on ${boards[s.board].label}: this build updates over USB only.`,
    );
  if (f.net && !String(rawSettings.host || "").trim())
    report.warnings.push(
      `Firmware broker host is empty; this preview uses ${s.host}, which is only a placeholder. Enter the broker the board should use.`,
    );
  if (!f.debug) {
    if (s.emulate)
      report.warnings.push(
        "PC input emulation needs a Debug build: this release build reads the real pins.",
      );
    if (flow.nodes.some(isManual))
      report.warnings.push(
        "Release build: manual inject, switch and push button nodes are triggered from the IDE, so they never fire.",
      );
    if (flow.nodes.some((n) => n.type === "debug"))
      report.warnings.push("Release build: debug nodes produce no output.");
    if (!f.net && f.wifi)
      report.warnings.push(
        "Release build without MQTT nodes or remote update: WiFi stays off and the chip runs fully offline. Updates need USB.",
      );
  }
  const board = boards[s.board];
  if (f.log || (f.offline && f.wifi)) {
    const needNet = flow.nodes.filter(
      (n) =>
        isMqttRadio(n) ||
        n.type === "pwa" ||
        webfw.uses([n]) ||
        radiofw.uses([n]).local,
    );
    if (needNet.length)
      throw Error(
        `${f.log ? "USB test builds have" : "WiFi and MQTT are switched off, so this build has"} no WiFi: ${needNet.map((n) => n.label).join(", ")} need${needNet.length > 1 ? "" : "s"} it. Remove ${needNet.length > 1 ? "them" : "it"}, or ${f.log ? "untick USB test" : "tick “WiFi and MQTT”"} in the Device panel.`,
      );
    if (!f.log)
      report.warnings.push(
        "WiFi and MQTT are off: no PC telemetry, MQTT tests or remote update. The chip runs the flow on its own; upload and the test terminal use USB.",
      );
  }
  if (f.log) {
    report.warnings.push(
      "USB test build: WiFi is off (no MQTT, telemetry or remote update). The serial monitor (115200 baud) shows the pin modes at start, every value each box handles, and the flow's pin levels every 2 s.",
    );
  }
  if (!f.wifi)
    report.warnings.push(
      `${board.label} has no WiFi: the firmware runs offline. Upload, board check and the test terminal work over USB; MQTT tests, telemetry and remote update are not available.${f.debug && flow.nodes.some(isManual) ? " Manual inject, switch and push button nodes fire from the test terminal: send <node id> <payload>." : ""}`,
    );
  const ble = blefw.uses(flow.nodes);
  const terminal = termfw.uses(flow.nodes);
  if (ble && s.ota && !/PartitionScheme=/.test(board.fqbn))
    report.warnings.push(
      "Bluetooth needs a larger app partition (Minimal SPIFFS, 1.9 MB). Upload over USB the first time after adding BLE nodes; remote updates work after that.",
    );
  const id = buildId(flow, s);
  const index = new Map(flow.nodes.map((n, i) => [n.id, i]));
  const fw = (n) => defs[n.type].fw || {};
  const all = wiring(flow);
  // C++ calls passing `v` from node i to each connected node. An Arduino node learns
  // which input sent it (mfFrom<i>), so each input is a variable of its own there.
  // The nodes wired into n, in order (an input's position is its slot).
  const slotsOf = (n) => [
    ...new Set(all.filter((e) => e.to === n.id).map((e) => e.from)),
  ];
  const wireOf = (n) => ({
    inputs: slotsOf(n).map((id) => flow.nodes[index.get(id)]),
  });
  // port: only the wires from that output (nodes with several outputs).
  const calls = (n, v, port) =>
    all
      .filter((e) => e.from === n.id)
      .filter((e) => port === undefined || (e.port || 0) === port)
      .map((e) => {
        const j = index.get(e.to);
        if (fw(flow.nodes[j]).defs)
          return `mfArduino${j}::mfFrom${index.get(n.id)}(${v});`;
        // Nodes that tell their inputs apart (Logic): which input this is.
        if (defs[flow.nodes[j].type].slots)
          return `{ mfSlot${j} = ${slotsOf(flow.nodes[j]).indexOf(n.id)}; node${j}(${v}); }`;
        return `node${j}(${v});`;
      });
  const red = f.language === "nodered";
  // Nodes shown on the Status display report each value they handle (as mfTrace).
  const shownCall = (n, v, port) => {
    const c = statusfw.call(flow.nodes, n, v, port);
    return c ? "\n  " + c : "";
  };
  const fieldsOf = (n) => (n.msg ? checkFields(n.msg) : "{}");
  // Nodes with several outputs (Counter): one function per output port,
  // node<i>_out<k>(value), which the node calls itself.
  const ports = (n) => defs[n.type].outputs?.length || 0;
  const portFuncs = flow.nodes.flatMap((n, i) =>
    Array.from({ length: ports(n) }, (_, k) => {
      const next = calls(n, red ? "mfOut" : "value", k).map((c) => "  " + c);
      const wrap = red && next.length
        ? `\n  String mfOut = mfMsg::out("{}", value, ${quoted(fieldsOf(n))});`
        : "";
      const trace =
        (f.emulate ? `\n  mfTrace(${i}, value);` : "") +
        (f.log ? `\n  mfLog(${i}, value, ${k + 1});` : "");
      const status = shownCall(n, "value", k);
      return `// ${n.label.replace(/[^\x20-\x7e]/g, "?").replace(/\*\//g, "* /")}: output ${k + 1}\nvoid node${i}_out${k}(String value) {${trace}${status}${wrap}${next.length ? "\n" + next.join("\n") : "\n  (void)value;"}\n}`;
    }),
  );
  const funcs = flow.nodes.map((n, i) => {
    const next = ports(n)
      ? [] // sends through its output functions
      : calls(n, red ? "mfOut" : "value").map((c) => "  " + c);
    const body = fw(n).body?.(n, i, f, wireOf(n));
    // Arduino nodes forward (and report) only through their own send().
    if (fw(n).defs)
      return `// ${n.label.replace(/[^\x20-\x7e]/g, "?").replace(/\*\//g, "* /")} (${n.type})\nvoid node${i}(String value) {\n  ${body}\n}`;
    // Emulation builds report what passes each node (after its body, so filtered
    // messages are not reported).
    const trace =
      (f.emulate ? `\n  mfTrace(${i}, value);` : "") +
      (f.log && !ports(n) ? `\n  mfLog(${i}, value, 0);` : "");
    // With several outputs (Counter) each output function reports its own value.
    const status = ports(n) ? "" : shownCall(n, "value");
    // Input / Output types chosen in Properties: each value received, and each value
    // sent, becomes that type (private signals from loop(), char 31, pass unchanged).
    const TO = { bool: "toBool", int: "toInt", double: "toFloat" };
    const convert = (t) =>
      TO[t]
        ? `\n  if (!(value.length() && value[0] == 31)) value = mfJson::${TO[t]}(value); // as ${TYPE_LABEL[t]}`
        : "";
    const typeIn = convert(n.itype),
      typeOut = convert(n.vtype);
    // Node-RED language: the node works on msg.payload (value); what it sends is the
    // message with the new payload, its Message fields and the fields it received.
    const unwrap = red
      ? `\n  String mfIn = mfMsg::in(value, ${defs[n.type].source ? "true" : "false"});\n  value = mfMsg::payload(mfIn);`
      : "";
    const wrap =
      red && next.length
        ? `\n  String mfOut = mfMsg::out(mfIn, value, ${quoted(fieldsOf(n))});`
        : red
          ? "\n  (void)mfIn;"
          : "";
    return `// ${n.label.replace(/[^\x20-\x7e]/g, "?").replace(/\*\//g, "* /")} (${n.type})\nvoid node${i}(String value) {${unwrap}${typeIn}${body ? "\n  " + body : ""}${typeOut}${trace}${status}${wrap}${next.length ? "\n" + next.join("\n") : ""}\n}`;
  });
  // Code nodes (Arduino): defined after every global and node prototype, with
  // prototypes of their input functions first so any node can call them.
  const inputsOf = (n) =>
    all
      .filter((e) => e.to === n.id)
      .map((e) => {
        const m = flow.nodes[index.get(e.from)];
        return {
          i: index.get(e.from),
          name: m.name,
          type: varType(m, upstream),
        };
      });
  const codeNodes = flow.nodes.filter((n) => fw(n).defs);
  // The nodes feeding n (for variable types that follow their input).
  function upstream(n) {
    return all
      .filter((e) => e.to === n.id)
      .map((e) => flow.nodes[index.get(e.from)]);
  }
  const prototypes = codeNodes.flatMap((n) =>
    inputsOf(n).map(
      (x) =>
        `namespace mfArduino${index.get(n.id)} { void mfFrom${x.i}(const String& v); }`,
    ),
  );
  const defsCode = [
    ...(codeNodes.length ||
    red ||
    flow.nodes.some(
      (n) =>
        ["logic", "timer", "counter", "peripheral", "camera", "pwa"].includes(n.type) ||
        n.itype ||
        n.vtype,
    )
      ? [jsonfw.helpers.trim()]
      : []),
    ...(red ? [jsonfw.msgHelpers.trim()] : []),
    ...(prototypes.length ? [prototypes.join("\n")] : []),
    ...codeNodes.map((n) =>
      fw(n).defs(n, index.get(n.id), f, {
        // send(v) shows v on the Status display first, when the node is shown there
        // (Node-RED language: the payload of mfOut, which sendMsg() has too).
        send: [
          statusfw.call(flow.nodes, n, red ? "mfMsg::payload(mfOut)" : "v"),
          ...calls(n, red ? "mfOut" : "v"),
        ].filter(Boolean),
        inputs: inputsOf(n),
        language: f.language,
        fields: fieldsOf(n),
      }),
    ),
  ];
  const subscriptions = flow.nodes.filter(
    (n) => n.type === "mqtt-in" && isMqttRadio(n),
  );
  const pwas = flow.nodes.filter((n) => n.type === "pwa"); // phone pages
  const radio = radiofw.uses(flow.nodes);
  const manual = f.debug ? flow.nodes.filter(isManual) : [];
  const timed = flow.nodes.filter(
    (n) => n.type === "inject" && n.config.interval,
  );
  const setup = [
    ...new Set(
      flow.nodes.map((n) => fw(n).setup?.(n, index.get(n.id))).filter(Boolean),
    ),
  ];
  if (ble) setup.unshift(...blefw.setup(flow.nodes, f.net));
  if (f.emulate) setup.unshift(emufw.setup); // before nodes read inputs
  setup.push(...radiofw.setup(flow.nodes));
  setup.unshift(...devices.setup(flow.nodes, !!radio.i2c)); // I2C before the sensors
  if (
    board.family === "esp8266" &&
    flow.nodes.some((n) => n.type === "pwm-write")
  )
    setup.push("analogWriteRange(255);");
  const loops = [
    ...flow.nodes
      .map((n) => fw(n).loop?.(n, index.get(n.id), f, wireOf(n)))
      .filter(Boolean),
    ...radiofw.loop(flow.nodes, index),
    ...statusfw.loop(flow.nodes),
  ];
  const chipId =
    board.family === "esp8266"
      ? "ESP.getChipId()"
      : "(uint32_t)ESP.getEfuseMac()";
  const flowName = quoted(
    JSON.stringify(String(flow.name || "flow").slice(0, 60)),
  );
  const keys = rawSettings.otaKeys || PREVIEW_KEYS;
  const wifiHeader = board.family === "esp8266" ? "ESP8266WiFi" : "WiFi";
  // Screen support: when the flow uses it, or in debug builds for the terminal's lcd command.
  const lcd =
    !!board.display &&
    (f.debug || flow.nodes.some((n) => n.type === "display"));
  const header = `// Generated by Microflow · build ${id} · ${f.debug ? "DEBUG" : "RELEASE"}${f.ota ? " + remote update" : ""} · ${board.label} (${board.fqbn})
// GPIO numbers are chip GPIO, not board D-labels.${f.net ? " Contains WiFi/MQTT credentials: do not share." : ""}
${f.wifi ? `#include <${wifiHeader}.h>\n` : ""}${f.net ? "#include <PubSubClient.h>\n" : ""}${ble ? blefw.includes : ""}${f.web ? webfw.includes(board.family) : ""}${lcd ? displayfw.includesFor(board) : ""}${radiofw.includes(radio)}${devices.includes(flow.nodes, board.family, !!radio.i2c)}${speechfw.includes(flow.nodes)}#include <math.h>
#include <stdlib.h>
#include <ctype.h>
#include <string.h>
`;
  const common = `
const char* MF_BUILD = "${id}";
String mfId, mfBase;
${f.net ? `const char* MF_SSID = ${quoted(s.ssid)};\nconst char* MF_PASS = ${quoted(s.password)};\n` : ""}
${
  f.net
    ? `WiFiClient network;
PubSubClient mqtt(network);
const bool mfTelemetry = ${f.debug && s.telemetry};
// Expands {{device}} in topics to this board's Device ID.
String mfTopic(const char* topic) {
  String t(topic);
  t.replace("{{device}}", mfId);
  return t;
}
`
    : radio.espnow
      ? `// Expands {{device}} in topics to this board's Device ID.
String mfTopic(const char* topic) {
  String t(topic);
  t.replace("{{device}}", mfId);
  return t;
}
`
      : ""
}${f.ota ? otafw.globals(board.family, keys) + "\n" : ""}
bool mfNumber(const String& s, double& out) {
  const char* start = s.c_str();
  char* end;
  out = strtod(start, &end);
  if (end == start) return false;
  while (*end && isspace((unsigned char)*end)) end++;
  return *end == 0 && isfinite(out);
}
${
  subscriptions.length || radio.espnow || radio.local
    ? `bool mqttTopicMatch(const char* filter, const char* topic) {
  if (*topic == '$' && *filter != '$') return false;
  while (*filter && *topic) {
    if (*filter == '#') return true;
    if (*filter == '+') { while (*topic && *topic != '/') topic++; filter++; }
    else if (*filter++ != *topic++) return false;
  }
  if (*filter == '+' && *topic == 0) filter++;
  if (*filter == '/' && filter[1] == '#' && *topic == 0) return true;
  return (*filter == 0 && *topic == 0) || (*filter == '#' && *topic == 0);
}`
    : ""
}
${f.emulate ? emufw.globals(flow.nodes) : ""}${f.log ? logGlobals(flow.nodes) : ""}${peripheral.types(flow.nodes)}${lines(flow.nodes.map((n, i) => fw(n).globals?.(n, i, f, wireOf(n))))}
${statusfw.globals(flow.nodes)}
${lcd ? displayfw.globals(board) : ""}${flow.nodes.map((n, i) => `void node${i}(String value);` + Array.from({ length: ports(n) }, (_, k) => ` void node${i}_out${k}(String value);`).join("")).join("\n")}${radiofw.globals(flow.nodes, index, f)}
${ble ? blefw.globals(flow.nodes, index) : ""}
${terminal ? termfw.globals(flow.nodes, index) + (f.debug ? "" : termfw.releasePoll) : ""}
${
  f.web
    ? (f.debug ? "String mfCommand(String line);\n" : "") +
      webfw.globals(
        flow.nodes,
        index,
        board.family,
        f.debug
          ? "mfCommand(line)"
          : terminal
            ? '[&]() { String r = mfTerminal(line); return r.length() ? r : String("error: unknown command"); }()'
            : 'String("error: release build without Terminal nodes")',
      )
    : ""
}
${defsCode.join("\n\n")}
${funcs.join("\n")}${portFuncs.length ? "\n" + portFuncs.join("\n") : ""}
`;
  const debugHooks = f.debug
    ? `${shellfw.shell({ board, nodes: flow.nodes, net: f.net, terminal, extra: lcd ? displayfw.shell : "", extraHelp: lcd ? " | lcd <row 0-6> <text> | lcd clear" : "", emulate: f.emulate })}
${
  f.net
    ? `void mfSendTelemetry() {
  String t = String("{\\"uptime\\":") + (millis() / 1000) + ",\\"heap\\":" + ESP.getFreeHeap() + ",\\"rssi\\":" + WiFi.RSSI() +
    ",\\"ip\\":\\"" + WiFi.localIP().toString() + "\\",\\"build\\":\\"" + MF_BUILD + "\\",\\"board\\":\\"${s.board}\\",\\"ota\\":${f.ota ? 1 : 0},\\"flow\\":" + ${flowName} + "}";
  mqtt.publish((mfBase + "/telemetry").c_str(), t.c_str());
}
// Answers "mf?" on USB serial so the IDE can verify the board after upload.
void mfReport() {
  Serial.println(String("MF:{\\"build\\":\\"") + MF_BUILD + "\\",\\"id\\":\\"" + mfId + "\\",\\"wifi\\":" + (int)WiFi.status() +
    ",\\"mqtt\\":" + mqtt.state() + ",\\"ip\\":\\"" + WiFi.localIP().toString() + "\\",\\"rssi\\":" + WiFi.RSSI() +
    ",\\"heap\\":" + ESP.getFreeHeap() + ",\\"uptime\\":" + (millis() / 1000) + ",\\"ota\\":${f.ota ? 1 : 0}${f.emulate ? ',\\"emu\\":1' : ""}}");
}`
    : `// Answers "mf?" on USB serial so the IDE can verify the board after upload.
// "net":0 tells the IDE this build has no WiFi/MQTT to check.
void mfReport() {
  Serial.println(String("MF:{\\"build\\":\\"") + MF_BUILD + "\\",\\"id\\":\\"" + mfId + "\\",\\"net\\":0" +
    ",\\"heap\\":" + ESP.getFreeHeap() + ",\\"uptime\\":" + (millis() / 1000) + ",\\"ota\\":0${f.emulate ? ',\\"emu\\":1' : ""}}");
}`
}
void mfSerialPoll() {
  static String line;
  static unsigned long first = 0, last = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 10 || c == 13) { // newline / carriage return
      if (line == "mf?") mfReport();
      else if (line.length()) mfSerialReply(mfCommand(line)); // test terminal
      line = "";
    } else if (line.length() < 128) {
      if (!line.length()) first = millis();
      last = millis();
      line += c;
    }
  }
  // A line sent in one go without Enter (a terminal's "Send as text"): run it after
  // 0.3 s of quiet. Typed key by key it waits for Enter.
  if (line.length() > 1 && millis() - last > 300 && last - first < 50) {
    if (line == "mf?") mfReport();
    else mfSerialReply(mfCommand(line));
    line = "";
  }
}
`
    : "";
  // Ping lets the IDE confirm which build runs (debug, and after remote updates).
  const ping = f.debug || f.ota;
  const received = f.net
    ? `void received(char* rawTopic, byte* payload, unsigned int length) {
  // Copy first: publishing from a node reuses PubSubClient's buffer that rawTopic/payload point into.
  String topicCopy(rawTopic);
${lines([
  f.ota && otafw.dispatch,
  "  const char* topic = topicCopy.c_str();",
  "  String value;",
  "  value.reserve(length);",
  "  for (unsigned int i = 0; i < length; i++) value += (char)payload[i];",
  f.debug && shellfw.mqttDispatch,
  ping &&
    `  if ((mfBase + "/ping") == topicCopy) {
    mqtt.publish((mfBase + "/pong").c_str(), (value + " " + MF_BUILD + " ${f.ota ? "ota" : "no-ota"}").c_str());
    return;
  }`,
  ...manual.map(
    (n) =>
      `  if ((mfBase + ${quoted("/inject/" + n.id)}) == topicCopy) node${index.get(n.id)}(length ? value : String(${quoted(n.config.payload ?? "1")}));`,
  ),
  ...subscriptions.map(
    (n) =>
      `  if (mqttTopicMatch(${cTopic(n.config.topic)}, topic)) node${index.get(n.id)}(value);`,
  ),
  ...pwas.map((n) => pwafw.received(n, index.get(n.id))),
])}
  (void)topic;
}
`
    : "";
  const setupFn = `void setup() {
  Serial.begin(115200);${
    board.usbSerial
      ? "\n  Serial.setTxTimeoutMs(10); // USB serial: barely stall when no program reads the port (0 makes the core send nothing)"
      : ""
  }
${lcd ? displayfw.setup(board, flow) + "\n" : ""}${lines(setup.map((l) => "  " + l))}
  mfId = ${s.deviceId ? quoted(s.deviceId) : `String("microflow-") + String(${chipId}, HEX)`};
  mfBase = String("microflow/") + mfId;
${
  f.net
    ? `  WiFi.persistent(false); // avoid flash writes on every boot
  WiFi.mode(WIFI_STA);
  WiFi.begin(MF_SSID, MF_PASS);
  mqtt.setBufferSize(${pwas.length ? (board.family === "esp8266" ? 2048 : 8192) : f.ota ? 1024 : 512});${pwas.length ? " // PWA: room for images (data URIs)" : ""}
  mqtt.setServer(${quoted(s.host)}, ${s.port});
  mqtt.setCallback(received);${f.web ? "\n" + webfw.setup.map((l) => "  " + l).join("\n") : ""}`
    : f.wifi
      ? `  WiFi.mode(WIFI_OFF); // ${f.log ? "USB test build" : "offline release build"}${board.family === "esp8266" ? "\n  WiFi.forceSleepBegin();" : ""}`
      : "  // no WiFi on this board"
}
  Serial.println(String("Microflow ${id} ${f.debug ? "debug" : "release"} as ") + mfId);${f.log ? "\n" + logSetup(flow.nodes) : ""}
}
`;
  const connect = f.net
    ? `  // WiFi watchdog: the ESP32 may stay idle after a failed first attempt, so
  // re-start the connection after 10, 20, 40, then every 60 s without WiFi.
  { static unsigned long wifiSince = 0, wifiWait = 10000;
    if (WiFi.status() == WL_CONNECTED) { wifiSince = millis(); wifiWait = 10000; }
    else if (millis() - wifiSince >= wifiWait) {
      wifiSince = millis();
      if (wifiWait < 60000) wifiWait *= 2;
      Serial.println("WiFi not connected; retrying");
      WiFi.disconnect();
      WiFi.begin(MF_SSID, MF_PASS);
    } }
  static unsigned long retry = 0, backoff = 5000;
  static bool tried = false;
${f.debug ? "  static unsigned long beat = 0;\n" : ""}  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && (!tried || millis() - retry >= backoff)) {
    tried = true;
    retry = millis();
    String will = mfBase + "/status";
    if (mqtt.connect(mfId.c_str(), ${nullable(s.username)}, ${nullable(s.mqttPassword)}, will.c_str(), 0, true, "offline")) {
      backoff = 5000;
      mqtt.publish(will.c_str(), "online", true);
${lines([
  ping && `      mqtt.subscribe((mfBase + "/ping").c_str());`,
  f.ota && otafw.subscribe,
  f.debug && shellfw.mqttSubscribe,
  ...subscriptions.map(
    (n) => `      mqtt.subscribe(${cTopic(n.config.topic)});`,
  ),
  ...manual.map(
    (n) =>
      `      mqtt.subscribe((mfBase + ${quoted("/inject/" + n.id)}).c_str());`,
  ),
  ...pwas.map(pwafw.subscribe),
  f.debug && "      if (mfTelemetry) { beat = millis(); mfSendTelemetry(); }",
])}
    } else if (backoff < 30000) {
      // connect() blocks for seconds when the broker is unreachable; back off
      // (5, 10, 20, 30 s) so inputs and timers keep running between attempts.
      backoff *= 2;
      if (backoff > 30000) backoff = 30000;
    }
  }
  mqtt.loop();
${lines([
  f.debug && "  mfSerialPoll();",
  f.debug &&
    "  if (mfTelemetry && mqtt.connected() && millis() - beat >= 30000UL) { beat = millis(); mfSendTelemetry(); }",
  f.ota && otafw.loop,
  f.debug && shellfw.loop,
])}
`
    : f.debug
      ? lines(["  mfSerialPoll(); // USB-only debug build", shellfw.loop]) +
        "\n"
      : "";
  const loopFn = `void loop() {
${connect}${lines([
    ...timed.map((n) => {
      const i = index.get(n.id);
      return `  { static unsigned long tick${i} = 0; if (millis() - tick${i} >= ${n.config.interval}UL) { tick${i} = millis(); node${i}(String(${quoted(n.config.payload)})); } }`;
    }),
    ...loops.map((l) => "  " + l),
    ...(ble ? blefw.loop(flow.nodes).map((l) => "  " + l) : []),
    f.web && "  " + webfw.loop,
    f.web &&
      '  { static bool shown = false; if (!shown && WiFi.status() == WL_CONNECTED) { shown = true; Serial.println(String("Web page: http://") + WiFi.localIP().toString() + "/"); } }',
    terminal && !f.debug && "  mfTerminalPoll();",
    f.log && "  " + logLoop(flow.nodes),
    lcd && "  " + displayfw.loop(), // the OLED sends its drawing here
  ])}
}
`;
  let source = header + common + debugHooks + received + setupFn + loopFn;
  // Realtek boards: the ESP-only calls mapped to Realtek's core (lib/amebafw.js).
  if (board.family === "ameba") source = amebafw.port(source);
  // Raspberry Pi Pico boards: the same for the Pico core (lib/picofw.js).
  if (board.family === "rp2040") source = picofw.port(source);
  source = source
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    // After an Arduino node's code, compiler messages refer to the sketch again.
    .map((line, k) =>
      line === "#line MF_RESUME" ? `#line ${k + 2} "microflow.ino"` : line,
    )
    .join("\n");
  return {
    source,
    build: id,
    warnings: report.warnings,
    board: s.board,
    // Bluetooth + WiFi does not fit the default 1.25 MB app partition.
    fqbn: withOptions(board.fqbn, [
      // (Boards that already choose a large partition keep theirs.)
      ...(ble && !/PartitionScheme=/.test(board.fqbn)
        ? ["PartitionScheme=min_spiffs"]
        : []),
      // Voice command: the partition with the speech models (overrides BLE's).
      ...speechfw.fqbnOptions(flow.nodes),
    ]),
    features: f,
    // Arduino libraries to install before compiling (device nodes).
    libraries: [
      ...devices.libraries(flow.nodes),
      ...speechfw.libraries(flow.nodes),
      ...(radiofw.uses(flow.nodes).local ? [radiofw.LIBRARY] : []),
      ...(lcd ? displayfw.libraries(board) : []),
    ].filter((x, i, all) => all.indexOf(x) === i),
  };
}
const generate = (flow, settings) => build(flow, settings).source;
// Why the firmware needs an MQTT broker (whatever the upload method), or null.
// Web in/out alone need WiFi but no broker.
function brokerReason(flow, settings) {
  const f = features(flow, checkSettings(settings));
  if (!f.net) return null;
  const mqtt = flow.nodes.filter(
    (n) => isMqttRadio(n) || n.type === "pwa",
  );
  if (mqtt.length)
    return `this flow uses MQTT (${mqtt
      .slice(0, 3)
      .map((n) => {
        const type = defs[n.type].label;
        return n.label && n.label !== type ? `${type} “${n.label}”` : type;
      })
      .join(", ")}${mqtt.length > 3 ? ", …" : ""})`;
  if (f.debug)
    return "Debug builds report to the IDE over MQTT (telemetry, test terminal, inject)";
  if (f.ota) return "Remote update is on, and updates arrive over MQTT";
  return null;
}
module.exports = {
  validate,
  wiring,
  analyze,
  build,
  generate,
  checkSettings,
  brokerReason,
  types,
  expandCustom,
  LIMITS,
};
