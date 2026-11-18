const $ = (id) => document.getElementById(id);
// Node types and boards come from the server (lib/nodes.js, lib/boards.js).
let catalog = {},
  boards = [],
  reservedNames = new Set(); // Arduino C++ words a variable name may not take
let flow = {
  name: "Workspace monitor",
  nodes: [
    {
      id: "sensor",
      type: "mqtt-in",
      label: "Room temperature",
      x: 45,
      y: 105,
      config: { topic: "workshop/sensor" },
    },
    {
      id: "threshold",
      type: "threshold",
      label: "Above 25°C",
      x: 265,
      y: 105,
      config: { value: 25 },
    },
    {
      id: "debug",
      type: "debug",
      label: "Temperature log",
      x: 465,
      y: 65,
      config: {},
    },
    {
      id: "publish",
      type: "mqtt-out",
      label: "Publish alert",
      x: 465,
      y: 190,
      config: { topic: "workshop/alert" },
    },
    {
      id: "inject",
      type: "inject",
      label: "Test temperature",
      x: 45,
      y: 205,
      config: { payload: "28", interval: 0 },
    },
  ],
  edges: [
    { from: "sensor", to: "threshold" },
    { from: "threshold", to: "debug" },
    { from: "threshold", to: "publish" },
    { from: "inject", to: "threshold" },
  ],
};
let selected,
  selectedLink,
  pending,
  dirty = true;
// Multi-selection on the canvas: `selected` is the main node (its Properties show);
// `alsoSelected` holds the others. Code that sets `selected` alone (e.g. adding a
// node) leaves a single selection: render() drops alsoSelected when the main node
// changed without selectNodes().
let alsoSelected = new Set(),
  selectionMain = null;
// ── Flow tabs: pages of the same flow, saved and compiled together ──
// flow.tabs = [{ id, name }] and node.tab = its tab id. Without flow.tabs (or for
// nodes without a known tab) everything is on the first tab. Nodes on different
// tabs connect through Link out / Link in nodes with the same link name.
let currentTab = null;
const MAX_TABS = 16; // per chip
// ── Chips: several boards in one project (multi-chip development) ──
// flow.chips = [{ id, name, board, deviceId, serialPort }] and tab.chip = the chip a
// flow tab belongs to. Each chip is compiled, uploaded and simulated on its own,
// from its own tabs; chips talk through Radio in / out nodes. Without flow.chips
// there is one chip, set up in the Device panel as before.
let currentChip = null;
// While every chip is simulated at once: [{ id, name, deviceId }] (lib/simgroup.js).
let simChips = null;
// Node id → the last value it handled while simulating (shown on its box).
const nodeValues = new Map();
// True while splitview.js draws the other screen's chip (the Device panel stays
// on the edited chip).
let splitDrawing = false;
const MAX_CHIPS = 8;
const allTabs = () =>
  flow.tabs?.length ? flow.tabs : [{ id: "t1", name: "Flow 1" }];
const chipsOf = () =>
  flow.chips?.length ? flow.chips : [{ id: "c1", name: "Chip 1" }];
const chipOfTab = (t) =>
  chipsOf().some((c) => c.id === t?.chip) ? t.chip : chipsOf()[0].id;
const currentChipId = () =>
  chipsOf().some((c) => c.id === currentChip) ? currentChip : chipsOf()[0].id;
// The flow tabs of the chip on screen.
const tabsOf = (chip = currentChipId()) => {
  const list = allTabs().filter((t) => chipOfTab(t) === chip);
  return list.length ? list : allTabs().slice(0, 1);
};
const tabOf = (n) =>
  allTabs().some((t) => t.id === n.tab) ? n.tab : allTabs()[0].id;
const chipOfNode = (n) => chipOfTab(allTabs().find((t) => t.id === tabOf(n)));
const onTab = (n) => tabOf(n) === currentTab;
const tabName = (id) => allTabs().find((t) => t.id === id)?.name;
const newNodeId = () =>
  "n" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
// ── Variable names (n.name): unique per flow, shown under each node's label ──
// In a C/C++ node, every node wired into it is a typed variable of that name.
const takenNames = (except) =>
  new Set(flow.nodes.filter((m) => m !== except && m.name).map((m) => m.name));
// Same rule as lib/nodes.js autoName(): GPIO4 for a pin node, else SW1, SW2, …
function autoName(n, taken = takenNames(n)) {
  const template =
    ruled(n, "varNames", "name") || catalog[n.type]?.varName || "NODE";
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
// Is n's name one Microflow gave it (GPIO4, GPIO4_2, TEMP1, …), not one you typed?
// Such a name follows the node's settings: GPIO4 becomes GPIO26 with the pin.
function isDefaultName(n) {
  const template =
    ruled(n, "varNames", "name") || catalog[n.type]?.varName || "NODE";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pin = n.config?.pin;
  const pattern =
    template.includes("{pin}") && Number.isInteger(pin)
      ? `^${esc(template.replace("{pin}", pin))}(_\\d+)?$`
      : `^${esc(template.replace("{pin}", ""))}\\d+$`;
  return n.name === autoName(n) || new RegExp(pattern).test(n.name || "");
}
// Gives every node without a (unique) name a default one, e.g. in older flows.
// Like the server: names already given are kept first, then the others filled in.
function ensureNames() {
  const taken = new Set();
  for (const n of flow.nodes)
    if (n.name && !taken.has(n.name)) taken.add(n.name);
    else n.name = "";
  for (const n of flow.nodes)
    if (!n.name) taken.add((n.name = autoName(n, taken)));
}
// Why `name` cannot be node n's variable name, or "" (same rules as the server).
function nameProblem(n, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name))
    return "Use letters, digits and _ (max 32), starting with a letter.";
  if (reservedNames.has(name) || /^mf/i.test(name) || /^B[01]{1,8}$/.test(name))
    return `${name} is reserved in C/C++.`;
  if (takenNames(n).has(name)) return `Another node is already called ${name}.`;
  return "";
}
// Logic inputs (Set, Reset, Data, Clock) and C/C++ code refer to nodes by name:
// renames them in `nodes`. Returns how many nodes changed.
function renameRefs(nodes, before, now) {
  if (!before || before === now) return 0;
  const word = new RegExp(`\\b${before}\\b`, "g");
  let count = 0;
  for (const m of nodes) {
    let hit = false;
    // Fields that name a connected input (Logic Set / Reset…, Peripheral Trigger…).
    for (const f of catalog[m.type]?.fields || [])
      if (f.inputChoice && m.config[f.key] === before)
        ((m.config[f.key] = now), (hit = true));
    if (m.type === "arduino")
      for (const key of ["vars", "setup", "message", "loop"])
        if (typeof m.config[key] === "string") {
          const text = m.config[key].replace(word, now);
          if (text !== m.config[key]) ((m.config[key] = text), (hit = true));
        }
    count += hit;
  }
  return count;
}
// Renames a node; a default Message box ({"topic":"<old name>"}) and the Logic
// and C/C++ nodes that use the name follow.
function setName(n, name) {
  const defaultMsg = n.msg === defaultFields(n);
  const before = n.name;
  n.name = name;
  if (defaultMsg) n.msg = defaultFields(n);
  renameRefs(flow.nodes, before, name);
}
function renameNode(n, name) {
  name = name.trim();
  if (name === n.name) return true;
  const why = nameProblem(n, name);
  if (why) {
    toast(why);
    return false;
  }
  setName(n, name);
  changed();
  render();
  if (selected === n.id) showNode();
  return true;
}
let advancedOpen = false; // Node properties: Advanced section left open
// ── Language (Settings ⚙) ──
// "nodered": every wire carries a JSON message ({"payload":…,"topic":…}) and each node
// has a Message box; "arduino": wires carry plain values. Stored in each flow; the
// app setting is the language new flows start with.
let appSettings = { language: "arduino" };
const LANGUAGES = {
  nodered: {
    label: "Node-RED",
    text: "Every wire carries a JSON message, like Node-RED's msg. Nodes work on msg.payload and pass the other fields on; each node's Message box (prefilled) adds fields such as topic. In C/C++ nodes: value = msg.payload, msg = the whole message, send(x) keeps its fields, sendMsg(…) sends a whole message.",
    example: '{"payload": 1, "topic": "SW1"}',
  },
  arduino: {
    label: "Arduino",
    text: "Wires carry plain values (1, 21.5, on). The smallest and fastest firmware; flows saved before this setting existed use it.",
    example: "1",
  },
};
const languageOf = () => (flow.language === "nodered" ? "nodered" : "arduino");
// A node's default Message box: inputs say where a message comes from.
const defaultFields = (n) =>
  catalog[n.type]?.source ? JSON.stringify({ topic: n.name }) : "{}";
function ensureFields() {
  if (languageOf() === "nodered")
    for (const n of flow.nodes) if (!n.msg) n.msg = defaultFields(n);
}
// Why text cannot be a Message box, or "" (same rules as lib/msg.js checkFields).
function fieldsProblem(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return 'Message must be valid JSON, e.g. {"topic": "SW1"}.';
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    return 'Message must be a JSON object, e.g. {"topic": "SW1"}.';
  if (Object.hasOwn(obj, "payload"))
    return "Message: payload is set by the node itself; use other fields (topic, room, …).";
  if (text.length > 256) return "Message is limited to 256 characters.";
  return "";
}
function setLanguage(language) {
  flow.language = language;
  ensureFields();
  changed();
  render();
  showNode();
  appSettings.language = language;
  api("settings", { language }, "PUT").catch((e) => toast(e.message));
}
function openSettings() {
  const area = el("div", "settings");
  area.append(
    el("div", "section-title", "LANGUAGE"),
    el(
      "p",
      "muted",
      "How values travel between the nodes of this flow. New flows start with the language chosen here.",
    ),
  );
  for (const [key, l] of Object.entries(LANGUAGES)) {
    const card = el(
      "label",
      "language-card" + (languageOf() === key ? " chosen" : ""),
    );
    const radio = el("input");
    radio.type = "radio";
    radio.name = "language";
    radio.checked = languageOf() === key;
    radio.onchange = () => {
      setLanguage(key);
      openSettings();
      toast(`This flow now uses the ${l.label} language.`);
    };
    const text = el("div");
    text.append(
      el("strong", "", l.label),
      el("p", "", l.text),
      el("code", "mono", "on a wire: " + l.example),
    );
    card.append(radio, text);
    area.append(card);
  }
  area.append(
    el(
      "p",
      "muted",
      "C/C++ nodes run on the board in both languages. Their inputs are typed C++ variables: bool, int, double or String, chosen from the node they come from (change it with Variable type in that node's Properties).",
    ),
  );
  modal("Settings", area);
}
$("settings").onclick = openSettings;
$("languageBadge").onclick = openSettings;
// ── Variable types: the C++ type of a node's variable in C/C++ nodes ──
const VAR_TYPES = ["bool", "int", "double", "String"];
// Same rules as lib/nodes.js payloadType() and varType().
function payloadType(text) {
  const t = String(text ?? "").trim();
  if (t === "true" || t === "false") return "bool";
  if (/^-?\d{1,9}$/.test(t)) return "int";
  if (t !== "" && Number.isFinite(Number(t))) return "double";
  return "String";
}
function upstreamOf(n) {
  const ins = flow.edges
    .filter((e) => e.to === n.id)
    .map((e) => flow.nodes.find((m) => m.id === e.from))
    .filter(Boolean);
  if (n.type === "link-in")
    ins.push(
      ...flow.nodes.filter(
        (m) => m.type === "link-out" && m.config.link === n.config.link,
      ),
    );
  return ins;
}
// Does a node's config match `when` (an object, or a list of which one must
// match)? Same rule as lib/devices.js whenMatches().
function whenMatches(n, when) {
  if (!when) return true;
  const fields = catalog[n.type]?.fields || [];
  const one = (w) =>
    Object.entries(w).every(([key, values]) =>
      values.includes(
        String(n.config?.[key] ?? fields.find((f) => f.key === key)?.default),
      ),
    );
  return Array.isArray(when) ? when.some(one) : one(when);
}
// Per-setting name / type of a node (Input / Output device): first rule that matches.
const ruled = (n, list, what) =>
  (catalog[n.type]?.[list] || []).find((r) => whenMatches(n, r.when))?.[what];
// The pins a node uses, as lib/nodes.js pinsOf(): [{ key, pin, use, sim }].
function nodePins(n) {
  const c = catalog[n.type];
  if (c?.pinSpec)
    return c.pinSpec
      .filter((p) => whenMatches(n, p.when))
      .map((p) => ({ ...p, pin: n.config[p.key] }))
      .filter((p) => Number.isInteger(p.pin) && p.pin >= 0);
  return c?.pin
    ? [{ key: "pin", pin: n.config.pin, use: c.pin, sim: true }]
    : [];
}
// ── Analog and logic signals: same rule as lib/nodes.js wireProblem() ──
// Analog values (ADC, sensors) do not go straight into Logic / Timer, nor on / off
// values straight into analog outputs (PWM out, servo, stepper).
function sendsSignal(n, kind, seen = new Set()) {
  const s = catalog[n.type]?.signal;
  if (s === kind) return true;
  if (s !== "pass" || seen.has(n.id)) return false;
  seen.add(n.id);
  return upstreamOf(n).some((m) => sendsSignal(m, kind, seen));
}
function wireProblem(a, b) {
  // An I2C display shows any value (text), unlike a motor.
  const to =
    b.type === "output-device" && b.config?.device === "i2cdisplay"
      ? null
      : catalog[b.type]?.signal;
  const name = (n) => n.label || catalog[n.type]?.label;
  if ((to === "logic" || to === "trigger") && sendsSignal(a, "analog"))
    return `${name(a)} → ${name(b)}: an analog value is not on / off, so it cannot go into ${name(b)} directly. Convert it first: put a Threshold (on from a level) or a Compare between them.`;
  if (to === "analog-out" && sendsSignal(a, "logic"))
    return `${name(a)} → ${name(b)}: an on / off value (0 / 1) is not an analog level for ${name(b)}. Convert it first: put a Map range between them (e.g. 0–1 → 0–255 for PWM, 0–1 → 0–180 for a servo).`;
  return "";
}
// ── Pin clashes: one pin for an input and an output, or for two outputs ──
// (two inputs, or sensors on one I2C bus, may share). Same rule as lib/flow.js.
const pinRole = (use) => (use === "in" || use === "adc" ? "input" : "output");
const nodeWho = (m) => `${m.name || m.label} (${catalog[m.type]?.label})`;
// Other nodes using `pin`: [{ m, role, shared }].
function pinUsers(pin, except) {
  return flow.nodes.flatMap((m) =>
    m === except || (except && chipOfNode(m) !== chipOfNode(except)) // pins are per chip
      ? []
      : nodePins(m)
          .filter((q) => q.pin === pin)
          .map((q) => ({ m, role: pinRole(q.use), shared: q.shared })),
  );
}
// Why node n's pin (with this use) would clash with other nodes, or "".
function pinClash(n, pin, use, shared) {
  const role = pinRole(use);
  for (const u of pinUsers(pin, n)) {
    if (shared && u.shared === shared) continue;
    if (u.role !== role)
      return `GPIO ${pin} is already ${u.role === "input" ? "an input" : "an output"} for ${nodeWho(u.m)}. A pin can be an input or an output, not both: choose another pin.`;
    if (role === "output")
      return `GPIO ${pin} is already driven by ${nodeWho(u.m)}: two outputs on one pin fight each other. Choose another pin.`;
  }
  return "";
}
// All clashes of node n's pins.
const pinClashesOf = (n) => [
  ...new Set(
    nodePins(n)
      .map((p) => pinClash(n, p.pin, p.use, p.shared))
      .filter(Boolean),
  ),
];
// How the node's main pin ("pin") is used, for the pin guide; null if none.
const mainPinUse = (n) => nodePins(n).find((p) => p.key === "pin")?.use || null;
function varTypeOf(n, seen = new Set()) {
  if (VAR_TYPES.includes(n.vtype)) return n.vtype;
  const kind =
    ruled(n, "varTypes", "type") || catalog[n.type]?.varType || "String";
  if (kind === "payload") return payloadType(n.config?.payload);
  if (kind !== "inherit") return kind;
  if (seen.has(n.id)) return "String";
  seen.add(n.id);
  const types = [...new Set(upstreamOf(n).map((m) => varTypeOf(m, seen)))];
  return types.length === 1 ? types[0] : "String";
}
// Type of the value a node takes in (Input type), null without one. Same rules as
// lib/nodes.js inType(); a C/C++ node's inputs are variables of their own.
function inTypeOf(n, seen = new Set()) {
  const c = catalog[n.type];
  if (!c || c.source || c.standalone || n.type === "arduino") return null;
  if (VAR_TYPES.includes(n.itype)) return n.itype;
  const kind = c.inType || "String";
  if (kind !== "inherit") return kind;
  const from = [...new Set(upstreamOf(n).map((m) => varTypeOf(m, seen)))];
  return from.length === 1 ? from[0] : "String";
}
// Types as shown (C++ double is a float: a decimal number).
const TYPE_LABEL = {
  bool: "bool",
  int: "int",
  double: "float",
  String: "String",
};
// What a value loses going from type `from` into an input of type `to` (as
// lib/nodes.js conversionNote()), or "".
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
// The conversion on a wire, shown when a chosen Input / Output type is involved.
function wireConversion(a, b) {
  if (!a.vtype && !b.itype) return null;
  const from = varTypeOf(a),
    to = inTypeOf(b);
  if (!to || from === to) return null;
  return { from, to, note: conversionNote(from, to) };
}
// Edits a variable name in place (the name chip on a node box).
function editName(n, chip) {
  const input = el("input", "var-input");
  input.value = n.name;
  input.maxLength = 32;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Variable name");
  chip.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save || !renameNode(n, input.value)) render();
  };
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  input.onpointerdown = (event) => event.stopPropagation();
}
// Link nodes on the other end of a Link out / Link in name.
const linkPeers = (n) =>
  flow.nodes.filter(
    (m) =>
      m.type === (n.type === "link-in" ? "link-out" : "link-in") &&
      m.config.link === n.config.link &&
      chipOfNode(m) === chipOfNode(n), // links stay on one chip
  );
