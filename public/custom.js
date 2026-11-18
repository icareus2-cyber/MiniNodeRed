// ── Custom nodes: combine nodes into one box, kept in a library ─────────
// Select two or more nodes → "◈ Save as custom node" (Properties) → name it. The
// library (stored with the app's settings, so every flow can use it) is the
// CUSTOM group of the node library on the left: click an entry to add it. A box
// carries a copy of its nodes (config.def), so a flow works on another PC too.
// The server expands boxes before analysis, firmware and simulation
// (lib/custom.js). Properties of a box: the pins of the hardware nodes inside it,
// Unpack (back to its nodes, to edit them) and Update the library copy.
let customLib = [];
async function loadCustomLib() {
  try {
    const s = await api("settings");
    customLib = JSON.parse(s.customNodes || "[]");
    if (!Array.isArray(customLib)) customLib = [];
  } catch {
    customLib = [];
  }
  buildPalette();
  updatePalette();
}
async function saveCustomLib() {
  await api("settings", { customNodes: JSON.stringify(customLib) }, "PUT");
  buildPalette();
  updatePalette();
}
// Node fields that name another node (Logic / Timer / Peripheral inputs).
const refFields = (m) =>
  (catalog[m.type]?.fields || []).filter((f) => f.inputChoice);
// The definition of a group of nodes: copies, the wires between them, and which
// of them take the box's input and give its output.
function customDef(group) {
  const ids = new Set(group.map((m) => m.id));
  const inside = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const into = flow.edges.filter((e) => !ids.has(e.from) && ids.has(e.to));
  const outOf = flow.edges.filter((e) => ids.has(e.from) && !ids.has(e.to));
  const hasIn = (m) => inside.some((e) => e.to === m.id);
  const hasOut = (m) => inside.some((e) => e.from === m.id);
  const pick = (list, fallback) =>
    list.length ? [...new Set(list)] : fallback.map((m) => m.id);
  const inputs = pick(
    into.map((e) => e.to),
    group.filter((m) => !hasIn(m) && !catalog[m.type]?.source),
  );
  const outputs = pick(
    outOf.map((e) => e.from),
    group.filter((m) => !hasOut(m) && !catalog[m.type]?.sink),
  );
  const x0 = Math.min(...group.map((m) => m.x)),
    y0 = Math.min(...group.map((m) => m.y));
  const names = new Set(group.map((m) => m.name));
  const nodes = group.map((m) => {
    const copy = structuredClone({
      id: m.id,
      type: m.type,
      label: m.label,
      name: m.name,
      config: m.config,
      ...(m.itype ? { itype: m.itype } : {}),
      ...(m.vtype ? { vtype: m.vtype } : {}),
      ...(m.msg ? { msg: m.msg } : {}),
      x: m.x - x0,
      y: m.y - y0,
    });
    // A reference to a node outside the group would point nowhere: back to default.
    for (const f of refFields(copy))
      if (copy.config[f.key] && !names.has(copy.config[f.key]))
        copy.config[f.key] = "";
    return copy;
  });
  return {
    nodes,
    edges: inside.map((e) => ({ from: e.from, to: e.to, ...(e.port ? { port: e.port } : {}) })),
    inputs,
    outputs,
  };
}
// A C++-style variable name from the custom node's name: "Temp alarm" → TEMP_ALARM1.
function customVarName(name) {
  const base =
    String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^[^A-Z]+|_+$/g, "")
      .slice(0, 24) || "CUSTOM";
  const taken = new Set(flow.nodes.map((m) => m.name));
  for (let k = 1; ; k++) if (!taken.has(base + k)) return base + k;
}
function newCustomNode(entry, at = freeSpot()) {
  return {
    id: newNodeId(),
    ...(flow.tabs ? { tab: currentTab } : {}),
    type: "custom",
    label: entry.name,
    x: at.x,
    y: at.y,
    name: customVarName(entry.name),
    config: { def: structuredClone(entry.def), pins: {}, lib: entry.id },
  };
}
function saveCustomDialog(group) {
  group = group.filter((m) => m.type);
  if (group.length < 2) return toast("Select two or more nodes first.");
  const def = customDef(group);
  const area = el("div", "custom-dialog");
  const name = Object.assign(el("input"), {
    placeholder: "e.g. Temperature alarm",
    maxLength: 40,
  });
  const help = Object.assign(el("input"), {
    placeholder: "What it does (shown as its help)",
    maxLength: 200,
  });
  const replace = Object.assign(el("input"), { type: "checkbox", checked: true });
  const label = (text, input) => {
    const l = el("label", "", text);
    l.append(input);
    return l;
  };
  const replaceRow = el("label", "check-row");
  replaceRow.append(replace, " Replace the selected nodes by the new custom node");
  const byId = new Map(group.map((m) => [m.id, m]));
  const list = (ids) =>
    ids.map((id) => byId.get(id)?.label || id).join(", ") || "none";
  area.append(
    label("Name", name),
    label("Description", help),
    el("p", "muted", `${group.length} nodes, ${def.edges.length} wires inside.`),
    el("p", "muted", `Input goes to: ${list(def.inputs)}`),
    el("p", "muted", `Output comes from: ${list(def.outputs)}`),
    replaceRow,
  );
  const ok = button(
    "Save to library",
    attempt(async () => {
      const text = name.value.trim();
      if (!text) return toast("Give the custom node a name.");
      const entry = {
        id: "c" + Date.now().toString(36),
        name: text,
        help: help.value.trim(),
        def,
      };
      const same = customLib.findIndex(
        (e) => e.name.toLowerCase() === text.toLowerCase(),
      );
      if (same >= 0) {
        if (!confirm(`Replace the custom node “${customLib[same].name}” in the library?`))
          return;
        entry.id = customLib[same].id;
        customLib[same] = entry;
      } else customLib.push(entry);
      await saveCustomLib();
      if (replace.checked) replaceByCustom(group, entry);
      $("modal").close();
      toast(`“${text}” saved: find it under CUSTOM in the node library.`);
    }),
    "primary",
  );
  area.append(ok);
  modal("Save as custom node", area);
  name.focus();
}
// The group's nodes leave the canvas; one box takes their place and their wires.
function replaceByCustom(group, entry) {
  remember("Custom node");
  const ids = new Set(group.map((m) => m.id));
  const box = newCustomNode(entry, {
    x: Math.min(...group.map((m) => m.x)),
    y: Math.min(...group.map((m) => m.y)),
  });
  if (group[0].tab) box.tab = group[0].tab;
  const edges = [];
  const add = (e) =>
    !edges.some((x) => sameLink(x, e)) && edges.push(e);
  for (const e of flow.edges) {
    const a = ids.has(e.from),
      b = ids.has(e.to);
    if (!a && !b) add(e);
    else if (!a && b) add({ from: e.from, to: box.id, ...(e.port ? { port: e.port } : {}) });
    else if (a && !b) add({ from: box.id, to: e.to });
  }
  flow.nodes = flow.nodes.filter((m) => !ids.has(m.id)).concat(box);
  flow.edges = edges;
  selected = box.id;
  alsoSelected = new Set();
  changed();
  render();
  showNode();
}
// Back to the nodes inside (new ids and names), wired as the box was.
function unpackCustom(box) {
  remember("Unpack custom node");
  const def = box.config.def;
  const map = new Map();
  const taken = new Set(flow.nodes.map((m) => m.name));
  const fresh = def.nodes.map((m) => {
    const copy = structuredClone(m);
    copy.id = newNodeId();
    map.set(m.id, copy.id);
    copy.x = box.x + m.x;
    copy.y = box.y + m.y;
    if (box.tab) copy.tab = box.tab;
    for (const [key, value] of Object.entries(box.config.pins || {})) {
      const [mid, field] = key.split(".");
      if (mid === m.id) copy.config[field] = value;
    }
    return copy;
  });
  // Names already used elsewhere get a free one; references inside follow.
  for (const m of fresh)
    if (m.name && taken.has(m.name)) {
      const before = m.name;
      let k = 2;
      while (taken.has(`${before}_${k}`)) k++;
      renameRefs(fresh, before, `${before}_${k}`);
      m.name = `${before}_${k}`;
    }
  for (const m of fresh) taken.add(m.name);
  const edges = flow.edges.filter((e) => e.from !== box.id && e.to !== box.id);
  for (const e of def.edges)
    edges.push({ from: map.get(e.from), to: map.get(e.to), ...(e.port ? { port: e.port } : {}) });
  for (const e of flow.edges) {
    if (e.to === box.id)
      for (const x of def.inputs)
        edges.push({ from: e.from, to: map.get(x), ...(e.port ? { port: e.port } : {}) });
    if (e.from === box.id)
      for (const x of def.outputs) edges.push({ from: map.get(x), to: e.to });
  }
  flow.nodes = flow.nodes.filter((m) => m.id !== box.id).concat(fresh);
  flow.edges = edges;
  selected = null;
  alsoSelected = new Set(fresh.map((m) => m.id));
  selected = fresh[0]?.id ?? null;
  changed();
  render();
  showNode();
  toast(`Unpacked into ${fresh.length} nodes (Ctrl+Z puts the box back).`);
}
// Properties of a box: what is inside, the pins of its hardware, unpack / update.
function customProps(box) {
  const def = box.config.def;
  const area = el("div", "custom-props");
  area.append(el("b", "", "Inside"));
  const list = el("ul", "custom-inside");
  const byId = new Map(def.nodes.map((m) => [m.id, m]));
  for (const m of def.nodes) {
    const tags = [
      def.inputs.includes(m.id) ? "input" : "",
      def.outputs.includes(m.id) ? "output" : "",
    ].filter(Boolean);
    list.append(
      el(
        "li",
        "",
        `${catalog[m.type]?.icon || ""} ${m.label} (${catalog[m.type]?.label || m.type})${tags.length ? " · " + tags.join(", ") : ""}`,
      ),
    );
  }
  area.append(list);
  // Pins of the hardware nodes inside: set per box (two boxes, two sets of pins).
  const pinRows = def.nodes.flatMap((m) =>
    nodePins(m).map((p) => ({ m, p })),
  );
  if (pinRows.length) {
    area.append(el("b", "", "Pins"));
    box.config.pins ||= {};
    for (const { m, p } of pinRows) {
      const key = `${m.id}.${p.key}`;
      const input = Object.assign(el("input"), {
        type: "number",
        min: 0,
        max: 48,
        step: 1,
        value: box.config.pins[key] ?? p.pin,
      });
      input.onchange = () => {
        const v = Number(input.value);
        if (!Number.isInteger(v) || v < 0 || v > 48)
          return toast("A pin is a GPIO number from 0 to 48.");
        if (v === byId.get(m.id).config[p.key]) delete box.config.pins[key];
        else box.config.pins[key] = v;
        changed();
      };
      const l = el("label", "", `${m.label} · ${p.key === "pin" ? "GPIO pin" : p.key}`);
      l.append(input);
      area.append(l);
    }
  }
  const row = el("div", "step-row");
  row.append(
    button("Unpack", () => unpackCustom(box)),
    button(
      "Update library copy",
      attempt(async () => {
        const entry = customLib.find((e) => e.id === box.config.lib);
        if (!entry) return toast("This custom node is not in your library (it came with the flow). Save it again from its nodes.");
        entry.def = structuredClone(def);
        await saveCustomLib();
        toast(`Library copy of “${entry.name}” updated.`);
      }),
    ),
  );
  area.append(row);
  return area;
}
// The CUSTOM group of the node library (buildPalette() in app.js calls this).
function customPalette() {
  const c = catalog.custom;
  if (!c) return;
  $("palette").append(el("div", "group-label", "CUSTOM"));
  if (!customLib.length)
    $("palette").append(
      el(
        "p",
        "muted custom-hint",
        "Select nodes on the canvas (Ctrl+click or drag a box around them), then Save as custom node in Properties.",
      ),
    );
  for (const entry of customLib) {
    const b = el("button", "palette-node");
    b.dataset.type = "custom";
    b.style.cssText = `--color:${c.color};--tint:${c.tint}`;
    b.title = `${entry.help || "Custom node"}\n\n${entry.def.nodes.length} nodes: ${entry.def.nodes.map((m) => m.label).join(", ")}`;
    const remove = el("span", "custom-remove", "×");
    remove.title = "Remove from the library (boxes already in flows keep working)";
    remove.onclick = attempt(async (event) => {
      event?.stopPropagation?.();
      if (!confirm(`Remove “${entry.name}” from the library?`)) return;
      customLib = customLib.filter((e) => e !== entry);
      await saveCustomLib();
    });
    remove.addEventListener("click", (e) => e.stopPropagation(), true);
    b.append(el("span", "node-icon", c.icon), el("b", "", entry.name), remove);
    b.onclick = (event) => {
      if (event.target.closest(".custom-remove")) return;
      const n = newCustomNode(entry);
      flow.nodes.push(n);
      selected = n.id;
      selectedLink = null;
      changed();
      render();
      showNode();
    };
    $("palette").append(b);
  }
  const count = Object.keys(catalog).length - 1 + customLib.length;
  $("paletteCount").textContent = String(count).padStart(2, "0");
}
loadCustomLib();
