// ── MQTT broker board (left bar ⇄) ──────────────────────────────
// Programs an ESP32 / ESP32-S3 as this network's MQTT broker over USB, checks it,
// then points this editor and the boards built afterwards at it.
const BROKER_FORM = "microflow.brokerBoard";
function brokerForm() {
  try {
    return JSON.parse(localStorage.getItem(BROKER_FORM) || "{}");
  } catch {
    return {};
  }
}
function bbField(label, control) {
  const l = el("label", "", label);
  l.append(control);
  return l;
}
const bbInput = (props) => Object.assign(el("input"), props);
$("brokerBoard").onclick = attempt(async () => {
  const saved = brokerForm();
  const espBoards = boards.filter(
    (b) => b.family === "esp32" && b.features.includes("wifi"),
  );
  const board = el("select");
  for (const b of espBoards) {
    const o = el("option", "", b.label);
    o.value = b.id;
    board.append(o);
  }
  board.value =
    saved.board ||
    (espBoards.some((b) => b.id === $("board").value)
      ? $("board").value
      : "esp32");
  const serialPort = bbInput({
    value: saved.serialPort || $("serialPort").value.trim(),
    placeholder: "COM3",
  });
  const port = bbInput({
    type: "number",
    min: 1,
    max: 65535,
    value: saved.port || 1883,
  });
  const username = bbInput({
    value: saved.username || "",
    placeholder: "Optional",
  });
  const password = bbInput({ type: "password", placeholder: "Optional" });
  const staticIp = bbInput({
    value: saved.staticIp || "",
    placeholder: "e.g. 192.168.1.50 (optional)",
  });
  const gateway = bbInput({
    value: saved.gateway || "",
    placeholder: "e.g. 192.168.1.1",
  });
  const subnet = bbInput({ value: saved.subnet || "255.255.255.0" });
  const heartbeat = bbInput({
    type: "number",
    min: 5,
    max: 3600,
    value: saved.heartbeat ?? 30,
  });
  const screenSeconds = bbInput({
    type: "number",
    min: 0,
    max: 3600,
    value: saved.screenSeconds ?? 60,
  });
  const screenField = bbField("Screen on time (s, 0 = always)", screenSeconds);
  // Boards without a screen: an I2C OLED (SSD1306 128×64) is used if one answers.
  const oled = bbInput({ type: "checkbox", checked: saved.oled !== false });
  const oledField = el("label", "check");
  const oledText = el("span");
  oledField.append(oled, oledText);
  const screenNote = el(
    "p",
    "muted",
    "The screen shows the broker's IP, port, clients and messages at reset and when either button is pressed, then turns off.",
  );
  const ssid = $("ssid").value;
  const result = el("div");
  const go = el("button", "primary", "Build and upload broker");
  const two = (...items) => {
    const d = el("div", "two");
    d.append(...items);
    return d;
  };
  const box = el("div", "broker-board");
  box.append(
    el(
      "p",
      "",
      "Program an ESP32 or ESP32-S3 as this network's MQTT broker. Your other boards and this editor then connect to it on the LAN instead of a public server.",
    ),
    two(bbField("Board", board), bbField("Serial port (USB)", serialPort)),
    el(
      "p",
      ssid ? "muted" : "bad",
      ssid
        ? `WiFi: “${ssid}” (from the Device panel).`
        : "Enter the WiFi SSID and password in the Device panel first.",
    ),
    two(bbField("Broker port", port), bbField("Fixed IP", staticIp)),
    two(bbField("Gateway (router)", gateway), bbField("Subnet mask", subnet)),
    el(
      "p",
      "muted",
      "A fixed IP (or a DHCP reservation in the router) keeps the broker's address stable, so boards built for it keep finding it.",
    ),
    two(
      bbField("Client username", username),
      bbField("Client password", password),
    ),
    el(
      "p",
      "muted",
      "With a username, clients must log in. Use one if the broker is reachable from outside your network.",
    ),
    oledField,
    two(bbField("Heartbeat every (s)", heartbeat), screenField),
    screenNote,
    el(
      "p",
      "muted",
      "Heartbeat: the broker reports itself (status, telemetry, ping) like a Microflow board, so it shows in Devices. Boards that miss their MQTT keep-alive are dropped and marked offline.",
    ),
    go,
    result,
  );
  // Screen settings for boards with a built-in display (TTGO T-Display, Heltec and
  // Lolin32 OLED boards), or with the I2C OLED option ticked.
  const syncScreen = () => {
    const b = boards.find((x) => x.id === board.value);
    const lcd = b?.features.includes("display");
    oledField.hidden = !!lcd;
    oledText.textContent = ` Show the broker on an I2C OLED if one is connected (SSD1306 128×64 on SDA ${b?.i2c?.sda ?? 21}, SCL ${b?.i2c?.scl ?? 22}; checked at start-up, optional)`;
    screenField.hidden = screenNote.hidden = !(lcd || oled.checked);
    screenNote.textContent = lcd
      ? "The screen shows the broker's IP, port, clients and messages at reset and when a button is pressed, then turns off."
      : "The OLED shows the broker's IP, port, clients and messages at reset and when BOOT is pressed, then turns off. Without an OLED the broker simply runs without it.";
  };
  board.onchange = syncScreen;
  oled.onchange = syncScreen;
  syncScreen();
  modal("MQTT broker board", box);
  go.onclick = attempt(async () => {
    const form = {
      board: board.value,
      serialPort: serialPort.value.trim(),
      port: Number(port.value) || 1883,
      username: username.value.trim(),
      staticIp: staticIp.value.trim(),
      gateway: gateway.value.trim(),
      subnet: subnet.value.trim(),
      heartbeat: Number(heartbeat.value),
      screenSeconds: Number(screenSeconds.value),
      oled: oled.checked,
    };
    try {
      localStorage.setItem(BROKER_FORM, JSON.stringify(form)); // no passwords
    } catch {}
    go.disabled = true;
    go.textContent = "Compiling and uploading… (about a minute)";
    result.replaceChildren(el("p", "muted", "Building the broker firmware…"));
    try {
      if (browserSerial.port) await browserSerial.disconnect();
      const r = await api("broker-board/upload", {
        ...form,
        ssid: $("ssid").value,
        password: $("password").value,
        brokerPassword: password.value,
      });
      result.replaceChildren(
        el("p", "", `Broker build ${r.build} uploaded. Checking the board…`),
        sizeReport(r.size),
      );
      await brokerCheck(result, form, r, password.value);
    } catch (e) {
      result.replaceChildren(
        el("b", "bad", "✗ Broker not uploaded"),
        el("pre", "check-error", e.detail || e.message),
      );
    } finally {
      go.disabled = false;
      go.textContent = "Build and upload broker";
    }
  });
});
// USB check of the new broker (no MQTT ping: a broker board does not answer one),
// then the address and a button that points the editor and new builds at it.
async function brokerCheck(container, form, uploaded, clientPassword) {
  const list = el("div", "verify-list");
  container.append(list);
  const rows = [];
  const view = {
    update(i, step) {
      rows[i] ||= list.appendChild(el("div", "verify-step"));
      rows[i].className =
        "verify-step " +
        (step.ok === null ? "skip" : step.ok ? "pass" : "fail");
      rows[i].replaceChildren(
        el(
          "b",
          "",
          `${step.ok === null ? "–" : step.ok ? "✓" : "✗"} ${step.name.replace("MQTT connected (board)", "Broker running")}`,
        ),
        el("span", "", step.detail),
      );
    },
  };
  activeVerify = view;
  let report;
  try {
    report = await api("verify", {
      serialPort: form.serialPort,
      build: uploaded.build,
      board: form.board,
    });
  } finally {
    if (activeVerify === view) activeVerify = null;
  }
  report.steps.forEach((s, i) => view.update(i, s));
  const ip = report.device?.ip;
  if (!report.ok || !ip || ip === "0.0.0.0") {
    container.append(
      el(
        "p",
        "bad",
        "The broker did not come up. Check the ✗ step: usually the WiFi name or password, or a fixed IP outside your router's network.",
      ),
    );
    return;
  }
  // The address came from the board over USB: switch the editor to it at once.
  const before = await useBrokerBoard({
    ip,
    port: uploaded.port,
    username: form.username,
    password: clientPassword,
  });
  const url = `mqtt://${ip}:${uploaded.port}`;
  const undo = button("Undo", async () => {
    await applyBroker(before);
    undo.disabled = true;
    toast(`Broker settings restored to ${before.url}.`);
  });
  container.append(
    el(
      "p",
      "result-head pass",
      `✓ MQTT broker running at ${url}  (also microflow-broker.local)`,
    ),
    el(
      "p",
      "",
      `Broker URL and Firmware broker host are now set to ${url} (read from the board over USB). Upload your flows again so the boards use it.`,
    ),
    undo,
    el(
      "p",
      "muted",
      "Keep the broker board powered whenever the others run. If its address changes, connect it by serial and the app picks up the new one.",
    ),
  );
}
// Broker settings in the Device panel (Broker URL for the IDE, host/port and login
// for new firmware). Returns the previous values, for Undo.
async function applyBroker({ url, host, port, username, password }) {
  if (!url) return null;
  const before = {
    url: $("brokerUrl").value,
    host: $("host").value,
    port: $("mqttPort").value,
    username: $("username").value,
    password: $("mqttPassword").value,
  };
  $("brokerUrl").value = url;
  $("host").value = host;
  $("mqttPort").value = port;
  $("username").value = username;
  $("mqttPassword").value = password;
  saveSettings();
  // A listen-only runtime follows the new broker; a running test keeps its own.
  const run = await api("runtime/status").catch(() => ({}));
  if (run.running && run.mode === "monitor")
    await api("runtime/start", {
      flow: chipFlow(),
      broker: broker(),
      mode: "monitor",
    }).catch(() => {});
  return before;
}
const useBrokerBoard = ({ ip, port, username, password }) =>
  applyBroker({
    seen: (brokerSeen = `mqtt://${ip}:${port}`),
    url: `mqtt://${ip}:${port}`,
    host: ip,
    port,
    username: username ?? $("username").value,
    password: password ?? $("mqttPassword").value,
  });
