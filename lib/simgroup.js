// PC simulation of one chip, or of every chip of a project at once.
// One chip: the FlowRuntime as before (real broker or offline).
// Several chips (start({ chips: [...] })): one FlowRuntime per chip, all on the
// built-in MQTT (lib/localbus.js), so Radio out on one chip reaches Radio in on
// the others with no broker and no upload. ESP-NOW broadcasts reach every chip.
// Console messages carry the chip's name; events carry `chip` (its id).
const { FlowRuntime, matches } = require("./runtime");
const { createBus } = require("./localbus");
const { LIMITS } = require("./flow");

const PROTOCOL = {
  mqtt: "MQTT",
  local: "Local MQTT",
  espnow: "ESP-NOW",
  i2c: "I2C",
};
// Radio in boxes that no Radio out of the project can reach in the simulator:
// a topic that does not match, or a protocol that does not carry between chips.
// Returns [{ chip, text }] naming what is sent instead.
function radioCheck(chips, ids) {
  const radios = chips.flatMap((c, i) =>
    (c.flow?.nodes || [])
      .filter((n) => n.type === "mqtt-in" || n.type === "mqtt-out")
      .map((n) => ({
        n,
        i,
        chip: c.chip,
        name: c.name || `Chip ${i + 1}`,
        protocol: n.config?.protocol || "mqtt",
        topic: String(n.config?.topic || "").replaceAll("{{device}}", ids[i]),
      })),
  );
  const outs = radios.filter((r) => r.n.type === "mqtt-out");
  const warnings = [];
  for (const r of radios) {
    if (r.n.type !== "mqtt-in" || r.protocol === "i2c" || !r.topic) continue;
    // MQTT Radio in boxes also hear another chip's Local MQTT broker (as if
    // connected to it); a Local MQTT Radio in only hears its own chip.
    const reach = (o) =>
      matches(r.topic, o.topic) &&
      (r.protocol === "local"
        ? o.protocol === "local" && o.i === r.i
        : o.protocol === r.protocol ||
          (r.protocol === "mqtt" && o.protocol === "local" && o.i !== r.i));
    if (outs.some(reach)) continue;
    const label = r.n.label || "Radio in";
    const sent = outs.map(
      (o) => `${o.name} "${o.topic}" (${PROTOCOL[o.protocol] || o.protocol})`,
    );
    const hint =
      r.protocol === "local"
        ? ` A Local MQTT Radio in only hears its own chip (${r.name}'s broker). To receive from another chip, set this Radio in to MQTT: it then hears the other chip's MQTT or Local MQTT Radio out.`
        : outs.some((o) => matches(r.topic, o.topic))
          ? ` Use the same protocol (${PROTOCOL[r.protocol]}) on both sides.`
          : " Use the same topic on both sides (the topic field suggests the topics other chips send).";
    warnings.push({
      chip: r.chip,
      text: `${r.name} · ${label} listens to "${r.topic}" (${PROTOCOL[r.protocol] || r.protocol}) but no Radio out sends there.${hint}${sent.length ? ` Radio out boxes send: ${sent.join(", ")}.` : " No chip has a Radio out."}`,
    });
  }
  return warnings;
}

