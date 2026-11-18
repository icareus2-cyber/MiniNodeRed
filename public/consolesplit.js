// ── Console: one monitor, or two (upper and lower), one chip each ──────
// ⬒ 2 chips in the Console header splits the debug monitor. Each half shows the
// messages of the chip chosen in its header: the multi-chip simulator names the
// chip of every message; other messages (upload, board checks, one simulated chip)
// belong to the chip being edited. Pause, Clear and Simulation / Upload / All work
// on both. Drag the bar between them to resize; the choice and size are remembered.
const logSplit = {
  on: false,
  ratio: 0.5,
  chips: [null, null], // upper, lower
  rows: [], // every message row, newest last (re-sorted when the chips change)
};
try {
  logSplit.on = localStorage.getItem("microflow.logSplit") === "on";
  const r = Number(localStorage.getItem("microflow.logSplitRatio"));
  if (r >= 0.15 && r <= 0.85) logSplit.ratio = r;
} catch {}
function saveLogSplit() {
  try {
    localStorage.setItem("microflow.logSplit", logSplit.on ? "on" : "off");
    localStorage.setItem("microflow.logSplitRatio", String(logSplit.ratio));
  } catch {}
}
const LOG_KEEP = 300; // rows per monitor
// Chips for the two monitors: kept while they exist; else the screens' chips when
// the flow area is split, else the first two chips.
function logChips() {
  const ids = chipsOf().map((c) => c.id);
  const screens =
    typeof split !== "undefined" && split.on
      ? split.active === "A"
        ? [currentChipId(), split.chip]
        : [split.chip, currentChipId()]
      : [ids[0], ids[1] ?? ids[0]];
  logSplit.chips = logSplit.chips.map((id, i) =>
    ids.includes(id) ? id : screens[i] && ids.includes(screens[i]) ? screens[i] : ids[0],
  );
  return logSplit.chips;
}
// The monitor a row goes to: 0 upper, 1 lower, -1 neither (kept for later).
function logSlot(row) {
  if (!logSplit.on) return 0;
  const [a, b] = logChips();
  const chip = row.dataset.chip;
  if (chip === a) return 0;
  if (chip === b) return 1;
  return -1;
}
const logBoxes = () => [$("log"), $("log2")];
function addRow(row) {
  const slot = logSlot(row);
  if (slot < 0) return;
  const box = logBoxes()[slot];
  const follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.append(row);
  while (box.querySelectorAll(".log-row").length > LOG_KEEP)
    box.querySelector(".log-row").remove();
  if (follow) box.scrollTop = box.scrollHeight;
  countRows();
}
// Called by appendLogRow() in app.js.
function placeLogRow(row) {
  logSplit.rows.push(row);
  if (logSplit.rows.length > LOG_KEEP * 4)
    logSplit.rows.splice(0, logSplit.rows.length - LOG_KEEP * 4);
  addRow(row);
}
function clearLogs() {
  logSplit.rows = [];
  for (const box of logBoxes()) box.replaceChildren();
  countRows();
}
function countRows() {
  if (!logSplit.on) return;
  logBoxes().forEach((box, i) => {
    const n = box.querySelectorAll(".log-row").length;
    const count = $(i ? "logHeadB" : "logHeadA").querySelector(".log-count");
    if (count) count.textContent = `${n} message${n === 1 ? "" : "s"}`;
  });
}
function logHead(i) {
  const head = $(i ? "logHeadB" : "logHeadA");
  const select = el("select");
  select.setAttribute("aria-label", `Chip in the ${i ? "lower" : "upper"} monitor`);
  for (const c of chipsOf()) select.append(new Option(c.name, c.id));
  select.value = logSplit.chips[i];
  select.onchange = () => {
    logSplit.chips[i] = select.value;
    refillLogs();
  };
  head.replaceChildren(
    el("b", "", i ? "LOWER" : "UPPER"),
    select,
    el("span", "log-count"),
  );
}
// Lays out one or two monitors and puts every kept row back where it belongs.
function refillLogs() {
  const on = logSplit.on;
  $("log2").hidden = $("logGrip").hidden = !on;
  $("logHeadA").hidden = $("logHeadB").hidden = !on;
  $("log").style.flex = on ? `${logSplit.ratio} 1 0` : "";
  $("log2").style.flex = on ? `${1 - logSplit.ratio} 1 0` : "";
  $("logSplit").setAttribute("aria-pressed", String(on));
  $("logSplit").textContent = on ? "▭ 1 monitor" : "⬒ 2 chips";
  const welcome = $("log").querySelector(".log-welcome");
  for (const box of logBoxes()) box.replaceChildren();
  if (welcome && !logSplit.rows.length) $("log").append(welcome);
  if (on) {
    logChips();
    logHead(0);
    logHead(1);
  }
  for (const row of logSplit.rows) addRow(row);
  for (const box of logBoxes()) box.scrollTop = box.scrollHeight;
  countRows();
}
$("logSplit").onclick = () => {
  logSplit.on = !logSplit.on;
  saveLogSplit();
  refillLogs();
};
// Chips added, renamed or deleted: the headers follow (cheap, no refill unless needed).
let logChipKey = "";
setInterval(() => {
  if (!logSplit.on) return;
  const key = chipsOf()
    .map((c) => c.id + ":" + c.name)
    .join();
  if (key !== logChipKey) {
    logChipKey = key;
    refillLogs();
  }
}, 1000);
(() => {
  const grip = $("logGrip");
  const set = (ratio) => {
    logSplit.ratio = Math.min(0.85, Math.max(0.15, ratio));
    $("log").style.flex = `${logSplit.ratio} 1 0`;
    $("log2").style.flex = `${1 - logSplit.ratio} 1 0`;
    saveLogSplit();
  };
  grip.onpointerdown = (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    const top = $("log").getBoundingClientRect().top;
    const bottom = $("log2").getBoundingClientRect().bottom;
    grip.onpointermove = (e) => set((e.clientY - top) / (bottom - top));
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("dragging");
    };
  };
  grip.ondblclick = () => set(0.5);
  grip.onkeydown = (event) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    if (event.key === "ArrowUp") set(logSplit.ratio - step);
    else if (event.key === "ArrowDown") set(logSplit.ratio + step);
    else return;
    event.preventDefault();
  };
})();
if (logSplit.on) refillLogs();
