// Secondary panels: virtual pins, MQTT tests, revision history, devices and builds.
// Shares globals (flow, api, el, modal, toast, attempt, broker, …) with app.js.
const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.round(s / 60)} min ago`
      : s < 86400
        ? `${Math.round(s / 3600)} h ago`
        : new Date(iso).toLocaleString();
};
const button = (text, onclick, cls = "") => {
  const b = el("button", cls, text);
  b.onclick = onclick;
  return b;
};
const targetDevice = () => $("deviceId").value.trim() || "sim";
// ── Virtual pins (host simulation) ──────────────────────────────
let simPins = null;
function pinRoles() {
  const roles = {};
  for (const n of flow.nodes)
    for (const p of nodePins(n)) if (p.sim) roles[p.pin] = p.use;
  return roles;
}
function showSimPins(pins, lcd) {
  if (emuActive) return showEmuPins(); // the strip shows the PC inputs (emulate.js)
  const before = simPins ? Object.keys(simPins).join() : null;
  simPins = pins ? { ...pins } : null;
  // GPIO input boxes show PUSH / SWITCH only while simulating: redraw when it starts,
  // stops or its pins change (not on every pin level, which would cut a press short).
  if (before !== (simPins ? Object.keys(simPins).join() : null)) render();
  updatePinLeds();
  updateSimSwitches();
  if (!simPins) simLcd = null;
  else if (lcd) simLcd = new Map(lcd.map((l) => [l.row, l]));
  else if (!simLcd && flowHasDisplay()) simLcd = new Map();
  const strip = $("simPins");
  // The virtual LCD appears only for boards that have a screen (e.g. not ESP8266).
  const lcdShown = !!simLcd && boardHasDisplay();
  strip.hidden = !simPins || (!Object.keys(simPins).length && !lcdShown);
  if (strip.hidden) return;
  const roles = pinRoles();
  strip.replaceChildren(el("span", "sim-title", "VIRTUAL PINS"));
  for (const [pin, value] of Object.entries(simPins)) {
    const role = roles[pin] || "out";
    const chip = el("div", "sim-pin " + role);
    chip.id = "sim-pin-" + pin;
    if (role === "in") {
      const toggle = button(
        `GPIO ${pin} · ${value ? "HIGH" : "LOW"}`,
        attempt(() =>
          api("runtime/pin", {
            pin: Number(pin),
            value: simPins[pin] ? 0 : 1,
            chip: currentChipId(),
          }),
        ),
      );
      toggle.title = "Simulate an external signal on this input";
      toggle.setAttribute("aria-pressed", String(!!value));
      chip.append(toggle);
    } else if (role === "adc") {
      // The range of the Analog sample's Resolution (the board's own ADC by default:
      // ESP8266 10 bits, ESP32 12 bits).
      const native =
        boards.find((b) => b.id === $("board").value)?.family === "esp8266"
          ? 10
          : 12;
      const bits = Math.max(
        ...chipFlow()
          .nodes.filter(
            (n) => n.type === "analog-in" && String(n.config.pin) === String(pin),
          )
          .map((n) =>
            n.config.bits && n.config.bits !== "native"
              ? Number(n.config.bits)
              : native,
          ),
        0,
      );
      const max = 2 ** (bits || native) - 1;
      const slider = el("input");
      Object.assign(slider, { type: "range", min: 0, max, value });
      slider.setAttribute("aria-label", `Analog value for GPIO ${pin}`);
      const out = el("span", "", String(value));
      slider.oninput = () => (out.textContent = slider.value);
      slider.onchange = attempt(() =>
        api("runtime/pin", {
          pin: Number(pin),
          value: Number(slider.value),
          chip: currentChipId(),
        }),
      );
      chip.append(el("span", "", `ADC ${pin}`), slider, out);
    } else
      chip.append(
        el(
          "span",
          "",
          `GPIO ${pin} → ${role === "pwm" ? value : value ? "HIGH" : "LOW"}`,
        ),
      );
    strip.append(chip);
  }
  if (lcdShown) {
    const box = el("div", "sim-lcd");
    const canvas = el("canvas");
    canvas.id = "simLcd";
    canvas.width = 240;
    canvas.height = 135;
    canvas.setAttribute("aria-label", "Simulated LCD");
    box.append(el("span", "sim-title", "LCD 240×135"), canvas);
    strip.append(box);
    drawLcd();
  }
}
function updateSimPin(pin, value) {
  if (!simPins || !(pin in simPins) || simPins[pin] === value) return;
  simPins[pin] = value;
  const slider = document.querySelector(`#sim-pin-${pin} input`);
  if (slider && document.activeElement === slider) return;
  showSimPins(simPins);
}
// ── Virtual LCD: what Display nodes draw, while the PC simulator runs ──
let simLcd = null; // Map row → { row, size, color, text }
// Adafruit ST77XX colours as CSS.
const LCD_CSS = {
  white: "#ffffff",
  green: "#00ff00",
  yellow: "#ffff00",
  cyan: "#00ffff",
  orange: "#ff8000",
  red: "#ff0000",
  magenta: "#ff00ff",
};
function drawLcd() {
  const canvas = document.getElementById("simLcd");
  if (!canvas || !simLcd) return;
  const g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.textBaseline = "top";
  for (const l of [...simLcd.values()].sort((a, b) => a.row - b.row)) {
    // Same layout as mfLcd(): 19 px rows, 6×8 px font scaled by size, clipped to the width.
    g.font = `bold ${8 * l.size}px Consolas, monospace`;
    g.fillStyle = LCD_CSS[l.color] || "#fff";
    g.fillText(
      l.text.slice(0, Math.floor((canvas.width - 8) / (6 * l.size))),
      4,
      3 + l.row * 19,
    );
  }
}
function updateSimLcd(event) {
  if (!simLcd) return;
  if (event.clear) simLcd.clear();
  else
    simLcd.set(event.row, {
      row: event.row,
      size: event.size,
      color: event.color,
      text: event.text,
    });
  drawLcd();
}
const flowHasDisplay = () => flow.nodes.some((n) => n.type === "display");
const boardHasDisplay = () =>
  !!boards.find((b) => b.id === $("board").value)?.features.includes("display");
// ── MQTT tests ──────────────────────────────────────────────────
const OPS = {
  publish: "Publish",
  expect: "Expect",
  "expect-none": "Expect none",
  wait: "Wait",
};
const MATCH = {
  equals: "equals",
  contains: "contains",
  regex: "regex",
  gte: "≥ number",
  lte: "≤ number",
  any: "any payload",
};
// Radio in/out boxes using MQTT (tests run over the broker).
const mqttRadio = (n, type) =>
  n.type === type && (n.config.protocol || "mqtt") === "mqtt";