class SimGroup {
  constructor(emit, options = {}) {
    this.emit = emit;
    this.options = options;
    this.main = new FlowRuntime(emit, options);
    this.chips = new Map(); // chip id → FlowRuntime (multi-chip simulation)
    this.names = new Map(); // chip id → name
  }
  get multi() {
    return this.chips.size > 0;
  }
  get list() {
    return this.multi ? [...this.chips.values()] : [this.main];
  }
  // The runtime of a chip; without one, the first.
  of(chip) {
    return this.chips.get(chip) || this.list[0];
  }
  // Web in/out and Terminal: the chip that has such nodes, else the first.
  get web() {
    return (
      this.list.find((r) =>
        r.flow?.nodes.some((n) => /^web-|^terminal$/.test(n.type)),
      ) || this.list[0]
    );
  }
  get flow() {
    return this.web.flow;
  }
  get stills() {
    const all = new Map();
    for (const r of this.list) for (const [k, v] of r.stills) all.set(k, v);
    return all;
  }
  status(chip) {
    const s = this.of(chip).status();
    if (!this.multi) return s;
    return {
      ...s,
      chip: chip && this.chips.has(chip) ? chip : [...this.chips.keys()][0],
      chips: [...this.chips].map(([id, r]) => ({
        id,
        name: this.names.get(id),
        deviceId: r.deviceId,
        running: !!r.flow,
      })),
    };
  }
  stop(message = "Runtime stopped") {
    if (this.multi) {
      for (const r of this.chips.values()) r.stop();
      this.chips.clear();
      this.names.clear();
    }
    this.main.stop(message); // reports "Runtime stopped" (or "Restarting")
  }
  start(body = {}) {
    const chips = body.chips;
    if (!Array.isArray(chips) || chips.length < 2) {
      if (this.multi) this.stop("Restarting");
      return this.main.start(body);
    }
    if ((body.mode || "host") !== "host")
      throw Error("Only the PC simulation can run several chips at once.");
    if (chips.length > LIMITS.chips)
      throw Error(`A project has at most ${LIMITS.chips} chips.`);
    // Each chip needs its own Device ID: blank ones become sim, sim2, sim3…
    const used = new Set();
    const ids = chips.map((c, i) => {
      const id = String(c.deviceId || "").trim() || (i ? `sim${i + 1}` : "sim");
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
        throw Error(
          `${c.name || "A chip"}: Device ID may use letters, digits, - and _.`,
        );
      if (used.has(id))
        throw Error(
          `Two chips use the Device ID "${id}". Give each chip its own Device ID (Device panel), so their topics do not mix.`,
        );
      used.add(id);
      return id;
    });
    this.stop(this.multi || this.main.flow ? "Restarting" : "Runtime stopped");
    const bus = createBus();
    chips.forEach((c, i) => {
      const id = String(c.chip || `chip${i + 1}`);
      const name = String(c.name || `Chip ${i + 1}`).slice(0, 40);
      const emit = (kind, message, extra = {}) => {
        // Each chip's own start/stop notices would only repeat the group's.
        if (kind === "status" && /^(Runtime stopped|Restarting)$/.test(message))
          return;
        this.emit(
          kind,
          kind === "trace" ? message : `${name} · ${message}`,
          { ...extra, chip: id },
        );
      };
      const runtime = new FlowRuntime(emit, {
        ...this.options,
        connect: bus.connect,
      });
      runtime.peers = () => this.list.filter((r) => r !== runtime);
      this.chips.set(id, runtime);
      this.names.set(id, name);
    });
    for (const r of this.chips.values()) r.siblings = used;
    try {
      [...this.chips.values()].forEach((r, i) =>
        r.start({
          flow: chips[i].flow,
          mode: "host",
          deviceId: ids[i],
          broker: { url: "mqtt://built-in" },
        }),
      );
    } catch (err) {
      const name = [...this.names.values()][
        [...this.chips.values()].findIndex((r) => !r.flow)
      ];
      this.stop();
      throw Error(`${name || "A chip"}: ${err.message}`);
    }
    this.emit(
      "status",
      `Simulating ${chips.length} chips on this PC · built-in MQTT (${ids.join(", ")})`,
      { connected: true },
    );
    for (const { chip, text } of radioCheck(chips, ids))
      this.emit("warning", text, { chip });
    return this.status(body.chip);
  }
  // A node id is unique in the project, so it names its chip.
  inject(id, payload) {
    const r =
      this.list.find((x) => x.flow?.nodes.some((n) => n.id === id)) ||
      this.list[0];
    return r.inject(id, payload);
  }
  // PWA phone pages (server /api/pwa/…): the chip whose flow has the node.
  pwaOf(id, folder) {
    return (
      this.list.find((r) => r.flow?.nodes.some((n) => n.id === id)) ||
      this.list.find((r) => r.pwaFind(id, folder)) ||
      this.list[0]
    );
  }
  pwaKey(id, json, folder) {
    return this.pwaOf(id, folder).pwaKey(id, json, false, folder);
  }
  pwaState(id, folder) {
    return this.pwaOf(id, folder).pwaState(id, folder);
  }
  setPin(pin, value, chip) {
    return this.of(chip).setPin(pin, value);
  }
  webAll() {
    return this.web.webAll();
  }
  webGet(name) {
    return this.web.webGet(name);
  }
  webPost(name, body) {
    return this.web.webPost(name, body);
  }
  command(line) {
    return this.web.command(line);
  }
}

module.exports = { SimGroup, radioCheck };
