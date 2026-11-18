// ── Status display (Status node, lib/statusfw.js) ─────────────────────
// The Status box draws its I2C display as the board writes it: one line per node
// of its chip with "Show on the Status display" ticked in Properties, e.g.
// "GPIO 13 HIGH". A line changes when its node handles a value (the simulator's
// traces, or the real board's over USB while emulating) and stays until then; with
// more nodes than lines the box pages through them, as the board does.
const statusLines = new Map(); // node id → its latest status line
let statusPage = 0,
  statusTimer = null;

// The line for a value: the same text as lib/statusfw.js text().
function statusHead(n, port) {
  const c = catalog[n.type] || {};
  const head = c.statusPin ? `GPIO ${n.config.pin}` : n.name || n.label;
  return port === undefined ? head : `${head} out${port + 1}`;
}
function statusText(n, value, port) {
  const v = String(value);
  const off = v === "0" || v === "false";
  const head = statusHead(n, port);
  const kind = catalog[n.type]?.statusKind;
  if (kind === "level") return `${head} ${off ? "LOW" : "HIGH"}`;
  if (kind === "onoff") return `${head} ${off ? "OFF" : "ON"}`;
  if (kind === "pwm") return `${head} PWM ${v}`;
  return `${head} ${v}`;
}
// The Status node of a chip, and the nodes it shows (in flow order, as the board).
const statusScreenOf = (chip) =>
  flow.nodes.find((n) => n.type === "status" && chipOfNode(n) === chip);
const statusShown = (screen) =>
  flow.nodes.filter(
    (n) =>
      n.status &&
      catalog[n.type]?.statusOk &&
      chipOfNode(n) === chipOfNode(screen),
  );
// Lines and characters per line of the chosen display (lib/devices.js displayGrid()).
function statusGrid(c) {
  if (!String(c.screen).startsWith("oled"))
    return c.screen === "lcd2004" ? [4, 20] : [2, 16];
  const size = Number(c.textSize) || 1;
  const h = c.screen === "oled32" ? 32 : 64;
  return [Math.floor(h / (8 * size)), Math.floor(128 / (6 * size))];
}
// The lines on screen now (the page that is showing), padded to the display's width.
function statusPageLines(screen) {
  const [rows, cols] = statusGrid(screen.config);
  const shown = statusShown(screen);
  const all = shown.length
    ? shown.map((n) => statusLines.get(n.id) ?? `${statusHead(n)} -`)
    : ["No status"];
  const pages = Math.ceil(all.length / rows);
  const page = statusPage % pages;
  return {
    lines: Array.from({ length: rows }, (_, r) =>
      (all[page * rows + r] ?? "").slice(0, cols).padEnd(cols),
    ),
    page,
    pages,
  };
}
function statusView(n) {
  const c = n.config;
  const box = el(
    "div",
    "status-view " + (String(c.screen).startsWith("oled") ? "oled" : "lcd"),
  );
  box.dataset.node = n.id;
  box.setAttribute("role", "img");
  paintStatus(box, n);
  return box;
}
function paintStatus(box, n) {
  const { lines, page, pages } = statusPageLines(n);
  box.setAttribute("aria-label", `${n.label} display: ${lines.join(" / ")}`);
  box.replaceChildren(
    ...lines.map((t) => el("div", "status-line", t)),
    ...(pages > 1
      ? [el("div", "status-page", `page ${page + 1} / ${pages}`)]
      : []),
  );
}
function paintStatusViews() {
  for (const box of document.querySelectorAll(".status-view")) {
    const n = flow.nodes.find((m) => m.id === box.dataset.node);
    if (n) paintStatus(box, n);
  }
}
// Pages turn at the Status node's interval (the first Status node's, when several
// chips each have one; they all turn together on screen).
function statusPaging() {
  const screen = flow.nodes.find((n) => n.type === "status");
  const ms = screen ? Math.max(500, Number(screen.config.page) || 3000) : 0;
  if (statusTimer?.ms === ms) return;
  clearInterval(statusTimer?.id);
  statusTimer = ms
    ? {
        ms,
        id: setInterval(() => {
          statusPage++;
          paintStatusViews();
        }, ms),
      }
    : null;
}
// Simulator and emulation events (called by log() in app.js).
function statusEvent(event) {
  if (event.kind === "trace" && event.payload !== undefined) {
    const [id, inner] = String(event.message).split("__");
    if (inner) return; // nodes inside a custom box are not shown
    const n = flow.nodes.find((m) => m.id === id);
    if (!n?.status || !catalog[n.type]?.statusOk) return;
    const line = statusText(n, event.payload, event.port);
    if (statusLines.get(id) === line) return;
    statusLines.set(id, line);
    paintStatusViews();
  } else if (
    event.kind === "status" &&
    (event.message === "Runtime stopped" || event.message === "Restarting")
  ) {
    statusLines.clear();
    statusPage = 0;
    paintStatusViews();
  }
}
// Properties of a node: "Show on the Status display".
function statusOption(n) {
  const label = el("label", "status-option");
  const box = el("input");
  box.type = "checkbox";
  box.checked = !!n.status;
  const screen = statusScreenOf(chipOfNode(n));
  const shown = screen ? statusShown(screen) : [];
  const k = shown.indexOf(n);
  const rows = screen ? statusGrid(screen.config)[0] : 0;
  const note = el(
    "span",
    "muted",
    !screen
      ? " · add a Status node to see it"
      : k >= 0
        ? ` · line ${(k % rows) + 1}${shown.length > rows ? `, page ${Math.floor(k / rows) + 1}` : ""}`
        : "",
  );
  box.onchange = () => {
    if (box.checked) n.status = true;
    else delete n.status;
    statusLines.delete(n.id);
    changed();
    render();
    showNode();
  };
  label.append(box, " Show on the Status display", note);
  label.title = `This node's status (e.g. "${statusText(n, 1)}") gets a line on the Status display, and changes when the node handles a new value.`;
  return label;
}
