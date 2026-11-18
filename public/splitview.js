// ── Split screen: two identical flow screens, upper and lower ────────
// Each screen has its own chip and flow tab, with the full chip bar, flow tabs,
// Undo / Clear and canvas. Both can be edited: the screen under the mouse is the
// live editor (add from the palette, drag, connect, rename, delete, copy/paste,
// Properties). The other screen shows an exact picture of its chip's flow that
// keeps updating while simulating (flashes, values, LEDs), and becomes the editor
// as soon as the mouse enters it. The editor screen has a green edge; palette
// clicks and keyboard shortcuts go to it.
// ⬒ Split / ▭ Single (bottom bar) switches; drag the bar between them to resize.
const split = {
  on: false,
  ratio: 0.55, // share of the upper screen
  active: "A", // the screen holding the editor: "A" upper, "B" lower
  chip: null, // the other screen's chip and tab
  tab: null,
  pins: {}, // that chip's simulated pin levels
};
try {
  split.on = localStorage.getItem("microflow.split") === "on";
  const r = Number(localStorage.getItem("microflow.splitRatio"));
  if (r >= 0.15 && r <= 0.85) split.ratio = r;
} catch {}
function saveSplit() {
  try {
    localStorage.setItem("microflow.split", split.on ? "on" : "off");
    localStorage.setItem("microflow.splitRatio", String(split.ratio));
  } catch {}
}
const slotEl = (slot) => $(slot === "A" ? "slotA" : "slotB");
function layoutSplit() {
  $("slotB").hidden = $("splitGrip").hidden = !split.on;
  $("slotA").style.flex = split.on ? `${split.ratio} 1 0` : "";
  $("slotB").style.flex = split.on ? `${1 - split.ratio} 1 0` : "";
  $("slotA").classList.toggle("active", split.on && split.active === "A");
  $("slotB").classList.toggle("active", split.on && split.active === "B");
  $("panes").classList.toggle("split", split.on);
  $("splitToggle").textContent = split.on ? "▭ Single" : "⬒ Split";
  $("splitToggle").setAttribute("aria-pressed", String(split.on));
  $("splitToggle").title = split.on
    ? "Show one flow screen"
    : "Show two flow screens (upper and lower), both editable, to work on two chips";
}
// The other screen's chip and tab: kept while valid, else the next chip (or the
// next tab of the only chip), never the same tab as the editor.
function pickPane() {
  const chips = chipsOf().map((c) => c.id);
  const tabsOfChip = (id) => allTabs().filter((t) => chipOfTab(t) === id);
  const valid =
    chips.includes(split.chip) &&
    tabsOfChip(split.chip).some((t) => t.id === split.tab) &&
    !(split.chip === currentChipId() && split.tab === currentTab);
  if (valid) return;
  const other = chips.find((id) => id !== currentChipId());
  if (other) {
    split.chip = other;
    split.tab = tabsOfChip(other)[0]?.id ?? null;
  } else {
    split.chip = currentChipId();
    const tabs = tabsOfChip(split.chip);
    split.tab = (tabs.find((t) => t.id !== currentTab) || tabs[0])?.id ?? null;
  }
  split.pins = {};
  refreshPanePins();
}
// The other chip's pins while every chip is simulated (or the one chip running).
function refreshPanePins() {
  if (!split.on || !split.chip) return;
  api("runtime/status?chip=" + encodeURIComponent(split.chip))
    .then((s) => {
      if (!s.running || s.mode !== "host") return;
      if (s.chips && s.chip !== split.chip) return; // that chip is not simulated
      split.pins = { ...(s.pins || {}) };
      paneLeds();
    })
    .catch(() => {});
}
function paneLeds() {
  for (const led of $("pane2").querySelectorAll(".pin-led")) {
    const value = split.pins[led.dataset.pin];
    const state = value === undefined ? "unknown" : value ? "high" : "low";
    led.className = "pin-led " + state;
  }
}
// Moves the editor into `slot` and the picture into the other screen; the chip and
// tab shown in each screen stay where they are.
function activate(slot) {
  if (!split.on || slot === split.active) return;
  const canvas = $("canvas"),
    pane = $("pane2"),
    view = $("pane2Canvas");
  const editorScroll = [canvas.scrollLeft, canvas.scrollTop];
  const viewScroll = [view.scrollLeft, view.scrollTop];
  const target = { chip: split.chip, tab: split.tab };
  split.chip = currentChipId();
  split.tab = currentTab;
  split.active = slot;
  // Elements are looked up before moving: a detached one has no id lookup.
  const editor = [$("chipTabs"), $("flowTabs").parentElement, canvas];
  slotEl(slot).replaceChildren(...editor);
  slotEl(slot === "A" ? "B" : "A").replaceChildren(pane);
  pending = null;
  split.pins = {};
  if (target.chip !== currentChipId()) showChip(target.chip);
  currentTab = target.tab;
  render();
  canvas.scrollTo(...viewScroll);
  view.scrollTo(...editorScroll);
  refreshPanePins();
  // The chip now edited: its pins in the Virtual pins strip.
  if (simChips)
    api("runtime/status?chip=" + encodeURIComponent(currentChipId()))
      .then((s) => simChips && showSimPins(s.pins, s.lcd))
      .catch(() => {});
}
// Draws the other screen: the editor's own render() for that chip and tab, copied
// (without handlers), then the editor's content is put back as it was.
function drawView() {
  const keep = {
    chip: currentChip,
    tab: currentTab,
    also: new Set(alsoSelected),
    title: document.title,
    count: $("nodeCount").textContent,
    label: $("chipLabel").textContent,
    del: $("deleteSelected").disabled,
  };
  const saved = ["chipTabs", "flowTabs", "nodes", "wires"].map((id) => [
    id,
    [...$(id).childNodes],
  ]);
  splitDrawing = true;
  let parts;
  try {
    currentChip = split.chip;
    currentTab = split.tab;
    render();
    parts = {
      chips: $("chipTabs").cloneNode(true),
      bar: $("flowTabs").parentElement.cloneNode(true),
      wires: $("wires").cloneNode(true),
      nodes: $("nodes").cloneNode(true),
    };
  } finally {
    currentChip = keep.chip;
    currentTab = keep.tab;
    splitDrawing = false;
    for (const [id, children] of saved) $(id).replaceChildren(...children);
    alsoSelected = keep.also;
    document.title = keep.title;
    $("nodeCount").textContent = keep.count;
    $("chipLabel").textContent = keep.label;
    $("deleteSelected").disabled = keep.del;
  }
  // Ids would repeat the editor's: boxes get p2-node-…, the rest none.
  for (const part of Object.values(parts)) {
    for (const e of part.querySelectorAll("[id]"))
      e.id = e.id.startsWith("node-") ? "p2-" + e.id : "";
    part.removeAttribute("id");
  }
  parts.wires.setAttribute("class", "pane2-wires");
  parts.nodes.className = "pane2-nodes";
  for (const b of parts.bar.querySelectorAll("button")) b.disabled = true;
  const head = $("pane2Head");
  head.replaceChildren(parts.chips, parts.bar);
  $("pane2Canvas").replaceChildren(
    parts.wires,
    parts.nodes,
    el("div", "canvas-caption", "FLOW CANVAS · move the mouse here to edit"),
  );
  paneLeds();
}
let drawingSplit = false;
function renderSplit() {
  layoutSplit();
  if (!split.on || splitDrawing || drawingSplit) return;
  drawingSplit = true;
  try {
    pickPane();
    drawView();
  } finally {
    drawingSplit = false;
  }
}
// Simulator events for the other screen (called by log() in app.js).
function splitEvent(event) {
  if (
    event.kind === "status" &&
    (event.message === "Runtime stopped" || event.message === "Restarting")
  ) {
    split.pins = {};
    for (const v of $("pane2").querySelectorAll(".node-value"))
      v.textContent = "";
    paneLeds();
    return;
  }
  if (!split.on || !split.chip) return;
  if (event.kind === "trace") {
    // A node id is unique in the project: no chip check needed.
    const box = document.getElementById(
      "p2-node-" + String(event.message).split("__")[0],
    );
    if (!box) return;
    box.classList.add("flash");
    setTimeout(() => box.classList.remove("flash"), 250);
    const v = box.querySelector(".node-value");
    if (v && event.payload !== undefined)
      v.textContent = String(event.payload).slice(0, 60);
    return;
  }
  // Events name their chip while every chip is simulated; a single simulated chip
  // is the one being edited.
  const chip = event.chip || currentChipId();
  if (chip !== split.chip) return;
  if (event.kind === "gpio") {
    split.pins[event.pin] = event.value;
    paneLeds();
  }
  if (/^Simulating|simulating as/.test(event.message || "")) refreshPanePins();
}
function setSplit(on) {
  if (!on && split.active === "B") activate("A"); // the editor goes back up
  split.on = on;
  saveSplit();
  render();
  refreshPanePins();
}
$("splitToggle").onclick = () => setSplit(!split.on);
// The editor follows the mouse (and the keyboard focus), but never in the middle
// of a drag or while a dialog is open.
for (const slot of ["A", "B"]) {
  const box = slotEl(slot);
  box.addEventListener("pointerenter", (event) => {
    if (event.buttons || document.querySelector("dialog[open]")) return;
    activate(slot);
  });
  box.addEventListener("focusin", () => activate(slot));
}
// The bar between the screens: drag, arrow keys (Shift: bigger steps), double-click.
(() => {
  const grip = $("splitGrip");
  const set = (ratio) => {
    split.ratio = Math.min(0.85, Math.max(0.15, ratio));
    layoutSplit();
    saveSplit();
  };
  grip.onpointerdown = (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    const area = $("panes").getBoundingClientRect();
    grip.onpointermove = (e) => set((e.clientY - area.top) / area.height);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("dragging");
    };
  };
  grip.ondblclick = () => set(0.5);
  grip.onkeydown = (event) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    if (event.key === "ArrowUp") set(split.ratio - step);
    else if (event.key === "ArrowDown") set(split.ratio + step);
    else return;
    event.preventDefault();
  };
})();
layoutSplit();