function showTab(id) {
  currentTab = id;
  selected = selectedLink = pending = null;
  render();
  if (!$("nodePanel").hidden) showNode();
}
// Adds a tab (optionally with nodes and their connections) and switches to it.
function addTab(name, nodes = [], edges = []) {
  const tabs = tabsOf();
  if (tabs.length >= MAX_TABS)
    throw Error(`A flow has at most ${MAX_TABS} tabs.`);
  if (!name) {
    let k = 1;
    while (tabs.some((t) => t.name === `Flow ${k}`)) k++;
    name = `Flow ${k}`;
  }
  const id = "t" + crypto.randomUUID().slice(0, 8);
  flow.tabs = [
    ...allTabs(),
    { id, name, ...(flow.chips?.length ? { chip: currentChipId() } : {}) },
  ];
  for (const n of nodes) n.tab = id;
  flow.nodes.push(...nodes);
  flow.edges.push(...edges);
  changed();
  showTab(id);
}
// Copies a saved flow's nodes into a new tab, with fresh node ids.
function addFlowAsTab(other) {
  if (chipFlow().nodes.length + other.nodes.length > 64)
    throw Error(
      `A chip holds at most 64 nodes: this one has ${chipFlow().nodes.length}, “${other.name}” has ${other.nodes.length}.`,
    );
  const ids = new Map(other.nodes.map((n) => [n.id, newNodeId()]));
  const taken = takenNames();
  addTab(
    String(other.name).slice(0, 40),
    other.nodes.map((n) => {
      const copy = { ...structuredClone(n), id: ids.get(n.id) };
      // Variable names stay unique: clashing ones get a new default.
      if (!copy.name || taken.has(copy.name)) copy.name = autoName(copy, taken);
      taken.add(copy.name);
      return copy;
    }),
    other.edges.map((e) => ({ from: ids.get(e.from), to: ids.get(e.to) })),
  );
}
function deleteTab(t) {
  const ids = new Set(
    flow.nodes.filter((n) => tabOf(n) === t.id).map((n) => n.id),
  );
  if (
    !confirm(
      `Delete tab “${t.name}”${ids.size ? ` and its ${ids.size} node${ids.size > 1 ? "s" : ""}` : ""}?`,
    )
  )
    return;
  remember(`delete tab ${t.name}`);
  flow.tabs = allTabs().filter((x) => x.id !== t.id);
  flow.nodes = flow.nodes.filter((n) => !ids.has(n.id));
  flow.edges = flow.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  changed();
  showTab(tabsOf()[0].id);
}
function renameTab(t, button) {
  const input = el("input", "tab-rename");
  input.value = t.name;
  input.maxLength = 40;
  input.setAttribute("aria-label", "Tab name");
  button.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== t.name) {
      flow.tabs = allTabs().map((x) => (x.id === t.id ? { ...x, name } : x));
      changed();
    }
    render();
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}
function renderTabs() {
  const tabs = tabsOf();
  const bar = $("flowTabs");
  bar.replaceChildren();
  for (const t of tabs) {
    const active = t.id === currentTab;
    const b = el("button", "flow-tab" + (active ? " selected" : ""));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(active));
    b.title = "Double-click to rename";
    const count = flow.nodes.filter((n) => tabOf(n) === t.id).length;
    b.append(el("span", "tab-dot"), el("span", "", t.name));
    b.append(el("span", "tab-count", String(count)));
    if (active && tabs.length > 1) {
      const close = el("span", "tab-close", "×");
      close.title = "Delete this tab";
      close.onclick = (event) => {
        event.stopPropagation();
        deleteTab(t);
      };
      b.append(close);
    }
    b.onclick = () => active || showTab(t.id);
    b.ondblclick = () => renameTab(t, b);
    bar.append(b);
  }
  const add = el("button", "flow-tab add", "+");
  add.title = "New flow tab";
  add.onclick = attempt(() => addTab());
  bar.append(add);
}
// The part of the project that runs on the chip on screen: its tabs, their nodes and
// the connections between them. Compile, upload, checks and the simulator use this.
function chipFlow(id = currentChipId()) {
  if (!flow.chips?.length) return flow;
  const tabs = tabsOf(id);
  const ids = new Set(tabs.map((t) => t.id));
  const nodes = flow.nodes.filter((n) => ids.has(tabOf(n)));
  const inChip = new Set(nodes.map((n) => n.id));
  const { chips, ...rest } = flow;
  const chip = chipsOf().find((c) => c.id === id);
  return {
    ...rest,
    name: `${flow.name} · ${chip?.name || "chip"}`,
    tabs,
    nodes,
    edges: flow.edges.filter((e) => inChip.has(e.from) && inChip.has(e.to)),
  };
}
// Which flow and chip the Device panel shows; its edits are stored in that chip.
let settingsChip = null;
const flowKey = () => flow.id ?? "new";
function storeChipSettings() {
  if (!flow.chips?.length || !settingsChip) return;
  if (settingsChip.key !== flowKey() || settingsChip.chip !== currentChipId())
    return;
  const c = flow.chips.find((x) => x.id === settingsChip.chip);
  if (!c) return;
  const now = {
    board: $("board").value,
    deviceId: $("deviceId").value.trim(),
    serialPort: $("serialPort").value.trim(),
  };
  if (Object.entries(now).some(([k, v]) => (c[k] || "") !== v)) {
    Object.assign(c, now);
    dirty = true;
    $("saveState").textContent = "Unsaved changes";
  }
}
function loadChipSettings(c) {
  if (c.board && boards.some((b) => b.id === c.board))
    $("board").value = c.board;
  $("deviceId").value = c.deviceId || "";
  $("serialPort").value = c.serialPort || "";
  currentBoard = $("board").value;
  showBoard();
  saveSettings();
}
// Keeps the chip on screen valid when the project changes (opened, saved, imported).
function syncChip() {
  if (!chipsOf().some((c) => c.id === currentChip)) {
    currentChip = chipsOf()[0].id;
    currentTab = null;
    settingsChip = { key: flowKey(), chip: currentChip };
    if (flow.chips?.length) loadChipSettings(flow.chips[0]);
  } else if (!splitDrawing) settingsChip = { key: flowKey(), chip: currentChip };
  const chip = chipsOf().find((c) => c.id === currentChip);
  $("chipLabel").textContent = flow.chips?.length ? ` · ${chip.name}` : "";
}
function showChip(id) {
  storeChipSettings();
  currentChip = id;
  currentTab = tabsOf()[0].id;
  settingsChip = { key: flowKey(), chip: id };
  const chip = flow.chips?.find((c) => c.id === id);
  if (chip) loadChipSettings(chip);
  selected = selectedLink = pending = null;
  render();
  if (!$("nodePanel").hidden) showNode();
  if (simChips)
    // Every chip runs: show the pins and LCD of the chip now on screen.
    api("runtime/status?chip=" + encodeURIComponent(id))
      .then((s) => simChips && showSimPins(s.pins, s.lcd))
      .catch(() => {});
  else if (simPins) showSimPins(simPins);
}
const shortBoard = (id) => {
  const b = boards.find((x) => x.id === id);
  return b ? b.look?.name || b.label.replace(/^[^·]*·\s*/, "") : "";
};
function nextChipNumber(names) {
  const used = names.map((n) => Number(/^\s*Chip\s*(\d+)/i.exec(n)?.[1] || 0));
  return Math.max(names.length, ...used) + 1;
}
// Adds a chip with one empty flow tab and switches to it. The first time, the
// project's existing tabs become Chip 1, with the Device panel's settings.
function addChip() {
  if (flow.chips?.length >= MAX_CHIPS)
    throw Error(`A project has at most ${MAX_CHIPS} chips.`);
  const newId = (p) => p + crypto.randomUUID().slice(0, 8);
  if (!flow.chips?.length) {
    const first = {
      id: newId("c"),
      name: "Chip 1",
      board: $("board").value,
      deviceId: $("deviceId").value.trim(),
      serialPort: $("serialPort").value.trim(),
    };
    flow.chips = [first];
    flow.tabs = allTabs().map((t) => ({ ...t, chip: first.id }));
    for (const n of flow.nodes) if (!n.tab) n.tab = flow.tabs[0].id;
    currentChip = first.id;
    settingsChip = { key: flowKey(), chip: first.id };
  }
  storeChipSettings();
  // The next number after the highest "Chip <n>…" (renamed ones too, e.g.
  // "Chip 2 sensor"), and never below the number of chips: Chip 2 exists → Chip 3.
  const k = nextChipNumber(flow.chips.map((c) => c.name));
  const chip = {
    id: newId("c"),
    name: `Chip ${k}`,
    board: $("board").value,
    deviceId: "",
    serialPort: "",
  };
  flow.chips.push(chip);
  flow.tabs = [...allTabs(), { id: newId("t"), name: "Flow 1", chip: chip.id }];
  changed();
  showChip(chip.id);
  toast(
    `${chip.name} added: choose its board in the Device panel. Chips talk to each other through Radio in / out nodes.`,
  );
}
function deleteChip(c) {
  const tabs = new Set(
    allTabs()
      .filter((t) => chipOfTab(t) === c.id)
      .map((t) => t.id),
  );
  const ids = new Set(
    flow.nodes.filter((n) => tabs.has(tabOf(n))).map((n) => n.id),
  );
  if (
    !confirm(
      `Delete chip “${c.name}”${ids.size ? ` and its ${ids.size} node${ids.size > 1 ? "s" : ""}` : ""}?`,
    )
  )
    return;
  remember(`delete chip ${c.name}`);
  flow.chips = flow.chips.filter((x) => x.id !== c.id);
  flow.tabs = allTabs().filter((t) => !tabs.has(t.id));
  flow.nodes = flow.nodes.filter((n) => !ids.has(n.id));
  flow.edges = flow.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  changed();
  showChip(flow.chips[0].id);
}
function renameChip(c, button) {
  const input = el("input", "tab-rename");
  input.value = c.name;
  input.maxLength = 40;
  input.setAttribute("aria-label", "Chip name");
  button.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== c.name) {
      c.name = name;
      changed();
    }
    render();
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}
// The chip layer: one tab per chip, behind the flow tabs.
function renderChips() {
  setTimeout(serialBadge); // the chip name in the top bar
  const bar = $("chipTabs");
  bar.replaceChildren(el("span", "chip-bar-title", "CHIPS"));
  const chips = chipsOf();
  for (const c of chips) {
    const active = c.id === currentChipId();
    const b = el("button", "chip-tab" + (active ? " selected" : ""));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(active));
    // The Device panel's board for the chip it edits; the chip's own otherwise.
    const board = flow.chips?.length
      ? active && c.id === settingsChip?.chip && !splitDrawing
        ? $("board").value
        : c.board
      : $("board").value;
    const tabs = new Set(
      allTabs()
        .filter((t) => chipOfTab(t) === c.id)
        .map((t) => t.id),
    );
    const count = flow.nodes.filter((n) => tabs.has(tabOf(n))).length;
    b.title = flow.chips?.length
      ? `${c.name}: ${shortBoard(board)}${c.deviceId ? ` · ${c.deviceId}` : ""}. Double-click to rename.`
      : "The project's only chip. Add a chip (+) for multi-chip development.";
    b.append(
      el("span", "chip-icon", "▣"),
      el("span", "", c.name),
      el("span", "chip-board", shortBoard(board)),
      el("span", "tab-count", String(count)),
    );
    if (active && flow.chips?.length > 1) {
      const close = el("span", "tab-close", "×");
      close.title = "Delete this chip and its flows";
      close.onclick = (event) => {
        event.stopPropagation();
        deleteChip(c);
      };
      b.append(close);
    }
    b.onclick = () => active || showChip(c.id);
    if (flow.chips?.length) b.ondblclick = () => renameChip(c, b);
    bar.append(b);
  }
  const add = el("button", "chip-tab add", "+ Add chip");
  add.title =
    "Add a chip (board) to this project: it gets its own flows, board and Device ID";
  add.onclick = attempt(() => addChip());
  bar.append(add);
}
// The server (npm start) must run the code that is on disk: after an update it keeps
// the old code until restarted, and would build old firmware. A server without
// /api/version is older still. Shows a banner that stays until the restart.
async function checkServerCode() {
  let text = "";
  try {
    const v = await api("version");
    if (v.stale) text = v.restart;
  } catch (e) {
    if (e.status === 404 || /endpoint is missing|HTML page/.test(e.message))
      text =
        "This page is newer than the running server (npm start), which still runs old code and would build old firmware. Restart it: in its window press Ctrl+C, then run npm start again, and reload this page.";
  }
  let bar = document.getElementById("restartBanner");
  if (!text) {
    bar?.remove();
    return true;
  }
  if (!bar) {
    bar = el("div", "restart-banner");
    bar.id = "restartBanner";
    bar.setAttribute("role", "alert");
    document.body.prepend(bar);
  }
  bar.textContent = "⚠ " + text;
  return false;
}
// The output being connected (nodes with several outputs: 0, 1, 2).
let pendingPort = 0;
// Same connection: same boxes and the same output.
const sameLink = (a, b) =>
  a.from === b.from && a.to === b.to && (a.port || 0) === (b.port || 0);
