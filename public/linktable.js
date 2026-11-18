// ── Link table: connect Radio out boxes to Radio in boxes across chips ──
// "⇄ Link" (top bar) opens a table: every Radio in of the project on the left
// (inputs: what each chip receives), every Radio out on the right (outputs: what
// each chip sends), with what each one is linked to now. Pick one input and one
// output: the table proposes the protocol and topic that link them (keeping the
// links they already have where it can) and names any link the change would break.
// The topic stays editable, so a conflict is settled by typing the topic you want.
// Apply link writes the settings into both boxes (Ctrl+Z undoes it).
const LINK_PROTOCOL = {
  mqtt: "MQTT",
  local: "Local MQTT",
  espnow: "ESP-NOW",
  i2c: "I2C",
};
const linkSel = { in: null, out: null };
// Topic filter (with + and #) against a topic, as MQTT does.
function linkMatches(filter, topic) {
  if (!filter || !topic) return false;
  const f = filter.split("/"),
    t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (t[i] === undefined || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}
const protocolOf = (n) => n.config.protocol || "mqtt";
const chipNameOf = (n) =>
  chipsOf().find((c) => c.id === chipOfNode(n))?.name || "Chip";
const sameChip = (a, b) => chipOfNode(a) === chipOfNode(b);
// The protocol a Radio in needs to hear this Radio out (MQTT boxes on other chips
// hear a chip's Local MQTT broker; Local MQTT Radio in only hears its own chip).
function protocolFor(out, inn) {
  const p = protocolOf(out);
  if (p === "local") return sameChip(out, inn) ? "local" : "mqtt";
  return p;
}
// Does this Radio in hear this Radio out now?
function hears(inn, out) {
  const pi = protocolOf(inn),
    po = protocolOf(out);
  if (pi === "i2c" || po === "i2c")
    return pi === po && Number(inn.config.address) === Number(out.config.address);
  const ok =
    pi === "local"
      ? po === "local" && sameChip(inn, out)
      : pi === po || (pi === "mqtt" && po === "local" && !sameChip(inn, out));
  return ok && linkMatches(inn.config.topic, out.config.topic);
}
const radioIns = () => flow.nodes.filter((n) => n.type === "mqtt-in");
const radioOuts = () => flow.nodes.filter((n) => n.type === "mqtt-out");
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "value";
const nameOf = (n) => `${chipNameOf(n)} · ${n.label || n.name}`;
// What linking `inn` to `out` takes: protocol, a proposed topic, notes, conflicts.
function linkPlan(inn, out) {
  const plan = { notes: [], conflicts: [] };
  if (hears(inn, out)) plan.already = true;
  const po = protocolOf(out);
  if (po === "i2c" || protocolOf(inn) === "i2c") {
    plan.i2c = true;
    plan.address = Number(out.config.address) || 8;
    plan.protocol = "i2c";
    if (protocolOf(inn) !== "i2c")
      plan.notes.push(`${nameOf(inn)} switches to I2C.`);
    return plan;
  }
  plan.protocol = protocolFor(out, inn);
  if (protocolOf(inn) !== plan.protocol)
    plan.notes.push(
      `${nameOf(inn)} switches from ${LINK_PROTOCOL[protocolOf(inn)]} to ${LINK_PROTOCOL[plan.protocol]}${po === "local" && plan.protocol === "mqtt" ? ` (it connects to ${chipNameOf(out)}'s broker; on real boards set its broker URL to that board's IP)` : ""}.`,
    );
  const ot = out.config.topic || "",
    it = inn.config.topic || "";
  const wild = /[+#]/.test(it);
  const outListeners = radioIns().filter((m) => m !== inn && hears(m, out));
  const inSenders = radioOuts().filter((m) => m !== out && hears(inn, m));
  // Keep the side that has other links; else the output's topic (the sender names it).
  if (plan.already) plan.topic = ot;
  else if (ot && it && wild && linkMatches(it, ot)) plan.topic = ot;
  else if (ot && (inSenders.length === 0 || outListeners.length > 0 || !it || wild))
    plan.topic = ot;
  else if (it && !wild) plan.topic = it;
  else plan.topic = `${slug(chipNameOf(out))}/${slug(out.label || out.name)}`;
  plan.check = (topic) => {
    const list = [];
    if (topic !== ot)
      for (const m of outListeners)
        if (!linkMatches(m.config.topic, topic))
          list.push(
            `${nameOf(m)} hears ${nameOf(out)} now and would stop (it listens to "${m.config.topic}").`,
          );
    const newIn = wild && linkMatches(it, topic) ? it : topic;
    for (const m of inSenders)
      if (!linkMatches(newIn, m.config.topic) || protocolOf(inn) !== plan.protocol)
        list.push(
          `${nameOf(inn)} hears ${nameOf(m)} now ("${m.config.topic}") and would stop.`,
        );
    return list;
  };
  plan.conflicts = plan.check(plan.topic);
  return plan;
}
function applyLink(inn, out, plan, topic) {
  remember("Link");
  if (plan.i2c) {
    inn.config.protocol = out.config.protocol = "i2c";
    inn.config.address = plan.address;
  } else {
    inn.config.protocol = plan.protocol;
    out.config.topic = topic;
    const it = inn.config.topic || "";
    if (!(/[+#]/.test(it) && linkMatches(it, topic))) inn.config.topic = topic;
  }
  changed();
  render();
  toast(`Linked ${nameOf(out)} → ${nameOf(inn)}.`);
}
function linkRow(n, side) {
  const tr = el("tr", "link-row");
  const sel = linkSel[side] === n.id;
  if (sel) tr.classList.add("selected");
  tr.tabIndex = 0;
  tr.setAttribute("aria-selected", String(sel));
  const p = protocolOf(n);
  const where =
    p === "i2c" ? `address ${n.config.address ?? "?"}` : n.config.topic || "(no topic)";
  const peers =
    side === "in"
      ? radioOuts().filter((o) => hears(n, o))
      : radioIns().filter((i) => hears(i, n));
  const status = el(
    "td",
    peers.length ? "link-ok" : "link-none",
    peers.length
      ? (side === "in" ? "← " : "→ ") + peers.map(nameOf).join(", ")
      : side === "in"
        ? "✗ hears nothing"
        : "✗ nobody listens",
  );
  tr.append(
    el("td", "", chipNameOf(n)),
    el("td", "", n.label || n.name),
    el("td", "", LINK_PROTOCOL[p] || p),
    el("td", "mono", where),
    status,
  );
  const pick = () => {
    linkSel[side] = sel ? null : n.id;
    showLinks();
  };
  tr.onclick = pick;
  tr.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick());
  return tr;
}
function linkTable(side, nodes) {
  const table = el("table", "link-table");
  const head = el("tr");
  for (const h of ["Chip", "Box", "Protocol", "Topic", side === "in" ? "Hears" : "Heard by"])
    head.append(el("th", "", h));
  table.append(head);
  for (const n of nodes) table.append(linkRow(n, side));
  if (!nodes.length) {
    const tr = el("tr");
    const td = el(
      "td",
      "muted",
      side === "in"
        ? "No Radio in box yet: add one from the palette (INPUT)."
        : "No Radio out box yet: add one from the palette (OUTPUT).",
    );
    td.colSpan = 5;
    tr.append(td);
    table.append(tr);
  }
  return table;
}
function showLinks() {
  const ins = radioIns(),
    outs = radioOuts();
  if (!ins.some((n) => n.id === linkSel.in)) linkSel.in = null;
  if (!outs.some((n) => n.id === linkSel.out)) linkSel.out = null;
  const area = el("div", "link-page");
  area.append(
    el(
      "p",
      "muted",
      "Pick an input (left) and an output (right): the topic and protocol that link them are proposed below. Edit the topic if there is a conflict, then Apply link.",
    ),
  );
  const cols = el("div", "link-cols");
  const left = el("div", "link-col");
  left.append(el("h4", "", `INPUTS · Radio in (${ins.length})`), linkTable("in", ins));
  const right = el("div", "link-col");
  right.append(el("h4", "", `OUTPUTS · Radio out (${outs.length})`), linkTable("out", outs));
  cols.append(left, right);
  area.append(cols);
  const match = el("div", "link-match");
  const inn = ins.find((n) => n.id === linkSel.in),
    out = outs.find((n) => n.id === linkSel.out);
  if (!inn || !out) {
    match.append(
      el(
        "p",
        "muted",
        inn
          ? "Now pick an output on the right."
          : out
            ? "Now pick an input on the left."
            : "Nothing selected yet.",
      ),
    );
  } else {
    const plan = linkPlan(inn, out);
    match.append(el("b", "", `${nameOf(out)} → ${nameOf(inn)}`));
    if (plan.already)
      match.append(el("p", "link-ok", "✓ Already linked: this input hears this output."));
    const notes = el("ul");
    for (const n of plan.notes) notes.append(el("li", "", n));
    const topicRow = el("label", "link-topic");
    const input = Object.assign(el("input"), {
      value: plan.i2c ? String(plan.address) : plan.topic,
    });
    const conflicts = el("ul", "link-conflicts");
    const showConflicts = () => {
      const list = plan.i2c ? [] : plan.check(input.value.trim());
      conflicts.replaceChildren(...list.map((c) => el("li", "", "⚠ " + c)));
      if (list.length)
        conflicts.prepend(
          el("li", "link-conflict-head", "Conflict: other links change. Type another topic, or apply anyway:"),
        );
    };
    input.oninput = showConflicts;
    topicRow.append(
      plan.i2c ? "I2C address (both boxes)" : `Topic (both boxes, ${LINK_PROTOCOL[plan.protocol]})`,
      input,
    );
    const apply = button(
      plan.already ? "Apply anyway" : "Apply link",
      () => {
        const value = input.value.trim();
        if (plan.i2c) {
          const a = Number(value);
          if (!(a >= 8 && a <= 119)) return toast("I2C address: 8 to 119.");
          plan.address = a;
        } else if (!value || /[+#]/.test(value) || /\s/.test(value))
          return toast("Topic: no spaces, + or # (Radio out sends to one exact topic).");
        applyLink(inn, out, plan, value);
        showLinks();
      },
      "primary",
    );
    match.append(notes, topicRow, conflicts, apply);
    showConflicts();
  }
  area.append(match);
  modal("Link · inputs and outputs", area);
  $("modal").classList.add("wide");
  $("modal").addEventListener("close", () => $("modal").classList.remove("wide"), { once: true });
}
$("linksButton").onclick = showLinks;
