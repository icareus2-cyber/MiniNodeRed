// Custom nodes: a group of nodes saved as one box ("◈" in the palette's CUSTOM
// group). Each box carries its definition, so a flow stays complete on its own:
//
//   config.def  = { nodes: [...], edges: [...], inputs: [inner ids], outputs: [...] }
//   config.pins = { "<inner id>.<pin key>": number }   (pins chosen on this box)
//
// Before anything runs (analysis, firmware, simulator) expand() replaces each box
// by its inner nodes: ids become "<box id>__<inner id>", variable names get a
// suffix (_1, _2 … per box) and the names inner nodes use for each other (Logic /
// Timer inputs, C/C++ code) follow. Wires into the box go to its input nodes;
// wires out of it leave from its output nodes. Boxes may contain boxes.
const MAX_DEPTH = 4;
const SEP = "__";

const word = (name) => new RegExp(`\\b${name}\\b`, "g");
// Inner nodes that refer to others by name: input-choice fields, C/C++ code.
function rename(nodes, before, now, types) {
  for (const m of nodes) {
    for (const f of types[m.type]?.fields || [])
      if (f.inputChoice && m.config?.[f.key] === before) m.config[f.key] = now;
    if (m.type === "arduino")
      for (const key of ["vars", "setup", "message", "loop"])
        if (typeof m.config?.[key] === "string")
          m.config[key] = m.config[key].replace(word(before), now);
  }
}
function checkDef(def) {
  if (
    !def ||
    !Array.isArray(def.nodes) ||
    !Array.isArray(def.edges) ||
    !def.nodes.length
  )
    throw Error("Custom node: its definition is missing or empty.");
  if (def.nodes.length > 32)
    throw Error("Custom node: at most 32 nodes inside.");
  const ids = new Set(def.nodes.map((m) => m.id));
  for (const e of def.edges)
    if (!ids.has(e.from) || !ids.has(e.to))
      throw Error("Custom node: a wire inside it is broken.");
  for (const key of ["inputs", "outputs"])
    if (!Array.isArray(def[key]) || def[key].some((id) => !ids.has(id)))
      throw Error(`Custom node: its ${key} are broken.`);
}
function expandOnce(flow, types) {
  const boxes = flow.nodes.filter((n) => n.type === "custom");
  if (!boxes.length) return false;
  const taken = new Set(
    flow.nodes.filter((n) => n.type !== "custom" && n.name).map((n) => n.name),
  );
  let nodes = flow.nodes.filter((n) => n.type !== "custom");
  let edges = flow.edges.filter(
    (e) => !boxes.some((b) => b.id === e.from || b.id === e.to),
  );
  boxes.forEach((box, k) => {
    const def = box.config?.def;
    checkDef(def);
    const pins = box.config.pins || {};
    const inner = structuredClone(def.nodes);
    const id = (x) => `${box.id}${SEP}${x}`.slice(0, 64);
    // Unique variable names: TIMER1 → TIMER1_1 (box 1), TIMER1_2 (box 2) …
    for (const m of inner) {
      if (!m.name) continue;
      let name = `${m.name}_${k + 1}`.slice(0, 32);
      for (let j = 2; taken.has(name); j++)
        name = `${m.name.slice(0, 27)}_${k + 1}_${j}`;
      taken.add(name);
      rename(inner, m.name, name, types);
      m.name = name;
    }
    for (const m of inner) {
      for (const [key, value] of Object.entries(pins)) {
        const [mid, field] = key.split(".");
        if (mid === m.id && Number.isInteger(value)) m.config[field] = value;
      }
      m.id = id(m.id);
      m.tab = box.tab;
      m.label = `${box.label || "Custom"} · ${m.label || types[m.type]?.label || m.type}`.slice(0, 100);
      m.x = box.x;
      m.y = box.y;
    }
    nodes.push(...inner);
    edges.push(
      ...def.edges.map((e) => ({
        from: id(e.from),
        to: id(e.to),
        ...(e.port ? { port: e.port } : {}),
      })),
    );
    for (const e of flow.edges) {
      if (e.to === box.id)
        for (const x of def.inputs)
          edges.push({ from: e.from, to: id(x), ...(e.port ? { port: e.port } : {}) });
      if (e.from === box.id)
        for (const x of def.outputs) edges.push({ from: id(x), to: e.to });
    }
  });
  // A wire between two boxes went in from both sides, still naming the other box:
  // replace that end by the box's inner input / output nodes (duplicates go below).
  const byId = new Map(boxes.map((b) => [b.id, b]));
  edges = edges.flatMap((e) => {
    const fromBox = byId.get(e.from),
      toBox = byId.get(e.to);
    if (!fromBox && !toBox) return [e];
    const froms = fromBox
      ? fromBox.config.def.outputs.map((x) => `${fromBox.id}${SEP}${x}`)
      : [e.from];
    const tos = toBox
      ? toBox.config.def.inputs.map((x) => `${toBox.id}${SEP}${x}`)
      : [e.to];
    return froms.flatMap((f) =>
      tos.map((t) => ({ from: f, to: t, ...(!fromBox && e.port ? { port: e.port } : {}) })),
    );
  });
  const seen = new Set();
  flow.edges = edges.filter((e) => {
    const key = e.from + ">" + e.to + ">" + (e.port || 0);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  flow.nodes = nodes;
  return true;
}
// A copy of the flow with every Custom box replaced by its nodes (the flow given
// is not changed). Flows without Custom boxes come back as they are.
function expand(flow, types) {
  if (!flow?.nodes?.some?.((n) => n?.type === "custom")) return flow;
  const out = structuredClone(flow);
  for (let depth = 0; expandOnce(out, types); depth++)
    if (depth >= MAX_DEPTH)
      throw Error(`Custom nodes nest more than ${MAX_DEPTH} levels deep.`);
  return out;
}
// Where a node of an expanded flow came from: the outermost box id, else itself.
const outerId = (id) => String(id).split(SEP)[0];
module.exports = { expand, checkDef, outerId, SEP };