// Top of output dot k on a box with several outputs (px).
const portTop = (k) => 9 + k * 17;
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").style.display = "none"), 5000);
}
function attempt(fn) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
      log({
        kind: "error",
        message: e.message,
        time: new Date().toISOString(),
      });
    }
  };
}
function changed() {
  dirty = true;
  $("saveState").textContent =
    typeof helpActive === "function" && helpActive()
      ? "Help example · not saved"
      : "Unsaved changes";
  boardCheck();
  if (typeof simEdited === "function") simEdited(); // runcheck.js
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
// Web in/out URL: the simulator's /sim on this PC in host mode, else the board's IP
// (from chip status or telemetry). known = false while the board's IP is unknown.
function webUrl(n, path) {
  path ??= "/api/" + n.config.name;
  if ($("runtimeMode").value === "host")
    return { url: `${location.origin}/sim${path}`, known: true };
  const ip =
    (typeof chipLast !== "undefined" && chipLast?.ip) ||
    deviceIps.get($("deviceId").value.trim()) ||
    "";
  return ip && ip !== "0.0.0.0"
    ? { url: `http://${ip}${path}`, known: true }
    : { url: `http://<board IP>${path}`, known: false };
}
const deviceIps = new Map(); // Device ID → IP from telemetry (Devices list)
// Redraws Web node URLs after the board's IP or the runtime mode changed.
function webUrlsChanged() {
  if (!flow.nodes.some((n) => catalog[n.type]?.web)) return;
  render();
  const n = flow.nodes.find((n) => n.id === selected);
  if (n && catalog[n.type]?.web && !$("nodePanel").hidden) showNode();
}
async function refreshDeviceIps() {
  try {
    for (const d of await api("devices"))
      if (d.telemetry?.ip) deviceIps.set(d.id, d.telemetry.ip);
  } catch {}
  webUrlsChanged();
}
// Fills a catalog summary template such as "payload {op} {value}" from node config.
function summary(n) {
  const c = catalog[n.type];
  if (n.type === "custom")
    return `${n.config.def?.nodes?.length || 0} nodes inside`;
  if (c.web) return `${c.web} ${webUrl(n).url}`;
  if (c.manualSummary && !Number(n.config.interval)) return c.manualSummary;
  // One summary per protocol (Radio in/out) or per function (Logic).
  const template =
    typeof c.summary === "object"
      ? c.summary[
          c.summaryBy
            ? (n.config[c.summaryBy] ??
              c.fields.find((f) => f.key === c.summaryBy)?.default)
            : n.config.protocol || "mqtt"
        ]
      : c.summary;
  return template
    .replace(/\{(\w+)\}/g, (_, key) => {
      const field = c.fields.find((f) => f.key === key);
      const value = n.config[key] ?? field?.default ?? "";
      return field?.options ? (field.options[value] ?? value) : value;
    })
    .replace(/ · $/, ""); // an empty last field
}
function render() {
  if (
    selectedLink &&
    !flow.edges.some((edge) => sameLink(edge, selectedLink))
  )
    selectedLink = null;
  if (selected !== selectionMain) alsoSelected = new Set();
  selectionMain = selected;
  for (const id of alsoSelected)
    if (!flow.nodes.some((m) => m.id === id && onTab(m)))
      alsoSelected.delete(id);
  $("deleteSelected").disabled = !selectedLink && !selectedNodes().length;
  $("nodes").replaceChildren();
  ensureNames();
  ensureFields();
  const lang = languageOf();
  $("languageBadge").textContent = LANGUAGES[lang].label;
  $("languageBadge").className = "language-badge " + lang;
  syncChip();
  if (!tabsOf().some((t) => t.id === currentTab)) currentTab = tabsOf()[0].id;
  renderChips();
  renderTabs();
  document.title = `${flow.name} · Microflow`;
  const tabCount = tabsOf().length;
  $("nodeCount").textContent =
    `${flow.nodes.length} nodes · ${flow.edges.length} connections${tabCount > 1 ? ` · ${tabCount} tabs` : ""}`;
  for (const n of flow.nodes) {
    if (!onTab(n)) continue;
    const c = catalog[n.type],
      e = el(
        "div",
        "flow-node" +
          (selected === n.id ? " selected" : "") +
          (alsoSelected.has(n.id) ? " selected also" : "") +
          (n.type === "test-scope" ? " scope" : "") +
          (n.type === "test-screen"
            ? ` screen ${n.config.size || "medium"}`
            : "") +
          (n.type === "status" ? " status-node" : ""),
      );
    e.id = "node-" + n.id;
    e.style.cssText = `left:${n.x}px;top:${n.y}px;--color:${c.color};--tint:${c.tint}`;
    const top = el("div", "node-top");
    top.append(el("span", "node-icon", c.icon), el("span", "", n.label));
    if (n.type === "timer") top.append(timerIndicator(n.id));
    // Shown on the Status display (statusview.js).
    if (n.status && c.statusOk) {
      const mark = el("span", "status-mark", "☰");
      mark.title = "Shown on the Status display";
      top.append(mark);
    }
    // A pin shared with another node in a clashing way: "!" on both boxes.
    const clashes = pinClashesOf(n);
    if (clashes.length) {
      e.classList.add("pin-clash");
      const mark = el("span", "clash-mark", "!");
      mark.title = clashes.join("\n");
      top.append(mark);
    }
    if (LED_TYPES.has(n.type)) {
      const led = el("span", "pin-led");
      led.dataset.pin = n.config.pin;
      top.append(led);
    }
    // GPIO output, PWM out and Pulse: HIGH / LOW, the duty or PULSE while running.
    if (OUT_STATE_TYPES.has(n.type)) {
      const state = el("span", "pin-state");
      state.dataset.pin = n.config.pin;
      state.dataset.kind = n.type;
      state.dataset.active = n.config.active === "low" ? 0 : 1;
      top.append(state);
    }
    let text = summary(n);
    if (n.type === "link-in" || n.type === "link-out") {
      const where = [...new Set(linkPeers(n).map((m) => tabName(tabOf(m))))];
      text += where.length ? " · " + where.join(", ") : " · not linked";
    }
    const sub = el("div", "node-sub" + (c.web ? " url" : ""));
    sub.title = text;
    // Variable name: click to rename. A button, so clicking it does not drag the box.
    const chip = el("button", "var-name", n.name);
    chip.title = `Variable ${TYPE_LABEL[varTypeOf(n)]} ${n.name}${inTypeOf(n) ? ` (takes in ${TYPE_LABEL[inTypeOf(n)]})` : ""}: click to rename. In a C/C++ node connected after this one, ${n.name} holds this node's latest ${lang === "nodered" ? "msg.payload" : "value"}.`;
    chip.onclick = (event) => {
      event.stopPropagation();
      editName(n, chip);
    };
    sub.append(chip, " " + text);
    e.append(top, sub);
    // Input and output types, inside the box: "in bool → out float" (a type chosen in
    // Properties is bold blue; auto ones are grey).
    const tIn = inTypeOf(n),
      tOut = c.sink ? null : varTypeOf(n);
    if (tIn || tOut) {
      const types = el("div", "node-types");
      const part = (word, type, chosen, bare) => {
        const span = el(
          "span",
          chosen ? "chosen" : "",
          bare ? TYPE_LABEL[type] : `${word} ${TYPE_LABEL[type]}`,
        );
        span.title = `${word === "in" ? "Input" : "Output"} type: ${TYPE_LABEL[type]}${chosen ? " (chosen: values are converted)" : " (auto)"}`;
        return span;
      };
      // Both: "float → int"; only one: "in String" / "out bool".
      const both = !!(tIn && tOut);
      if (tIn) types.append(part("in", tIn, !!n.itype, both));
      if (both) types.append(" → ");
      if (tOut) types.append(part("out", tOut, !!n.vtype, both));
      e.append(types);
    }
    e.append(el("div", "node-value", nodeValues.get(n.id) ?? ""));
    // A custom node has an input / output only when its group has them.
    const def = n.type === "custom" ? n.config.def : null;
    const sides = def
      ? [
          ...(def.inputs?.length ? ["in"] : []),
          ...(def.outputs?.length ? ["out"] : []),
        ]
      : c.standalone
        ? [] // no wires (Status)
        : c.source
        ? ["out"]
        : c.sink
          ? ["in"]
          : ["in", "out"];
    // Several outputs (Counter): one dot per output, 1 at the top.
    const outNames = !def && c.outputs?.length > 1 ? c.outputs : null;
    if (outNames) e.classList.add("multi-out");
    const portList = sides.flatMap((side) =>
      side === "out" && outNames
        ? outNames.map((name, k) => [side, k, name])
        : [[side, 0, null]],
    );
    for (const [side, k, outName] of portList) {
      const p = el(
        "button",
        "port " +
          side +
          (pending === n.id && side === "out" && pendingPort === k
            ? " pending"
            : ""),
      );
      if (outName) {
        p.style.top = portTop(k) + "px";
        p.dataset.port = String(k + 1);
      }
      const portType =
        side === "in" ? inTypeOf(n) : c.sink ? null : varTypeOf(n);
      p.title =
        (side === "in" ? "Connect input" : `Connect ${outName || "output"}`) +
        (outName && n.config["preset" + (k + 1)] !== undefined
          ? ` (pulse at count ${n.config["preset" + (k + 1)]})`
          : "") +
        (portType ? ` (${TYPE_LABEL[portType]})` : "");
      p.onclick = (event) => {
        event.stopPropagation();
        if (side === "out") {
          pending = n.id;
          pendingPort = k;
          render();
        } else if (pending && pending !== n.id) {
          const from = flow.nodes.find((m) => m.id === pending);
          const why = from && wireProblem(from, n);
          const link = {
            from: pending,
            to: n.id,
            ...(pendingPort ? { port: pendingPort } : {}),
          };
          if (why)
            toast(why); // not connected: a converter must go between
          else if (!flow.edges.some((e) => sameLink(e, link))) {
            flow.edges.push(link);
            const conv = from && wireConversion(from, n);
            if (conv?.note)
              toast(`Connected; the value is converted: ${conv.note}.`);
          }
          pending = null;
          changed();
          render();
        }
      };
      e.append(p);
    }
    // Camera: 🖼 opens its latest picture in a floating window.
    if (n.type === "camera") {
      const b = el("button", "camera-view", "🖼");
      const last = stills.get(n.id);
      b.title = last
        ? `Show picture ${last.shot ?? ""} (${last.name}) in a floating window`
        : "Show the latest picture in a floating window (none yet: trigger the camera)";
      if (last) b.classList.add("has-picture");
      b.onclick = (event) => {
        event.stopPropagation();
        openStill(n);
      };
      e.append(b);
    }
    if (n.type === "inject") {
      const b = el("button", "inject-trigger", "▶");
      b.title = "Inject payload into running test";
      // Emulating: the board's own Inject fires (over USB), as on the real circuit.
      b.onclick = attempt(() =>
        emuActive
          ? emuSend(`send ${n.id} ${n.config.payload ?? "1"}`)
          : api("runtime/inject", { id: n.id }),
      );
      e.append(b);
    }
    testDevice(n, e);
    // Servo boxes: the robot arm (servoview.js).
    if (typeof isServoNode === "function" && isServoNode(n)) e.append(servoView(n));
    // Status: its display (statusview.js).
    if (n.type === "status" && typeof statusView === "function") {
      e.append(statusView(n));
      statusPaging();
    }
    simInputControls(n, e);
    if (typeof emuControls === "function") emuControls(n, e); // emulate.js
    e.onpointerdown = (event) => {
      if (event.target.closest("button") || event.button === 2) return;
      // Ctrl / Shift / ⌘ + click adds or removes a node from the selection.
      if (event.ctrlKey || event.shiftKey || event.metaKey) {
        const ids = selectedNodes().map((m) => m.id);
        selectNodes(
          ids.includes(n.id) ? ids.filter((id) => id !== n.id) : [...ids, n.id],
          n.id,
        );
        return;
      }
      // Dragging a node of a multi-selection moves them all.
      const group = selectedNodes().some((m) => m.id === n.id)
        ? selectedNodes()
        : [n];
      if (group.length === 1) {
        selected = n.id;
        selectedLink = null;
        showNode();
        render();
      }
      const node = $("node-" + n.id),
        sx = event.clientX,
        sy = event.clientY,
        start = group.map((m) => [m, m.x, m.y]);
      node.setPointerCapture(event.pointerId);
      node.onpointermove = (ev) => {
        for (const [m, x, y] of start) {
          m.x = Math.max(30, Math.min(1200, x + ev.clientX - sx));
          m.y = Math.max(20, Math.min(750, y + ev.clientY - sy));
          const box = $("node-" + m.id);
          box.style.left = m.x + "px";
          box.style.top = m.y + "px";
        }
        wires();
      };
      node.onpointerup = () => {
        node.onpointermove = null;
        changed();
      };
    };
    $("nodes").append(e);
  }
  updatePinLeds();
  wires();
  if (typeof renderSplit === "function") renderSplit(); // lower screen (splitview.js)
}
// ── Camera pictures: saved as PNG files on this PC, shown in a floating window ──
const stills = new Map(); // node id → { name, width, height, shot, bytes, folder, at }
const stillWindows = new Map(); // node id → window
// A Camera node reported a picture ({"image": url, "width", "height", "shot"}):
// Microflow fetches it (from the board, or the simulator) and saves the PNG file.
async function stillTaken(id, payload) {
  let info;
  try {
    info = JSON.parse(String(payload));
  } catch {
    return; // other debug text, e.g. "no picture (camera not ready)"
  }
  if (!info?.image) return;
  const n = flow.nodes.find((m) => m.id === id);
  try {
    const saved = await api("camera/save", {
      url: info.image,
      label: n?.name || n?.label || "camera",
    });
    // ▶ Simulate makes a test picture; a board sends what its camera sees.
    const simulated = String(info.image).startsWith("/api/camera/sim/");
    stills.set(id, {
      ...saved,
      shot: info.shot,
      at: new Date(),
      simulated,
      image: info.image,
    });
    toast(
      simulated
        ? `Simulated test picture ${info.shot ?? ""} saved: ${saved.name}. This is the PC simulation: for the real camera, choose Real board (monitor) and ▶ Start MQTT test (done for you after an upload).`
        : `Picture ${info.shot ?? ""} saved: ${saved.name}`,
    );
  } catch (e) {
    stills.set(id, { ...(stills.get(id) || {}), error: e.message });
    toast(`Picture not saved: ${e.message}`);
  }
  drawStill(id);
  // Only the 🖼 button changes: no full redraw (it would cut a button press short).
  const view = document.querySelector(`#node-${id} .camera-view`);
  const last = stills.get(id);
  if (view && last?.name) {
    view.classList.add("has-picture");
    view.title = `Show picture ${last.shot ?? ""} (${last.name}) in a floating window`;
  }
}
// The floating window: Document Picture-in-Picture where the browser has it (it
// stays on top of every window, on any monitor), else a small pop-up window.
async function openStill(n) {
  let win = stillWindows.get(n.id);
  if (win && !win.closed) return win.focus();
  const last = stills.get(n.id);
  const ratio = last?.width ? last.height / last.width : 0.75;
  const width = 480,
    height = Math.round(width * ratio) + 90;
  win = null;
  if (window.documentPictureInPicture)
    try {
      win = await documentPictureInPicture.requestWindow({ width, height });
    } catch {
      win = null;
    }
  if (!win)
    win = window.open(
      "",
      "microflow-still-" + n.id,
      `popup,width=${width},height=${height}`,
    );
  if (!win)
    return toast(
      "The browser blocked the picture window: allow pop-ups for Microflow.",
    );
  const doc = win.document;
  doc.title = `${n.label || "Camera"} · Microflow`;
  const style = doc.createElement("style");
  style.textContent = `body{margin:0;font:12px system-ui,sans-serif;background:#101511;color:#e8efe9;display:flex;flex-direction:column;height:100vh}
header{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#1d2a21}
header b{font-size:13px}header span{color:#a9bcae;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:6px}
img{width:100%;height:100%;object-fit:contain;background:#000}
p{color:#a9bcae;text-align:center;padding:0 16px}
footer{display:flex;gap:6px;padding:6px 10px;background:#1d2a21;align-items:center}
a,button{color:#e8efe9;background:#2f4a37;border:1px solid #4d7a5a;border-radius:5px;padding:3px 9px;font:inherit;text-decoration:none;cursor:pointer}
footer small{color:#a9bcae;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
  doc.head.append(style);
  doc.body.replaceChildren();
  stillWindows.set(n.id, win);
  win.addEventListener("pagehide", () => stillWindows.delete(n.id));
  drawStill(n.id);
}
function drawStill(id) {
  const win = stillWindows.get(id);
  if (!win || win.closed) return;
  const doc = win.document;
  const n = flow.nodes.find((m) => m.id === id);
  const last = stills.get(id);
  const make = (tag, text) => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const header = make("header");
  header.append(
    make("b", n?.label || "Camera"),
    make(
      "span",
      last?.name
        ? `${last.simulated ? "simulated test picture" : "picture"} ${last.shot ?? ""} · ${last.width} × ${last.height} · ${last.at.toLocaleTimeString()}`
        : "",
    ),
  );
  const main = make("main");
  const footer = make("footer");
  if (last?.name) {
    const src = new URL(
      "/api/camera/file/" + encodeURIComponent(last.name),
      location.href,
    ).href;
    const img = make("img");
    img.src = src;
    img.alt = `Picture ${last.shot ?? ""} from ${n?.label || "the camera"}`;
    main.append(img);
    const save = make("a", "Save PNG");
    save.href = src;
    save.download = last.name;
    const open = make("a", "Full size");
    open.href = src;
    open.target = "_blank";
    const sep = String(last.folder).includes("\\") ? "\\" : "/";
    const where = make("small", `${last.folder}${sep}${last.name}`);
    where.title = "The PNG file on this PC";
    footer.append(save, open);
    // A board serves live video for focusing next to its pictures (lib/camerafw.js).
    if (!last.simulated && last.image && (n?.config?.live ?? "VGA") !== "off") {
      const live = make("a", "Live video (focus)");
      live.href = new URL("/camera/live", last.image).href;
      live.target = "_blank";
      live.title =
        "Live video from the board, with a sharpness number to turn the lens by. The board's flow pauses while it plays.";
      footer.append(live);
    }
    footer.append(where);
  } else
    main.append(
      make(
        "p",
        last?.error
          ? `The last picture could not be saved: ${last.error}`
          : "No picture yet. Trigger the camera (its input going on): with ▶ Simulate, or a board running a debug build.",
      ),
    );
  doc.body.replaceChildren(header, main, footer);
}
// ── Timer indicator: what the timer is doing, on its box ──
// From the simulator ("indicator" events) or a board's debug build (debug topic).
const timerStates = new Map(); // node id → state
const TIMER_LOOK = {
  idle: ["idle", "Timer idle"],
  triggered: ["T1", "Triggered: waiting T1"],
  on: ["ON", "Active: sending 1 for T2"],
  off: ["done", "Done: sent 0; ready for the next trigger"],
};
function timerIndicator(id) {
  const box = el("span", "timer-ind");
  box.id = "timer-ind-" + id;
  showTimerState(box, timerStates.get(id) || "idle");
  return box;
}
function showTimerState(box, state) {
  const [text, title] = TIMER_LOOK[state] || TIMER_LOOK.idle;
  box.textContent = text;
  box.title = title;
  box.dataset.state = state;
}
// Board debug messages are the texts of lib/timer.js STATES.
const timerStateOf = (text) =>
  /^triggered/.test(text)
    ? "triggered"
    : /^active/.test(text)
      ? "on"
      : /^done/.test(text)
        ? "off"
        : /ignored: timer running/.test(text)
          ? "ignored"
          : /too short/.test(text)
            ? "short"
            : null;
function timerEvent(id, state) {
  const box = $("timer-ind-" + id);
  // Ignored triggers flash the box; the state stays what it was.
  if (state === "ignored" || state === "short") {
    box?.classList.remove("blink");
    void box?.offsetWidth; // restart the animation
    box?.classList.add("blink");
    return;
  }
  timerStates.set(id, state);
  if (box) {
    showTimerState(box, state);
    if (state === "triggered" || state === "on") {
      box.classList.remove("pop");
      void box.offsetWidth;
      box.classList.add("pop");
    }
  }
}
// GPIO input/output boxes show their pin level while the PC simulation runs.
const LED_TYPES = new Set(["gpio-watch", "digital-read", "digital-write"]);
const OUT_STATE_TYPES = new Set(["digital-write", "pwm-write", "pulse"]);
function updatePinLeds() {
  for (const led of document.querySelectorAll("#nodes .pin-led")) {
    // Emulation shows the real board's levels; otherwise the simulator's pins.
    const pins = emuActive
      ? Object.fromEntries(emuLevels)
      : typeof simPins === "undefined" // panels.js loads later
        ? null
        : simPins;
    const value = pins?.[led.dataset.pin];
    const state = value === undefined ? "unknown" : value ? "high" : "low";
    led.className = "pin-led " + state;
    led.title =
      state === "unknown"
        ? `GPIO ${led.dataset.pin}: level shown while the simulation runs`
        : `GPIO ${led.dataset.pin}: ${state.toUpperCase()}`;
  }
  // Output boxes: HIGH / LOW, PWM duty, or PULSE while a pulse is out.
  const levels = emuActive
    ? Object.fromEntries(emuLevels)
    : typeof simPins === "undefined"
      ? null
      : simPins;
  for (const s of document.querySelectorAll("#nodes .pin-state")) {
    const value = levels?.[s.dataset.pin];
    let text = "",
      kind = "";
    if (value !== undefined)
      if (s.dataset.kind === "pwm-write") {
        text = `PWM ${value}`;
        kind = value ? "high" : "low";
      } else if (s.dataset.kind === "pulse") {
        const on = emuActive
          ? emuPulsing.has(Number(s.dataset.pin))
          : value === Number(s.dataset.active);
        text = on ? "PULSE" : value ? "HIGH" : "LOW";
        kind = on ? "pulse" : value ? "high" : "low";
      } else {
        text = value ? "HIGH" : "LOW";
        kind = value ? "high" : "low";
      }
    s.textContent = text;
    s.className = "pin-state" + (kind ? " " + kind : "");
    s.hidden = !text;
  }
  if (typeof updateEmuControls === "function") updateEmuControls(); // emulate.js
}
// ── Test devices: Switch, Push button and Oscilloscope boxes ─────
const switchOn = new Map(); // node id → true while switched on
const scopeData = new Map(); // node id → [{ t, v }]
// ▶ Simulate: GPIO input boxes get a PUSH button (held = pressed) and a SWITCH, which
// set the simulated pin. With a pull-up, pressed reads LOW (a button to GND).
const SIM_INPUTS = new Set(["digital-read", "gpio-watch"]);
const pressedLevel = (n) => (n.config.pull === "pullup" ? 0 : 1);
function simInputControls(n, e) {
  if (!SIM_INPUTS.has(n.type) || !simPins || emuActive) return;
  const pin = Number(n.config.pin);
  if (!(pin in simPins)) return;
  const active = pressedLevel(n);
  const setPin = (value) => attempt(() => api("runtime/pin", { pin, value, chip: currentChipId() }))();
  const box = el("div", "sim-controls");
  const push = el("button", "test-push", "PUSH");
  push.title = `Hold to press: GPIO ${pin} reads ${active ? "HIGH" : "LOW"} while held`;
  push.onpointerdown = (event) => {
    event.stopPropagation();
    push.classList.add("down");
    setPin(active);
    // Released anywhere (the box may be redrawn meanwhile): back to idle.
    document.addEventListener(
      "pointerup",
      () => {
        push.classList.remove("down");
        setPin(1 - active);
      },
      { once: true },
    );
  };
  const on = simPins[pin] === active;
  const toggle = el(
    "button",
    "test-toggle sim-switch" + (on ? " on" : ""),
    on ? "ON" : "OFF",
  );
  toggle.dataset.pin = pin;
  toggle.dataset.active = active;
  toggle.title = `Switch: ON = GPIO ${pin} ${active ? "HIGH" : "LOW"} (pressed), OFF = released`;
  toggle.setAttribute("aria-pressed", String(on));
  toggle.onclick = (event) => {
    event.stopPropagation();
    setPin(simPins[pin] === active ? 1 - active : active);
  };
  box.append(push, toggle);
  e.append(box);
}
// Keeps the SWITCH labels in step with the simulated pin levels.
function updateSimSwitches() {
  for (const t of document.querySelectorAll(".sim-switch")) {
    const on = simPins?.[t.dataset.pin] === Number(t.dataset.active);
    t.textContent = on ? "ON" : "OFF";
    t.classList.toggle("on", on);
    t.setAttribute("aria-pressed", String(on));
  }
}
const pushHeld = new Set(); // Push button nodes held down now
function testDevice(n, e) {
  if (n.type === "test-switch") {
    const on = !!switchOn.get(n.id);
    const b = el(
      "button",
      "test-toggle" + (on ? " on" : ""),
      on ? "ON" : "OFF",
    );
    b.title = "Flip the switch (start the simulation or a test first)";
    b.setAttribute("aria-pressed", String(on));
    b.onclick = attempt(async () => {
      await triggerNode(n.id, on ? "0" : "1");
      switchOn.set(n.id, !on);
      render();
    });
    e.append(b);
  } else if (n.type === "test-button") {
    const b = el("button", "test-push", "PUSH");
    b.title = "Hold to press (start the simulation or a test first)";
    // attempt() calls without arguments, so each payload gets its own handler.
    const send = (payload) => attempt(() => triggerNode(n.id, payload))();
    if (pushHeld.has(n.id)) b.classList.add("down"); // redrawn while held
    b.onpointerdown = (event) => {
      event.stopPropagation();
      if (pushHeld.has(n.id)) return;
      pushHeld.add(n.id);
      b.classList.add("down");
      send("1");
      // Released anywhere, even if the box is redrawn meanwhile (e.g. a Camera
      // picture arriving): always send the 0, or the next press is no new edge.
      const release = () => {
        document.removeEventListener("pointerup", release);
        document.removeEventListener("pointercancel", release);
        pushHeld.delete(n.id);
        document
          .querySelector(`#node-${n.id} .test-push`)
          ?.classList.remove("down");
        send("0");
      };
      document.addEventListener("pointerup", release);
      document.addEventListener("pointercancel", release);
    };
    e.append(b);
  } else if (n.type === "voice-in") {
    e.append(voiceControl(n)); // speech.js
  } else if (n.type === "test-screen") {
    e.append(screenView(n));
  } else if (n.type === "test-scope") {
    const canvas = el("canvas", "scope-screen");
    canvas.id = "scope-" + n.id;
    canvas.width = 192;
    canvas.height = 72;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Oscilloscope trace of ${n.label}`);
    e.append(canvas);
    drawScope(n);
  }
}
// ── Screen (simulation only): the latest picture each Screen node received ──
const screenImages = new Map(); // node id → { src, width, height, shot, at }
// The picture in a value: a Camera node's JSON ({"image": …}), an address or a data URL.
function screenPicture(payload) {
  const text = String(payload).trim();
  let info = {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") info = v;
  } catch {}
  const src = String(
    info.image || info.url || info.src || (info === null ? "" : text),
  );
  if (!/^(https?:\/\/|\/api\/|data:image\/)/i.test(src)) return null;
  return { src, width: info.width, height: info.height, shot: info.shot };
}
function screenEvent(id, payload) {
  const pic = screenPicture(payload);
  const n = flow.nodes.find((m) => m.id === id);
  if (!pic) {
    screenImages.set(id, {
      error: String(payload).slice(0, 60),
      at: new Date(),
    });
  } else screenImages.set(id, { ...pic, at: new Date() });
  // Only the screen changes: no full redraw (it would cut a button press short).
  const box = document.querySelector(`#node-${id} .screen-view`);
  if (box && n) box.replaceWith(screenView(n));
}
function screenView(n) {
  const box = el("div", "screen-view");
  const last = screenImages.get(n.id);
  if (last?.src) {
    const img = el("img");
    img.src = last.src;
    img.alt = `Picture on ${n.label || "Screen"}`;
    img.title = "Click to see it full size";
    img.onpointerdown = (event) => event.stopPropagation();
    img.onclick = (event) => {
      event.stopPropagation();
      openScreenPicture(n);
    };
    box.append(img);
  } else
    box.append(
      el(
        "div",
        "screen-empty",
        last?.error
          ? `Not a picture: ${last.error}`
          : "No picture yet · ▶ Simulate",
      ),
    );
  if ((n.config.info || "yes") === "yes" && last?.src) {
    const parts = [
      last.width && last.height ? `${last.width} × ${last.height}` : "",
      last.shot !== undefined ? `shot ${last.shot}` : "",
      last.at.toLocaleTimeString(),
    ].filter(Boolean);
    box.append(el("div", "screen-info", parts.join(" · ")));
  }
  return box;
}
function openScreenPicture(n) {
  const last = screenImages.get(n.id);
  if (!last?.src) return;
  const area = el("div", "screen-full");
  const img = el("img");
  img.src = last.src;
  img.alt = `Picture on ${n.label || "Screen"}`;
  const open = el("a", "", "Open in a new tab");
  open.href = last.src;
  open.target = "_blank";
  area.append(img, open);
  modal(
    `${n.label || "Screen"}${last.shot !== undefined ? ` · shot ${last.shot}` : ""}`,
    area,
  );
}
function scopeSample(id, payload) {
  const text = String(payload).trim().toLowerCase();
  const v =
    text === "on" || text === "true"
      ? 1
      : text === "off" || text === "false"
        ? 0
        : text === ""
          ? NaN
          : Number(text);
  if (!Number.isFinite(v)) return;
  const samples = scopeData.get(id) || [];
  samples.push({ t: Date.now(), v });
  // Keep the longest possible window (120 s) and a bounded number of points.
  while (samples.length > 4000 || Date.now() - samples[0].t > 121000)
    samples.shift();
  scopeData.set(id, samples);
}
function drawScope(n) {
  const canvas = $("scope-" + n.id);
  if (!canvas) return;
  const g = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  g.fillStyle = "#14231c";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#2a4436";
  g.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const x = Math.round((w * i) / 6) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  const span = n.config.window * 1000,
    now = Date.now();
  const all = scopeData.get(n.id) || [];
  const first = all.findIndex((s) => s.t >= now - span);
  // Start from the last sample before the window so the trace reaches the left edge.
  const shown = first < 0 ? all.slice(-1) : all.slice(Math.max(0, first - 1));
  g.font = "10px ui-monospace, monospace";
  if (!shown.length) {
    g.fillStyle = "#6f8f7c";
    g.fillText("no signal", 6, 14);
    return;
  }
  let lo = Math.min(...shown.map((s) => s.v)),
    hi = Math.max(...shown.map((s) => s.v));
  if (lo >= 0 && hi <= 1) ((lo = 0), (hi = 1)); // digital: fixed 0–1 scale
  if (lo === hi) ((lo -= 1), (hi += 1));
  const pad = 8,
    x = (t) => Math.max(0, w - ((now - t) / span) * w),
    y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  g.strokeStyle = "#4be27a";
  g.lineWidth = 1.5;
  g.beginPath();
  shown.forEach((s, i) => {
    if (i === 0) g.moveTo(x(s.t), y(s.v));
    else (g.lineTo(x(s.t), y(shown[i - 1].v)), g.lineTo(x(s.t), y(s.v))); // step trace
  });
  g.lineTo(w, y(shown[shown.length - 1].v));
  g.stroke();
  g.fillStyle = "#9fc9ae";
  g.fillText(String(+hi.toPrecision(4)), 4, 10);
  g.fillText(String(+lo.toPrecision(4)), 4, h - 2);
  const last = String(+shown[shown.length - 1].v.toPrecision(6));
  g.fillStyle = "#4be27a";
  g.fillText(last, w - 6 - g.measureText(last).width, 10);
}
function resetTestDevices() {
  switchOn.clear();
  scopeData.clear();
  render();
}
// Scrolls the traces while time passes, even when no new values arrive.
setInterval(() => {
  for (const n of flow.nodes)
    if (n.type === "test-scope" && onTab(n)) drawScope(n);
}, 200);
function wires() {
  const svg = $("wires");
  svg.replaceChildren();
  for (const e of flow.edges) {
    const a = flow.nodes.find((n) => n.id === e.from),
      b = flow.nodes.find((n) => n.id === e.to);
    if (!a || !b || !onTab(a) || !onTab(b)) continue;
    const width = window.innerWidth <= 1150 ? 130 : 140;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // Several outputs (Counter): the wire starts at its output's dot.
    const multi = catalog[a.type]?.outputs?.length > 1;
    const x = a.x + width,
      y = a.y + (multi ? portTop(e.port || 0) + 5 : 25),
      tx = b.x,
      ty = b.y + 25;
    p.setAttribute(
      "d",
      `M${x},${y} C${x + 70},${y} ${tx - 70},${ty} ${tx},${ty}`,
    );
    p.setAttribute("fill", "none");
    const active = !!selectedLink && sameLink(selectedLink, e);
    // A wire not allowed (e.g. from an older flow): red and dashed, with the reason.
    const why = wireProblem(a, b);
    p.setAttribute("stroke", active ? "#174ea6" : why ? "#c4483a" : "#607d64");
    p.setAttribute("stroke-width", active ? "4" : "2");
    p.setAttribute("class", "connection-line" + (why ? " bad" : ""));
    if (why) p.setAttribute("stroke-dasharray", "6 4");
    const hit = p.cloneNode();
    hit.setAttribute("class", "connection-hit");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "16");
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("role", "button");
    hit.setAttribute(
      "aria-label",
      `Link from ${a.label}${multi ? " output " + ((e.port || 0) + 1) : ""} to ${b.label}`,
    );
    if (why) {
      const tip = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "title",
      );
      tip.textContent = why + " Select the wire and delete it.";
      hit.append(tip);
    }
    // A chosen Input / Output type converts the value on this wire: a small label.
    const conv = !why && wireConversion(a, b);
    if (conv) {
      const mid = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      mid.setAttribute("x", (x + tx) / 2);
      mid.setAttribute("y", (y + ty) / 2 - 6);
      mid.setAttribute("class", "wire-type" + (conv.note ? " lossy" : ""));
      mid.textContent = `${TYPE_LABEL[conv.from]}→${TYPE_LABEL[conv.to]}`;
      const tip = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "title",
      );
      tip.textContent = conv.note
        ? `Converted: ${conv.note}.`
        : `Converted from ${TYPE_LABEL[conv.from]} to ${TYPE_LABEL[conv.to]}.`;
      mid.append(tip);
      svg.append(mid);
      if (conv.note && !active) p.setAttribute("stroke", "#c98a1c");
    }
    hit.setAttribute("aria-pressed", String(active));
    const selectLink = () => {
      selected = null;
      selectedLink = null;
      pending = null;
      selectedLink = { from: e.from, to: e.to, port: e.port || 0 };
      render();
      showNode();
    };
    hit.onclick = (event) => {
      event.stopPropagation();
      selectLink();
    };
    hit.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectLink();
      }
    };
    svg.append(p, hit);
  }
}
// First grid cell not covered by an existing node.
function freeSpot() {
  for (let row = 0; row < 7; row++)
    for (let col = 0; col < 5; col++) {
      const x = 45 + col * 210,
        y = 60 + row * 110;
      if (
        !flow.nodes.some(
          (n) => onTab(n) && Math.abs(n.x - x) < 185 && Math.abs(n.y - y) < 85,
        )
      )
        return { x, y };
    }
  const count = flow.nodes.filter(onTab).length;
  return { x: 45 + (count % 5) * 20, y: 60 + (count % 5) * 20 };
}
function buildPalette() {
  let group = "";
  $("palette").replaceChildren();
  // Legacy types (Switch, Push button) still work in older flows, but are not offered.
  $("paletteCount").textContent = String(
    Object.values(catalog).filter((c) => !c.legacy).length,
  ).padStart(2, "0");
  for (const [type, c] of Object.entries(catalog)) {
    if (type === "custom") continue; // the library's entries instead (custom.js)
    if (c.legacy) continue;
    if (c.group !== group) {
      group = c.group;
      $("palette").append(el("div", "group-label", group));
    }
    const b = el("button", "palette-node");
    b.dataset.type = type;
    b.style.cssText = `--color:${c.color};--tint:${c.tint}`;
    b.title = c.help;
    b.append(
      el("span", "node-icon", c.icon),
      el("b", "", c.label),
      el("span", "", "+"),
    );
    b.onclick = () => {
      const n = {
        id: newNodeId(),
        ...(flow.tabs ? { tab: currentTab } : {}),
        type,
        label: c.label,
        ...freeSpot(),
        config: Object.fromEntries(c.fields.map((f) => [f.key, f.default])),
      };
      // Each of its pins: the default, or else the first suitable pin no other node
      // would clash with (two GPIO outputs do not both start on GPIO 2; a Speak box
      // on a board without GPIO 6 gets other amplifier pins).
      const board = boards.find((x) => x.id === $("board").value);
      const taken = new Set();
      for (const main of board ? nodePins(n) : []) {
        if (
          !taken.has(main.pin) &&
          !pinClash(n, main.pin, main.use) &&
          suitablePins(board, main.use).includes(main.pin)
        ) {
          taken.add(main.pin);
          continue;
        }
        // Plain pins first: no boot role, not shared with serial, USB or an LED.
        const plain = (p) => !board.strapping[p] && !board.notes[p];
        const pins = suitablePins(board, main.use);
        const free = [
          ...pins.filter(plain),
          ...pins.filter((p) => !plain(p)),
        ].find(
          (p) =>
            !taken.has(p) && !pinClash(n, p, main.use) && !pinUsers(p, n).length,
        );
        if (free !== undefined) {
          n.config[main.key] = free;
          taken.add(free);
        }
      }
      n.name = autoName(n);
      flow.nodes.push(n);
      selected = n.id;
      selectedLink = null;
      changed();
      render();
      showNode();
    };
    $("palette").append(b);
  }
  if (typeof customPalette === "function") customPalette(); // custom.js
  if (typeof filterPalette === "function") filterPalette(); // palettesearch.js
}
const NEEDS = {
  display: "a built-in display",
  bluetooth: "Bluetooth (ESP32 boards only)",
  wifi: "WiFi",
  webserver: "a web server (ESP32 or ESP8266 boards)",
  camera: "a camera (AI-Thinker ESP32-CAM or Freenove ESP32-S3 WROOM CAM)",
  localbroker: "an ESP32 board (it runs the local MQTT broker)",
  stillcam: "the Freenove ESP32-S3 WROOM CAM board",
};
// Disables palette nodes the selected board cannot run (e.g. BLE on ESP8266).
function updatePalette() {
  const board = boards.find((b) => b.id === $("board").value);
  for (const b of $("palette").querySelectorAll(".palette-node")) {
    const c = catalog[b.dataset.type];
    const missing = !!(board && c.needs && !board.features.includes(c.needs));
    b.disabled = missing;
    b.title = missing
      ? `Not available on ${board.label}: needs ${NEEDS[c.needs] || c.needs}.\n\n${c.help}`
      : c.help;
  }
}
function panel(node, stay = true) {
  // Ask AI open: it stays open and its suggestions follow the selected node.
  if (node && stay && !$("aiPanel").hidden) return queueMicrotask(showAi);
  $("devicePanel").hidden = node;
  $("nodePanel").hidden = !node;
  $("aiPanel").hidden = true; // Ask AI tab (askai.js)
  $("consolePanel").hidden = true;
  $("aiTab").classList.remove("selected");
  $("consoleTab").classList.remove("selected");
  $("deviceTab").classList.toggle("selected", !node);
  $("nodeTab").classList.toggle("selected", node);
}
// ── Debug console: a tab of the right panel ──
// Each message belongs to a channel: "upload" (compile, upload, board checks) or
// "sim" (simulation, MQTT tests, the board's messages); errors and warnings join the
// channel last started. The console shows one channel, or all.
const UPLOAD_KINDS = new Set(["build", "verify", "ota", "progress"]);
let consoleChannel = "sim";
function consoleMode(mode) {
  if (mode !== "all") consoleChannel = mode;
  for (const box of [$("log"), $("log2")]) {
    box.dataset.mode = mode;
    box.scrollTop = box.scrollHeight;
  }
  for (const b of document.querySelectorAll(".console-modes button"))
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
}
// Opens the Console tab; mode: "sim", "upload" or "all" (kept when omitted).
function showConsole(mode) {
  for (const id of ["devicePanel", "nodePanel", "aiPanel"]) $(id).hidden = true;
  $("consolePanel").hidden = false;
  for (const id of ["deviceTab", "nodeTab", "aiTab"])
    $(id).classList.remove("selected");
  $("consoleTab").classList.add("selected");
  if (mode) consoleMode(mode);
}
$("consoleTab").onclick = () => showConsole();
for (const b of document.querySelectorAll(".console-modes button"))
  b.onclick = () => consoleMode(b.dataset.mode);
