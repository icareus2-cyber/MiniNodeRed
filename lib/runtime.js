const mqtt = require("mqtt");
const { KEY: PWA_KEY, folderOf: pwaFolder } = require("./pwafw");
const { toJson } = require("./webfw");
const { validate, wiring } = require("./flow");
const {
  types: defs,
  isManual,
  isMqttRadio,
  parseBroker,
  pinsOf,
  convertValue,
} = require("./nodes");
const { HELP } = require("./shellfw");
const { msgIn, payloadOf, msgOut, checkFields } = require("./msg");
// Status topics for one board, or for every board when id is "+".
const monitorTopics = (id) => [
  `microflow/${id}/status`,
  `microflow/${id}/telemetry`,
  `microflow/${id}/debug/+`,
];
function matches(filter, topic) {
  const f = filter.split("/"),
    t = topic.split("/");
  if (topic.startsWith("$") && !filter.startsWith("$")) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (t[i] === undefined || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}
// Turns low-level MQTT connection errors into advice the user can act on.
function brokerHint(err, url) {
  const message = err?.message || String(err);
  const code = err?.code || /E[A-Z_]{3,}/.exec(message)?.[0];
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {}
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  if (code === "ECONNREFUSED")
    return local
      ? `No MQTT broker is running on this PC (${url}). Start one (e.g. Mosquitto), or click "Use public test broker". The PC and the board must use the same broker.`
      : `${host} refused the connection. Check the broker URL and port, and that the broker is running.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return `Cannot find ${host}. Check the broker host name and this PC's internet connection.`;
  if (
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    /timeout/i.test(message)
  )
    return `${host} did not answer. Check the address, network and firewall.`;
  if (/not authori[sz]ed|bad user ?name or password/i.test(message))
    return "The broker rejected the MQTT username or password.";
  return message;
}
function checkBroker(broker = {}) {
  let url;
  try {
    url = new URL(broker.url);
  } catch {
    throw Error("Enter a broker URL such as mqtt://192.168.1.10:1883");
  }
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol))
    throw Error("Use mqtt://, mqtts://, ws:// or wss://");
  return {
    url: url.href,
    username: broker.username || undefined,
    password: broker.password || undefined,
  };
}
// Host runtime. mode "host" executes the flow on this PC against a real broker,
// mirroring firmware topics (microflow/<device>/…) so tests work on either target.
// mode "device" only monitors real boards and forwards inject requests to them.
class FlowRuntime {
  constructor(emit, { connect = mqtt.connect, onDevice = () => {} } = {}) {
    this.emit = emit;
    this.connect = connect;
    this.onDevice = onDevice;
    this.client = null;
    this.flow = null;
    this.timers = [];
    this.timeouts = new Set();
    this.generation = 0;
    this.pins = new Map();
    this.state = new Map();
    this.webVals = new Map(); // Web out name → JSON text
    this.stills = new Map(); // Camera node id → latest simulated PNG
    this.own = new Map(); // Radio out node id → client of its own broker (Advanced)
    this.pwaLast = new Map(); // PWA node id → what its phone page shows (JSON)
  }
  status() {
    return {
      running: !!this.flow,
      connected: !!this.client?.connected,
      mode: this.mode || null,
      deviceId: this.deviceId || null,
      pins: Object.fromEntries(this.pins),
      lcd: this.lcd ? [...this.lcd.values()] : [],
    };
  }
  // message: "Runtime stopped", or "Restarting" when start() replaces a run (the
  // IDE then keeps its virtual pins, which the new run's status brings).
  stop(message = "Runtime stopped") {
    this.generation++;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.timeouts.forEach(clearTimeout);
    this.timeouts.clear();
    this.lcd = null;
    this.flow = null;
    this.state.clear();
    this.webVals.clear();
    this.pwaLast.clear();
    this.pwaHinted = false;
    for (const c of this.own.values()) c.end(true);
    this.own.clear();
    if (this.client) {
      // Publish "offline" ourselves: a clean disconnect does not trigger the last will.
      if (this.mode === "host" && this.client.connected)
        this.client.publish(this.base + "/status", "offline", { retain: true });
      this.client.end(false);
      this.client = null;
    }
    this.emit("status", message, { connected: false });
  }
  // offline: simulate without a broker (host mode only; MQTT nodes then cannot work).
  start({ flow, broker, mode = "host", deviceId, offline = false }) {
    validate(flow);
    // monitor: only listens (every board's status, telemetry, debug); no flow runs.
    if (!["host", "device", "monitor"].includes(mode))
      throw Error("Unknown runtime mode.");
    if (offline && mode !== "host")
      throw Error("Only the PC simulation can run without a broker.");
    const options = offline ? null : checkBroker(broker);
    if (deviceId && !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId))
      throw Error("Device ID may use letters, digits, - and _.");
    if (mode === "device" && !deviceId)
      throw Error("Enter the board's Device ID to monitor it (see Devices).");
    this.stop(this.flow ? "Restarting" : "Runtime stopped");
    this.flow = flow;
    this.edges = wiring(flow);
    this.mode = mode;
    this.deviceId = deviceId || "sim";
    this.base = "microflow/" + this.deviceId;
    this.resetPins();
    if (offline)
      this.emit(
        "status",
        `Simulating on this PC as ${this.deviceId} · no MQTT`,
        { connected: false },
      );
    else this.connectBroker(flow, mode, options);
    if (mode === "host") this.startSimulation(flow);
    return this.status();
  }
  connectBroker(flow, mode, options) {
    const where = new URL(options.url).host;
    const token = this.generation;
    const live = () => token === this.generation;
    const client = (this.client = this.connect(options.url, {
      username: options.username,
      password: options.password,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
      will:
        mode === "host"
          ? {
              topic: this.base + "/status",
              payload: "offline",
              retain: true,
              qos: 0,
            }
          : undefined,
    }));
    client.on("connect", () => {
      if (!live()) return;
      this.emit(
        "status",
        mode === "host"
          ? `MQTT connected to ${where} · simulating as ${this.deviceId}`
          : mode === "monitor"
            ? `MQTT connected to ${where} · listening for all boards`
            : `MQTT connected to ${where} · monitoring ${this.deviceId}`,
        {
          connected: true,
        },
      );
      // Device mode listens only to its board, so strangers' boards on a shared or
      // public broker never show up; the simulator discovers any board.
      const topics = monitorTopics(mode === "device" ? this.deviceId : "+");
      if (mode === "host") {
        client.publish(this.base + "/status", "online", { retain: true });
        topics.push(this.base + "/ping", this.base + "/cmd");
        for (const n of flow.nodes) {
          if (n.type === "mqtt-in" && isMqttRadio(n))
            topics.push(this.topic(n.config.topic));
          if (isManual(n)) topics.push(`${this.base}/inject/${n.id}`);
          // PWA: keys from a phone page connected to the broker.
          if (n.type === "pwa") topics.push(`${this.base}/pwa/${n.id}/in`);
        }
      } else
        // Watch the board's MQTT traffic so its outputs show in the console.
        for (const n of flow.nodes)
          if (isMqttRadio(n)) topics.push(this.topic(n.config.topic));
        // What the board shows on its phone pages (the IDE's test page follows it).
        if (mode === "device") topics.push(`${this.base}/pwa/+/out`);
      client.subscribe(
        [...new Set(topics)],
        (err) => err && live() && this.emit("error", err.message),
      );
    });
    // Reconnects every 3 s; report each distinct problem once instead of spamming.
    // Reports name the broker and keep the specific reason; mqtt.js follows every
    // failed attempt with "offline", which must not hide the reason.
    let lastError = null,
      wasConnected = false;
    client.on("connect", () => {
      lastError = null;
      wasConnected = true;
    });
    client.on("error", (err) => {
      const hint = brokerHint(err, options.url);
      if (!live() || hint === lastError) return;
      lastError = hint;
      this.emit("error", hint);
      this.emit("status", `Cannot reach ${where} · retrying every 3 s`, {
        connected: false,
      });
    });
    client.on("offline", () => {
      if (!live() || !wasConnected) return;
      wasConnected = false;
      this.emit("warning", `Lost the connection to ${where}; reconnecting…`);
      this.emit("status", `Connection to ${where} lost · reconnecting`, {
        connected: false,
      });
    });
    client.on(
      "message",
      (topic, buffer, packet) =>
        live() && this.message(topic, buffer.toString(), packet),
    );
  }
  // Timers, pulse trains and boot screens: the parts of the flow that run by themselves.
  // Radio out nodes with a broker of their own (Advanced) get their own client, like
  // the firmware; it connects in the background and publishes only while connected.
  ownBrokers(flow) {
    for (const n of flow.nodes) {
      const c = n.config;
      if (n.type !== "mqtt-out" || (c.protocol || "mqtt") !== "mqtt") continue;
      const own = parseBroker(c.broker);
      if (!own) continue;
      const where = `${own.host}:${own.port}`;
      try {
        const client = this.connect(`mqtt://${where}`, {
          clientId: c.clientId || `${this.deviceId}-${n.id}`,
          username: c.username || undefined,
          password: c.password || undefined,
          connectTimeout: 8000,
          reconnectPeriod: 5000,
        });
        client.on("connect", () =>
          this.emit("status", `${n.label}: connected to its broker ${where}`),
        );
        client.on("error", (err) =>
          this.emit("warning", `${n.label}: broker ${where}: ${err.message}`),
        );
        this.own.set(n.id, client);
      } catch (err) {
        this.emit("warning", `${n.label}: broker ${where}: ${err.message}`);
      }
    }
  }
  startSimulation(flow) {
    this.ownBrokers(flow);
    for (const n of flow.nodes) {
      const every =
        n.type === "inject" || n.type === "analog-in" || n.type === "digital-read"
          ? n.config.interval
          : 0;
      if (every > 0)
        this.timers.push(
          setInterval(
            () =>
              this.run(
                n.id,
                n.type === "inject"
                  ? n.config.payload
                  : String(this.readPin(n.config.pin)),
              ),
            every,
          ),
        );
    }
    for (const n of flow.nodes) {
      if (n.type === "pulse-train") this.pulseTrain(n);
      // GPIO input with "Send the current level once": after the debounce, as on the board.
      if (n.type === "gpio-watch" && n.config.startup === "level")
        this.later(Number(n.config.debounce) || 0, () =>
          this.run(n.id, this.readPin(n.config.pin) ? "1" : "0"),
        );
      // Input devices: made-up readings at the node's interval (lib/devices.js).
      defs[n.type].simulate?.(n, {
        every: (ms, fn) => this.timers.push(setInterval(fn, ms)),
        send: (value) => this.run(n.id, value),
        readPin: (pin) => this.readPin(pin),
        warn: (text) => this.emit("warning", text),
      });
      // Boot text of Display nodes, as the firmware draws it in setup().
      if (n.type === "display" && n.config.initial)
        this.showText({
          ...n.config,
          size: Number(n.config.size),
          text: n.config.initial,
        });
    }
  }
  // Virtual LCD: the UI draws these lines like the board's screen.
  showText({ row, size, color, text }) {
    this.lcd ||= new Map();
    this.lcd.set(row, { row, size, color, text: String(text) });
    this.emit("display", `LCD row ${row}: ${text}`, {
      row,
      size,
      color,
      text: String(text),
    });
  }
  // One-shot timer tied to this run: cleared on stop, ignored after a restart.
  later(ms, fn) {
    const token = this.generation;
    const timer = setTimeout(() => {
      this.timeouts.delete(timer);
      if (token === this.generation && this.flow) fn();
    }, ms);
    this.timeouts.add(timer);
    return timer;
  }
  // Pulse generator: 1, ON time, 0, OFF time, repeated (count 0 = forever).
  pulseTrain(n) {
    const { high, low, count, delay } = n.config;
    let done = 0;
    const on = () => {
      this.run(n.id, "1");
      this.later(high, off);
    };
    const off = () => {
      this.run(n.id, "0");
      if (!count || ++done < count) this.later(low, on);
    };
    this.later(delay, on);
  }
  message(topic, payload, packet = {}) {
    // Same ping/pong contract as the firmware, so "Verify" works against the simulator.
    if (this.mode === "host" && topic === this.base + "/cmd") {
      this.client?.publish(this.base + "/cmd/reply", this.command(payload));
      return;
    }
    if (this.mode === "host" && topic === this.base + "/ping") {
      this.client?.publish(this.base + "/pong", `${payload} sim no-ota`);
      return;
    }
    const monitor =
      /^microflow\/([^/]+)\/(status|telemetry|debug\/[^/]+)$/.exec(topic);
    if (monitor) {
      const [, id, kind] = monitor;
      if (
        this.mode === "host" &&
        (id === this.deviceId || this.siblings?.has(id))
      ) {
        // Our own echo, or a chip simulated alongside (lib/simgroup.js), whose
        // events were already shown.
      } else if (kind === "status") {
        this.onDevice(id, { status: payload });
        this.emit(
          "device",
          packet.retain
            ? `${id}: last status stored on the broker is "${payload}"${payload === "offline" ? " (it is not connected to this broker now)" : ""}`
            : `${id} is ${payload}`,
          {
            device: id,
            status: payload,
            retained: !!packet.retain,
          },
        );
      } else if (kind === "telemetry") {
        let telemetry;
        try {
          telemetry = JSON.parse(payload);
        } catch {
          return this.emit("warning", `${id}: unreadable telemetry`, {
            payload,
          });
        }
        this.onDevice(id, { status: "online", telemetry });
        this.emit("device", `${id} heartbeat`, {
          device: id,
          telemetry,
          quiet: true,
        });
      } else
        this.emit("debug", `${id} · ${kind.slice(6)}`, {
          payload,
          node: kind.slice(6),
        });
    } else this.emit("mqtt", `← ${topic}`, { payload });
    const shown = /^microflow\/([^/]+)\/pwa\/([^/]+)\/out$/.exec(topic);
    if (shown && this.mode === "device" && shown[1] === this.deviceId) {
      this.pwaLast.set(shown[2], payload);
      this.emit("pwa", `Phone page: ${payload.slice(0, 80)}`, {
        node: shown[2],
        payload,
        quiet: true,
      });
    }
    if (this.mode !== "host") return;
    const key = /^microflow\/([^/]+)\/pwa\/([^/]+)\/in$/.exec(topic);
    if (key && key[1] === this.deviceId)
      return this.pwaKey(key[2], payload, true);
    for (const n of this.flow.nodes) {
      if (
        n.type === "mqtt-in" &&
        isMqttRadio(n) &&
        matches(this.topic(n.config.topic), topic)
      )
        this.run(n.id, payload);
      if (isManual(n) && topic === `${this.base}/inject/${n.id}`)
        this.run(n.id, payload || (n.config.payload ?? "1"));
    }
  }
  inject(id, payload) {
    if (!this.flow) throw Error("Start the runtime first.");
    if (this.mode === "monitor")
      throw Error(
        "The runtime only listens for devices now. Start ▶ Simulate or a real-board test to trigger nodes.",
      );
    const n = this.flow.nodes.find(
      (n) => n.id === id && (n.type === "inject" || defs[n.type].manual),
    );
    if (!n)
      throw Error(
        "This node is not in the running flow. Restart the runtime after edits.",
      );
    payload ??= n.config.payload ?? "1";
    if (this.mode === "device") {
      if (!this.client?.connected) throw Error("Broker is disconnected.");
      const topic = `${this.base}/inject/${n.id}`;
      this.client.publish(topic, payload);
      this.emit("mqtt", `→ ${topic}`, { payload });
    } else this.run(n.id, payload);
  }
  // An ESP-NOW broadcast reaches this chip's ESP-NOW Radio in boxes.
  hearEspnow(topic, payload) {
    if (!this.flow || this.mode !== "host") return;
    for (const m of this.flow.nodes)
      if (
        m.type === "mqtt-in" &&
        m.config.protocol === "espnow" &&
        matches(this.topic(m.config.topic), topic)
      )
        this.later(0, () => this.run(m.id, payload));
  }
  // A key from a phone page (PWA node): the simulator runs the node with it; a
  // monitored board gets it on its …/pwa/<node>/in topic.
  // The PWA node of a page: by its id, else by its folder (the variable name), so
  // a page still works after the node was re-created or pasted (new id).
  pwaFind(id, folder) {
    const all = (this.flow?.nodes || []).filter((m) => m.type === "pwa");
    return (
      all.find((m) => m.id === id) ||
      (folder ? all.find((m) => pwaFolder(m) === folder) : undefined)
    );
  }
  pwaKey(id, json, fromBroker = false, folder = "") {
    if (!this.flow) throw Error("Start ▶ Simulate (or a real-board test) first.");
    const n = this.pwaFind(id, folder);
    if (!n) throw Error(this.pwaMissing());
    id = n.id;
    if (this.mode === "host") {
      // Through the broker when connected (it counts the message; it comes back
      // on …/pwa/<id>/in and runs the node), else straight into the node.
      if (!fromBroker && this.client?.connected) {
        const topic = `${this.base}/pwa/${id}/in`;
        this.client.publish(topic, json);
        this.emit("mqtt", `→ ${topic}`, { payload: json });
        return;
      }
      if (!fromBroker) this.emit("pwa", `${n.label}: key ${json}`, { node: id, quiet: true });
      return this.run(id, PWA_KEY + json);
    }
    if (this.mode !== "device") throw Error("Start ▶ Simulate or a real-board test first.");
    if (!this.client?.connected) throw Error("Broker is disconnected.");
    const topic = `${this.base}/pwa/${id}/in`;
    this.client.publish(topic, json);
    this.emit("mqtt", `→ ${topic}`, { payload: json });
    // Once per run: the key reaches the flow only if the board runs it.
    if (!this.pwaHinted) {
      this.pwaHinted = true;
      this.emit(
        "warning",
        `PWA key sent to the real board ${this.deviceId}: it reaches the flow only if this flow (with the PWA node) is uploaded to that board; Debug shows it with a debug build. To try it on this PC, choose "Simulate on this PC" and press ▶ Simulate.`,
      );
    }
  }
  // The running flow's PWA nodes, with their page folders.
  pwaNodes() {
    return (this.flow?.nodes || [])
      .filter((n) => n.type === "pwa")
      .map((n) => ({ id: n.id, name: n.name, folder: pwaFolder(n) }));
  }
  pwaMissing() {
    const pages = this.pwaNodes().map((p) => `/pwa/${p.folder}/`);
    return `This page's PWA node is not in the running flow (${
      pages.length ? `it has ${pages.join(", ")}` : "it has no PWA node"
    }). Save the flow with the PWA node and press ▶ again.`;
  }
  pwaState(id, folder = "") {
    const n = this.pwaFind(id, folder);
    if (n) id = n.id;
    return {
      running: !!this.flow,
      mode: this.mode || null,
      known: !!n,
      node: id,
      ...(this.flow && !n ? { problem: this.pwaMissing() } : {}),
      payload: this.pwaLast.get(id) || null,
    };
  }
  resetPins() {
    this.pins.clear();
    for (const n of this.flow.nodes)
      for (const { pin, sim } of pinsOf(n))
        if (sim)
          this.pins.set(
            pin,
            (n.type === "gpio-watch" || n.type === "digital-read") &&
              n.config.pull === "pullup"
              ? 1
              : 0,
          );
  }
  // Expands {{device}} the same way the firmware does.
  topic(topic) {
    return topic.replaceAll("{{device}}", this.deviceId);
  }
  // The firmware's test terminal (lib/shellfw.js), simulated with virtual pins.
  command(line) {
    const words = String(line).trim().split(/\s+/);
    const cmd = (words.shift() || "").toLowerCase();
    const rest = String(line).trim().slice(cmd.length).trim();
    const pin = (w) => (/^\d+$/.test(w || "") ? Number(w) : NaN);
    if (cmd === "help" || cmd === "?") return HELP + " (simulator)";
    if (cmd === "echo") return rest;
    if (cmd === "status")
      return `build sim · id ${this.deviceId} · simulator on this PC`;
    if (cmd === "wifi") return "simulator: no WiFi";
    if (cmd === "lcd") {
      if (words[0] === "clear")
        return (
          this.lcd?.clear(),
          this.emit("display", "LCD cleared", { clear: true }),
          "display cleared"
        );
      const row = Number(words[0]);
      if (!Number.isInteger(row) || row < 0 || row > 6)
        return "error: lcd <row 0-6> <text> | lcd clear";
      const text = rest.slice(words[0].length).trim();
      this.showText({ row, size: 2, color: "white", text });
      return `row ${row} = ${text}`;
    }
    if (cmd === "reboot") return "simulator: restart the runtime instead";
    if (cmd === "nodes")
      return `${this.flow.nodes.length} nodes: ${this.flow.nodes.map((n) => n.id).join(" ")}`;
    if (cmd === "send") {
      const [id] = words;
      if (!this.flow.nodes.some((n) => n.id === id))
        return `error: no node '${id}' (try nodes)`;
      const payload = rest.slice(id.length).trim();
      this.run(id, payload);
      return `sent "${payload}" to ${id}`;
    }
    if (cmd === "pub") {
      const [topic] = words;
      if (!topic) return "error: pub <topic> <payload>";
      this.client?.publish(topic, rest.slice(topic.length).trim());
      return `published to ${topic}`;
    }
    if (cmd === "gpio" || cmd === "adc" || cmd === "pwm") {
      const sub = cmd === "gpio" ? words.shift() : cmd;
      const p = pin(sub === "adc" && !words.length ? "17" : words[0]);
      if (Number.isNaN(p)) return "error: bad pin";
      if (sub === "read" || sub === "adc")
        return `${sub === "adc" ? "ADC" : "GPIO"} ${p} = ${this.readPin(p)}`;
      const v = Number(words[1]);
      if (sub === "write" && (v === 0 || v === 1))
        return (this.writePin(p, v), `GPIO ${p} = ${v ? "HIGH" : "LOW"}`);
      if (sub === "pwm" && Number.isInteger(v) && v >= 0 && v <= 255)
        return (this.writePin(p, v), `PWM ${p} = ${v}`);
      if (sub === "mode") return `GPIO ${p} mode ${words[1]}`;
      return "error: check the value";
    }
    const reply = this.terminal(line);
    if (reply) return reply;
    return `error: unknown command '${cmd}' (try help)`;
  }
  // Terminal nodes: "<command> <data>" fires the nodes with that command word.
  terminal(line) {
    if (!this.flow) return "";
    const text = String(line).trim();
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const data = text.slice(cmd.length).trim();
    const hits = this.flow.nodes.filter(
      (n) => n.type === "terminal" && n.config.command === cmd,
    );
    if (!cmd || !hits.length) return "";
    for (const n of hits) this.run(n.id, data);
    return `→ ${cmd}: "${data}"`;
  }
  // Simulated web API (the board's /api), served by Microflow under /sim/api.
  webAll() {
    if (!this.flow || this.mode !== "host")
      throw Error("Start a host simulation first.");
    const names = [
      ...new Set(
        this.flow.nodes
          .filter((n) => n.type === "web-out")
          .map((n) => n.config.name),
      ),
    ];
    return `{${names.map((k) => `${JSON.stringify(k)}:${this.webVals.get(k) ?? "null"}`).join(",")}}`;
  }
  webGet(name) {
    this.webAll();
    if (
      !this.flow.nodes.some(
        (n) => n.type === "web-out" && n.config.name === name,
      )
    )
      return null;
    return `{${JSON.stringify(name)}:${this.webVals.get(name) ?? "null"}}`;
  }
  webPost(name, body) {
    this.webAll();
    const hits = this.flow.nodes.filter(
      (n) => n.type === "web-in" && n.config.name === name,
    );
    if (!hits.length) return null;
    for (const n of hits) this.run(n.id, String(body ?? "").trim());
    return this.webAll();
  }
  readPin(pin) {
    return this.pins.get(pin) ?? 0;
  }
  writePin(pin, value) {
    this.pins.set(pin, value);
    this.emit("gpio", `GPIO ${pin} = ${value}`, { pin, value });
  }
  // Simulates an external signal on an input pin; fires GPIO input (change) nodes on change.
  setPin(pin, value) {
    if (!this.flow || this.mode !== "host")
      throw Error("Start a host simulation first.");
    pin = Number(pin);
    value = Number(value);
    if (!this.pins.has(pin))
      throw Error(`GPIO ${pin} is not used by the running flow.`);
    if (!Number.isInteger(value) || value < 0 || value > 4095)
      throw Error("Pin value must be an integer 0–4095.");
    const before = this.pins.get(pin);
    this.writePin(pin, value);
    const level = value ? 1 : 0;
    if ((before ? 1 : 0) !== level)
      for (const n of this.flow.nodes)
        if (n.type === "gpio-watch" && n.config.pin === pin)
          this.run(n.id, String(level));
  }
  // Depth-first like the generated firmware, so output order matches the device.
  run(id, payload) {
    if (!this.flow) return;
    const budget = { steps: 0 };
    this.visit(id, String(payload), budget);
    if (budget.steps > 2048)
      this.emit("warning", "Flow stopped after 2048 node executions.");
  }
  // from: the node that sent the value (Logic nodes tell their inputs apart).
  visit(id, value, budget, from) {
    if (++budget.steps > 2048) return;
    const n = this.flow.nodes.find((n) => n.id === id);
    if (!n) return;
    // Node-RED language: nodes work on msg.payload and pass the message on (like the
    // firmware, lib/msg.js mirrors it).
    const red = this.flow.language === "nodered";
    const msg = red ? msgIn(value, !!defs[n.type].source) : null;
    if (red) value = payloadOf(msg);
    // Input type chosen in Properties: the value as that type (as the firmware).
    if (n.itype) value = convertValue(value, n.itype);
    const host = defs[n.type].host;
    if (host) {
      if (!this.state.has(n.id)) this.state.set(n.id, {});
      const ctx = this.context(n);
      if (red) ctx.msg = msg; // the message received (Debug can show it)
      ctx.from = from;
      value = host(value, n, ctx);
      if (value === undefined) return;
      value = String(value);
    }
    // Output type chosen in Properties (C/C++ nodes send through their own send()).
    if (n.vtype && n.type !== "arduino") value = convertValue(value, n.vtype);
    this.emit("trace", n.id, { payload: value }); // value: the split screen shows it
    const out = red ? msgOut(msg, value, this.fields(n)) : value;
    // A node with several outputs (Counter) sends through ctx.forward(value, port);
    // a returned value goes out of output 1.
    for (const e of this.edges)
      if (e.from === n.id && (e.port || 0) === 0)
        this.visit(e.to, out, budget, n.id);
  }
  inputsOf(n) {
    return [
      ...new Set(this.edges.filter((e) => e.to === n.id).map((e) => e.from)),
    ].map((id) => this.flow.nodes.find((m) => m.id === id));
  }
  // A node's Message fields (Node-RED language), compact JSON.
  fields(n) {
    return n.msg ? checkFields(n.msg) : "{}";
  }
  context(n) {
    return {
      state: this.state.get(n.id),
      // The nodes wired into n, in order (as the firmware numbers them).
      inputs: this.inputsOf(n),
      now: Date.now,
      later: (ms, fn) => this.later(ms, fn),
      display: (line) => this.showText(line),
      cancel: (timer) => {
        clearTimeout(timer);
        this.timeouts.delete(timer);
      },
      // Sends a value from this node to its outputs later (e.g. a pulse ending);
      // port: which output (nodes with several outputs, e.g. Counter), 0 = the first.
      forward: (value, port = 0) => {
        const budget = { steps: 0 };
        if (n.vtype && n.type !== "arduino")
          value = convertValue(value, n.vtype);
        // Reported like the values run() passes on (the firmware's mfTrace does the
        // same); port: which output, for nodes with several.
        this.emit("trace", n.id, {
          payload: String(value),
          ...(defs[n.type].outputs ? { port } : {}),
        });
        const out =
          this.flow.language === "nodered"
            ? msgOut("{}", String(value), this.fields(n))
            : String(value);
        for (const e of this.edges)
          if (e.from === n.id && (e.port || 0) === port)
            this.visit(e.to, out, budget, n.id);
      },
      readPin: (pin) => this.readPin(pin),
      writePin: (pin, value) => this.writePin(pin, value),
      warn: (text) => this.emit("warning", text),
      // What a motor does (Output device): shown in the console.
      log: (text) => this.emit("output", text),
      // A servo starts turning (or spinning): the IDE animates its box.
      motion: (detail) =>
        this.emit("servo", `${n.label}: servo`, {
          node: n.id,
          quiet: true,
          ...detail,
        }),
      // Camera: the simulated picture, served at /api/camera/sim/<node id>.png.
      still: (buffer, shot) => {
        this.stills.set(n.id, buffer);
        return `/api/camera/sim/${n.id}.png?shot=${shot}`;
      },
      // A picture was taken: the IDE saves it as a PNG file and shows it.
      camera: (json) =>
        this.emit("camera", `${n.label || "Camera"}: picture taken`, {
          node: n.id,
          payload: json,
        }),
      // A node's state (Timer: triggered, active, …): on its box and in the console.
      indicate: (state, text) =>
        this.emit("indicator", `${n.label || n.type}: ${text}`, {
          node: n.id,
          state,
        }),
      // Radio out with a broker of its own (Advanced): dropped while not connected (QoS 0).
      publishTo: (own, config, raw, payload, retain) => {
        const topic = this.topic(raw);
        const client = this.own.get(n.id);
        if (!client?.connected)
          return this.emit(
            "warning",
            `${n.label}: not connected to ${own.host}:${own.port}; message dropped`,
          );
        client.publish(topic, payload, { qos: 0, retain }, (err) =>
          err ? this.emit("error", err.message) : null,
        );
        this.emit("mqtt", `→ ${own.host}:${own.port} ${topic}`, { payload });
      },
      publish: (raw, payload, retain) => {
        const topic = this.topic(raw);
        if (!this.client?.connected)
          return this.emit("error", "Broker is disconnected");
        this.client.publish(
          topic,
          payload,
          { qos: 0, retain },
          (err) => err && this.emit("error", err.message),
        );
        this.emit("mqtt", `→ ${topic}`, { payload });
      },
      // ESP-NOW: the simulated board hears its own broadcast, like the firmware.
      espnow: (raw, payload) => {
        const topic = this.topic(raw);
        this.emit("radio", `ESP-NOW → ${topic}`, { payload });
        this.hearEspnow(topic, payload);
        // Multi-chip simulation (lib/simgroup.js): the other chips hear it too.
        for (const peer of this.peers?.() || []) peer.hearEspnow(topic, payload);
      },
      // Local MQTT: the simulated board's own broker. Its Radio in boxes hear what
      // its Radio out publishes (no outside clients in the simulator).
      localMqtt: (raw, payload) => {
        const topic = this.topic(raw);
        this.emit("radio", `Local MQTT → ${topic}`, { payload });
        for (const m of this.flow.nodes)
          if (
            m.type === "mqtt-in" &&
            m.config.protocol === "local" &&
            matches(this.topic(m.config.topic), topic)
          )
            this.later(0, () => this.run(m.id, payload));
        // Multi-chip simulation (lib/simgroup.js): the other chips connect to this
        // chip's broker, so their MQTT Radio in boxes hear it too.
        for (const peer of this.peers?.() || [])
          setImmediate(() => peer.flow && peer.message(topic, payload));
      },
      // I2C exists on the board only: the simulator just logs the transfer.
      i2c: (node, payload) =>
        this.emit(
          "radio",
          node.config.i2cRole === "peripheral"
            ? `I2C reply set (board only, not sent)`
            : `I2C → address ${node.config.address} (board only, not sent)`,
          { payload },
        ),
      // Bluetooth exists on the board only: the simulator just logs the broadcast.
      ble: (link, payload) =>
        this.emit("ble", `BLE → ${link} (board only, not sent)`, { payload }),
      web: (name, payload) => {
        this.webVals.set(name, toJson(payload));
        this.emit("web", `Web out ${name} = ${toJson(payload)}`);
      },
      debug: (node, payload) => {
        this.emit("debug", node.label || "Debug", { payload });
        if (this.client?.connected)
          this.client.publish(`${this.base}/debug/${node.id}`, payload);
      },
      // Speak: the IDE says the text with the PC's speech synthesis.
      speak: (node, text) =>
        this.emit("speak", `${node.label || "Speak"} says: ${text}`, {
          node: node.id,
          payload: text,
          voice: node.config.voice,
        }),
      // PWA: what the phone page shows (the IDE's test page, and the broker).
      pwa: (node, json) => {
        this.pwaLast.set(node.id, json);
        this.emit("pwa", `${node.label || "PWA"} → phone: ${json.slice(0, 80)}`, {
          node: node.id,
          payload: json,
        });
        if (this.client?.connected)
          this.client.publish(`${this.base}/pwa/${node.id}/out`, json, {
            retain: true,
          });
      },
      // Screen (simulation only): the picture is shown on its box.
      screen: (node, payload) =>
        this.emit("screen", `${node.label || "Screen"}: picture`, {
          node: node.id,
          payload,
          quiet: true,
        }),
      // Oscilloscope samples: drawn on the box, kept out of the console.
      scope: (node, payload) => {
        this.emit("scope", node.label || "Oscilloscope", {
          node: node.id,
          payload,
          quiet: true,
        });
        if (this.client?.connected)
          this.client.publish(`${this.base}/debug/${node.id}`, payload);
      },
    };
  }
}
module.exports = { FlowRuntime, matches, checkBroker, brokerHint };