// A broker board on the serial port reports "broker":1 with its IP and port in
// its MF:{…} status line (chip status card): adopt that address automatically.
let brokerSeen = "";
function brokerFromSerial(status) {
  if (status.broker !== 1 || !status.ip || status.ip === "0.0.0.0") return;
  const url = `mqtt://${status.ip}:${status.port || 1883}`;
  if (url === brokerSeen) return; // once per address: later manual edits stay
  brokerSeen = url;
  if ($("brokerUrl").value === url && $("host").value === status.ip) return;
  useBrokerBoard({ ip: status.ip, port: status.port || 1883 }).then(() =>
    toast(
      `Broker board ${status.id} is at ${url}: Broker URL and Firmware broker host updated. Upload flows again so boards use it.`,
    ),
  );
}
// ── Upload window: which MQTT broker the board connects to ──
// Starts from the Device panel's broker settings (nothing is overwritten on open).
// Presets fill the fields; the fields are saved to the Device panel on upload.
function brokerChooser(reason, lan, devices = []) {
  const box = el("div", "broker-choice");
  // mqtt://user:pass@host:port → host, port. A pattern, not new URL(): some
  // browsers do not parse the host of non-web schemes such as mqtt://.
  const parts = (url) =>
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]+)(?::(\d+))?/i.exec(
      String(url || "").trim(),
    ) || [];
  // This PC's own addresses mean nothing to the board.
  const urlHost = (url) => {
    const h = parts(url)[1] || "";
    return /^(127\.|localhost$|0\.0\.0\.0$|\[::1\]$)/i.test(h) ? "" : h;
  };
  const urlPort = (url) => Number(parts(url)[2]) || 0;
  const panel = {
    host: $("host").value.trim() || urlHost($("brokerUrl").value),
    port: Number($("mqttPort").value) || urlPort($("brokerUrl").value) || 1883,
    url: $("brokerUrl").value.trim(),
  };
  // Presets: [id, title, help, host, port, editor URL]
  const presets = [];
  if (panel.host)
    presets.push([
      "panel",
      "As in the Device panel",
      `Board connects to ${panel.host}:${panel.port}; this editor uses ${panel.url || "(no Broker URL)"}.`,
      panel.host,
      panel.port,
      panel.url || `mqtt://${panel.host}:${panel.port}`,
    ]);
  for (const d of devices)
    if (
      (d.telemetry?.broker === 1 || d.id.startsWith("broker-")) &&
      d.telemetry?.ip &&
      d.telemetry.ip !== "0.0.0.0"
    ) {
      const p = d.telemetry.port || 1883;
      presets.push([
        "board-" + d.id,
        `Broker board ${d.id}`,
        `Your ESP32 broker at ${d.telemetry.ip}:${p} (local network, no internet needed).`,
        d.telemetry.ip,
        p,
        `mqtt://${d.telemetry.ip}:${p}`,
      ]);
    }
  presets.push([
    "public",
    "Public test broker",
    `${PUBLIC_BROKER} on the internet. Works right away; anyone can read the messages, so use it for tests only.`,
    PUBLIC_BROKER,
    1883,
    `mqtt://${PUBLIC_BROKER}:1883`,
  ]);
  if (lan)
    presets.push([
      "pc",
      "This PC",
      `${lan}: needs an MQTT broker (e.g. Mosquitto) running on this PC.`,
      lan,
      1883,
      "mqtt://127.0.0.1:1883", // the editor reaches a broker on this PC locally
    ]);
  const host = Object.assign(el("input"), {
    value: panel.host,
    placeholder: "e.g. 192.168.1.133 or broker.example.com",
  });
  const port = Object.assign(el("input"), {
    type: "number",
    min: 1,
    max: 65535,
    value: panel.port,
  });
  const url = Object.assign(el("input"), {
    value: panel.url,
    placeholder: "mqtt://192.168.1.133:1883",
  });
  const label = (text, input) => {
    const l = el("label", "", text);
    l.append(input);
    return l;
  };
  const fields = el("div", "two");
  fields.append(
    label("Board connects to (Firmware broker host)", host),
    label("Port", port),
  );
  const status = el("p", "muted", "");
  const state = { ok: null, host: "" };
  let token = 0;
  async function check() {
    const h = host.value.trim(),
      p = Number(port.value) || 1883;
    state.host = h;
    const mine = ++token;
    if (!h) {
      state.ok = false;
      status.className = "bad";
      status.textContent =
        "Choose a broker above, or enter the host the board should connect to.";
      return;
    }
    state.ok = null;
    status.className = "muted";
    status.textContent = `Checking ${h}:${p}…`;
    try {
      const r = await api("broker/probe", { host: h, port: p });
      if (mine !== token) return;
      state.ok = r.ok;
      status.className = r.ok ? "port-free" : "bad";
      status.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
    } catch (e) {
      if (mine !== token) return;
      state.ok = false;
      status.className = "bad";
      status.textContent = "✗ " + (e.detail || e.message);
    }
  }
  const list = el("div", "method-list");
  const radios = [];
  for (const [id, title, help, h, p, u] of presets) {
    const row = el("label", "method");
    const radio = Object.assign(el("input"), {
      type: "radio",
      name: "brokerChoice",
      value: id,
    });
    radio.onchange = () => {
      host.value = h;
      port.value = p;
      url.value = u;
      check();
    };
    radios.push([radio, h, p]);
    const text = el("span");
    text.append(el("b", "", title), el("small", "", help));
    row.append(radio, text);
    list.append(row);
  }
  // The preset matching the fields is shown as selected.
  const sync = () => {
    for (const [radio, h, p] of radios)
      radio.checked =
        host.value.trim() === h && (Number(port.value) || 1883) === p;
  };
  let typing;
  host.oninput = port.oninput = () => {
    // The editor follows the board's broker; a broker on this PC is reached locally.
    const h = host.value.trim();
    const p = Number(port.value) || 1883;
    if (h) url.value = `mqtt://${h === lan ? "127.0.0.1" : h}:${p}`;
    sync();
    clearTimeout(typing);
    typing = setTimeout(check, 500);
  };
  sync();
  box.append(
    el("b", "", "MQTT broker"),
    el("p", "muted", `The board needs one because ${reason}.`),
    list,
    fields,
    label("This editor uses (Broker URL, for tests and Devices)", url),
    status,
  );
  check();
  // Saves the fields to the Device panel (called when uploading).
  const commit = () => {
    $("host").value = host.value.trim();
    $("mqttPort").value = Number(port.value) || 1883;
    if (url.value.trim()) $("brokerUrl").value = url.value.trim();
    saveSettings();
  };
  return { box, state, commit, host: () => host.value.trim() };
}