// ── Right panel width: drag its left edge (remembered; double-click resets) ──
(() => {
  const aside = $("inspector"),
    grip = $("inspectorGrip");
  const MIN = 240,
    MAX = () => Math.max(MIN, Math.round(window.innerWidth * 0.6));
  const set = (w) => {
    const width = Math.min(MAX(), Math.max(MIN, Math.round(w)));
    aside.style.width = width + "px";
    return width;
  };
  try {
    const saved = Number(localStorage.getItem("microflow.panelWidth"));
    if (saved) set(saved);
  } catch {}
  const keep = (w) => {
    try {
      localStorage.setItem("microflow.panelWidth", String(w));
    } catch {}
  };
  grip.onpointerdown = (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    const start = event.clientX,
      from = aside.getBoundingClientRect().width;
    grip.onpointermove = (e) => set(from + start - e.clientX);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("dragging");
      keep(aside.getBoundingClientRect().width);
      wires();
    };
  };
  grip.ondblclick = () => {
    aside.style.width = "";
    try {
      localStorage.removeItem("microflow.panelWidth");
    } catch {}
    wires();
  };
  grip.onkeydown = (event) => {
    const step = event.shiftKey ? 50 : 10;
    if (event.key === "ArrowLeft")
      keep(set(aside.getBoundingClientRect().width + step));
    else if (event.key === "ArrowRight")
      keep(set(aside.getBoundingClientRect().width - step));
    else return;
    event.preventDefault();
  };
})();
function showNode() {
  panel(true);
  const area = $("properties");
  area.replaceChildren();
  // Several nodes selected: say so above the main node's properties.
  const many = selectedNodes().length;
  if (many > 1) {
    const note = el("div", "multi-note");
    note.append(
      el("strong", "", `${many} nodes selected`),
      el(
        "span",
        "",
        " · Ctrl+C copy · Ctrl+V paste · Ctrl+D duplicate · Del delete · drag one to move all. Properties below: ",
      ),
    );
    // Save the selection as one reusable node (custom.js).
    if (typeof saveCustomDialog === "function") {
      const save = el("button", "custom-save", "◈ Save as custom node");
      save.title =
        "Combine the selected nodes into one node and save it to the library (CUSTOM group, left)";
      save.onclick = () => saveCustomDialog(selectedNodes());
      note.append(save);
    }
    area.append(note);
  }
  const n = flow.nodes.find((n) => n.id === selected);
  if (!n) {
    if (selectedLink) {
      const from = flow.nodes.find((node) => node.id === selectedLink.from);
      const to = flow.nodes.find((node) => node.id === selectedLink.to);
      area.append(
        el("strong", "", "Selected link"),
        el(
          "p",
          "",
          `${from?.label}${catalog[from?.type]?.outputs?.length > 1 ? ` (output ${(selectedLink.port || 0) + 1})` : ""} → ${to?.label}`,
        ),
      );
      const why = from && to && wireProblem(from, to);
      if (why) area.append(el("p", "pin-bad", "✗ " + why));
      const remove = el("button", "full danger", "Delete link");
      remove.onclick = deleteSelectedNode;
      area.append(remove);
    } else area.append(el("p", "muted", "Select a node or link to edit."));
    return;
  }
  const def = catalog[n.type];
  // Fields with `when` show only for those values of other fields (e.g. the Radio
  // protocol); changing a field others depend on redraws the panel.
  const shown = (f) => whenMatches(n, f.when);
  const controlling = new Set([
    ...def.fields.flatMap((f) =>
      [f.when || {}].flat().flatMap((w) => Object.keys(w)),
    ),
    // Device nodes: the help and pins follow the device.
    ...(def.helpBy ? [def.helpBy.key] : []),
  ]);
  const field = (f, target, into = area) => {
    // Some labels depend on another setting (e.g. Signal pin / STEP pin).
    const label = el(
      "label",
      "",
      f.labelBy
        ? (f.labelBy.labels[
            String(
              target[f.labelBy.key] ??
                def.fields.find((g) => g.key === f.labelBy.key)?.default,
            )
          ] ?? f.label)
        : f.label,
    );
    let input;
    // Fields that name a connected input (Logic Set / Reset / Data / Clock,
    // Peripheral Trigger and parameters) choose among the connected inputs.
    const inputChoice = !!f.inputChoice;
    if (inputChoice) {
      input = el("select");
      const ups = upstreamOf(n);
      const names = ups.map((m) => m.name);
      // "GPIO4 · GPIO 4 (GPIO input (change))": which pin each input reads.
      const describe = (name) => {
        const m = ups.find((x) => x.name === name);
        const pin = m && nodePins(m)[0]?.pin;
        return pin !== undefined
          ? `${name} · GPIO ${pin} (${m.label})`
          : `${name}${m && m.label !== name ? ` (${m.label})` : ""}`;
      };
      const current = target[f.key] || "";
      for (const value of [
        "",
        ...names,
        ...(current && !names.includes(current) ? [current] : []),
      ]) {
        const o = el(
          "option",
          "",
          value === ""
            ? f.inputChoice === "optional"
              ? f.noneLabel || "— the default value below —"
              : names.length
                ? "choose a connected input…"
                : "connect inputs first"
            : names.includes(value)
              ? describe(value)
              : `${value} (not connected)`,
        );
        o.value = value;
        input.append(o);
      }
    } else if (f.type === "select") {
      input = el("select");
      for (const [value, text] of Object.entries(f.options)) {
        const o = el("option", "", text);
        o.value = value;
        input.append(o);
      }
    } else if (f.type === "textarea") {
      input = el("textarea", "field-lines");
      input.rows = 6;
    } else if (f.type === "code") {
      input = codeBox(target[f.key] ?? f.default ?? "", 14);
    } else {
      input = el("input");
      if (f.type === "number") {
        input.type = "number";
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        input.step = f.integer ? "1" : "any";
      }
      // Passwords: hidden while typing, never offered by the browser's autofill.
      if (f.type === "secret") {
        input.type = "password";
        input.autocomplete = "new-password";
      } // Radio in / out topics: the ones the project's other nodes already use, with
      // the chip that publishes or listens, so chips find each other's messages.
      if (
        f.key === "topic" &&
        (n.type === "mqtt-in" || n.type === "mqtt-out")
      ) {
        const other = n.type === "mqtt-in" ? "mqtt-out" : "mqtt-in";
        const seen = new Map();
        for (const m of flow.nodes)
          if (m.type === other && m.config.topic && !seen.has(m.config.topic))
            seen.set(
              m.config.topic,
              `${other === "mqtt-out" ? "sent by" : "heard by"} ${chipsOf().find((c) => c.id === chipOfNode(m))?.name || "this chip"} · ${m.name}`,
            );
        if (seen.size) {
          const list = el("datalist");
          list.id = "topics-" + n.id;
          for (const [topic, who] of seen) {
            const o = el("option");
            o.value = topic;
            o.label = who;
            list.append(o);
          }
          label.append(list);
          input.setAttribute("list", list.id);
        }
      }
    }
    input.value = target[f.key] ?? f.default ?? "";
    input.oninput = input.onchange = (event) => {
      // A default name such as GPIO4 follows the pin; a name you chose stays.
      const followName = target === n.config && isDefaultName(n);
      target[f.key] =
        f.type === "number" && input.value !== ""
          ? Number(input.value)
          : input.value;
      // Switching a Radio box to I2C: start with the board's usual I2C pins.
      if (f.key === "protocol" && input.value === "i2c") {
        const pins = boards.find((b) => b.id === $("board").value)?.i2c;
        if (pins) Object.assign(target, pins);
      }
      // Device nodes: a gyroscope starts on the board's I2C pins, and a pin that
      // does not suit the new device (e.g. not analog) moves to one that does.
      if (def.pinSpec && controlling.has(f.key)) {
        const board = boards.find((b) => b.id === $("board").value);
        if (
          (f.key === "device" || f.key === "kind") &&
          (input.value === "gyro" || input.value === "i2cdisplay") &&
          board?.i2c
        )
          Object.assign(target, board.i2c);
        const use = mainPinUse(n);
        if (board && use) {
          const fits = suitablePins(board, use);
          if (fits.length && !fits.includes(Number(target.pin)))
            target.pin = fits[0];
        }
      }
      if (followName) {
        setName(n, autoName(n));
        nameInput.value = n.name;
      }
      // A pin another node already uses as the other kind (or two outputs): warn
      // when the choice is made (not on every keystroke); the pin guide says it too.
      const pinNow = nodePins(n).find((p) => p.key === f.key);
      if (event?.type === "change" && pinNow) {
        const why = pinClash(n, pinNow.pin, pinNow.use, pinNow.shared);
        if (why) toast(why);
      }
      changed();
      render();
      if (target === n.config && controlling.has(f.key)) showNode();
    };
    label.append(input);
    into.append(label);
  };
  // What kind of box this is, whatever its label says.
  const kind = el("div", "node-kind");
  kind.style.cssText = `--color:${def.color};--tint:${def.tint}`;
  const name = el("div", "node-kind-name");
  name.append(
    el("strong", "", def.label),
    el("span", "node-kind-group", def.group),
  );
  const id = el("div", "node-kind-id mono", "id: " + n.id);
  id.title = "Node ID, used in MQTT topics and the test terminal";
  const text = el("div");
  text.append(name, id);
  kind.append(el("span", "node-icon", def.icon), text);
  area.append(kind);
  field({ key: "label", label: "Label", type: "text" }, n);
  // Variable name: checked and applied when you leave the box or press Enter.
  const nameLabel = el(
    "label",
    "",
    "Output variable name (used in C/C++ nodes)",
  );
  const nameInput = el("input", "mono");
  nameInput.value = n.name;
  nameInput.maxLength = 32;
  nameInput.spellcheck = false;
  nameInput.onchange = () => {
    if (!renameNode(n, nameInput.value)) nameInput.value = n.name;
  };
  nameInput.onkeydown = (event) => event.key === "Enter" && nameInput.blur();
  nameLabel.append(nameInput);
  area.append(nameLabel);
  // Input and output variables: the type of the value the node takes in and of the
  // value it sends. Auto keeps the node's own type; a chosen type converts each value.
  const typeChoice = (title, key, autoType, help) => {
    const label = el("label", "", title);
    const select = el("select");
    for (const [value, text] of [
      ["auto", `auto: ${TYPE_LABEL[autoType] || autoType}`],
      ["bool", "bool (on / off: 1 / 0)"],
      ["int", "int (whole number)"],
      ["double", "float (decimal number)"],
      ["String", "String (text)"],
    ]) {
      const o = el("option", "", text);
      o.value = value;
      select.append(o);
    }
    select.value = n[key] || "auto";
    select.title = help;
    select.onchange = () => {
      if (select.value === "auto") delete n[key];
      else n[key] = select.value;
      changed();
      render();
      showNode();
    };
    label.append(select);
    return label;
  };
  const vars = el("div", "var-types");
  const autoIn = inTypeOf({ ...n, itype: undefined });
  if (autoIn)
    vars.append(
      typeChoice(
        "Input type",
        "itype",
        autoIn,
        "What each value this node receives becomes before the node uses it. Auto: the node's own type, no conversion.",
      ),
    );
  if (!def.sink)
    vars.append(
      typeChoice(
        `Output type (${n.name})`,
        "vtype",
        varTypeOf({ ...n, vtype: undefined }),
        `What this node sends becomes this type; it is also the type of ${n.name} in C/C++ nodes.`,
      ),
    );
  // A custom node's types are those of the nodes inside it.
  if (n.type !== "custom") area.append(vars);
  // "Show on the Status display" (statusview.js).
  if (def.statusOk && typeof statusOption === "function")
    area.append(statusOption(n));
  // Conversions on this node's wires that change values (shown, not blocked).
  const typeNotes = [];
  for (const m of upstreamOf(n)) {
    const conv = wireConversion(m, n);
    if (conv?.note) typeNotes.push(`${m.name} → ${n.name}: ${conv.note}`);
  }
  for (const e of flow.edges.filter((e) => e.from === n.id)) {
    const m = flow.nodes.find((x) => x.id === e.to);
    const conv = m && wireConversion(n, m);
    if (conv?.note) typeNotes.push(`${n.name} → ${m.name}: ${conv.note}`);
  }
  if (typeNotes.length)
    area.append(
      el("p", "type-warning", typeNotes.map((t) => "⚠ " + t).join("\n")),
    );
  // Node-RED language: the fields this node adds to the messages it sends.
  if (languageOf() === "nodered") {
    const msgLabel = el(
      "label",
      "",
      "Message (JSON) · fields added to what this node sends; payload is set by the node",
    );
    const box = codeBox(n.msg || defaultFields(n), 6);
    box.classList.add("msg-box");
    box.onchange = () => {
      const text = box.value.trim() || "{}";
      const why = fieldsProblem(text);
      if (why) {
        toast(why);
        box.value = n.msg;
        return;
      }
      n.msg = text;
      changed();
      render();
    };
    msgLabel.append(box);
    area.append(msgLabel);
  }
  for (const f of def.fields) if (shown(f) && !f.advanced) field(f, n.config);
  // Advanced settings: folded away until needed; open when any is in use.
  const advanced = def.fields.filter((f) => f.advanced && shown(f));
  if (advanced.length) {
    const box = el("details", "advanced");
    const inUse = advanced.some(
      (f) => (n.config[f.key] ?? f.default) !== f.default,
    );
    box.open = advancedOpen || inUse;
    box.ontoggle = () => (advancedOpen = box.open);
    box.append(el("summary", "", `Advanced settings (${advanced.length})`));
    for (const f of advanced) field(f, n.config, box);
    area.append(box);
  }
  // C/C++ node: the variables its connected inputs give the code.
  if (n.type === "arduino") area.append(codeInputs(n));
  // Logic: its connected inputs, by the names Set / Reset / Data / Clock refer to.
  if (n.type === "logic") {
    const names = upstreamOf(n).map((m) => m.name);
    area.append(
      el(
        "p",
        "muted code-inputs",
        names.length
          ? `Connected inputs: ${names.join(", ")}. Gates use all of them; flip-flops name theirs above.`
          : "Connect inputs to this node: their variable names (shown on their boxes) are what Set, Reset, Data and Clock refer to.",
      ),
    );
  }
  // C/C++ node: all code sections side by side in a large window.
  if (def.fields.some((f) => f.type === "code")) {
    const wide = el("button", "full", "Open code editor");
    wide.title = "Edit the code sections in a large window";
    wide.onclick = () => openCodeEditor(n);
    area.append(wide);
  }
  // Board-specific pin advice (panels.js); follows edits to the pin and input mode.
  const guide = pinGuide(n);
  area.append(guide);
  area.oninput = area.onchange = () => guide.refresh?.();
  area.append(el("p", "muted", def.help));
  if (n.type === "custom" && typeof customProps === "function")
    area.append(customProps(n)); // custom.js
  if (n.type === "pwa" && typeof pwaProps === "function")
    area.append(pwaProps(n)); // pwa.js
  // Device nodes: wiring and use of the chosen device.
  if (def.helpBy) {
    const text =
      def.helpBy.texts[
        n.config[def.helpBy.key] ??
          def.fields.find((f) => f.key === def.helpBy.key)?.default
      ];
    if (text) area.append(el("p", "muted device-help", text));
  }
  if (n.type === "link-in" || n.type === "link-out") {
    const peers = linkPeers(n);
    const other = n.type === "link-out" ? "Link in" : "Link out";
    area.append(
      el(
        "p",
        "muted",
        peers.length
          ? n.type === "link-out"
            ? "Sends to:"
            : "Receives from:"
          : `No ${other} uses this link name yet. Add one (on any tab) with the same link name.`,
      ),
    );
    for (const m of peers) {
      const go = el("button", "full", `${m.label} · ${tabName(tabOf(m))}`);
      go.title = "Show this node";
      go.onclick = () => {
        showTab(tabOf(m));
        selected = m.id;
        render();
        showNode();
      };
      area.append(go);
    }
  }
  if (n.type === "inject") {
    const topic = `microflow/${$("deviceId").value.trim() || "<device>"}/inject/${n.id}`;
    area.append(el("p", "muted mono", "MQTT trigger: " + topic));
  }
  if (def.web) {
    const { url, known } = webUrl(n);
    const p = el("p", "muted mono", def.web + " ");
    if (known) {
      const a = el("a", "", url);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      p.append(a);
    } else p.append(url);
    const page = webUrl(n, "/").url;
    p.append(el("br"), `Page: ${page}`);
    area.append(p);
  }
  if (typeof helpButton === "function") area.append(helpButton(n)); // nodehelp.js
  const remove = el("button", "full", "Delete node");
  remove.onclick = deleteSelectedNode;
  area.append(remove);
}
const settings = () => ({
  board: $("board").value,
  serialPort: $("serialPort").value,
  ssid: $("ssid").value,
  password: $("password").value,
  host: $("host").value.trim() || brokerHostForBoard(),
  port: Number($("mqttPort").value),
  username: $("username").value,
  mqttPassword: $("mqttPassword").value,
  deviceId: $("deviceId").value.trim(),
  telemetry: $("telemetry").checked,
  profile: $("buildProfile").value,
  ota: $("ota").checked && !$("ota").disabled, // off on boards without remote update
  emulate: $("emulate").checked,
  usbTest: $("usbTest").checked,
  network: $("netOn").checked,
});
// The board can use the PC's broker host unless it is loopback (which means the board itself).
// A pattern, not new URL(): some browsers do not parse the host of mqtt:// URLs.
function brokerHostForBoard() {
  const host =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]+)/i.exec(
      $("brokerUrl").value.trim(),
    )?.[1] || "";
  return ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].includes(host)
    ? ""
    : host;
}
const broker = () => ({
  url: $("brokerUrl").value,
  username: $("username").value,
  password: $("mqttPassword").value,
});
// Non-secret settings are remembered per browser. WiFi SSID/password are saved
// on this PC in SQLite (see wifiSettings) so every browser gets them.
const REMEMBER = [
  "board",
  "serialPort",
  "host",
  "mqttPort",
  "username",
  "deviceId",
  "brokerUrl",
  "baudRate",
  "runtimeMode",
  "buildProfile",
];
function saveSettings() {
  storeChipSettings(); // the chip on screen keeps its board, Device ID and port
  try {
    const data = Object.fromEntries(REMEMBER.map((id) => [id, $(id).value]));
    data.telemetry = $("telemetry").checked;
    data.ota = $("ota").checked;
    data.emulate = $("emulate").checked;
    data.usbTest = $("usbTest").checked;
    data.netOn = $("netOn").checked;
    localStorage.setItem("microflow.settings", JSON.stringify(data));
  } catch {}
}
function restoreSettings() {
  let data = {};
  try {
    data = JSON.parse(localStorage.getItem("microflow.settings") || "{}");
  } catch {}
  for (const id of REMEMBER)
    if (typeof data[id] === "string" && data[id]) $(id).value = data[id];
  if (!$("board").value) $("board").value = boards[0]?.id;
  if (typeof data.telemetry === "boolean")
    $("telemetry").checked = data.telemetry;
  if (typeof data.ota === "boolean") $("ota").checked = data.ota;
  if (typeof data.emulate === "boolean") $("emulate").checked = data.emulate;
  if (typeof data.usbTest === "boolean") $("usbTest").checked = data.usbTest;
  if (typeof data.netOn === "boolean") $("netOn").checked = data.netOn;
  $("telemetry").disabled = $("emulate").disabled =
    $("buildProfile").value === "release";
}
let wifiTimer;
function saveWifi() {
  clearTimeout(wifiTimer);
  wifiTimer = setTimeout(
    () =>
      api(
        "settings",
        { ssid: $("ssid").value, password: $("password").value },
        "PUT",
      )
        .then(
          () =>
            ($("wifiState").textContent = $("ssid").value
              ? "Saved on this PC"
              : ""),
        )
        .catch((e) => toast(e.message)),
    400,
  );
}
async function restoreWifi() {
  const saved = await api("settings");
  $("ssid").value = saved.ssid || "";
  $("password").value = saved.password || "";
  $("wifiState").textContent = saved.ssid ? "Saved on this PC" : "";
}
$("ssid").addEventListener("input", saveWifi);
$("password").addEventListener("input", saveWifi);
$("forgetWifi").onclick = () => {
  $("ssid").value = "";
  $("password").value = "";
  saveWifi();
  toast("Saved WiFi credentials removed");
};
// Debounced board/pin check shown under the chip card.
let checkTimer;
function boardCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const box = $("boardCheck");
    try {
      const { errors, warnings } = await api("analyze", {
        flow: chipFlow(),
        board: $("board").value,
      });
      box.replaceChildren(
        ...errors.map((m) => el("div", "check-error", "✗ " + m)),
        ...warnings.map((m) => el("div", "check-warning", "! " + m)),
      );
      if (!errors.length && !warnings.length)
        box.append(el("div", "check-ok", "✓ Pins valid for this board"));
    } catch (e) {
      box.replaceChildren(el("div", "check-error", "✗ " + e.message));
    }
  }, 300);
}
let consolePaused = false;
let pendingSerialLog = null,
  serialLogTimer = null;
