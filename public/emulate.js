// ── PC input emulation (hardware-in-the-loop) ───────────────────
// The flow runs on the real board: outputs and communication are real, but the
// board's input nodes read the values set here ("emu <pin> <value>" over the USB
// serial port). Needs a Debug build with "PC input emulation" ticked. The board
// reports every node's output as MF:{"n":…,"v":…}, which drives the GPIO circles,
// the Oscilloscope and the node flashes, so the real board's behaviour shows here.
// While emulating, every box has a yellow outline, and the boxes themselves are the
// controls (nothing in the flow changes between emulation and the real circuit):
// GPIO input boxes get PUSH (held = pressed), SWITCH and REAL (the real pin again);
// Analog sample boxes a slider; Input device boxes a value field (the PC stands in
// for the sensor: "emu node <id> <value>"); GPIO output, PWM and Pulse boxes show
// HIGH / LOW, the duty or PULSE as the real board reports it; Output devices show
// the value they act on (servo angle, display text…).
// Loaded before app.js (its state is read there); functions run only after load.
let emuActive = false;
const emuInputs = new Map(); // input pin → { role: "in" | "adc", value: null = real pin }
const emuLevels = new Map(); // pin → last level seen on the real board (from reports)
const emuDevices = new Map(); // input device node id → value sent by the PC (null = sensor)
const emuPulsing = new Set(); // Pulse output pins in their pulse now
// Serial writes share the port with the status poll: queue them, retry when busy.
let emuQueue = Promise.resolve();
function emuSend(line) {
  const send = async () => {
    for (let attempt = 0; ; attempt++)
      try {
        return await chipSend(line + "\n");
      } catch (e) {
        if (attempt >= 10 || !/busy|in progress/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 30));
      }
  };
  const next = emuQueue.then(send, send);
  emuQueue = next.catch(() => {});
  return next;
}
// Input pins of the flow: digital inputs (GPIO input, GPIO input (change)) and ADC.
function emuInputPins() {
  const pins = new Map();
  for (const n of chipFlow().nodes) {
    const role = catalog[n.type]?.pin;
    if (role === "in" || role === "adc")
      pins.set(n.config.pin, {
        role,
        // Pressing a pull-up button pulls the pin LOW, so LOW is its "active" level.
        active: role === "in" && n.config.pull === "pullup" ? 0 : 1,
      });
  }
  return pins;
}
async function startEmulation() {
  if (!serialConnected())
    throw Error(
      "Connect the board's serial port first (Device panel → Serial monitor), then start again.",
    );
  if (chipLast && !chipLast.emu)
    throw Error(
      "The firmware on this board has no PC input emulation. Upload a Debug build with “PC input emulation” ticked, then start again.",
    );
  await api("runtime/stop", {}).catch(() => {}); // the PC simulator would compete
  emuInputs.clear();
  emuLevels.clear();
  emuDevices.clear();
  emuPulsing.clear();
  for (const [pin, info] of emuInputPins())
    emuInputs.set(pin, { ...info, value: null });
  await emuSend("emu off"); // start from the real pins
  emuActive = true;
  document.body.classList.add("emulating");
  resetTestDevices();
  showEmuPins();
  render(); // the boxes get their emulation controls
  $("runtimeStatus").textContent = "Real board · PC inputs over USB";
  $("connectionDot").style.background = "#c08a3e";
  toast(
    chipLast
      ? "Emulation started (yellow boxes): use PUSH / SWITCH on GPIO inputs, the slider on analog inputs and PC values on input devices; outputs show what the real board does."
      : "Emulation started. Waiting for the board's status: if inputs do not react, upload a Debug build with “PC input emulation” ticked.",
  );
}
async function stopEmulation() {
  if (!emuActive) return;
  emuActive = false;
  emuInputs.clear();
  emuLevels.clear();
  emuDevices.clear();
  emuPulsing.clear();
  document.body.classList.remove("emulating");
  nodeValues.clear();
  showSimPins(null);
  render();
  updatePinLeds();
  $("runtimeStatus").textContent = "Runtime idle";
  $("connectionDot").style.background = "#a5b0a4";
  if (serialConnected()) await emuSend("emu off").catch(() => {});
}
async function emuSet(pin, value) {
  const info = emuInputs.get(pin);
  await emuSend(`emu ${pin} ${value === null ? "off" : value}`);
  if (info) info.value = value;
  // A digital input the PC drives shows that level at once (the board reports it too).
  if (info?.role === "in" && value !== null) emuLevels.set(pin, value ? 1 : 0);
  showEmuPins();
  updatePinLeds();
  updateEmuControls();
}
// An input device's value from the PC (null: read the real sensor again).
async function emuDevice(id, value) {
  await emuSend(`emu node ${id} ${value === null ? "off" : value}`);
  emuDevices.set(id, value);
  updateEmuControls();
}
// ── Controls on the boxes while emulating (called by render() in app.js) ──
const EMU_GPIO_INPUTS = new Set(["digital-read", "gpio-watch"]);
const EMU_SAMPLES = {
  temp: "21.5",
  volt: "1.65",
  scope: "1.65",
  gyro: '{"pitch":10,"roll":-5}',
};
function emuControls(n, e) {
  if (!emuActive) return;
  const pin = Number(n.config.pin);
  const info = emuInputs.get(pin);
  if (EMU_GPIO_INPUTS.has(n.type) && info) {
    const box = el("div", "sim-controls emu-controls");
    const push = el("button", "test-push", "PUSH");
    push.title = `Hold to press: GPIO ${pin} reads ${info.active ? "HIGH" : "LOW"} on the board while held`;
    push.onpointerdown = (event) => {
      event.stopPropagation();
      push.classList.add("down");
      attempt(() => emuSet(pin, info.active))();
      document.addEventListener(
        "pointerup",
        () => {
          push.classList.remove("down");
          attempt(() => emuSet(pin, 1 - info.active))();
        },
        { once: true },
      );
    };
    const toggle = el("button", "test-toggle emu-switch");
    toggle.dataset.pin = pin;
    toggle.title = `Switch: ON = GPIO ${pin} ${info.active ? "HIGH" : "LOW"} (pressed), OFF = released`;
    toggle.onclick = (event) => {
      event.stopPropagation();
      const now = emuInputs.get(pin);
      attempt(() =>
        emuSet(pin, now.value === now.active ? 1 - now.active : now.active),
      )();
    };
    const real = el("button", "emu-real emu-pin-real", "REAL");
    real.dataset.pin = pin;
    real.title = "Read the real pin again (the PC stops driving it)";
    real.onclick = (event) => {
      event.stopPropagation();
      attempt(() => emuSet(pin, null))();
    };
    box.append(push, toggle, real);
    e.append(box);
  } else if (n.type === "analog-in" && info) {
    const max =
      boards.find((b) => b.id === $("board").value)?.family === "esp8266"
        ? 1023
        : 4095;
    const box = el("div", "sim-controls emu-controls");
    const slider = Object.assign(el("input", "emu-slider"), {
      type: "range",
      min: 0,
      max,
      value: info.value ?? 0,
    });
    slider.dataset.pin = pin;
    slider.setAttribute("aria-label", `PC value for analog pin ${pin}`);
    slider.onpointerdown = (event) => event.stopPropagation();
    slider.onchange = attempt(() => emuSet(pin, Number(slider.value)));
    const real = el("button", "emu-real emu-pin-real", "REAL");
    real.dataset.pin = pin;
    real.title = "Read the real pin again";
    real.onclick = (event) => {
      event.stopPropagation();
      attempt(() => emuSet(pin, null))();
    };
    box.append(slider, real);
    e.append(box);
  } else if (n.type === "input-device" && n.config.device !== "camera") {
    const box = el("div", "sim-controls emu-controls emu-device");
    const field = Object.assign(el("input", "emu-value"), {
      placeholder: EMU_SAMPLES[n.config.device] || "value",
      value: emuDevices.get(n.id) ?? "",
    });
    field.dataset.node = n.id;
    field.setAttribute("aria-label", `Value the PC sends for ${n.label}`);
    field.title = "The PC stands in for the sensor: type a value and press Enter (or PC). REAL reads the sensor again.";
    const send = () => {
      const v = field.value.trim();
      if (v) attempt(() => emuDevice(n.id, v))();
    };
    field.onpointerdown = (event) => event.stopPropagation();
    field.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") send();
    };
    const pc = el("button", "test-toggle", "PC");
    pc.onclick = (event) => {
      event.stopPropagation();
      send();
    };
    const real = el("button", "emu-real emu-node-real", "REAL");
    real.dataset.node = n.id;
    real.onclick = (event) => {
      event.stopPropagation();
      attempt(() => emuDevice(n.id, null))();
    };
    box.append(field, pc, real);
    e.append(box);
  }
}
// Keeps the box controls in step with the emulated pins and devices.
function updateEmuControls() {
  for (const t of document.querySelectorAll(".emu-switch")) {
    const info = emuInputs.get(Number(t.dataset.pin));
    const on = !!info && info.value === info.active;
    t.textContent = on ? "ON" : "OFF";
    t.classList.toggle("on", on);
    t.setAttribute("aria-pressed", String(on));
  }
  for (const r of document.querySelectorAll(".emu-pin-real")) {
    const info = emuInputs.get(Number(r.dataset.pin));
    r.classList.toggle("active", !info || info.value === null);
  }
  for (const r of document.querySelectorAll(".emu-node-real"))
    r.classList.toggle("active", !emuDevices.get(r.dataset.node));
}
// Switch and Push button: in emulation they fire on the board through the test
// terminal's "send <node> <payload>"; otherwise through the runtime (simulator or MQTT).
const triggerNode = (id, payload) =>
  emuActive
    ? emuSend(`send ${id} ${payload}`)
    : api("runtime/inject", { id, payload });