function scaffoldTest() {
  const steps = [];
  const input = flow.nodes.find((n) => mqttRadio(n, "mqtt-in"));
  const manual = flow.nodes.find(
    (n) => n.type === "inject" && !Number(n.config.interval),
  );
  if (input)
    steps.push({
      op: "publish",
      topic: input.config.topic.replaceAll("+", "test").replace(/#$/, "test"),
      payload: "1",
    });
  else if (manual)
    steps.push({
      op: "publish",
      topic: `microflow/{{device}}/inject/${manual.id}`,
      payload: "",
    });
  for (const n of flow.nodes) {
    if (mqttRadio(n, "mqtt-out"))
      steps.push({
        op: "expect",
        topic: n.config.topic,
        match: "any",
        value: "",
        timeout: 2000,
      });
    if (n.type === "debug")
      steps.push({
        op: "expect",
        topic: `microflow/{{device}}/debug/${n.id}`,
        match: "any",
        value: "",
        timeout: 2000,
      });
  }
  if (!steps.length)
    steps.push({ op: "publish", topic: "test/topic", payload: "1" });
  return { name: "New test", steps };
}
function stepRow(step, rows) {
  const row = el("div", "step-row");
  const op = el("select");
  for (const [v, t] of Object.entries(OPS)) {
    const o = el("option", "", t);
    o.value = v;
    op.append(o);
  }
  op.value = step.op;
  const topic = Object.assign(el("input"), {
    value: step.topic ?? "",
    placeholder: "topic (+/# allowed for expect)",
  });
  const match = el("select");
  for (const [v, t] of Object.entries(MATCH)) {
    const o = el("option", "", t);
    o.value = v;
    match.append(o);
  }
  match.value = step.match || "equals";
  const value = Object.assign(el("input"), {
    value: step.op === "publish" ? (step.payload ?? "") : (step.value ?? ""),
  });
  const timeout = Object.assign(el("input"), {
    type: "number",
    min: 10,
    max: 60000,
    value: step.timeout ?? 2000,
    title: "Timeout / duration (ms)",
  });
  const sync = () => {
    topic.hidden = op.value === "wait";
    match.hidden = op.value !== "expect";
    value.hidden = !(
      op.value === "publish" ||
      (op.value === "expect" && match.value !== "any")
    );
    value.placeholder = op.value === "publish" ? "payload" : "expected value";
    timeout.hidden = op.value === "publish";
  };
  op.onchange = match.onchange = sync;
  sync();
  const remove = button("✕", () => row.remove());
  remove.title = "Remove step";
  row.append(op, topic, match, value, timeout, remove);
  row.read = () => {
    const s = { op: op.value };
    if (s.op !== "wait") s.topic = topic.value.trim();
    if (s.op === "publish") s.payload = value.value;
    if (s.op === "expect")
      Object.assign(s, { match: match.value, value: value.value });
    if (s.op !== "publish") s.timeout = Number(timeout.value);
    return s;
  };
  rows.append(row);
}
function editTest(test) {
  const area = el("div", "test-editor");
  const name = Object.assign(el("input"), { value: test.name });
  const label = el("label", "", "Test name");
  label.append(name);
  const rows = el("div", "steps");
  test.steps.forEach((s) => stepRow(s, rows));
  area.append(
    label,
    el(
      "p",
      "muted",
      "Steps run in order against the broker. {{device}} becomes the Device ID (or sim). Expectations only count messages after the latest publish; retained messages are ignored.",
    ),
    rows,
    button("+ Add step", () =>
      stepRow({ op: "expect", match: "equals", timeout: 2000 }, rows),
    ),
  );
  const actions = el("div", "actions spaced-top");
  actions.append(
    button("Cancel", () => openTests()),
    button(
      "Save test",
      attempt(async () => {
        await api(`flows/${encodeURIComponent(flow.id)}/tests`, {
          id: test.id,
          name: name.value,
          steps: [...rows.children].map((r) => r.read()),
        });
        toast("Test saved");
        openTests();
      }),
      "primary",
    ),
  );
  area.append(actions);
  modal(test.id ? "Edit test" : "New test", area);
}
function resultView(results) {
  const box = el("div", "test-results");
  for (const r of results) {
    box.append(
      el(
        "div",
        "result-head " + (r.passed ? "pass" : "fail"),
        `${r.passed ? "✓ PASS" : "✗ FAIL"} · ${r.name} · ${r.device} · ${r.durationMs} ms`,
      ),
    );
    if (r.error) box.append(el("div", "check-error", r.error));
    for (const s of r.steps)
      box.append(
        el(
          "div",
          "result-step " + (s.ok === null ? "skip" : s.ok ? "pass" : "fail"),
          `${s.ok === null ? "–" : s.ok ? "✓" : "✗"} ${s.text} — ${s.detail}${s.ms !== undefined ? ` (${s.ms} ms)` : ""}`,
        ),
      );
  }
  return box;
}
async function runTests(ids, area) {
  const status = el(
    "p",
    "muted",
    `Running ${ids.length} test(s) against ${targetDevice()} via ${$("brokerUrl").value}…`,
  );
  area.replaceChildren(status);
  const r = await api("tests/run", {
    ids,
    broker: broker(),
    device: targetDevice(),
  });
  status.textContent = `${r.passed} passed, ${r.failed} failed.`;
  area.append(
    resultView(r.results),
    button("← Back to tests", () => openTests()),
  );
}
// Shows how many tests the open flow has on the toolbar button.
async function updateTestsButton() {
  let n = 0;
  if (flow.id)
    try {
      n = (await api(`flows/${encodeURIComponent(flow.id)}/tests`)).length;
    } catch {}
  $("tests").textContent = n ? `Tests (${n})` : "Tests";
}
// Lists other saved flows that have tests, so they are one click away.
async function otherFlowsWithTests() {
  const flows = (await api("flows")).filter((f) => f.tests && f.id !== flow.id);
  if (!flows.length) return null;
  const box = el("div", "spaced-top");
  box.append(el("p", "muted", "These saved flows have tests:"));
  for (const f of flows) {
    const row = el("div", "saved-row");
    row.append(
      el(
        "strong",
        "",
        `${f.name} · ${f.tests} test${f.tests === 1 ? "" : "s"}`,
      ),
      button(
        "Open and show tests",
        attempt(async () => {
          if (await loadFlow(f.id)) await openTests();
        }),
        "primary",
      ),
    );
    box.append(row);
  }
  return box;
}
async function openTests() {
  if (!flow.id) {
    // Unsaved flow: explain and offer to save, rather than a fleeting error.
    const area = el("div");
    area.append(
      el(
        "p",
        "",
        "Tests are stored with a saved flow in SQLite. This flow has not been saved yet.",
      ),
      el("div", "actions", ""),
    );
    area.lastChild.append(
      button(
        "Save now and add tests",
        attempt(async () => {
          await saveFlow();
          await openTests();
        }),
        "primary",
      ),
    );
    const others = await otherFlowsWithTests();
    if (others) area.append(others);
    return modal(`MQTT tests · ${flow.name}`, area);
  }
  const tests = await api(`flows/${encodeURIComponent(flow.id)}/tests`);
  const area = el("div");
  const target = el(
    "p",
    "muted",
    `Target: ${targetDevice()} on ${$("brokerUrl").value}. ${$("runtimeMode").value === "host" ? "Start the simulation (▶ Start MQTT test) first to test on this PC" : "The board must be online"}; set Device ID to test a specific board.`,
  );
  area.append(target);
  if (dirty)
    area.append(
      el(
        "div",
        "check-warning",
        "! Unsaved edits: the running simulation and tests use the last started/saved flow.",
      ),
    );
  const list = el("div");
  if (!tests.length)
    list.append(
      el(
        "p",
        "",
        "No tests yet. A new test is pre-filled from this flow's MQTT inputs and outputs.",
      ),
    );
  for (const t of tests) {
    const row = el("div", "saved-row");
    const badge = el(
      "span",
      "badge " + (t.last ? (t.last.passed ? "pass" : "fail") : ""),
      t.last ? (t.last.passed ? "PASS" : "FAIL") : "NEW",
    );
    if (t.last) badge.title = `${t.last.device} · ${ago(t.last.started)}`;
    row.append(
      badge,
      el("strong", "", `${t.name} · ${t.steps.length} steps`),
      button(
        "Run",
        attempt(() => runTests([t.id], area)),
      ),
      button("Edit", () => editTest(t)),
      button(
        "History",
        attempt(async () => {
          const runs = await api(`tests/${t.id}/runs`);
          const view = el("div");
          view.append(button("← Back", () => openTests()));
          if (!runs.length) view.append(el("p", "", "Not run yet."));
          for (const run of runs)
            view.append(
              el(
                "p",
                "muted",
                `${new Date(run.started).toLocaleString()} · ${ago(run.started)}`,
              ),
              resultView([run.result]),
            );
          modal(`Runs · ${t.name}`, view);
        }),
      ),
      button(
        "Delete",
        attempt(async () => {
          if (!confirm(`Delete test “${t.name}”?`)) return;
          await api(`tests/${t.id}`, null, "DELETE");
          openTests();
        }),
        "danger",
      ),
    );
    list.append(row);
  }
  const actions = el("div", "actions spaced-top");
  const runAll = button(
    tests.length ? `▶ Run all (${tests.length})` : "▶ Run all",
    attempt(() =>
      runTests(
        tests.map((t) => t.id),
        area,
      ),
    ),
    "primary",
  );
  runAll.disabled = !tests.length;
  if (!tests.length) runAll.title = "Add a test first";
  actions.append(
    button("+ New test", () => editTest(scaffoldTest())),
    runAll,
  );
  area.append(list, actions);
  if (!tests.length) {
    const others = await otherFlowsWithTests();
    if (others) area.append(others);
  }
  modal(`MQTT tests · ${flow.name}`, area);
  updateTestsButton();
}
$("tests").onclick = attempt(openTests);
// ── Revision history ────────────────────────────────────────────
$("history").onclick = attempt(async () => {
  if (!flow.id)
    throw Error("Save the flow first; each save keeps a revision in SQLite.");
  const revisions = await api(`flows/${encodeURIComponent(flow.id)}/revisions`);
  const area = el("div");
  area.append(
    el(
      "p",
      "muted",
      "Each save that changes the flow keeps a revision (latest 50). Restoring loads it onto the canvas; save to keep it.",
    ),
  );
  revisions.forEach((r, i) => {
    const row = el("div", "saved-row");
    row.append(
      el("strong", "", `${i === 0 ? "Current · " : ""}${r.name}`),
      el(
        "span",
        "muted",
        `${r.nodes} nodes · ${r.edges} links · ${new Date(r.created).toLocaleString()}`,
      ),
      button(
        "Restore",
        attempt(async () => {
          if (dirty && !confirm("Discard unsaved changes?")) return;
          const doc = await api(
            `flows/${encodeURIComponent(flow.id)}/revisions/${r.id}`,
          );
          flow = { ...doc, id: flow.id };
          $("flowName").value = flow.name;
          selected = selectedLink = pending = null;
          changed();
          render();
          $("modal").close();
          toast("Revision restored. Save to make it current.");
        }),
      ),
    );
    area.append(row);
  });
  modal(`History · ${flow.name}`, area);
});
// ── Devices ─────────────────────────────────────────────────────
let devicesOpen = false,
  devicesTimer;
function devicesChanged() {
  if (!devicesOpen) return;
  clearTimeout(devicesTimer);
  devicesTimer = setTimeout(() => openDevices().catch(() => {}), 500);
}
async function openDevices() {
  const devices = await api("devices");
  const area = el("div");
  area.append(
    el(
      "p",
      "muted",
      "Boards running Microflow firmware publish status and telemetry to microflow/<id>/… Start the runtime (either mode) to listen. Records are kept in SQLite.",
    ),
  );
  // The broker this list comes from, whether the app listens on it, and a ping.
  const run = await api("runtime/status").catch(() => ({}));
  const brokerBox = el("div", "broker-choice");
  const listening = !run.running
    ? "Not listening: details (IP, uptime, heap…) arrive only while the app listens. Press Listen for devices."
    : !run.connected
      ? "Runtime started, but not connected to this broker."
      : run.mode === "host" || run.mode === "monitor"
        ? "Listening for all boards on this broker (heartbeats every 30 s)."
        : `Listening for ${run.deviceId} only (Real board mode). Listen for devices shows every board.`;
  // Listen-only runtime: subscribes to every board's status/telemetry, runs no flow.
  const listen = button(
    run.running && run.mode === "monitor"
      ? "Listen again"
      : "Listen for devices",
    attempt(async () => {
      await stopEmulation();
      await api("runtime/start", {
        flow: chipFlow(),
        broker: broker(),
        mode: "monitor",
      });
      toast(
        `Listening on ${$("brokerUrl").value}. Boards appear as they report (status at once, telemetry within 30 s).`,
      );
      setTimeout(() => devicesOpen && openDevices(), 2500);
      openDevices();
    }),
  );
  // A Broker URL on this PC cannot reach a broker board on the LAN.
  const local = /^mqtt:\/\/(127\.|localhost|\[?::1)/.test($("brokerUrl").value);
  const boardBroker = devices.find(
    (d) => d.telemetry?.broker === 1 || d.id.startsWith("broker-"),
  );
  const pingBroker = button(
    "Ping broker",
    attempt(async () => {
      devicesOpen = false;
      const view = el("div"),
        checks = el("div");
      view.append(checks, button("← Devices", attempt(openDevices)));
      modal("Ping broker", view);
      await runBrokerTest(checks);
    }),
  );
  const buttons = el("div", "step-row");
  buttons.append(listen, pingBroker);
  brokerBox.append(
    el("b", "", `MQTT broker: ${$("brokerUrl").value || "(no Broker URL)"}`),
    el("p", run.running && run.connected ? "muted" : "bad", listening),
  );
  if (local && boardBroker)
    brokerBox.append(
      el(
        "p",
        "bad",
        `This Broker URL is this PC, not your broker board ${boardBroker.id}${boardBroker.telemetry?.ip ? ` (${boardBroker.telemetry.ip})` : ""}. Press Use as broker on its row, then Listen for devices.`,
      ),
    );
  brokerBox.append(buttons);
  area.append(brokerBox);
  if (!devices.length) area.append(el("p", "", "No devices seen yet."));
  const table = el("table", "devices");
  if (devices.length) {
    const head = el("tr");
    for (const h of [
      "",
      "Device",
      "Seen",
      "Uptime",
      "Heap",
      "RSSI",
      "IP",
      "Firmware",
      "",
    ])
      head.append(el("th", "", h));
    table.append(head);
  }
  for (const d of devices) {
    const t = d.telemetry || {};
    const tr = el("tr");
    const dot = el("span", "status-dot");
    dot.style.background = d.status === "online" ? "#68a35e" : "#a5b0a4";
    dot.title = d.status || "unknown";
    // A broker board (⇄) reports "broker":1 with its port, clients and traffic.
    // Broker boards are named broker-xxxxxx, so they are known before telemetry.
    const isBroker = t.broker === 1 || d.id.startsWith("broker-");
    const fw = isBroker
      ? `${t.build || "build ?"} · MQTT broker :${t.port || 1883} · ${t.clients ?? "?"} clients · ${t.messages ?? "?"} msgs`
      : d.deployment
        ? `${t.build} · ${d.deployment.flow_name}`
        : t.build
          ? `${t.build}${t.flow ? " · " + t.flow : ""}`
          : "–";
    const name = el("span", "", d.id);
    if (isBroker) name.append(" ", el("span", "tag", "BROKER"));
    const cells = [
      dot,
      name,
      ago(d.last_seen),
      t.uptime !== undefined
        ? `${Math.floor(t.uptime / 3600)}h ${Math.floor((t.uptime % 3600) / 60)}m`
        : "–",
      t.heap ? `${(t.heap / 1024).toFixed(1)} KB` : "–",
      t.rssi ? `${t.rssi} dBm` : "–",
      t.ip || "–",
      fw,
    ];
    for (const c of cells) {
      const td = el("td");
      td.append(c);
      tr.append(td);
    }
    const actions = el("td", "row-actions");
    const brokerUrl =
      isBroker && t.ip ? `mqtt://${t.ip}:${t.port || 1883}` : "";
    actions.append(
      button(
        "Ping",
        attempt(async () => {
          devicesOpen = false;
          const checks = el("div");
          const view = el("div");
          view.append(checks, button("← Devices", attempt(openDevices)));
          modal(`Ping · ${d.id}`, view);
          // A broker board is pinged directly at its own address (QoS 0 only).
          if (brokerUrl)
            await runBrokerTest(checks, {
              broker: { ...broker(), url: brokerUrl },
              qos1: false,
            });
          else if (isBroker)
            checks.append(
              el(
                "p",
                "bad",
                "This broker board's IP address is not known yet. Connect it by USB and use Verify board, or press Listen for devices while the Broker URL points at it.",
              ),
            );
          else await verifyInto(checks, { deviceId: d.id }, { usb: false });
        }),
      ),
    );
    if (brokerUrl)
      actions.append(
        button(
          "Use as broker",
          attempt(async () => {
            await useBrokerBoard({ ip: t.ip, port: t.port || 1883 }); // brokerboard.js
            toast(
              `Broker set to ${brokerUrl}. Upload flows again so boards use it.`,
            );
            openDevices();
          }),
        ),
      );
    else
      actions.append(
        button("Use", async () => {
          if (!(await saveBeforeDeviceChange(d.id))) return;
          $("deviceId").value = d.id;
          $("runtimeMode").value = d.id === "sim" ? "host" : "device";
          saveSettings();
          toast(
            `Tests and ▶ inject now target ${d.id}. Restart the runtime to apply.`,
          );
        }),
      );
    actions.append(
      button(
        "Forget",
        attempt(async () => {
          await api(`devices/${encodeURIComponent(d.id)}`, null, "DELETE");
          openDevices();
        }),
      ),
    );
    tr.append(actions);
    table.append(tr);
  }
  area.append(table);
  devicesOpen = true;
  modal("Devices", area);
}
$("devices").onclick = attempt(openDevices);
$("modal").addEventListener("close", () => (devicesOpen = false));
// ── Build & upload history ──────────────────────────────────────
$("deployments").onclick = attempt(async () => {
  const rows = await api("deployments");
  const area = el("div");
  if (!rows.length) area.append(el("p", "", "No compiles or uploads yet."));
  for (const d of rows) {
    const box = el("div", "deploy-row");
    box.append(
      el(
        "div",
        "result-head " + (d.ok ? "pass" : "fail"),
        `${d.ok ? "✓" : "✗"} ${d.action} · ${d.flow_name} · ${d.board}${d.port ? " · " + d.port : ""} · build ${d.build} · ${new Date(d.created).toLocaleString()}`,
      ),
    );
    if (d.size) box.append(sizeReport(d.size));
    if (d.message) box.append(el("pre", "check-error", d.message));
    area.append(box);
  }
  modal("Builds & uploads", area);
});
// ── Board verification ──────────────────────────────────────────
// Live checklist fed by "verify" events (see log() in app.js) while /api/verify runs.
let activeVerify = null;
async function verifyInto(container, options, { usb = true } = {}) {
  const list = el("div", "verify-list");
  const status = el(
    "p",
    "muted",
    "Running checks (can take up to a minute while the board joins WiFi)…",
  );
  container.replaceChildren(status, list);
  const rows = [];
  const view = {
    update(index, step) {
      rows[index] ||= list.appendChild(el("div", "verify-step"));
      rows[index].className =
        "verify-step " +
        (step.ok === null ? "skip" : step.ok ? "pass" : "fail");
      rows[index].replaceChildren(
        el(
          "b",
          "",
          `${step.ok === null ? "–" : step.ok ? "✓" : "✗"} ${step.name}`,
        ),
        el("span", "", step.detail),
      );
    },
  };
  activeVerify = view;
  const runAgain = button(
    "↻ Verify again",
    attempt(() => verifyInto(container, options, { usb })),
  );
  try {
    if (usb && options.serialPort && browserSerial.port)
      await browserSerial.disconnect();
    const report = await api("verify", {
      ...options,
      serialPort: usb ? options.serialPort : undefined,
      broker: $("brokerUrl").value ? broker() : undefined,
      board: $("board").value,
    });
    report.steps.forEach((s, i) => view.update(i, s));
    const d = report.device;
    status.className = "result-head " + (report.ok ? "pass" : "fail");
    status.textContent = report.ok
      ? `✓ Board ${d.id || ""} is alive${d.build ? " · build " + d.build : ""}`
      : "✗ Board check failed — see the first ✗ below";
    const actions = el("div", "actions spaced-top");
    actions.append(runAgain);
    if (d.id && d.id !== $("deviceId").value.trim())
      actions.append(
        button(`Target ${d.id} in tests`, async () => {
          if (!(await saveBeforeDeviceChange(d.id))) return;
          $("deviceId").value = d.id;
          saveSettings();
          toast(`Device ID set to ${d.id}`);
        }),
      );
    container.append(actions);
    return report;
  } catch (e) {
    status.className = "result-head fail";
    status.textContent = "✗ " + e.message;
    container.append(runAgain);
  } finally {
    if (activeVerify === view) activeVerify = null;
  }
}
$("verifyBoard").onclick = attempt(async () => {
  const serialPort = $("serialPort").value.trim();
  const deviceId = $("deviceId").value.trim();
  if (!serialPort && !deviceId)
    throw Error(
      "Enter the board's serial port (or a Device ID to ping it over MQTT).",
    );
  const checks = el("div");
  modal("Verify board", checks);
  await verifyInto(checks, {
    serialPort: serialPort || undefined,
    deviceId: deviceId || undefined,
  });
});
// ── Public test broker preset ───────────────────────────────────
$("publicBroker").onclick = () => {
  $("brokerUrl").value = "mqtt://test.mosquitto.org:1883";
  $("host").value = "test.mosquitto.org";
  $("mqttPort").value = "1883";
  $("username").value = "";
  $("mqttPassword").value = "";
  saveSettings();
  toast(
    "Using test.mosquitto.org. It is public: anyone can read these topics. Use {{device}} in topics and a unique Device ID; re-upload so the board uses it.",
  );
};
// ── Broker loopback test (no board) ─────────────────────────────
// target: another broker than the Broker URL (e.g. a broker board from Devices),
// with qos1: false for QoS 0-only brokers.
async function runBrokerTest(container, target = null) {
  const url = target?.broker.url || $("brokerUrl").value;
  const status = el("p", "muted", `Testing ${url}…`);
  container.replaceChildren(status);
  const again = button(
    "↻ Test again",
    attempt(() => runBrokerTest(container, target)),
  );
  try {
    const r = await api("broker/test", {
      broker: target?.broker || broker(),
      qos1: target?.qos1 ?? true,
    });
    status.className = "result-head " + (r.ok ? "pass" : "fail");
    status.textContent = r.ok
      ? `✓ Broker works: ${r.url}`
      : "✗ Broker test failed — see the first ✗ below";
    const list = el("div", "verify-list");
    for (const s of r.steps) {
      const row = el(
        "div",
        "verify-step " + (s.ok === null ? "skip" : s.ok ? "pass" : "fail"),
      );
      row.append(
        el("b", "", `${s.ok === null ? "–" : s.ok ? "✓" : "✗"} ${s.name}`),
        el("span", "", s.detail),
      );
      list.append(row);
    }
    container.append(
      list,
      el(
        "p",
        "muted",
        target
          ? "Checks this PC ↔ broker with the username/password from the Device panel."
          : "Uses the Broker URL and username/password above. It checks this PC ↔ broker only; the board must also be able to reach the Firmware broker host.",
      ),
    );
  } catch (e) {
    status.className = "result-head fail";
    status.textContent = "✗ " + e.message;
  }
  container.append(again);
}
$("brokerTest").onclick = () => {
  const area = el("div");
  modal("Broker loopback test", area);
  runBrokerTest(area);
};
// ── Chip status over the serial terminal (Local serial or Web Serial) ──
let chipLast = null,
  chipMissed = 0,
  chipTimer = null,
  chipQuietUntil = 0, // ignore boot-ROM noise right after connect/reset
  lastUploadedBuild = null;
const chipParser = new ChipStatusParser((status) => {
  // Node reports from PC input emulation builds (emulate.js), not chip status.
  if (typeof status.n === "string") return emuTrace(status.n, status.v);
  brokerFromSerial(status); // a broker board reports its address (brokerboard.js)
  const ipChanged = status.ip !== chipLast?.ip;
  chipLast = { ...status, at: Date.now() };
  chipMissed = 0;
  renderChip();
  if (ipChanged) webUrlsChanged();
});
const chipSend = (text) =>
  $("serialTransport").value === "browser"
    ? browserSerial.send(text)
    : api("serial/send", { text });
function chipPoll() {
  if (!serialConnected() || serialBusy) return; // not while connecting/disconnecting
  chipMissed++;
  ($("serialTransport").value === "browser"
    ? browserSerial.send("mf?\n")
    : api("serial/poll", {})
  ).catch(() => {}); // a busy writer just skips this poll
  renderChip();
}
function chipMonitor() {
  const on = serialConnected();
  const appearing = on && $("chipCard").hidden;
  $("chipCard").hidden = !on;
  if (appearing)
    $("chipCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
  clearInterval(chipTimer);
  chipTimer = null;
  if (on && !serialBusy) {
    chipMissed = 0;
    chipQuietUntil = Date.now() + 3000;
    if ($("chipAuto").checked) {
      chipPoll();
      chipTimer = setInterval(chipPoll, 2000);
    }
  } else chipLast = null;
  renderChip();
}
function renderChip() {
  if ($("chipCard").hidden) return;
  const s = chipLast;
  const family =
    boards.find((b) => b.id === $("board").value)?.family || "esp8266";
  const age = s ? Math.round((Date.now() - s.at) / 1000) : null;
  const rows = s
    ? [
        ["Device", s.id],
        [
          "Build",
          s.build +
            (lastUploadedBuild
              ? s.build === lastUploadedBuild
                ? " ✓ last upload"
                : " ≠ last upload"
              : ""),
        ],
        // "net":0 = firmware built for a board without WiFi.
        ...(s.net === 0
          ? [["Network", "none (board has no WiFi)"]]
          : [
              [
                "WiFi",
                s.wifi === 3
                  ? `connected · ${s.ip} · ${s.rssi} dBm`
                  : describeWifi(s.wifi, family),
              ],
              ["MQTT", describeMqtt(s.mqtt)],
            ]),
        ...(s.emu ? [["Inputs", "PC emulation available"]] : []),
        ["Heap", `${(s.heap / 1024).toFixed(1)} KB free`],
        [
          "Uptime",
          `${Math.floor(s.uptime / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m ${s.uptime % 60}s`,
        ],
        ["Updated", age < 2 ? "just now" : `${age} s ago`],
      ]
    : [["Status", "waiting for the board…"]];
  $("chipFields").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dd = el("dd", "", v);
      if ((k === "WiFi" && s.wifi !== 3) || (k === "MQTT" && s.mqtt !== 0))
        dd.className = "bad";
      if (k === "Build" && v.includes("≠")) dd.className = "bad";
      return [el("dt", "", k), dd];
    }),
  );
  const quiet = Date.now() < chipQuietUntil;
  let hint = "";
  if ($("baudRate").value !== "115200")
    hint = "Microflow firmware talks at 115200 baud; status needs that rate.";
  else if (!quiet && chipParser.garbled())
    hint =
      "Receiving unreadable data: the baud rate may not match (Microflow firmware uses 115200; try Auto-detect baud), or the chip is stuck in a crash loop (its boot ROM prints at 74880). Press Reset board if the rate is right.";
  else if (chipMissed >= 3)
    hint = `No status reply for ${chipMissed * 2} s: the board may be busy (e.g. retrying an unreachable broker), crashed, or not running Microflow firmware. Try Reset board, or upload again.`;
  else if (s && s.wifi === 3 && s.mqtt !== 0)
    hint =
      "WiFi works but MQTT does not: check the Firmware broker host, then upload again.";
  $("chipHint").textContent = hint;
}
$("chipAuto").onchange = chipMonitor;
$("chipRefresh").onclick = attempt(async () => {
  await chipSend("mf?\n");
});
// Pulses RST over the open serial connection (GPIO0 released: normal boot).
async function resetBoard() {
  if ($("serialTransport").value === "browser") await browserSerial.reset();
  else await api("serial/reset", {});
  chipLast = null;
  chipMissed = 0;
  chipQuietUntil = Date.now() + 3000;
  chipParser.samples = [];
  renderChip();
}
$("chipReset").onclick = attempt(async () => {
  await resetBoard();
  toast("Board reset (RTS pulse). Boot output appears in the console.");
});
// After an upload: watch the board instead of the PC simulation, so test nodes
// (Push button, Switch, ▶ inject) trigger the real board and its Debug / Camera
// messages arrive. Debug builds with MQTT only. Returns a note, or "".
let boardTarget = ""; // the board last uploaded to (its Device ID)
async function useBoardNow(id, r) {
  if (!id || !r?.features?.debug || !r.features.net || !$("brokerUrl").value)
    return "";
  boardTarget = id;
  try {
    await stopEmulation();
    await api("runtime/start", {
      flow: chipFlow(),
      broker: broker(),
      mode: "device",
      deviceId: id,
    });
  } catch (e) {
    toast(`Could not connect to ${id}: ${e.message}`);
    return "";
  }
  // The bar shows what the board now runs: with PC inputs if it was built so.
  $("runtimeMode").value = $("emulate").checked && settings().profile !== "release" ? "emulate" : "device";
  showSimPins(null);
  resetTestDevices();
  render();
  const note = `Now working with the board ${id}: Push button, Switch, ▶ and 🖼 go to it (▶ Simulate switches back to the PC).`;
  toast(note);
  return note;
}
// Upload window: choose USB, over MQTT (no open ports) or over the LAN.
let otaView = null; // progress bar fed by "ota" events (see log())
let showUploadFailure = async () => {}; // set by the open upload window
async function knownBoard(id) {
  // Best guesses for a remote target: chip status, then the Devices list.
  const out = {
    id: id || chipLast?.id || "",
    ip: chipLast?.ip && chipLast.ip !== "(IP unset)" ? chipLast.ip : "",
  };
  try {
    const d = (await api("devices")).find((d) => d.id === out.id);
    if (d?.telemetry?.ip && !out.ip) out.ip = d.telemetry.ip;
  } catch {}
  return out;
}
const PUBLIC_BROKER = "test.mosquitto.org";
// Upload window; its MQTT broker section is brokerChooser() in brokerboard.js.
$("upload").onclick = attempt(async () => {
  // Guests cannot use this server's ports: the browser flashes the board on their own
  // USB (webflash.js), or they download the firmware.
  if (await isGuest()) {
    const area = el("div");
    const go = el("button", "primary", "⚡ Compile and upload to my board (USB)");
    const progress = el("div", "ota-progress");
    progress.hidden = true;
    const result = el("div");
    go.onclick = attempt(() => browserUploadInto({ go, progress, result }));
    const download = el("button", "", "⬇ Download firmware only");
    download.onclick = () => {
      $("modal").close();
      $("compile").click();
    };
    area.append(
      el(
        "p",
        "",
        `${$("board").selectedOptions[0].text} · flow “${flow.name}”. Plug the board into this computer's USB, click the button and pick its port (e.g. COM4) in the browser's list. Upload replaces the board's current program.`,
      ),
      el(
        "p",
        "muted",
        webFlashSupported()
          ? "Uses Chrome or Edge's Web Serial. Close the Arduino Serial Monitor or other programs using the port first."
          : "⚠ This browser cannot reach USB ports: open this page in Chrome or Edge (on https:// or localhost), or download the firmware and flash it yourself.",
      ),
      go,
      progress,
      result,
      el("p", "muted", "Log in to save on the server and upload over WiFi (MQTT or LAN). Guest firmware has no remote update."),
      download,
    );
    go.disabled = !webFlashSupported();
    return modal("Upload to my board", area);
  }
  // Old server code would build old firmware: stop here (checkServerCode, app.js).
  if (!(await checkServerCode()))
    throw Error(document.getElementById("restartBanner")?.textContent.replace(/^⚠ /, "") || "Restart npm start.");
  const base = { flow: structuredClone(chipFlow()), settings: settings() };
  // brokerNeed: why the board needs a broker (null: it does not). Not named
  // "broker": that would hide the global broker() used for the upload request.
  const {
    source,
    warnings,
    features,
    broker: brokerNeed,
    lan,
  } = await api("firmware", base);
  const known = await knownBoard($("deviceId").value.trim());
  const area = el("div");
  const s = base.settings;
  const devices = brokerNeed ? await api("devices").catch(() => []) : [];
  const chooser = brokerNeed ? brokerChooser(brokerNeed, lan, devices) : null;
  area.append(
    el(
      "p",
      "",
      `${$("board").selectedOptions[0].text} · flow “${flow.name}” · ${s.profile === "release" ? "RELEASE" : "DEBUG"} build${features?.ota ? " with remote update" : ""}${s.usbTest ? " · USB test (WiFi off, status on serial)" : features?.net ? ` · WiFi “${s.ssid || "(none)"}”` : " · offline (WiFi off)"}. Upload replaces the board’s current program.`,
    ),
    warningList(warnings),
  );
  // Which chip and which nodes go to the board (several chips: easy to mix up).
  {
    const chip = flow.chips?.length
      ? chipsOf().find((c) => c.id === currentChipId())?.name
      : "";
    const nodes = base.flow.nodes;
    const what = el(
      "p",
      "upload-what",
      `${chip ? `Uploading ${chip}: ` : "Uploading: "}${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${nodes
        .slice(0, 8)
        .map((n) => `${n.label} (${catalog[n.type]?.label || n.type})`)
        .join(", ")}${nodes.length > 8 ? ", …" : ""}`,
    );
    if (chip)
      what.title =
        "Upload sends the chip shown in the CHIPS row (and the Device panel's board and port). Switch chips there to upload another one.";
    area.append(what);
  }
  if (chooser) area.append(chooser.box);
  // Realtek and Pico boards update over USB only (no remote update firmware).
  const usbOnly = ["ameba", "rp2040"].includes(boards.find((b) => b.id === s.board)?.family);
  const methods = [
    [
      "web",
      "USB on this computer (in the browser)",
      "The board plugged into the computer you are using now: pick its port in the browser's list (Chrome or Edge). Use this when you open Microflow from another computer (micrologiclink.com).",
    ],
    [
      "usb",
      "USB cable on the server PC",
      `Serial port ${s.serialPort || "(not set)"} of the PC running Microflow. Always works there; needed for the first install.`,
    ],
    [
      "mqtt",
      "Over MQTT (no open ports)",
      "Through the broker, encrypted and signed. Works across networks; the board must run firmware built with Remote update on.",
    ],
    [
      "lan",
      "Over LAN (ArduinoOTA)",
      "Direct to the board's IP on this network. Windows Firewall must allow espota/python to accept the board's connection.",
    ],
  ].filter(([m]) => (m === "usb" || !usbOnly) && (m !== "web" || webFlashSupported()));
  const choice = el("div", "method-list");
  const targetBox = el("div", "two");
  const idInput = Object.assign(el("input"), {
    value: known.id,
    placeholder: "e.g. microflow-102fbb",
  });
  const ipInput = Object.assign(el("input"), {
    value: known.ip,
    placeholder: "e.g. 192.168.1.132",
  });
  const idLabel = el("label", "", "Board Device ID");
  idLabel.append(idInput);
  const ipLabel = el("label", "", "Board IP address");
  ipLabel.append(ipInput);
  targetBox.append(idLabel, ipLabel);
  let method = localStorage.getItem("microflow.uploadMethod") || "usb";
  if (!methods.some(([m]) => m === method)) method = methods[0][0];
  const sync = () => {
    idLabel.hidden = method !== "mqtt";
    ipLabel.hidden = method !== "lan";
    for (const r of choice.querySelectorAll("input"))
      r.checked = r.value === method;
  };
  for (const [value, title, help] of methods) {
    const label = el("label", "method");
    const radio = Object.assign(el("input"), {
      type: "radio",
      name: "uploadMethod",
      value,
    });
    radio.onchange = () => {
      method = value;
      try {
        localStorage.setItem("microflow.uploadMethod", value);
      } catch {}
      sync();
    };
    const text = el("span");
    text.append(el("b", "", title), el("small", "", help));
    label.append(radio, text);
    choice.append(label);
  }
  sync();
  // What the firmware is for: PC input emulation is built only into debug builds
  // with "PC input emulation (USB)" ticked in the Device panel (as lib/flow.js).
  const buildFor = () => {
    const s = settings();
    return (
      (s.profile !== "release" && s.emulate
        ? "Real board + PC input (USB)"
        : "Real board") + (s.usbTest ? " · USB test, WiFi off" : s.network === false ? " · WiFi off" : "")
    );
  };
  const approve = el("button", "primary", `Compile and upload for ${buildFor()}`);
  approve.title =
    "Real board: the flow runs on its own. Real board + PC input (USB): a debug build where this PC can set the input nodes over USB (Device panel → PC input emulation).";
  const progress = el("div", "ota-progress");
  // Shown when a USB upload fails: the error, a reminder that another program may
  // hold the port, and a live check of the port.
  const failure = el("div", "upload-failure");
  failure.hidden = true;
  showUploadFailure = async (error, port) => {
    // A missing setting (the broker host) stops the build before the port is
    // touched: explain it and offer the fix instead of port advice.
    if (error.stage === "settings") {
      const use = (host) =>
        button(`Use ${host} and upload`, () => {
          $("host").value = host;
          saveSettings();
          failure.hidden = true;
          toast(`Firmware broker host set to ${host}.`);
          approve.onclick(); // reads the new host (settings() at click time)
        });
      const fixes = el("div", "step-row");
      fixes.append(use("test.mosquitto.org"));
      if (error.lan) fixes.append(use(error.lan));
      failure.replaceChildren(
        el("b", "", "✗ Not uploaded: a setting is missing"),
        el("p", "", error.detail || error.message),
        fixes,
        el(
          "p",
          "muted",
          port
            ? `Nothing was sent to ${port}; the port was not used.`
            : "Nothing was sent to the board.",
        ),
      );
      failure.hidden = false;
      failure.scrollIntoView({ block: "nearest" });
      return;
    }
    // The check before compiling: the port is missing, or the chip on it is not the
    // chosen board's (lib/chipcheck.js). Nothing was compiled or sent.
    if (error.stage === "board") {
      const fixes = el("div", "step-row");
      for (const id of (error.fits || []).slice(0, 4)) {
        const b = boards.find((x) => x.id === id);
        if (!b) continue;
        fixes.append(
          button(`Use ${b.label}`, async () => {
            $("board").value = id;
            await $("board").onchange?.();
            if ($("board").value !== id) return; // switching was cancelled
            failure.hidden = true;
            toast(`Board set to ${b.label}. Press Upload again.`);
            $("modal").close();
          }),
        );
      }
      failure.replaceChildren(
        el(
          "b",
          "",
          error.chip
            ? `✗ Not uploaded: the board on ${port} is an ${error.chip}`
            : `✗ Not uploaded: check ${port}`,
        ),
        el("p", "", error.detail || error.message),
        fixes,
      );
      failure.hidden = false;
      failure.scrollIntoView({ block: "nearest" });
      return;
    }
    const portStatus = el("p", "muted", `Checking ${port}…`);
    failure.replaceChildren(
      el("b", "", "✗ Upload failed"),
      el("pre", "", error.detail || error.message),
      el(
        "p",
        "port-reminder",
        error.stage === "upload"
          ? `${port} may already be in use by another program, such as Arduino IDE's Serial Monitor, PuTTY, a browser tab connected with Web Serial, or another Microflow window. Close it, then upload again.`
          : "The upload stopped before flashing. If the message mentions the port, it may be in use by another program (Serial Monitor, PuTTY, Web Serial tab).",
      ),
      portStatus,
    );
    failure.hidden = false;
    failure.scrollIntoView({ block: "nearest" });
    try {
      const check = await api("serial/check", { path: port });
      portStatus.textContent = check.message;
      portStatus.className = "port-" + check.state;
    } catch (e) {
      portStatus.textContent = e.message;
    }
  };
  progress.hidden = true;
  approve.onclick = attempt(async () => {
    showConsole("upload"); // the console follows the upload
    // Current settings, not the ones from when the dialog opened: the fix buttons
    // (e.g. Use test.mosquitto.org) change them while the dialog is open.
    if (chooser && !chooser.host())
      throw Error(
        "Choose the MQTT broker the board connects to (MQTT broker section above).",
      );
    if (
      chooser &&
      chooser.state.ok === false &&
      !confirm(
        `The broker ${chooser.state.host || "(none)"} does not answer, so the board will not reach MQTT after this upload.\n\nOK = upload anyway · Cancel = choose another broker`,
      )
    )
      return;
    chooser?.commit(); // the broker chosen here becomes the Device panel setting
    if (method === "web") {
      const result = el("div");
      area.append(result);
      return browserUploadInto({ go: approve, progress, result });
    }
    const request = { ...base, settings: settings(), method, broker: broker() };
    if (method === "usb" && !request.settings.serialPort)
      throw Error("Enter the board’s serial port first.");
    if (method === "mqtt") request.target = { deviceId: idInput.value.trim() };
    if (method === "lan")
      request.target = {
        ip: ipInput.value.trim(),
        deviceId: idInput.value.trim() || known.id,
      };
    approve.disabled = true;
    $("upload").disabled = true;
    approve.textContent = `${method === "usb" ? "Compiling and uploading" : "Compiling and sending"} for ${buildFor()}…`;
    progress.hidden = false; // compile + upload, fed by "progress" events (app.js)
    otaView = {
      update: (pct) => progress.style.setProperty("--pct", pct + "%"),
    };
    otaView.update(0);
    try {
      if (method === "usb" && browserSerial.port)
        await browserSerial.disconnect();
      failure.hidden = true;
      let r;
      try {
        r = await api("upload", request);
      } catch (e) {
        if (method === "usb" || e.stage === "settings")
          await showUploadFailure(
            e,
            method === "usb" ? request.settings.serialPort : null,
          );
        throw e;
      }
      toast(`Firmware ${r.build} uploaded`);
      lastUploadedBuild = r.build;
      markUploaded(); // the board now runs this flow (runcheck.js)
      const checks = el("div");
      area.replaceChildren(
        el(
          "p",
          "",
          method === "usb"
            ? `Build ${r.build} uploaded over USB. Checking that the board is alive…`
            : `Build ${r.build} installed ${method === "mqtt" ? "over MQTT" : "over the LAN"}${r.features?.net && request.broker.url ? " and confirmed running (ping)" : ""}.`,
        ),
        sizeReport(r.size),
        checks,
      );
      const report =
        method === "usb"
          ? await verifyInto(checks, {
              serialPort: request.settings.serialPort,
              build: r.build,
              deviceId: request.settings.deviceId,
            })
          : null;
      // Now work with the board itself: PUSH, ▶, Switch and 🖼 go to it.
      const id =
        request.settings.deviceId ||
        report?.device?.id ||
        request.target?.deviceId ||
        "";
      const using = await useBoardNow(id, r);
      if (using) area.append(el("p", "result-head pass", using));
    } finally {
      otaView = null;
      approve.disabled = false;
      $("upload").disabled = false;
      approve.textContent = `Compile and upload for ${buildFor()}`;
    }
  });
  area.append(
    el("b", "", "Upload method"),
    choice,
    targetBox,
    approve,
    progress,
    failure,
    el("pre", "", source),
  );
  modal("Upload to board", area);
});
// ── Test terminal: commands to the chip over USB serial or MQTT ──
// Debug firmware understands: help, status, wifi [scan], gpio read|write|mode, adc,
// pwm, nodes, send <node> <payload>, pub <topic> <payload>, echo, reboot.
const termHistory = (() => {
  try {
    return JSON.parse(localStorage.getItem("microflow.termHistory") || "[]");
  } catch {
    return [];
  }
})();
let termIndex = termHistory.length;
function termAppend(text, cls = "") {
  const out = $("termOut");
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    if (!line) continue;
    out.append(el("div", "term-line " + cls, line));
  }
  while (out.children.length > 400) out.firstChild.remove();
  out.scrollTop = out.scrollHeight;
}
// Serial output appears in the terminal while it is open on USB.
// A USB command waiting for its "» " reply (see termSend).
let termAwaiting = 0;
function termSerial(text) {
  if ($("terminal").hidden || $("termVia").value !== "usb") return;
  if (/^» /m.test(text)) termAwaiting = 0;
  termAppend(text, /^» /m.test(text) ? "reply" : "");
  if (chipParser.garbled() && Date.now() > chipQuietUntil) termGarbleHint();
}
// Offered when the terminal receives unreadable bytes (at most every 15 s).
let termHintAt = 0;
function termGarbleHint(message, force = false) {
  if (!force && Date.now() - termHintAt < 15000) return;
  termHintAt = Date.now();
  const box = el("div", "term-line hint");
  box.append(
    el(
      "span",
      "",
      message ||
        `Unreadable data at ${$("baudRate").value} baud: the baud rate probably does not match. Microflow firmware uses 115200. (After a reset the ESP8266 boot ROM prints briefly at 74880; a short burst of garbage then is normal.) `,
    ),
    button(
      "Use 115200",
      attempt(() => applyBaud(115200)),
    ),
    button("Auto-detect baud", attempt(autoBaud)),
    button(
      "Reset board",
      attempt(async () => {
        await resetBoard();
        termAppend("Board reset (RTS pulse).", "note");
      }),
    ),
  );
  $("termOut").append(box);
  $("termOut").scrollTop = $("termOut").scrollHeight;
}
function termInfo() {
  $("termInfo").textContent =
    $("termVia").value === "usb"
      ? serialConnected()
        ? `USB · ${$("serialTransport").value === "browser" ? "Web Serial" : $("serialPort").value} · ${$("baudRate").value} baud`
        : "USB · not connected (Device panel → Connect serial)"
      : `MQTT · ${$("deviceId").value.trim() || chipLast?.id || targetDevice()} via ${$("brokerUrl").value}`;
}
// Applies a baud rate to the open connection (either transport).
async function applyBaud(rate) {
  $("baudRate").value = String(rate);
  saveSettings();
  if (!serialConnected()) return termInfo();
  if ($("serialTransport").value === "browser")
    await browserSerial.setBaud(rate);
  else await api("serial/baud", { baudRate: rate });
  chipParser.samples = [];
  chipQuietUntil = Date.now() + 1500;
  termInfo();
  termAppend(`Baud rate set to ${rate}.`, "note");
}
async function autoBaud() {
  if (!serialConnected())
    throw Error("Connect serial first, then auto-detect the baud rate.");
  $("baudAuto").disabled = true;
  termAppend("Detecting the baud rate (about 6 s)…", "note");
  toast("Detecting the baud rate…");
  try {
    const r =
      $("serialTransport").value === "browser"
        ? await browserSerial.detectBaud(
            detectBaud,
            Number($("baudRate").value),
          )
        : await api("serial/autobaud", {});
    const summary = r.results
      .map(
        (x) =>
          `${x.rate}: ${x.microflow ? "Microflow ✓" : x.bytes ? x.readable + "% readable" : "silent"}`,
      )
      .join(" · ");
    if (r.rom) {
      // Only the boot ROM was readable: the chip is crash-looping (or was booting).
      const crash = /Fatal exception/.test(r.sample);
      termAppend(
        crash
          ? `The only readable text is the ESP8266 boot ROM at 74880 baud reporting a crash ("${(r.sample.match(/Fatal exception[^\n]*/) || [""])[0]}"). This is not a baud problem: the chip is stuck in a crash loop. Reset it; Microflow firmware then talks at 115200.`
          : "The only readable text was the ESP8266 boot ROM at 74880 baud (the chip was restarting). Microflow firmware talks at 115200.",
        "error",
      );
      const box = el("div", "term-line hint");
      box.append(
        button(
          "Reset board and detect again",
          attempt(async () => {
            await resetBoard();
            termAppend("Board reset; waiting for it to boot…", "note");
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await autoBaud();
          }),
        ),
      );
      $("termOut").append(box);
      toast(
        crash
          ? "The chip is crash-looping: reset it."
          : "The chip was restarting; try again.",
      );
    } else if (r.rate) {
      $("baudRate").value = String(r.rate);
      saveSettings();
      const msg = `Baud rate ${r.rate}${r.microflow ? ": Microflow firmware answered" : ""}.`;
      termAppend(msg, "reply");
      toast(msg);
    } else {
      const msg =
        "No readable data at any common baud rate. The board may be silent or crash-looping: press its RST button (or Reset board) and try again, or upload Microflow firmware.";
      termAppend(msg, "error");
      toast(msg);
    }
    termAppend(summary, "note");
    chipParser.samples = [];
    chipQuietUntil = Date.now() + 1500;
  } finally {
    baudControls();
    termInfo();
  }
}
$("baudAuto").onclick = attempt(autoBaud);
$("baudRate").addEventListener(
  "change",
  attempt(() => applyBaud(Number($("baudRate").value))),
);
$("termVia").addEventListener("change", termInfo);
function termShow(open) {
  termInfo();
  $("terminal").hidden = !open;
  $("logArea").hidden = open;
  $("termToggle").setAttribute("aria-pressed", String(open));
  document.querySelector(".console").classList.toggle("term-open", open);
  if (open) {
    if (!$("termOut").children.length)
      termAppend(
        'Test terminal. Commands go to the chip via USB serial (connect it in the Device panel) or via MQTT (uses Device ID and Broker URL). Type "help". Needs a Debug build.',
        "note",
      );
    $("termLine").focus();
  }
}
$("termToggle").onclick = () => termShow($("terminal").hidden);
async function termSend(line) {
  line = line.trim();
  if (!line) return;
  termHistory.push(line);
  termHistory.splice(0, Math.max(0, termHistory.length - 30));
  termIndex = termHistory.length;
  try {
    localStorage.setItem("microflow.termHistory", JSON.stringify(termHistory));
  } catch {}
  termAppend("> " + line, "cmd");
  try {
    if ($("termVia").value === "usb") {
      if (!serialConnected())
        throw Error(
          "Serial is not connected: connect it in the Device panel, or switch to MQTT.",
        );
      await chipSend(line + "\n");
      // No readable reply soon: usually a baud mismatch (replies arrive as junk).
      const sent = (termAwaiting = Date.now());
      const wait = line.trim() === "wifi scan" ? 6000 : 1500;
      setTimeout(() => {
        if (termAwaiting !== sent) return;
        termAwaiting = 0;
        termGarbleHint(
          `No readable reply at ${$("baudRate").value} baud. Most likely the baud rate does not match (Microflow firmware uses 115200). Otherwise the board is not running a Debug Microflow build, is busy, or is crash-looping.`,
          true,
        );
      }, wait);
    } else {
      const deviceId =
        $("deviceId").value.trim() || chipLast?.id || targetDevice();
      const r = await api("terminal", { broker: broker(), deviceId, line });
      termAppend(r.reply, "reply");
      termAppend(`  (${deviceId} via MQTT, ${r.ms} ms)`, "note");
    }
  } catch (e) {
    termAppend(e.message, "error");
  }
}
$("termForm").onsubmit = (event) => {
  event.preventDefault();
  const line = $("termLine").value;
  $("termLine").value = "";
  termSend(line);
};
$("termLine").onkeydown = (event) => {
  if (event.key === "ArrowUp" && termIndex > 0)
    $("termLine").value = termHistory[--termIndex];
  else if (event.key === "ArrowDown")
    $("termLine").value =
      termHistory[++termIndex] ?? ((termIndex = termHistory.length), "");
  else return;
  event.preventDefault();
};
for (const cmd of [
  "help",
  "status",
  "wifi",
  "nodes",
  "gpio read 2",
  "adc",
  "wifi scan",
  "reboot",
]) {
  const b = button(cmd, () =>
    cmd === "reboot" && !confirm("Reboot the chip?") ? null : termSend(cmd),
  );
  $("termQuick").append(b);
}
$("termQuick").append(button("Clear", () => $("termOut").replaceChildren()));
// ── Pin guide in Node properties ────────────────────────────────
// Board-specific advice for the node's pin, and the pins that suit this node.
// Mirrors checkPin() in lib/boards.js (errors) plus pull-up and boot-pin hints.
function pinAdvice(board, pin, use, pull) {
  const lines = []; // [level, text]: "bad" | "warn" | "ok" | "info"
  if (!Number.isInteger(pin)) return [["bad", "Enter a GPIO number."]];
  const reserved = board.reserved?.[pin];
  if (reserved)
    return [
      [
        "bad",
        `GPIO ${pin} is used by the built-in ${reserved}. Pick another pin.`,
      ],
    ];
  if (use === "adc") {
    if (!board.adc.length)
      return [["bad", `${board.label} has no usable analog input.`]];
    if (!board.adc.includes(pin))
      return [
        [
          "bad",
          `GPIO ${pin} is not an analog input here. Analog pins: ${board.family === "esp8266" ? "A0 (enter 17)" : board.adc.join(", ")}.`,
        ],
      ];
    lines.push([
      "ok",
      `GPIO ${pin} is an analog input (${board.family === "esp8266" ? "0–1023" : "0–4095"}).`,
    ]);
  } else if (!board.gpio.includes(pin)) {
    return [
      [
        "bad",
        `GPIO ${pin} is not available on ${board.label} (flash, missing or reserved).`,
      ],
    ];
  } else if (
    (use === "out" || use === "pwm") &&
    board.inputOnly.includes(pin)
  ) {
    return [
      [
        "bad",
        `GPIO ${pin} is input-only: it cannot drive an output (no LED, relay or PWM).`,
      ],
    ];
  } else if (use === "pwm" && !board.pwm.includes(pin)) {
    return [["bad", `GPIO ${pin} cannot output PWM on this board.`]];
  } else if (use === "in") {
    if (board.noPull.includes(pin) && pull !== "none")
      lines.push([
        "warn",
        `GPIO ${pin} has no internal pull-up: wire a 10 kΩ resistor to 3.3 V (or GND) and choose "Floating / external resistor", otherwise it floats (often stuck at 0).`,
      ]);
    else
      lines.push([
        "ok",
        `GPIO ${pin} can be read${board.inputOnly.includes(pin) ? " (input-only pin)" : ""}.`,
      ]);
  } else
    lines.push([
      "ok",
      `GPIO ${pin} can drive an output${use === "pwm" ? " with PWM" : ""}.`,
    ]);
  if (board.strapping[pin])
    lines.push([
      "warn",
      `Boot pin (${board.strapping[pin]}): what is wired to it can stop the board from booting.`,
    ]);
  if (board.notes[pin])
    lines.push(["info", `Shared with ${board.notes[pin]}.`]);
  return lines;
}
// Pins that suit the node, best first (boot pins last).
function suitablePins(board, use) {
  const pool =
    use === "adc"
      ? board.adc
      : use === "pwm"
        ? board.pwm.filter((p) => !board.inputOnly.includes(p))
        : use === "out"
          ? board.gpio.filter((p) => !board.inputOnly.includes(p))
          : board.gpio;
  const free = pool.filter((p) => !board.reserved?.[p]);
  return [
    ...free.filter((p) => !board.strapping[p]),
    ...free.filter((p) => board.strapping[p]),
  ];
}
function pinGuide(n) {
  const def = catalog[n.type];
  const board = boards.find((b) => b.id === $("board").value);
  const box = el("div", "pin-guide");
  if (!mainPinUse(n) || !board) return box;
  const update = () => {
    const pin = Number(n.config.pin);
    const use = mainPinUse(n);
    if (!use) return box.replaceChildren();
    box.replaceChildren(el("b", "", `PIN GUIDE · ${board.label}`));
    // Another node on this pin (input + output, or two outputs) comes first.
    for (const text of pinClashesOf(n))
      box.append(el("div", "pin-bad", "✗ " + text));
    for (const [level, text] of pinAdvice(
      board,
      Number.isInteger(pin) ? pin : NaN,
      use,
      n.config.pull,
    ))
      box.append(
        el(
          "div",
          "pin-" + level,
          `${{ bad: "✗", warn: "!", ok: "✓", info: "i" }[level]} ${text}`,
        ),
      );
    const chips = el("div", "pin-chips");
    for (const p of suitablePins(board, use)) {
      const chip = button(
        String(
          p === 17 && board.family === "esp8266" && use === "adc" ? "A0" : p,
        ),
        () => {
          const follow = isDefaultName(n); // GPIO4 → GPIO26 with the pin
          n.config.pin = p;
          if (follow) setName(n, autoName(n));
          changed();
          render();
          showNode();
        },
      );
      chip.title =
        [
          board.strapping[p] && `boot pin: ${board.strapping[p]}`,
          board.notes[p],
          board.noPull.includes(p) && use === "in" && "no internal pull-up",
        ]
          .filter(Boolean)
          .join(" · ") || `GPIO ${p}`;
      if (board.strapping[p] || (use === "in" && board.noPull.includes(p)))
        chip.classList.add("caution");
      // Pins other nodes use: red if taking it would clash, else marked as shared.
      const users = pinUsers(p, n);
      if (users.length) {
        const clash = p !== pin && pinClash(n, p, use);
        chip.classList.add(clash ? "clash" : "taken");
        chip.title = `${clash ? "✗ " : ""}in use: ${users.map((u) => `${u.role} of ${nodeWho(u.m)}`).join(", ")}${chip.title ? " · " + chip.title : ""}`;
      }
      if (p === pin) chip.classList.add("current");
      chips.append(chip);
    }
    box.append(
      el(
        "span",
        "muted",
        use === "adc"
          ? "Analog pins:"
          : use === "in"
            ? "Pins you can read (amber: boot pin or no pull-up; red: used by another node as an output):"
            : "Pins that can drive an output (amber: boot pin; red: used by another node):",
      ),
      chips,
    );
    const groups = [];
    if (board.inputOnly.length)
      groups.push(`input-only, no pull-up: ${board.inputOnly.join(", ")}`);
    const reserved = Object.entries(board.reserved || {});
    if (reserved.length)
      groups.push(
        `display: ${reserved.map(([p, r]) => `${p} (${r.replace("display ", "")})`).join(", ")}`,
      );
    const boot = Object.keys(board.strapping);
    if (boot.length) groups.push(`boot pins: ${boot.join(", ")}`);
    if (groups.length)
      box.append(el("p", "muted", "This board: " + groups.join(" · ") + "."));
  };
  update();
  box.refresh = update;
  return box;
}
