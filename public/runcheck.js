// ── Checks before a run: saved? uploaded? ─────────────────────────────
// ▶ Simulate runs the flow on screen (no saving or compiling needed), but asks
// first when there are unsaved changes: Save & simulate, Simulate without saving
// or Cancel. Runs on a real board (Start MQTT test with a real board, Real
// Simulation) need the board to run this flow: when the chip's flow changed since
// its last upload from this app, they offer Upload first, Continue or Cancel.
// While simulating, an edit shows "Edited since ▶ Simulate" with a Restart button,
// because the simulation keeps running the flow it started with.

// What the board runs: nodes, settings, wires and board (not box positions).
function flowPrint(f = chipFlow()) {
  return JSON.stringify({
    board: $("board").value,
    language: f.language || null,
    nodes: (f.nodes || []).map((n) => [
      n.id,
      n.type,
      n.name,
      n.itype,
      n.vtype,
      n.config,
    ]),
    // The output too when it is not the first (Counter outputs 2, 3).
    edges: (f.edges || []).map((e) => (e.port ? [e.from, e.to, e.port] : [e.from, e.to])),
  });
}
const printKey = () => `microflow.uploaded:${flow.id ?? "new"}:${currentChipId()}`;
// Called after an upload succeeds (panels.js).
function markUploaded() {
  try {
    localStorage.setItem(printKey(), flowPrint());
  } catch {}
}
function uploadedState() {
  let saved = null;
  try {
    saved = localStorage.getItem(printKey());
  } catch {}
  return saved === null ? "never" : saved === flowPrint() ? "same" : "changed";
}
// A small question window; each button runs its action inside its own click (so
// Web Serial can still ask for a port).
function choose(title, text, buttons) {
  const area = el("div", "run-check");
  for (const line of [].concat(text)) area.append(el("p", "", line));
  const row = el("div", "step-row");
  for (const b of buttons) {
    const btn = button(
      b.label,
      () => {
        $("modal").close();
        b.run?.();
      },
      b.primary ? "primary" : "",
    );
    row.append(btn);
  }
  area.append(row);
  modal(title, area);
  row.querySelector(".primary")?.focus();
}
const chipName = () =>
  flow.chips?.length
    ? chipsOf().find((c) => c.id === currentChipId())?.name || "this chip"
    : "the board";
// kind: "sim" (PC simulation) or "board" (the real board runs the flow).
function beforeRun(kind, go) {
  if (kind === "sim") {
    if (!dirty || (typeof helpActive === "function" && helpActive())) return go();
    return choose(
      "Unsaved changes",
      [
        "The flow has changes that are not saved yet.",
        "The simulation runs the flow as it is on screen (no saving or compiling needed), but saving first keeps a copy of this version.",
      ],
      [
        {
          label: "Save & simulate",
          primary: true,
          run: attempt(async () => {
            await saveFlow();
            toast("Flow saved");
            go();
          }),
        },
        { label: "Simulate without saving", run: go },
        { label: "Cancel" },
      ],
    );
  }
  const state = uploadedState();
  if (state === "same") return go();
  const who = chipName();
  choose(
    state === "never" ? "Not uploaded yet" : "Not uploaded since your changes",
    [
      state === "never"
        ? `No upload of this flow to ${who} is recorded in this app, so the board may run a different program.`
        : `The flow of ${who} changed since its last upload: the board still runs the older version.`,
      "Upload it first (it is compiled on the way), or continue with what the board has now.",
      ...(dirty ? ["The flow also has unsaved changes."] : []),
    ],
    [
      {
        label: "Upload first",
        primary: true,
        run: () => $("upload").click(),
      },
      { label: "Continue anyway", run: go },
      { label: "Cancel" },
    ],
  );
}
// Wraps the run buttons (handlers from app.js) with the checks above.
for (const [id, kind] of [
  ["simulate", () => "sim"],
  ["start", () => ($("runtimeMode").value === "host" ? "sim" : "board")],
  ["realSim", () => "board"],
]) {
  const run = $(id).onclick;
  $(id).onclick = (event) => beforeRun(kind(), () => run.call($(id), event));
}
// ── Edited while simulating ──
// Called by changed() in app.js: shown while a PC simulation runs.
function simEdited() {
  if (emuActive) return;
  api("runtime/status")
    .then((s) => {
      if (s.running && s.mode === "host") $("simStale").hidden = false;
    })
    .catch(() => {});
}
$("simStale").replaceChildren(
  el("span", "", "Edited since ▶ Simulate: the simulation runs the older flow."),
  button("↻ Restart", () => $("simulate").click(), "primary"),
);
// Hidden again when a run starts or stops.
for (const id of ["simulate", "start", "stop", "realSim"])
  $(id).addEventListener("click", () => ($("simStale").hidden = true), true);

// ── One start button: the mode list beside it chooses what it starts ──
// Simulate on this PC → ▶ Simulate, Real board (monitor) → ▶ Start MQTT test,
// Real board + PC inputs (USB) → ▶ Start Real Simulation. The former Simulate and
// Start Real Simulation buttons stay hidden; their handlers (and checks) run.
const START_LABEL = {
  host: ["▶ Simulate", "Run the flow on this PC; GPIO, display and timers are simulated"],
  device: ["▶ Start MQTT test", "Monitor the real board over MQTT: ▶, Push button and Switch trigger it"],
  emulate: [
    "▶ Start Real Simulation",
    "Run the flow on the real board with inputs from this PC: checks the serial port and the board first",
  ],
};
function startLabel() {
  const [text, title] = START_LABEL[$("runtimeMode").value] || START_LABEL.host;
  if ($("start").textContent !== text) $("start").textContent = text;
  $("start").title = title;
}
{
  const runStart = $("start").onclick;
  $("start").onclick = (event) => {
    const mode = $("runtimeMode").value;
    if (mode === "host") return $("simulate").click();
    if (mode === "emulate") return $("realSim").click();
    return runStart.call($("start"), event);
  };
  $("runtimeMode").addEventListener("change", startLabel);
  setInterval(startLabel, 500); // the mode is also set by code (emulation, Devices)
  startLabel();
}