function showEmuPins() {
  const strip = $("simPins");
  strip.hidden = !emuActive;
  if (!emuActive) return;
  strip.replaceChildren(el("span", "sim-title", "PC INPUTS · REAL BOARD"));
  if (!emuInputs.size)
    strip.append(
      el(
        "span",
        "muted",
        "This flow has no input pins. Switch and Push button boxes still fire on the board.",
      ),
    );
  for (const [pin, info] of [...emuInputs].sort((a, b) => a[0] - b[0])) {
    const chip = el("div", "sim-pin emu " + info.role);
    const real = info.value === null;
    if (info.role === "in") {
      const next = real ? info.active : info.value ? 0 : 1;
      const toggle = button(
        `GPIO ${pin} · ${real ? "real pin" : info.value ? "HIGH" : "LOW"}`,
        attempt(() => emuSet(pin, next)),
      );
      toggle.title = real
        ? `Reading the real pin. Click to drive it ${next ? "HIGH" : "LOW"} from the PC.`
        : "Click to flip the emulated level";
      toggle.setAttribute("aria-pressed", String(!real && !!info.value));
      chip.append(toggle);
    } else {
      const max =
        boards.find((b) => b.id === $("board").value)?.family === "esp8266"
          ? 1023
          : 4095; // ESP32 and Realtek boards read 12 bits
      const slider = el("input");
      Object.assign(slider, {
        type: "range",
        min: 0,
        max,
        value: info.value ?? 0,
      });
      slider.setAttribute(
        "aria-label",
        `Emulated analog value for GPIO ${pin}`,
      );
      const out = el("span", "", real ? "real" : String(info.value));
      slider.oninput = () => (out.textContent = slider.value);
      slider.onchange = attempt(() => emuSet(pin, Number(slider.value)));
      chip.append(el("span", "", `ADC ${pin}`), slider, out);
    }
    if (!real) {
      const release = button(
        "real",
        attempt(() => emuSet(pin, null)),
        "emu-real",
      );
      release.title = "Stop emulating: read the real pin again";
      chip.append(release);
    }
    strip.append(chip);
  }
}
// A node report from the board: flash the node and follow pins and scopes.
function emuTrace(id, value) {
  const n = flow.nodes.find((n) => n.id === id);
  if (!n) return;
  const box = $("node-" + id);
  if (box && !consolePaused) {
    box.classList.add("flash");
    setTimeout(() => box.classList.remove("flash"), 250);
  }
  const v = String(value);
  // The value each box handled on the board (servo angle, display text…).
  nodeValues.set(id, v.slice(0, 60));
  if (typeof servoValue === "function") servoValue(id, v); // the servo arm follows
  const shown = box?.querySelector?.(".node-value");
  if (shown) shown.textContent = nodeValues.get(id);
  const off = v === "0" || v === "false";
  const c = n.config;
  if (n.type === "digital-write") emuLevels.set(c.pin, off ? 0 : 1);
  else if (n.type === "gpio-watch" || n.type === "digital-read")
    emuLevels.set(c.pin, off ? 0 : 1);
  else if (n.type === "pwm-write" && Number.isFinite(Number(v)))
    emuLevels.set(c.pin, Math.max(0, Math.min(255, Math.trunc(Number(v)))));
  else if (n.type === "pulse" && (v === "1" || v === "0")) {
    emuLevels.set(c.pin, c.active === "low" ? 1 - Number(v) : Number(v));
    if (v === "1") emuPulsing.add(c.pin);
    else emuPulsing.delete(c.pin);
  }
  else if (n.type === "test-scope") scopeSample(id, v);
  if (emuActive) updatePinLeds();
}
// ── Start Real Simulation: check the board, then start PC input emulation ──
// Serial text seen after the chip-status parser (app.js log) — for reply checks.
const serialWaiters = new Set();
function emuSerialText(text) {
  for (const w of serialWaiters) {
    w.seen = (w.seen + text).slice(-2048);
    if (w.pattern.test(w.seen)) w.done(true);
  }
}
function waitForSerial(pattern, ms) {
  return new Promise((resolve) => {
    const w = { pattern, seen: "" };
    const timer = setTimeout(() => w.done(false), ms);
    w.done = (ok) => {
      clearTimeout(timer);
      serialWaiters.delete(w);
      resolve(ok);
    };
    serialWaiters.add(w);
  });
}
// Asks "mf?" until a fresh status report arrives (chipLast is set by panels.js).
async function handshake(tries = 3, ms = 1500) {
  const since = Date.now();
  for (let i = 0; i < tries; i++) {
    await emuSend("mf?").catch(() => {});
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (chipLast && chipLast.at >= since) return chipLast;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return null;
}
async function realSimulation(connecting) {
  const list = el("div", "verify-list");
  const note = el("p", "muted", "Checking the board before starting…");
  const actions = el("div", "step-row");
  const box = el("div");
  box.append(note, list, actions);
  modal("Start Real Simulation", box);
  const step = (name) => {
    const row = list.appendChild(el("div", "verify-step"));
    const set = (ok, detail) => {
      row.className =
        "verify-step " + (ok === null ? "skip" : ok ? "pass" : "fail");
      row.replaceChildren(
        el("b", "", `${ok === null ? "–" : ok ? "✓" : "✗"} ${name}`),
        el("span", "", detail),
      );
      return ok !== false;
    };
    set(null, "checking…");
    return set;
  };
  // Marks a step failed and stops: the note says what to do, with a retry button.
  const stop = (set, detail) => {
    set(false, detail);
    note.textContent = "Not started. Fix the ✗ step, then check again.";
    note.className = "bad";
    actions.replaceChildren(
      button(
        "↻ Check again",
        () =>
          realSimulation(
            serialConnected() ? null : $("serialConnect").onclick(),
          ),
        "primary",
      ),
    );
    return false;
  };
  await stopEmulation();
  // 1. Serial port
  const port = step("Serial port connected");
  await connecting;
  const where =
    $("serialTransport").value === "browser"
      ? "Web Serial"
      : `Local serial ${$("serialPort").value.trim() || "(no port chosen)"}`;
  if (!serialConnected())
    return stop(
      port,
      `${where}: not connected. Choose the board's port in the Device panel (↻ lists ports) and connect.`,
    );
  port(true, where);
  // 2. Baud rate
  const baud = step("Baud rate");
  if ($("baudRate").value !== "115200")
    return stop(
      baud,
      `${$("baudRate").value} baud: Microflow firmware talks at 115200. Set Baud rate to 115200 and check again.`,
    );
  baud(true, "115200");
  // 3. Handshake
  const hello = step("Device answers (handshake)");
  const status = await handshake();
  if (!status)
    return stop(
      hello,
      chipParser.garbled()
        ? "Unreadable data: wrong baud rate or the chip is crash-looping. Try Auto-detect baud or reset the board."
        : "No answer to mf?. Is this the board's port, is it powered, and does it run a Microflow Debug build? Try resetting the board.",
    );
  hello(true, `device ${status.id} · build ${status.build}`);
  // 4. Emulation support
  const emu = step("Firmware supports PC inputs");
  if (!status.emu)
    return stop(
      emu,
      "This firmware has no PC input emulation. Choose a Debug build, tick “PC input emulation (USB)” and upload, then check again.",
    );
  emu(true, "emulation build");
  // 5. Same flow as on screen (a warning only: the board may run an older build)
  const same = step("Board runs this flow");
  try {
    const { build } = await api("firmware", {
      flow: chipFlow(),
      settings: { ...settings(), emulate: true },
    });
    same(
      build === status.build ? true : null,
      build === status.build
        ? `build ${build}`
        : `board has build ${status.build}, this flow builds ${build}. Inputs follow the flow on the board; upload to test the flow on screen.`,
    );
  } catch (e) {
    same(null, `could not compare builds: ${e.message}`);
  }
  // 6. Command round trip over the same port
  const cmd = step("Commands reach the board");
  const reply = waitForSerial(/» emu[: ]/, 2500);
  await emuSend("emu").catch(() => {});
  if (!(await reply))
    return stop(
      cmd,
      "The board answered mf? but not the emu command. Close other programs using the port and check again.",
    );
  cmd(true, "emu command answered");
  // 7. Start
  const start = step("PC inputs active");
  try {
    $("runtimeMode").value = "emulate";
    saveSettings();
    await startEmulation();
  } catch (e) {
    return stop(start, e.message);
  }
  start(
    true,
    emuInputs.size
      ? `${emuInputs.size} input pin${emuInputs.size > 1 ? "s" : ""} ready in PC INPUTS`
      : "no input pins in this flow; Switch and Push button still work",
  );
  note.textContent =
    "Real simulation running: outputs are real, inputs come from PC INPUTS. ■ Stop ends it.";
  note.className = "";
  actions.replaceChildren(button("Close", () => $("modal").close(), "primary"));
  return true;
}