function discardPendingSerialLog() {
  clearTimeout(serialLogTimer);
  serialLogTimer = null;
  pendingSerialLog = null;
}
function setConsolePaused(paused) {
  consolePaused = paused;
  if (paused) discardPendingSerialLog();
  $("consoleState").textContent = paused ? "PAUSED" : "LIVE";
  $("pauseLog").textContent = paused ? "Resume" : "Pause";
  $("pauseLog").setAttribute("aria-pressed", String(paused));
}
function log(event) {
  if (typeof splitEvent === "function") splitEvent(event); // lower screen
  if (typeof speechEvent === "function") speechEvent(event); // Speak (speech.js)
  if (typeof servoEvent === "function") servoEvent(event); // servo arms (servoview.js)
  if (typeof statusEvent === "function") statusEvent(event); // Status display (statusview.js)
  if (event.kind === "serial-status") {
    localSerialConnected = !!event.connected;
    localSerialPath = event.path || null;
    if ($("serialTransport").value === "local")
      updateSerialUI(localSerialConnected, event.message);
  }
  if (event.kind === "trace") {
    // Nodes inside a custom node ("<box>__<inner>") show on their box.
    event = { ...event, message: String(event.message).split("__")[0] };
    // The last value each box handled, under its name (cleared when stopped). One
    // output of a box with several (Counter, `port`) leaves its count shown.
    if (event.payload !== undefined && event.port === undefined) {
      nodeValues.set(event.message, String(event.payload).slice(0, 60));
      const v = document.querySelector(
        `#node-${CSS.escape(event.message)} .node-value`,
      );
      if (v) v.textContent = nodeValues.get(event.message);
    }
    if (consolePaused) return;
    const node = $("node-" + event.message);
    node?.classList.add("flash");
    setTimeout(() => node?.classList.remove("flash"), 250);
    return;
  }
  if (event.kind === "status" && !emuActive) {
    $("runtimeStatus").textContent = event.message;
    $("connectionDot").style.background = event.connected
      ? "#68a35e"
      : "#a5b0a4";
    // Stopped, or replaced by a new run ("Restarting": the new run's status
    // brings the virtual pins, so they stay).
    if (event.message === "Runtime stopped" || event.message === "Restarting") {
      nodeValues.clear();
      for (const v of document.querySelectorAll(".node-value"))
        v.textContent = "";
      timerStates.clear(); // timers start idle next time
      for (const box of document.querySelectorAll(".timer-ind"))
        showTimerState(box, "idle");
    }
    if (event.message === "Runtime stopped") {
      simChips = null;
      showSimPins(null);
    }
  }
  // Multi-chip simulation: pins and the LCD strip show the chip on screen.
  const otherChip = event.chip && event.chip !== currentChipId();
  if (event.kind === "gpio" && !otherChip) updateSimPin(event.pin, event.value);
  // Camera pictures: from the simulator ("camera") or a board's debug build.
  if (
    (event.kind === "camera" || event.kind === "debug") &&
    flow.nodes.some((n) => n.id === event.node && n.type === "camera")
  )
    stillTaken(event.node, event.payload);
  // Counter: the count (and which output pulsed) on its box.
  if (
    event.kind === "indicator" &&
    flow.nodes.some((n) => n.id === event.node && n.type === "counter")
  ) {
    const text = String(event.message).replace(/^[^:]*: /, "");
    nodeValues.set(event.node, text.slice(0, 60));
    const v = document.querySelector(`#node-${CSS.escape(event.node)} .node-value`);
    if (v) v.textContent = nodeValues.get(event.node);
    const box = $("node-" + event.node);
    box?.classList.add("flash");
    setTimeout(() => box?.classList.remove("flash"), 250);
  } else if (event.kind === "indicator" && event.node)
    timerEvent(event.node, event.state);
  if (
    event.kind === "debug" &&
    flow.nodes.some((n) => n.id === event.node && n.type === "timer")
  ) {
    const state = timerStateOf(String(event.payload));
    if (state) timerEvent(event.node, state);
  }
  // Scope samples: from the simulator, or from a board's debug topic.
  if (
    (event.kind === "scope" || event.kind === "debug") &&
    flow.nodes.some((n) => n.id === event.node && n.type === "test-scope")
  )
    scopeSample(event.node, event.payload);
  if (
    event.kind === "screen" &&
    flow.nodes.some((n) => n.id === event.node && n.type === "test-screen")
  )
    screenEvent(event.node, event.payload);
  if (event.kind === "display" && !otherChip) updateSimLcd(event);
  if (event.kind === "device") {
    devicesChanged();
    refreshDeviceIps();
  }
  // Heartbeats only refresh the device list; they would flood the console.
  if (event.step) activeVerify?.update(event.index, event.step);
  // Compile / upload progress: the bar at the top, and the upload window's bar.
  if (event.kind === "progress") {
    buildBar(event);
    otaView?.update(event.pct);
  }
  // Incoming serial text: status replies (MF:{…}) go to the chip status card, the
  // rest to the console. Runs while paused too, so the card keeps updating.
  if (event.kind === "serial" && event.payload && event.message.includes("←")) {
    event = { ...event, payload: chipParser.feed(event.payload) };
    if (event.payload) termSerial(event.payload); // mirror into the terminal (panels.js)
    if (event.payload) emuSerialText(event.payload); // replies awaited by emulate.js
    if (event.payload && typeof serialMonText === "function") serialMonText(event.payload); // serial monitor (serialmon.js)
    if (!event.payload) return;
  }
  if (event.quiet || consolePaused) return;
  // The serial monitor (serialmon.js) shows the board's text itself while it is open.
  if (
    event.kind === "serial" &&
    event.message.includes("←") &&
    typeof serialMonRunning === "function" &&
    serialMonRunning()
  )
    return;
  if (event.kind === "serial" && event.payload !== undefined) {
    pendingSerialLog = {
      ...event,
      payload: ((pendingSerialLog?.payload || "") + event.payload).slice(-8192),
    };
    if (!serialLogTimer)
      serialLogTimer = setTimeout(() => {
        const pending = pendingSerialLog;
        discardPendingSerialLog();
        if (!consolePaused && pending) appendLogRow(pending);
      }, 100);
    return;
  }
  appendLogRow(event);
}
function appendLogRow(event) {
  const row = el("div", "log-row " + event.kind);
  row.dataset.channel = UPLOAD_KINDS.has(event.kind)
    ? "upload"
    : event.kind === "error" || event.kind === "warning"
      ? consoleChannel
      : "sim";
  row.append(
    el("time", "", new Date(event.time).toLocaleTimeString()),
    el(
      "span",
      "",
      event.message +
        (event.payload !== undefined ? " · " + event.payload : ""),
    ),
  );
  // The chip it is about: named by the simulator, else the chip being edited.
  row.dataset.chip = event.chip || currentChipId();
  placeLogRow(row); // upper or lower monitor (consolesplit.js)
}
new EventSource("/api/events").onmessage = (e) => log(JSON.parse(e.data));
// Monospaced code box (C/C++ node). Tab indents instead of leaving the box.
function codeBox(text, maxRows) {
  const box = el("textarea", "code");
  box.value = text;
  box.rows = Math.min(maxRows, Math.max(3, text.split("\n").length + 1));
  box.spellcheck = false;
  box.wrap = "off";
  box.onkeydown = (event) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    box.setRangeText("  ", box.selectionStart, box.selectionEnd, "end");
    box.dispatchEvent(new Event("input"));
  };
  return box;
}
// The variables a C/C++ node's connected inputs give its code.
function codeInputs(n) {
  const red = languageOf() === "nodered";
  const inputs = flow.edges
    .filter((e) => e.to === n.id)
    .map((e) => flow.nodes.find((m) => m.id === e.from))
    .filter(Boolean)
    .map((m) => `${varTypeOf(m)} ${m.name}`);
  return el(
    "p",
    "muted code-inputs",
    (inputs.length
      ? `Inputs in your code: ${inputs.join(", ")} (latest ${red ? "msg.payload" : "value"} of each). \`from\` names the input that sent \`value\`.`
      : "Connect nodes to this one: each becomes a typed variable in the code, named as shown on its box (e.g. bool SW1, int ADC34).") +
      (red
        ? ' Node-RED language: value = msg.payload, msg = the whole message (jsonText(msg, "topic")), send(x) sends msg with payload x, sendMsg(Json().add("payload", 1).add("topic", "t")) sends a whole message.'
        : ""),
  );
}
// Large editor for a C/C++ node's code sections; edits apply as you type.
function openCodeEditor(n) {
  const def = catalog[n.type];
  const area = el("div", "code-editor");
  area.append(codeInputs(n));
  for (const f of def.fields.filter((f) => f.type === "code")) {
    const label = el("label", "", f.label);
    const box = codeBox(n.config[f.key] ?? f.default ?? "", 24);
    box.oninput = () => {
      n.config[f.key] = box.value;
      changed();
      render();
    };
    label.append(box);
    area.append(label);
  }
  area.append(el("p", "muted", def.help));
  $("modal").addEventListener(
    "close",
    () => selected === n.id && showNode(), // show the edits in the side panel
    { once: true },
  );
  modal(`C/C++ code · ${n.label}`, area);
}
function modal(title, content) {
  $("modalTitle").textContent = title;
  $("modalContent").replaceChildren(content);
  if (!$("modal").open) $("modal").showModal();
  keepModalOnScreen();
}
// Popup window: drag it by its title bar (e.g. to see the build log underneath).
// It keeps its place while the page is open; Esc or ✕ closes it as before.
(() => {
  const dialog = $("modal"),
    head = dialog.querySelector(".modal-head");
  head.title = "Drag to move";
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const box = dialog.getBoundingClientRect();
    const dx = event.clientX - box.left,
      dy = event.clientY - box.top;
    head.setPointerCapture(event.pointerId);
    const move = (e) => placeModal(e.clientX - dx, e.clientY - dy);
    const end = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", end);
      head.removeEventListener("pointercancel", end);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  });
  // Resizing from the corner sets an inline height: then allow up to 95vh.
  new ResizeObserver(() => {
    if (dialog.style.height) dialog.classList.add("resized");
  }).observe(dialog);
  // New status lines (upload progress, failures, board checks) come into view.
  new MutationObserver((changes) => {
    const content = $("modalContent");
    if (!dialog.open || content.scrollHeight <= content.clientHeight) return;
    const added = changes
      .flatMap((c) => [...c.addedNodes])
      .filter(
        (n) =>
          n.nodeType === 1 &&
          n.closest?.(
            ".upload-failure, .verify-list, .ota-progress, .result-head, .verify-step",
          ),
      );
    added.at(-1)?.scrollIntoView({ block: "nearest" });
  }).observe($("modalContent"), { childList: true, subtree: true });
  window.addEventListener("resize", keepModalOnScreen);
})();
// Moves the popup to (x, y), keeping its title bar on screen.
function placeModal(x, y) {
  const dialog = $("modal"),
    box = dialog.getBoundingClientRect();
  dialog.classList.add("moved");
  dialog.style.left =
    Math.min(Math.max(0, x), window.innerWidth - Math.min(box.width, 120)) +
    "px";
  dialog.style.top = Math.min(Math.max(0, y), window.innerHeight - 48) + "px";
}
function keepModalOnScreen() {
  const dialog = $("modal");
  if (!dialog.open || !dialog.classList.contains("moved")) return;
  const box = dialog.getBoundingClientRect();
  placeModal(box.left, box.top);
}
function download(name, text, type) {
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("deviceTab").onclick = () => panel(false);
$("nodeTab").onclick = () => {
  panel(true, false);
  showNode();
};
$("closeModal").onclick = () => $("modal").close();
function showBoard() {
  const b = boards.find((b) => b.id === $("board").value);
  if (!b) return;
  if (typeof renderBoardTests === "function") renderBoardTests(); // examples.js
  // Board name, chip and drawing on the card (boardview.js).
  if (typeof showBoardCard === "function") showBoardCard();
  else $("chipName").textContent = b.family.toUpperCase();
  // Realtek (BW16) and Raspberry Pi Pico boards have no remote update: USB only.
  const usbOnly = b.family === "ameba" || b.family === "rp2040";
  $("ota").disabled = usbOnly;
  $("ota").parentElement.title =
    usbOnly
      ? `${b.label} updates over USB only (no remote update).`
      : "";
  storeChipSettings(); // the chip on screen keeps the board just chosen
  renderChips(); // its tab names the board
  updatePalette();
  baudControls();
  boardCheck();
}
// Before switching to another device, offers to save unsaved flow edits.
// Returns false (stay on the current device) if the user cancels or saving fails.
async function saveBeforeDeviceChange(target) {
  if (!dirty) return true;
  if (
    !confirm(
      `“${flow.name}” has unsaved changes. Save the flow before switching to ${target}?\n\nOK = save and switch · Cancel = stay on the current device`,
    )
  )
    return false;
  try {
    await saveFlow();
    toast("Flow saved");
    return true;
  } catch (e) {
    toast(`Flow not saved, device not switched: ${e.message}`);
    return false;
  }
}
let currentBoard;
$("board").onfocus = () => (currentBoard = $("board").value);
$("board").onchange = async () => {
  if (!(await saveBeforeDeviceChange($("board").selectedOptions[0].text))) {
    if (currentBoard) $("board").value = currentBoard;
    return;
  }
  currentBoard = $("board").value;
  showBoard();
  saveSettings();
  if (simPins) showSimPins(simPins); // the virtual LCD follows the board's screen
  if (!$("nodePanel").hidden) showNode(); // pin guide follows the board
};
for (const id of REMEMBER) $(id).addEventListener("change", saveSettings);
$("telemetry").addEventListener("change", saveSettings);
$("ota").addEventListener("change", saveSettings);
$("emulate").addEventListener("change", saveSettings);
$("usbTest").addEventListener("change", saveSettings);
$("netOn").addEventListener("change", saveSettings);
$("buildProfile").addEventListener("change", () => {
  $("telemetry").disabled = $("emulate").disabled =
    $("buildProfile").value === "release";
});
$("flowName").oninput = () => {
  flow.name = $("flowName").value;
  document.title = `${flow.name} · Microflow`;
  changed();
};
// Each browser tab edits one flow; its URL names it (?flow=<id>, or ?new for a blank flow).
function showFlowInUrl() {
  history.replaceState(
    null,
    "",
    flow.id ? "?flow=" + encodeURIComponent(flow.id) : "?new",
  );
}
async function saveFlow() {
  if (typeof helpActive === "function" && helpActive())
    throw Error(
      "This is a help example: click ✕ Back to my flow first (or ⧉ Copy into my flow).",
    );
  // A one-chip flow remembers its board, so it opens with it next time
  // (a multi-chip project keeps one per chip).
  if (!flow.chips?.length) flow.board = $("board").value;
  else delete flow.board;
  const before = flow.id;
  flow = await api("flows", flow);
  // A shared example (or someone else's flow) is saved as a copy of your own.
  if (before && flow.id !== before) saveCopyNote = true;
  showFlowInUrl();
  dirty = false;
  $("saveState").textContent = (await isGuest()) ? "Saved in this browser" : "Saved to SQLite";
  updateTestsButton();
}
let saveCopyNote = false;
$("save").onclick = attempt(async () => {
  await saveFlow();
  toast(saveCopyNote ? "Saved as your own copy (the shared example is unchanged)" : "Flow saved");
  saveCopyNote = false;
});
// Loads a saved flow onto the canvas; false if the user keeps unsaved edits.
async function loadFlow(id) {
  if (dirty && !confirm("Discard unsaved changes?")) return false;
  flow = await api("flows/" + encodeURIComponent(id));
  currentTab = null;
  showFlowInUrl();
  $("flowName").value = flow.name;
  selected = null;
  selectedLink = null;
  pending = null;
  dirty = false;
  $("saveState").textContent = (await isGuest()) ? "Saved in this browser" : "Saved to SQLite";
  await openedFlow();
  if (boardNote) toast(boardNote);
  updateTestsButton();
  return true;
}
// After a flow is opened (saved flow, example, import): the chip tabs, the Device
// panel and Properties follow it. A multi-chip project shows its first chip with that
// chip's board, Device ID and port; a flow saved with its board gets that board;
// otherwise (examples, older flows) the board is kept if the flow fits it, else the
// first board the flow fits is chosen (pins and features checked as for upload).
async function openedFlow() {
  undoStack.length = 0; // undo works within one flow
  undoButton();
  currentChip = null; // syncChip() (in render) shows the first chip and its settings
  settingsChip = null;
  boardNote = "";
  if (!flow.chips?.length) {
    const want = boards.some((b) => b.id === flow.board) ? flow.board : "";
    if (want && want !== $("board").value) {
      setBoard(want);
      boardNote = `Device set to ${shortBoard(want)}, the board this flow was saved with.`;
    } else if (!want) boardNote = await fitBoard();
  }
  panel(false); // the Device panel shows what the flow runs on
  $("properties").replaceChildren(
    el("p", "muted", "Select a node on the canvas to configure it."),
  );
  render();
}
function setBoard(id) {
  $("board").value = currentBoard = id;
  showBoard();
  saveSettings();
  if (simChips)
    // Every chip runs: show the pins and LCD of the chip now on screen.
    api("runtime/status?chip=" + encodeURIComponent(id))
      .then((s) => simChips && showSimPins(s.pins, s.lcd))
      .catch(() => {});
  else if (simPins) showSimPins(simPins);
}
// The board on screen if the flow has no pin or feature errors there, else the first
// board without errors; returns a note when it switched, "" when it kept the board.
async function fitBoard() {
  const errorsOn = async (id) => {
    try {
      return (await api("analyze", { flow: chipFlow(), board: id })).errors
        .length;
    } catch {
      return 99;
    }
  };
  const current = $("board").value;
  if (!(await errorsOn(current))) return "";
  for (const b of boards)
    if (b.id !== current && !(await errorsOn(b.id))) {
      setBoard(b.id);
      return `Device switched to ${shortBoard(b.id)}: this flow's pins and nodes fit it (not ${shortBoard(current)}).`;
    }
  return matchBoardToFlow();
}
// Switches to a board that has what the flow needs (e.g. a Display node needs the
// TTGO T-Display, BLE needs an ESP32), so an opened example runs and builds as is.
// Returns a note for the user, or "" when the board was kept.
let boardNote = "";
function matchBoardToFlow() {
  const needs = [
    ...new Set(flow.nodes.map((n) => catalog[n.type]?.needs).filter(Boolean)),
  ];
  const fits = (b) => needs.every((need) => b.features.includes(need));
  const current = boards.find((b) => b.id === $("board").value);
  if (!current || fits(current)) return "";
  const board = boards.find(fits);
  if (!board) return "";
  $("board").value = currentBoard = board.id;
  showBoard();
  saveSettings();
  if (simPins) showSimPins(simPins);
  return `Device switched to ${board.label}: this flow needs ${needs
    .filter((need) => !current.features.includes(need))
    .map((need) => NEEDS[need] || need)
    .join(" and ")}.`;
}
function resetDeletedFlow() {
  flow = {
    name: "Untitled flow",
    language: appSettings.language,
    nodes: [],
    edges: [],
  };
  currentTab = null;
  showFlowInUrl();
  updateTestsButton();
  $("flowName").value = flow.name;
  selected = null;
  selectedLink = null;
  pending = null;
  dirty = false;
  $("saveState").textContent = "New flow";
  $("properties").replaceChildren(el("p", "muted", "Select a node to edit."));
  panel(false);
  render();
}
// Confirms and deletes one or more flows. Unsaved targets (no id) only clear the canvas.
function confirmDeleteFlows(targets, after = () => $("modal").close()) {
  const current = targets.some((t) => (t.id ? t.id === flow.id : true));
  const saved = targets.filter((t) => t.id);
  const area = el("div");
  const title =
    targets.length === 1
      ? `Delete “${targets[0].name}”?`
      : `Delete ${targets.length} flows?`;
  area.append(
    el(
      "p",
      "",
      `${title} ${saved.length ? "This permanently removes the saved flow" + (saved.length > 1 ? "s, their tests and history" : ", its tests and history") + " from SQLite." : "This clears the unsaved flow from the canvas."}${current && dirty ? " Unsaved changes on the canvas will also be discarded." : ""}`,
    ),
  );
  if (targets.length > 1) {
    const list = el("ul", "delete-list");
    for (const t of targets) list.append(el("li", "", t.name));
    area.append(list);
  }
  const actions = el("div", "actions");
  const cancel = el("button", "", "Cancel");
  const remove = el(
    "button",
    "danger",
    targets.length === 1 ? "Delete flow" : `Delete ${targets.length} flows`,
  );
  cancel.onclick = () => $("modal").close();
  remove.onclick = attempt(async () => {
    remove.disabled = true;
    cancel.disabled = true;
    $("closeModal").disabled = true;
    try {
      if (current) await api("runtime/stop", {});
      if (saved.length)
        await api("flows/delete", { ids: saved.map((t) => t.id) });
      if (current) resetDeletedFlow();
      toast(
        targets.length === 1
          ? "Flow deleted"
          : `${targets.length} flows deleted`,
      );
      await after();
    } finally {
      remove.disabled = false;
      cancel.disabled = false;
      $("closeModal").disabled = false;
    }
  });
  actions.append(cancel, remove);
  area.append(actions);
  modal(targets.length === 1 ? "Delete flow" : "Delete flows", area);
}
function deleteSelectedNode() {
  if (selectedLink) remember("delete a connection");
  else if (selectedNodes().length)
    remember(
      selectedNodes().length > 1
        ? `delete ${selectedNodes().length} nodes`
        : `delete ${selectedNodes()[0].label}`,
    );
  if (selectedLink) {
    flow.edges = flow.edges.filter((edge) => !sameLink(edge, selectedLink));
    selectedLink = null;
    changed();
    render();
    showNode();
    toast("Selected link deleted");
    return;
  }
  const ids = new Set(selectedNodes().map((m) => m.id));
  if (!ids.size) return;
  flow.nodes = flow.nodes.filter((node) => !ids.has(node.id));
  flow.edges = flow.edges.filter(
    (edge) => !ids.has(edge.from) && !ids.has(edge.to),
  );
  if (ids.has(pending)) pending = null;
  selected = null;
  changed();
  render();
  showNode();
  toast(ids.size > 1 ? `${ids.size} nodes deleted` : "Selected node deleted");
}
$("deleteSelected").onclick = deleteSelectedNode;
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Delete" ||
    $("modal").open ||
    event.target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  if (selectedNodes().length || selectedLink) {
    event.preventDefault();
    deleteSelectedNode();
  }
});
// ── Selection, copy and paste on the canvas ──
// The selected nodes on the current tab, main node first.
function selectedNodes() {
  const ids = [selected, ...alsoSelected];
  return ids
    .map((id) => flow.nodes.find((m) => m.id === id && onTab(m)))
    .filter(Boolean);
}
function selectNodes(ids, main = ids.at(-1)) {
  ids = [...new Set(ids)];
  selected = ids.includes(main) ? main : (ids[0] ?? null);
  alsoSelected = new Set(ids.filter((id) => id !== selected));
  selectionMain = selected;
  selectedLink = null;
  render();
  showNode();
}
// Copied nodes: { microflow: "nodes", nodes, edges } (edges between them only). Kept
// here and put on the system clipboard as JSON, so another Microflow window can paste.
let nodeClipboard = null;
function copyNodes() {
  const nodes = selectedNodes();
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((m) => m.id));
  nodeClipboard = {
    microflow: "nodes",
    nodes: structuredClone(nodes),
    edges: flow.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ ...e })),
  };
  try {
    localStorage.setItem("microflow.clipboard", JSON.stringify(nodeClipboard));
  } catch {}
  toast(
    `Copied ${nodes.length} node${nodes.length > 1 ? "s" : ""}. Paste with Ctrl+V.`,
  );
  return nodeClipboard;
}
function storedClipboard() {
  if (nodeClipboard) return nodeClipboard;
  try {
    const data = JSON.parse(localStorage.getItem("microflow.clipboard"));
    if (data?.microflow === "nodes") return data;
  } catch {}
  return null;
}
// Pastes copied nodes with new ids, onto the current tab: at `at` (canvas point) or
// 30 px below and right of the originals. Taken variable names get a new default
// (GPIO4 → GPIO4_2, SW1 → SW3), also where pasted code and Logic inputs use them.
function pasteNodes(data = storedClipboard(), at = null) {
  if (!data?.nodes?.length)
    return toast("Nothing to paste: copy nodes first (Ctrl+C).");
  const limit = 64;
  if (chipFlow().nodes.length + data.nodes.length > limit)
    return toast(
      `A chip holds at most ${limit} nodes: this one has ${chipFlow().nodes.length}.`,
    );
  const known = new Set(Object.keys(catalog));
  const nodes = structuredClone(data.nodes).filter((m) => known.has(m.type));
  const ids = new Map(nodes.map((m) => [m.id, newNodeId()]));
  const taken = takenNames();
  const renamed = new Map();
  for (const m of nodes) {
    m.config ||= {};
    if (!m.name || taken.has(m.name)) {
      const before = m.name;
      m.name = autoName(m, taken);
      if (before) renamed.set(before, m.name);
    }
    taken.add(m.name);
  }
  const left = Math.min(...nodes.map((m) => m.x)),
    top = Math.min(...nodes.map((m) => m.y));
  for (const m of nodes) {
    const oldName = [...renamed].find(([, now]) => now === m.name)?.[0];
    m.id = ids.get(m.id);
    if (flow.tabs) m.tab = currentTab;
    else delete m.tab;
    m.x = Math.max(30, Math.min(1200, at ? at.x + m.x - left : m.x + 30));
    m.y = Math.max(20, Math.min(750, at ? at.y + m.y - top : m.y + 30));
    // A default Message box follows the node's new name.
    if (oldName && m.msg === JSON.stringify({ topic: oldName }))
      m.msg = JSON.stringify({ topic: m.name });
  }
  // Logic inputs and C/C++ code refer to inputs by name.
  for (const [before, now] of renamed) renameRefs(nodes, before, now);
  flow.nodes.push(...nodes);
  flow.edges.push(
    ...(data.edges || [])
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ from: ids.get(e.from), to: ids.get(e.to) })),
  );
  changed();
  selectNodes(
    nodes.map((m) => m.id),
    nodes[0]?.id,
  );
  toast(
    `Pasted ${nodes.length} node${nodes.length > 1 ? "s" : ""}` +
      (renamed.size
        ? ` (renamed: ${[...renamed].map(([a, b]) => `${a} → ${b}`).join(", ")})`
        : "") +
      ".",
  );
}
const canvasKeys = (event) =>
  !$("modal").open &&
  !event.target.closest("input, textarea, select, [contenteditable]");
// Text highlighted on the page (e.g. in the console) keeps the browser's copy.
const textSelected = () => String(window.getSelection?.() || "").length > 0;
// Ctrl+C / Ctrl+V use the clipboard events, which need no permission prompt.
document.addEventListener("copy", (event) => {
  if (!canvasKeys(event) || !selectedNodes().length || textSelected()) return;
  const data = copyNodes();
  event.clipboardData.setData("text/plain", JSON.stringify(data));
  event.preventDefault();
});
document.addEventListener("cut", (event) => {
  if (!canvasKeys(event) || !selectedNodes().length || textSelected()) return;
  const data = copyNodes();
  event.clipboardData.setData("text/plain", JSON.stringify(data));
  event.preventDefault();
  deleteSelectedNode();
});
document.addEventListener("paste", (event) => {
  if (!canvasKeys(event)) return;
  let data = null;
  try {
    data = JSON.parse(event.clipboardData.getData("text/plain"));
  } catch {}
  if (data?.microflow !== "nodes") data = storedClipboard();
  if (!data) return;
  event.preventDefault();
  pasteNodes(data);
});
document.addEventListener("keydown", (event) => {
  if (!canvasKeys(event) || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const onCanvas =
    event.target === document.body || !!event.target.closest("#canvas");
  if (key === "a" && onCanvas) {
    // Select all on this tab (when the page, not a text field, has focus).
    event.preventDefault();
    selectNodes(
      flow.nodes.filter(onTab).map((m) => m.id),
      selected,
    );
  } else if (key === "d" && selectedNodes().length) {
    event.preventDefault(); // duplicate
    pasteNodes(copyNodes());
  } else if (key === "z" && !event.shiftKey && onCanvas) {
    event.preventDefault(); // undo the last Clear or delete
    undo();
  }
});
// Drag on empty canvas: a box that selects the nodes it touches (Ctrl / Shift adds).
(() => {
  const canvas = $("canvas");
  canvas.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      event.target.closest(
        ".flow-node, .connection-hit, button, .canvas-caption",
      )
    )
      return;
    const area = canvas.getBoundingClientRect();
    const point = (ev) => ({
      x: ev.clientX - area.left + canvas.scrollLeft,
      y: ev.clientY - area.top + canvas.scrollTop,
    });
    const from = point(event);
    const adding = event.ctrlKey || event.shiftKey || event.metaKey;
    const before = adding ? selectedNodes().map((m) => m.id) : [];
    const band = el("div", "select-band");
    let moved = false;
    canvas.setPointerCapture(event.pointerId);
    const move = (ev) => {
      const to = point(ev);
      if (!moved && Math.hypot(to.x - from.x, to.y - from.y) < 4) return;
      if (!moved) canvas.append(band);
      moved = true;
      Object.assign(band.style, {
        left: Math.min(from.x, to.x) + "px",
        top: Math.min(from.y, to.y) + "px",
        width: Math.abs(to.x - from.x) + "px",
        height: Math.abs(to.y - from.y) + "px",
      });
    };
    const up = (ev) => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      band.remove();
      if (!moved) {
        // A plain click on empty canvas clears the selection.
        if (!adding && (selected || alsoSelected.size)) selectNodes([]);
        return;
      }
      const to = point(ev);
      const x1 = Math.min(from.x, to.x),
        x2 = Math.max(from.x, to.x),
        y1 = Math.min(from.y, to.y),
        y2 = Math.max(from.y, to.y);
      const hit = flow.nodes.filter((m) => {
        const box = $("node-" + m.id);
        if (!box) return false;
        return (
          m.x < x2 &&
          m.x + box.offsetWidth > x1 &&
          m.y < y2 &&
          m.y + box.offsetHeight > y1
        );
      });
      selectNodes([...before, ...hit.map((m) => m.id)], hit[0]?.id ?? selected);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  });
  // Right-click on the canvas: copy, paste and the like (the palette keeps Ask AI).
  canvas.addEventListener("contextmenu", (event) => {
    if (event.shiftKey) return; // Shift: the browser's own menu
    event.preventDefault();
    document.querySelector(".ai-menu")?.remove();
    const area = canvas.getBoundingClientRect();
    const at = {
      x: event.clientX - area.left + canvas.scrollLeft,
      y: event.clientY - area.top + canvas.scrollTop,
    };
    const box = event.target.closest(".flow-node");
    const n = box && flow.nodes.find((m) => "node-" + m.id === box.id);
    // Right-clicking a node outside the selection selects it.
    if (n && !selectedNodes().some((m) => m.id === n.id)) selectNodes([n.id]);
    const count = selectedNodes().length;
    const clip = storedClipboard();
    const menu = el("div", "ai-menu canvas-menu");
    menu.setAttribute("role", "menu");
    const item = (text, keys, enabled, run) => {
      const b = el("button", "");
      b.append(el("span", "", text), el("kbd", "", keys));
      b.setAttribute("role", "menuitem");
      b.disabled = !enabled;
      b.onclick = () => {
        menu.remove();
        run();
      };
      menu.append(b);
    };
    const what = count > 1 ? `${count} nodes` : "node";
    menu.append(
      el(
        "div",
        "ai-menu-title",
        count
          ? `Selected: ${count > 1 ? `${count} nodes` : selectedNodes()[0].label}`
          : "Canvas",
      ),
    );
    item(`Copy ${what}`, "Ctrl+C", count, copyNodes);
    item(`Cut ${what}`, "Ctrl+X", count, () => {
      copyNodes();
      deleteSelectedNode();
    });
    item(`Duplicate ${what}`, "Ctrl+D", count, () => pasteNodes(copyNodes()));
    item(
      clip
        ? `Paste ${clip.nodes.length > 1 ? `${clip.nodes.length} nodes` : "node"} here`
        : "Paste here",
      "Ctrl+V",
      !!clip,
      () => pasteNodes(clip, at),
    );
    item(`Delete ${what}`, "Del", count, deleteSelectedNode);
    item("Select all on this tab", "Ctrl+A", flow.nodes.some(onTab), () =>
      selectNodes(
        flow.nodes.filter(onTab).map((m) => m.id),
        selected,
      ),
    );
    menu.append(
      el(
        "div",
        "ai-menu-hint",
        "Ctrl/Shift+click or drag a box to select several · Shift + right-click: browser menu",
      ),
    );
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(event.clientX, innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(event.clientY, innerHeight - r.height - 8) + "px";
    menu.querySelector("button:not(:disabled)")?.focus();
  });
})();
// Saved-flow library. Click a row (or its checkbox) to select it, Shift-click to
// select a range, or press and drag across rows to select/deselect several.
async function openLibrary() {
  const area = el("div");
  const flows = await api("flows");
  if (!flows.length) {
    area.append(el("p", "", "No saved flows yet."));
    return modal("Saved flows", area);
  }
  const picked = new Set();
  let anchor = null,
    painting = null; // true = selecting, false = deselecting while dragging
  const bar = el("div", "library-bar");
  const all = el("input");
  all.type = "checkbox";
  all.setAttribute("aria-label", "Select all flows");
  const count = el("span", "muted");
  const removeMany = el("button", "danger");
  bar.append(all, count, removeMany);
  const list = el("div", "library-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  const rows = flows.map((f, i) => {
    const row = el("div", "saved-row selectable");
    row.setAttribute("role", "option");
    const box = el("input");
    box.type = "checkbox";
    box.tabIndex = -1;
    box.setAttribute("aria-hidden", "true");
    const name = el("strong", "", f.name);
    if (f.id === flow.id) name.append(el("span", "tag", "OPEN"));
    // With accounts: whose flow it is, and whether it is a shared example.
    const me = typeof currentUser === "function" ? currentUser() : null;
    if (f.shared) name.append(el("span", "tag shared", "SHARED EXAMPLE"));
    const meta = el(
      "span",
      "muted",
      `${f.owner && !f.mine ? "by " + f.owner + " · " : ""}${f.tests ? f.tests + " tests · " : ""}${new Date(f.updated).toLocaleString()}`,
    );
    const open = el("button", "", "Open");
    open.onclick = attempt(async () => {
      if (await loadFlow(f.id)) $("modal").close();
    });
    const asTab = el("button", "", "Add as tab");
    asTab.title = "Copy this flow into a new tab of the open flow";
    asTab.disabled = f.id === flow.id;
    asTab.onclick = attempt(async () => {
      addFlowAsTab(await api("flows/" + encodeURIComponent(f.id)));
      $("modal").close();
      toast(`“${f.name}” added as a tab. Save to keep it.`);
    });
    const remove = el("button", "", "Delete");
    remove.onclick = () => confirmDeleteFlows([f], openLibrary);
    // Only the owner (or an admin) may delete; others save a copy instead.
    const writable = !me || me.admin || f.mine !== false;
    remove.hidden = !writable;
    if (!writable) remove.title = "A shared example: open it and save to get your own copy";
    const extra = [];
    if (me?.admin) {
      const share = el("button", "", f.shared ? "Unshare" : "Share");
      share.title = f.shared
        ? "Stop showing this flow to all users"
        : "Show this flow to all users as a read-only example (they save their own copy)";
      share.onclick = attempt(async () => {
        await api(`flows/${encodeURIComponent(f.id)}/share`, { shared: !f.shared });
        toast(f.shared ? `“${f.name}” is no longer shared` : `“${f.name}” is shared with all users`);
        openLibrary();
      });
      extra.push(share);
    }
    row.append(box, name, meta, open, asTab, ...extra, remove);
    row.writable = writable;
    row.set = (on) => {
      on ? picked.add(i) : picked.delete(i);
      box.checked = on;
      row.classList.toggle("picked", on);
      row.setAttribute("aria-selected", String(on));
    };
    row.set(false);
    row.onpointerdown = (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault(); // no text selection while dragging
      if (event.shiftKey && anchor !== null) {
        const [from, to] = [anchor, i].sort((x, y) => x - y);
        for (let k = from; k <= to; k++) rows[k].set(true);
      } else {
        painting = !picked.has(i);
        row.set(painting);
        anchor = i;
      }
      update();
    };
    row.onpointerenter = () => {
      if (painting === null) return;
      row.set(painting);
      update();
    };
    list.append(row);
    return row;
  });
  const stopPainting = () => (painting = null);
  document.addEventListener("pointerup", stopPainting);
  $("modal").addEventListener(
    "close",
    () => document.removeEventListener("pointerup", stopPainting),
    { once: true },
  );
  function update() {
    const n = picked.size;
    count.textContent = n
      ? `${n} of ${flows.length} selected`
      : `${flows.length} flow${flows.length === 1 ? "" : "s"} · click or drag to select`;
    all.checked = n === flows.length;
    all.indeterminate = n > 0 && n < flows.length;
    removeMany.textContent = `Delete selected (${n})`;
    removeMany.disabled = !n;
  }
  all.onchange = () => {
    rows.forEach((r) => r.set(all.checked));
    update();
  };
  removeMany.onclick = () => {
    const chosen = [...picked].sort((x, y) => x - y);
    if (chosen.some((k) => !rows[k].writable))
      return toast("Some selected flows are shared examples of other users: you can only delete your own.");
    confirmDeleteFlows(chosen.map((k) => flows[k]), openLibrary);
  };
  // Keyboard: Ctrl/Cmd+A selects all, Delete removes the selection.
  list.tabIndex = 0;
  list.onkeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      rows.forEach((r) => r.set(true));
      update();
    } else if (event.key === "Delete" && picked.size) removeMany.click();
  };
  update();
  area.append(bar, list);
  modal("Saved flows", area);
  list.focus();
}
$("library").onclick = attempt(openLibrary);
// ── Undo: the flow as it was before a Clear or a delete (latest 20) ──
const undoStack = [];
function remember(what) {
  undoStack.push({
    what,
    tab: currentTab,
    chip: currentChip,
    flow: structuredClone({
      nodes: flow.nodes,
      edges: flow.edges,
      tabs: flow.tabs,
      chips: flow.chips,
    }),
  });
  if (undoStack.length > 20) undoStack.shift();
  undoButton();
}
function undoButton() {
  const last = undoStack.at(-1);
  $("undo").disabled = !last;
  $("undo").title = last
    ? `Undo: ${last.what} (Ctrl+Z)`
    : "Nothing to undo yet: Clear and deletes can be undone (Ctrl+Z)";
}
function undo() {
  const last = undoStack.pop();
  if (!last) return toast("Nothing to undo.");
  for (const key of ["nodes", "edges", "tabs", "chips"])
    if (last.flow[key] === undefined) delete flow[key];
    else flow[key] = last.flow[key];
  currentChip = last.chip;
  currentTab = last.tab;
  selected = selectedLink = pending = null;
  alsoSelected = new Set();
  changed();
  render();
  if (!$("nodePanel").hidden) showNode();
  undoButton();
  toast(`Undone: ${last.what}.`);
}
$("undo").onclick = undo;
// Clear: everything on this tab (nodes and their connections), undoable.
$("clearConnections").onclick = () => {
  const here = new Set(flow.nodes.filter(onTab).map((n) => n.id));
  const wires = flow.edges.filter((e) => here.has(e.from) || here.has(e.to));
  if (!here.size && !wires.length) return toast("This tab is already empty.");
  remember(`clear ${tabName(currentTab) || "this tab"}`);
  flow.nodes = flow.nodes.filter((n) => !here.has(n.id));
  flow.edges = flow.edges.filter((e) => !here.has(e.from) && !here.has(e.to));
  selected = selectedLink = pending = null;
  alsoSelected = new Set();
  changed();
  render();
  if (!$("nodePanel").hidden) showNode();
  toast(
    `Cleared ${here.size} node${here.size === 1 ? "" : "s"} and ${wires.length} connection${wires.length === 1 ? "" : "s"}. Undo with Ctrl+Z.`,
  );
};
$("start").onclick = attempt(async () => {
  showConsole("sim"); // the console follows what runs
  const mode = $("runtimeMode").value;
  if (mode === "emulate") {
    setConsolePaused(false);
    return startEmulation(); // emulate.js
  }
  await stopEmulation();
  // Real board: the Device ID set, else the board last uploaded to or on USB.
  const deviceId =
    $("deviceId").value.trim() ||
    (mode === "device" ? boardTarget || chipLast?.id || "" : "");
  const status = await api("runtime/start", {
    flow: chipFlow(),
    broker: broker(),
    mode,
    deviceId,
  });
  setConsolePaused(false);
  resetTestDevices();
  showSimPins(mode === "host" ? status.pins : null, status.lcd);
  toast(
    mode === "host"
      ? "Simulation started. Edits take effect after restarting."
      : `Monitoring the board ${deviceId}. ▶, Push button and Switch now trigger it over MQTT.`,
  );
});
// Runs the flow on this PC. A flow without MQTT nodes needs no broker.
$("simulate").onclick = attempt(async () => {
  showConsole("sim"); // the console follows what runs
  // Radio boxes using MQTT need the broker; ESP-NOW and I2C do not.
  const offline = !flow.nodes.some(
    (n) =>
      n.type.startsWith("mqtt-") && (n.config.protocol || "mqtt") === "mqtt",
  );
  await stopEmulation();
  $("runtimeMode").value = "host";
  webUrlsChanged();
  // Several chips: all of them run at once on the built-in MQTT (no broker, no
  // upload), so Radio out on one chip reaches Radio in on another.
  storeChipSettings();
  const many = (flow.chips?.length || 0) > 1;
  const status = await api(
    "runtime/start",
    many
      ? {
          mode: "host",
          chip: currentChipId(),
          chips: flow.chips.map((c) => ({
            chip: c.id,
            name: c.name,
            deviceId: c.deviceId || "",
            flow: chipFlow(c.id),
          })),
        }
      : {
          flow: chipFlow(),
          broker: offline ? undefined : broker(),
          mode: "host",
          deviceId: $("deviceId").value.trim(),
          offline,
        },
  );
  simChips = status.chips || null;
  setConsolePaused(false);
  resetTestDevices();
  showSimPins(status.pins, status.lcd);
  render(); // a restart may bring new GPIO inputs (PUSH / SWITCH on their boxes)
  toast(
    many
      ? `Simulating ${flow.chips.length} chips on this PC with built-in MQTT (${status.chips.map((c) => `${c.name}: ${c.deviceId}`).join(", ")}). Switch chips to see each one's pins.`
      : offline
      ? "Simulation running on this PC. Edits take effect after restarting."
      : "Simulation running on this PC with MQTT. Edits take effect after restarting.",
  );
});
// The bottom bar's real-board choice and the Device panel's "PC input emulation
// (USB)" say the same thing, so they stay in step (and Upload builds what the bar
// shows): Real board = a normal build, Real board + PC inputs = an emulation build,
// which exists only as a debug build. Simulate on this PC leaves the checkbox as is.
function emulateFollowsMode() {
  const mode = $("runtimeMode").value;
  if (mode === "host") return;
  const want = mode === "emulate";
  if ($("emulate").checked === want) return;
  $("emulate").checked = want;
  if (want && $("buildProfile").value === "release") {
    $("buildProfile").value = "debug";
    $("buildProfile").dispatchEvent(new Event("change"));
    toast("PC inputs need a debug build: Build profile set to Debug.");
  }
  saveSettings();
}
function modeFollowsEmulate() {
  const mode = $("runtimeMode").value;
  const want = $("emulate").checked ? "emulate" : "device";
  if (mode === "host" || mode === want) return;
  $("runtimeMode").value = want;
  $("runtimeMode").dispatchEvent(new Event("change"));
  saveSettings();
}
// Choosing where the flow runs ends a run that no longer matches: GPIO input boxes
// lose their PUSH / SWITCH (or PC input) controls and pin levels and look as normal;
// ▶ Start runs the flow the new way.
async function runModeChanged() {
  const mode = $("runtimeMode").value;
  const simulating = !!simPins; // the PC simulation is running
  const emulating = typeof emuActive !== "undefined" && emuActive;
  if (!(simulating && mode !== "host") && !(emulating && mode !== "emulate"))
    return;
  try {
    if (emulating) await stopEmulation();
    if (simulating) await api("runtime/stop", {});
  } catch (e) {
    toast(e.message);
  }
  showSimPins(null); // at once, without waiting for the "stopped" event
  nodeValues.clear();
  for (const v of document.querySelectorAll(".node-value")) v.textContent = "";
  render();
  toast(
    `${simulating ? "PC simulation" : "PC inputs"} stopped: the GPIO boxes are back to normal. Press ▶ Start to run on ${$("runtimeMode").selectedOptions[0].textContent.trim()}.`,
  );
}
// Checks the serial link and the board, then starts PC input emulation (emulate.js).
// Connecting must start inside the click: Web Serial asks for the port only then.
$("realSim").onclick = () =>
  attempt(
    () =>
      showConsole("sim") ||
      realSimulation(serialConnected() ? null : $("serialConnect").onclick()),
  )();
$("stop").onclick = attempt(async () => {
  setConsolePaused(true);
  await stopEmulation();
  await api("runtime/stop", {});
});
$("pauseLog").onclick = () => setConsolePaused(!consolePaused);
$("clearLog").onclick = () => {
  discardPendingSerialLog();
  clearLogs(); // consolesplit.js
};
function warningList(warnings = []) {
  const box = el("div", "board-check");
  for (const w of warnings) box.append(el("div", "check-warning", "! " + w));
  return box;
}
function sizeReport(size = {}) {
  const box = el("div", "size-report");
  for (const [key, text] of [
    ["flash", "Flash"],
    ["ram", "RAM"],
  ]) {
    const s = size[key];
    if (!s) continue;
    const pct = Math.round((s.used / s.max) * 100);
    const bar = el(
      "div",
      "meter" + (pct >= 90 ? " hot" : pct >= 75 ? " warm" : ""),
    );
    bar.style.setProperty("--pct", pct + "%");
    box.append(
      el("span", "", text),
      bar,
      el(
        "span",
        "",
        `${(s.used / 1024).toFixed(1)} / ${(s.max / 1024).toFixed(0)} KB · ${pct}%`,
      ),
    );
  }
  return box;
}
$("source").onclick = attempt(async () => {
  const { source, build, warnings } = await api("firmware", {
    flow: chipFlow(),
    settings: settings(),
  });
  const area = el("div"),
    button = el("button", "", "Download .ino"),
    pre = el("pre", "", source);
  button.onclick = () => download("microflow.ino", source, "text/plain");
  area.append(
    el(
      "p",
      "muted",
      `Build ${build}. Telemetry reports this ID so you can spot boards running stale firmware.`,
    ),
    warningList(warnings),
    button,
    pre,
  );
  modal("Generated Arduino firmware", area);
});
// ── Progress bar for compiling and uploading (server: lib/progress.js) ──
const fmtTime = (s) =>
  s >= 60
    ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`
    : `${s} s`;
let buildBarHide = null;
function buildBar(p) {
  let bar = $("buildBar");
  if (!bar) {
    bar = el("div", "build-bar");
    bar.id = "buildBar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const text = el("div", "build-bar-text");
    text.append(el("b"), el("span"));
    const track = el("div", "build-bar-track");
    track.append(el("div", "build-bar-fill"));
    bar.append(text, track);
    document.body.append(bar);
  }
  clearTimeout(buildBarHide);
  bar.hidden = false;
  bar.classList.toggle("failed", !!(p.done && !p.ok));
  bar.classList.toggle("finished", !!(p.done && p.ok));
  bar.setAttribute("aria-valuenow", String(p.pct));
  bar.querySelector(".build-bar-fill").style.width = p.pct + "%";
  bar.querySelector("b").textContent =
    `${p.action === "upload" ? "Upload" : "Compile"} · ${p.label}`;
  bar.querySelector("span").textContent = p.done
    ? `${p.ok ? "100 %" : p.pct + " %"} · ${fmtTime(p.elapsed)}`
    : `${p.pct} % · ${fmtTime(p.elapsed)}${p.left != null ? ` · about ${fmtTime(p.left)} left` : " · estimating…"}`;
  if (!p.done) {
    $("compile").textContent =
      p.action === "compile"
        ? `Compiling ${p.pct} %`
        : $("compile").textContent;
  } else
    buildBarHide = setTimeout(() => (bar.hidden = true), p.ok ? 4000 : 12000);
}
$("compile").onclick = attempt(async () => {
  showConsole("upload");
  $("compile").disabled = true;
  $("compile").textContent = "Compiling…";
  try {
    const r = await api("compile", {
      flow: chipFlow(),
      settings: settings(),
      download: true,
    });
    const area = el("div");
    area.append(
      el(
        "p",
        "",
        `Build ${r.build} compiled for ${$("board").selectedOptions[0].text}.`,
      ),
      sizeReport(r.size),
      warningList(r.warnings),
    );
    // The image to flash yourself (guest.js saveFirmware), e.g. with a web flasher.
    if (r.firmware) {
      const get = el("button", "primary", `⬇ Download firmware (${r.firmware.name})`);
      get.onclick = () => saveFirmware(r.firmware);
      area.append(
        get,
        el(
          "p",
          "muted",
          r.firmware.format === "uf2"
            ? "Raspberry Pi Pico: hold BOOTSEL while plugging in the USB cable (a drive named RPI-RP2 or RP2350 opens), then copy this .uf2 file onto that drive. Or use Upload → USB on this computer."
            : "Flash it at address 0x0 with Espressif's web flasher (espressif.github.io/esptool-js, Chrome or Edge) or esptool, or use Upload → USB on this computer.",
        ),
      );
    }
    modal("Compile report", area);
  } finally {
    $("compile").disabled = false;
    $("compile").textContent = "✓ Compile";
  }
});
// USB-to-UART bridge chips by USB vendor ID: the port for uploads and serial on
// boards with two USB sockets (the other is the chip's own USB, VID 0x303A).
const UART_BRIDGES = {
  0x1a86: "CH34x",
  0x10c4: "CP210x",
  0x0403: "FTDI",
  0x067b: "PL2303",
};
// Names a port and says what it is for (Windows lists Espressif's own USB generically).
function portLabel(port) {
  const name = port.manufacturer || "Serial device";
  const vid = parseInt(port.vendorId, 16);
  if (UART_BRIDGES[vid])
    return `${name} · UART port (${UART_BRIDGES[vid]} bridge): upload, serial monitor, Web Serial`;
  if (vid !== 0x303a) return name;
  const pid = parseInt(port.productId, 16);
  if (pid === 0x1001)
    return usbSerialBoard()
      ? "ESP native USB port (USB-Serial-JTAG): upload, serial monitor, Web Serial"
      : "ESP native USB port (USB-Serial-JTAG): JTAG / USB; Microflow's serial output is on the UART port";
  return "ESP native USB port (USB OTG, program running)";
}
// Web Serial on a board with two USB sockets: the chip's own USB shows no serial output.
function webSerialPortCheck() {
  const info = browserSerial.port?.getInfo?.() || {};
  const two = boards.find((b) => b.id === $("board").value)?.look?.ports;
  if (two && info.usbVendorId === 0x303a)
    toast(
      "This is the board's native USB socket (USB OTG / JTAG). Microflow's serial output is on the UART socket: plug the cable into the socket marked UART and connect again.",
    );
  else if (two && UART_BRIDGES[info.usbVendorId])
    toast(
      `Connected through the UART socket (${UART_BRIDGES[info.usbVendorId]} bridge).`,
    );
}
$("scan").onclick = attempt(async () => {
  // This lists the server's ports: a guest has none, and Web Serial picks its port
  // in the browser's own list when connecting.
  if (await isGuest())
    throw Error(
      "You are a guest, so this list (the server's COM ports) stays empty. Log in (round badge, bottom left) to use this PC's ports, or choose Serial transport → Web Serial and click Connect serial to pick your port.",
    );
  if ($("serialTransport").value === "browser")
    return toast("Web Serial: click Connect serial, then pick the port (e.g. COM4) in the browser's list.");
  const ports = await api("serial/ports");
  if (!ports.length) {
    toast("No serial ports found. Check the USB data cable and driver.");
    return;
  }
  const area = el("div");
  const two = boards.find((b) => b.id === $("board").value)?.look?.ports;
  if (two)
    area.append(
      el(
        "p",
        "muted",
        "This board has two USB sockets: plug in the one marked UART and choose its port (a CH34x or CP210x bridge) for uploads, the serial monitor and Web Serial. The other socket is the chip's own USB (OTG / JTAG).",
      ),
    );
  for (const port of ports) {
    const row = el("div", "saved-row");
    row.append(el("strong", "", `${port.path} · ${portLabel(port)}`));
    const choose = el("button", "", "Use port");
    choose.onclick = () => {
      $("serialPort").value = port.path;
      $("modal").close();
    };
    row.append(choose);
    area.append(row);
  }
  modal("Choose a serial port", area);
});
let localSerialPath = null; // the server's open port (Local serial), e.g. COM4
let localSerialConnected = false,
  serialBusy = false;
const webSerialSupported = window.isSecureContext && !!navigator.serial;
const browserSerial = new BrowserSerialMonitor(
  webSerialSupported ? navigator.serial : null,
  (text) =>
    log({
      kind: "serial",
      message: "Web Serial ←",
      payload: text,
      time: new Date().toISOString(),
    }),
  (connected, message) => {
    if ($("serialTransport").value === "browser")
      updateSerialUI(connected, message);
    log({ kind: "serial", message, time: new Date().toISOString() });
  },
);
// Top bar: the serial connection and the chip it reaches, e.g. "Chip 1 · connected ·
// COM4". The chip is the one whose Device panel has that port, else the chip on screen.
// Web Serial does not tell the COM number, so it shows the USB bridge instead.
function serialBadge() {
  const badge = $("serialBadge");
  if (!badge) return;
  const web = $("serialTransport").value === "browser";
  const on = serialConnected();
  let where = "";
  if (on && web) {
    const info = browserSerial.port?.getInfo?.() || {};
    const bridge = UART_BRIDGES[info.usbVendorId] || (info.usbVendorId === 0x303a ? "native USB" : "");
    where = `Web Serial${bridge ? ` (${bridge})` : ""}`;
  } else if (on) where = localSerialPath || $("serialPort").value.trim() || "serial";
  const chips = chipsOf();
  const chip =
    (on && !web && chips.find((c) => c.serialPort && c.serialPort === where)) ||
    chips.find((c) => c.id === currentChipId()) ||
    chips[0];
  badge.classList.toggle("on", on);
  badge.querySelector(".serial-badge-text").textContent = on
    ? `${chip.name} connected ${where}`
    : `${chip.name} not connected`;
  badge.title = on
    ? `${$("serialStatus").textContent}. Click to open the Device panel.`
    : "No serial connection. Click to open the Device panel, then Connect serial.";
}
$("serialBadge").onclick = () => $("deviceTab").click();
setTimeout(serialBadge);
function updateSerialUI(connected, message) {
  setTimeout(serialBadge);
  setTimeout(chipMonitor); // panels.js; show/hide the chip status card
  setTimeout(termInfo);
  if (typeof serialMonSync === "function") setTimeout(serialMonSync); // serialmon.js
  $("serialStatus").textContent = message;
  $("serialConnect").textContent = connected
    ? "Disconnect serial"
    : "Connect serial";
  $("serialConnect").disabled = serialBusy;
  $("serialSend").disabled = !connected || serialBusy;
  $("serialTransport").disabled = connected || serialBusy;
  $("baudRate").disabled = serialBusy; // can change while connected
  $("baudAuto").disabled = !connected || serialBusy;
  baudControls();
  $("serialPort").disabled = connected || serialBusy;
  $("scan").disabled = connected || serialBusy;
}
// Boards whose USB port is the chip's own USB serial: the baud
// rate is ignored there, so the baud controls are switched off.
const USB_BAUD_NOTE =
  "Not used on this board: its USB port is the chip's built-in USB serial, so any baud rate works.";
const BAUD_AUTO_TITLE =
  "Try common baud rates and keep the one that gives readable text";
function usbSerialBoard() {
  return !!boards.find((b) => b.id === $("board").value)?.usbSerial;
}
function baudControls() {
  const usb = usbSerialBoard();
  if (usb && $("baudRate").value !== "115200") {
    $("baudRate").value = "115200"; // the firmware's rate; keeps the status hints quiet
    saveSettings();
  }
  $("baudRate").disabled = usb || serialBusy;
  $("baudAuto").disabled = usb || serialBusy || !serialConnected();
  $("baudRate").title = usb ? USB_BAUD_NOTE : "";
  $("baudAuto").title = usb ? USB_BAUD_NOTE : BAUD_AUTO_TITLE;
}
function serialConnected() {
  return $("serialTransport").value === "browser"
    ? !!browserSerial.port
    : localSerialConnected;
}
$("serialTransport").onchange = () => {
  updateSerialUI(
    serialConnected(),
    $("serialTransport").value === "browser"
      ? webSerialSupported
        ? "Choose a browser port when you connect."
        : "Web Serial is unavailable here. Choose Local serial, or open this app in Chrome/Edge."
      : "Local serial works without Arduino CLI.",
  );
};
$("serialConnect").onclick = attempt(async () => {
  if (serialBusy) return;
  const connecting = !serialConnected();
  serialBusy = true;
  updateSerialUI(
    !connecting,
    connecting ? "Connecting serial…" : "Disconnecting serial…",
  );
  try {
    if ($("serialTransport").value === "browser") {
      if (connecting) {
        await browserSerial.connect(Number($("baudRate").value));
        webSerialPortCheck();
      } else await browserSerial.disconnect();
    } else {
      if (connecting && !$("serialPort").value.trim())
        throw Error(
          "Choose a serial port using ↻, or enter COM4 in the port field.",
        );
      const status = await api(
        connecting ? "serial/connect" : "serial/disconnect",
        connecting
          ? {
              path: $("serialPort").value.trim(),
              baudRate: Number($("baudRate").value),
            }
          : {},
      );
      localSerialConnected = status.connected;
    localSerialPath = status.path || null;
      localSerialPath = status.path || null;
      updateSerialUI(
        status.connected,
        status.connected
          ? `Serial connected: ${status.path} · ${status.baudRate} baud`
          : "Serial disconnected",
      );
    }
  } catch (error) {
    const message =
      error.name === "NotFoundError"
        ? "Port selection cancelled. Click Connect serial to try again."
        : error.message;
    updateSerialUI(serialConnected(), message);
    throw Error(message);
  } finally {
    serialBusy = false;
    updateSerialUI(serialConnected(), $("serialStatus").textContent);
  }
});
$("serialSendForm").onsubmit = (event) => {
  event.preventDefault();
  attempt(async () => {
    const text = $("serialMessage").value + "\n";
    if ($("serialTransport").value === "browser")
      await browserSerial.send(text);
    else await api("serial/send", { text });
    log({
      kind: "serial",
      message: "Serial →",
      payload: text,
      time: new Date().toISOString(),
    });
    $("serialMessage").value = "";
  })();
};
if (!webSerialSupported)
  $("serialStatus").textContent =
    "Web Serial is unavailable here. Local serial is ready.";
// Guests cannot use this server's ports (lib/auth.js): their board is on their own
// computer, which only Web Serial reaches.
isGuest().then((guest) => {
  if (!guest) return;
  const local = $("serialTransport").querySelector('option[value="local"]');
  local.disabled = true;
  local.textContent = "Local serial (log in)";
  $("serialTransport").value = "browser";
  $("serialTransport").onchange();
  if (!webSerialSupported)
    $("serialStatus").textContent =
      "Open this page in Chrome or Edge (on a computer, over https) to reach your board with Web Serial.";
});
api("serial/status")
  .then((status) => {
    localSerialConnected = status.connected;
    if (status.connected) {
      $("serialPort").value = status.path;
      $("baudRate").value = String(status.baudRate);
      updateSerialUI(
        true,
        `Serial connected: ${status.path} · ${status.baudRate} baud`,
      );
    }
  })
  .catch((error) => {
    $("serialStatus").textContent = error.message;
  });
// Exported flows leave passwords out (Advanced settings such as a broker password):
// the file is meant for sharing. Saved flows on this PC keep them.
$("export").onclick = () => {
  const copy = structuredClone(flow);
  let removed = 0;
  for (const n of copy.nodes)
    for (const f of catalog[n.type]?.fields || [])
      if (f.type === "secret" && n.config[f.key]) {
        n.config[f.key] = "";
        removed++;
      }
  download("microflow.json", JSON.stringify(copy, null, 2), "application/json");
  if (removed)
    toast(
      `Exported without ${removed} password${removed > 1 ? "s" : ""}: enter ${removed > 1 ? "them" : "it"} again after importing.`,
    );
};
$("import").onclick = () => $("fileInput").click();
$("fileInput").onchange = attempt(async () => {
  const file = $("fileInput").files[0];
  if (!file) return;
  const imported = JSON.parse(await file.text());
  const normalized = await api("validate", imported);
  if (dirty && !confirm("Replace current flow and discard unsaved changes?"))
    return;
  delete normalized.id;
  flow = normalized;
  currentTab = null;
  showFlowInUrl();
  $("flowName").value = flow.name || "Imported flow";
  selected = null;
  selectedLink = null;
  pending = null;
  changed();
  await openedFlow();
  if (boardNote) toast(boardNote);
  $("fileInput").value = "";
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("resize", wires);
async function init() {
  const meta = await api("catalog");
  catalog = meta.nodes;
  boards = meta.boards;
  // The language new flows start with (the starting flow too, until it is saved).
  const saved = await api("settings").catch(() => ({}));
  if (saved.language === "nodered" || saved.language === "arduino")
    appSettings.language = saved.language;
  if (!flow.id && !flow.language) flow.language = appSettings.language;
  reservedNames = new Set(meta.reserved || []);
  $("board").replaceChildren(
    ...boards.map((b) => {
      const o = el("option", "", b.label);
      o.value = b.id;
      return o;
    }),
  );
  restoreSettings();
  currentBoard = $("board").value;
  $("runtimeMode").addEventListener("change", webUrlsChanged);
  $("runtimeMode").addEventListener("change", runModeChanged);
  $("runtimeMode").addEventListener("change", emulateFollowsMode);
  $("emulate").addEventListener("change", modeFollowsEmulate);
  // A release build has no PC inputs: the bar goes back to Real board.
  $("buildProfile").addEventListener("change", () => {
    if ($("buildProfile").value === "release" && $("runtimeMode").value === "emulate") {
      $("runtimeMode").value = "device";
      $("runtimeMode").dispatchEvent(new Event("change"));
    }
  });
  emulateFollowsMode(); // settings saved before they were linked may disagree
  checkServerCode();
  $("deviceId").addEventListener("change", webUrlsChanged);
  refreshDeviceIps();
  await restoreWifi();
  buildPalette();
  showBoard();
  const params = new URLSearchParams(location.search);
  if (params.has("flow")) {
    dirty = false; // nothing edited yet: the starter flow is not worth a prompt
    try {
      await loadFlow(params.get("flow"));
    } catch (e) {
      toast(`Flow not found, showing a new flow: ${e.message}`);
      resetDeletedFlow();
    }
  } else if (params.has("new")) resetDeletedFlow();
  render();
  const status = await api(
    "runtime/status?chip=" + encodeURIComponent(currentChipId()),
  );
  simChips = (status.running && status.chips) || null;
  if (status.running && status.mode === "host")
    showSimPins(status.pins, status.lcd);
  updateTestsButton();
}
init().catch((e) => toast(e.message));
