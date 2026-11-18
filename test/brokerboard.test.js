// public/brokerboard.js: the editor adopts a broker board's address, run in a VM
// with stand-ins for the Device panel fields and the API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.join(__dirname, "../public/brokerboard.js"),
  "utf8",
);
// Minimal DOM element stand-in for the panels built by brokerboard.js.
const element = (tag, className = "", textContent) => ({
  tag,
  className,
  textContent,
  value: "",
  children: [],
  append(...c) {
    this.children.push(...c);
  },
  setAttribute() {},
});
// All elements under a root, depth first.
const walk = (root) => [
  root,
  ...(root.children || []).flatMap((c) =>
    typeof c === "object" ? walk(c) : [],
  ),
];
function editor(runtime = { running: false }, panel = {}) {
  const fields = {
    brokerUrl: { value: "mqtt://127.0.0.1:1883" },
    host: { value: "" },
    mqttPort: { value: "1883" },
    username: { value: "me" },
    mqttPassword: { value: "pw" },
    brokerBoard: {},
  };
  for (const [k, v] of Object.entries(panel)) fields[k] = { value: v };
  const calls = [];
  const toasts = [];
  const ctx = {
    $: (id) => (fields[id] ||= { value: "" }),
    el: element,
    PUBLIC_BROKER: "test.mosquitto.org",
    setTimeout,
    clearTimeout,
    attempt: (fn) => fn,
    toast: (m) => toasts.push(m),
    saveSettings: () => calls.push(["save"]),
    flow: { nodes: [], edges: [] },
    broker: () => ({ url: fields.brokerUrl.value }),
    api: async (route, body) => {
      calls.push([route, body && JSON.parse(JSON.stringify(body))]);
      if (route === "runtime/status") return runtime;
      if (route === "broker/probe")
        return { ok: true, message: `${body.host}:${body.port} answers.` };
      return {};
    },
  };
  ctx.chipFlow = () => ctx.flow; // one chip: the whole flow (app.js)
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, fields, calls, toasts };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
test("a broker board's status line on the serial port sets the Broker URL", async () => {
  const { ctx, fields, toasts } = editor();
  const status = {
    id: "broker-6de378",
    broker: 1,
    ip: "192.168.1.133",
    port: 1883,
  };
  ctx.brokerFromSerial(status);
  await settle();
  assert.equal(fields.brokerUrl.value, "mqtt://192.168.1.133:1883");
  assert.equal(fields.host.value, "192.168.1.133");
  assert.equal(fields.mqttPort.value, 1883);
  assert.equal(fields.username.value, "me", "login fields are kept");
  assert.match(toasts[0], /broker-6de378 is at mqtt:\/\/192\.168\.1\.133:1883/);
  // Once per address: a later manual change is not overwritten by the next poll.
  fields.brokerUrl.value = "mqtt://test.mosquitto.org:1883";
  ctx.brokerFromSerial(status);
  await settle();
  assert.equal(fields.brokerUrl.value, "mqtt://test.mosquitto.org:1883");
  // A new address (e.g. a DHCP change) is adopted again.
  ctx.brokerFromSerial({ ...status, ip: "192.168.1.140" });
  await settle();
  assert.equal(fields.brokerUrl.value, "mqtt://192.168.1.140:1883");
});
test("ordinary boards and boards without an IP are ignored", async () => {
  const { ctx, fields } = editor();
  ctx.brokerFromSerial({ id: "microflow-1", ip: "192.168.1.9" });
  ctx.brokerFromSerial({ id: "broker-1", broker: 1, ip: "0.0.0.0" });
  await settle();
  assert.equal(fields.brokerUrl.value, "mqtt://127.0.0.1:1883");
});
test("switching brokers returns the old settings and restarts listening", async () => {
  const { ctx, fields, calls } = editor({ running: true, mode: "monitor" });
  const before = await ctx.applyBroker({
    url: "mqtt://192.168.1.133:1884",
    host: "192.168.1.133",
    port: 1884,
    username: "boards",
    password: "s3cret",
  });
  assert.equal(before.url, "mqtt://127.0.0.1:1883");
  const restart = calls.find(([r]) => r === "runtime/start");
  assert.equal(restart[1].mode, "monitor");
  assert.equal(restart[1].broker.url, "mqtt://192.168.1.133:1884");
  await ctx.applyBroker(before); // Undo
  assert.equal(fields.brokerUrl.value, "mqtt://127.0.0.1:1883");
  assert.equal(fields.username.value, "me");
});
// Upload window: the MQTT broker section.
const chooser = (panel, devices = []) => {
  const e = editor({ running: false }, panel);
  const c = e.ctx.brokerChooser("this flow uses MQTT", "192.168.1.68", devices);
  const all = walk(c.box);
  const radios = all.filter((n) => n.type === "radio");
  const inputs = all.filter((n) => n.tag === "input" && n.type !== "radio");
  const [host, port, url] = [
    inputs.find((n) => /broker\.example/.test(n.placeholder)),
    inputs.find((n) => n.type === "number"),
    inputs.find((n) => /^mqtt:\/\//.test(n.placeholder)),
  ];
  const titles = all.filter((n) => n.tag === "b").map((n) => n.textContent);
  return { ...e, c, radios, host, port, url, titles };
};
const brokerBoard = {
  id: "broker-6de378",
  telemetry: { broker: 1, ip: "192.168.1.133", port: 1883 },
};
test("the upload window starts from the Device panel and changes nothing on open", () => {
  const { c, fields, host, port, url, radios, titles } = chooser({
    brokerUrl: "mqtt://192.168.1.133:1883",
    host: "",
  });
  assert.equal(host.value, "192.168.1.133", "taken from the Broker URL");
  assert.equal(Number(port.value), 1883);
  assert.equal(url.value, "mqtt://192.168.1.133:1883");
  assert.ok(titles.includes("As in the Device panel"));
  assert.equal(radios.find((r) => r.value === "panel").checked, true);
  // Opening the window must not overwrite the Device panel.
  assert.equal(fields.host.value, "");
  assert.equal(fields.brokerUrl.value, "mqtt://192.168.1.133:1883");
  assert.equal(c.host(), "192.168.1.133");
});
test("a broker board seen in Devices is offered, and upload saves the choice", () => {
  const { c, fields, host, url, radios, titles } = chooser({}, [brokerBoard]);
  // Device panel default (this PC, no host): nothing chosen yet.
  assert.equal(c.host(), "");
  assert.ok(titles.includes("Broker board broker-6de378"));
  const pick = radios.find((r) => r.value === "board-broker-6de378");
  pick.onchange();
  assert.equal(host.value, "192.168.1.133");
  assert.equal(url.value, "mqtt://192.168.1.133:1883");
  assert.equal(
    fields.brokerUrl.value,
    "mqtt://127.0.0.1:1883",
    "not saved yet",
  );
  c.commit(); // pressing Compile and upload
  assert.equal(fields.host.value, "192.168.1.133");
  assert.equal(fields.mqttPort.value, 1883);
  assert.equal(fields.brokerUrl.value, "mqtt://192.168.1.133:1883");
});
test("typing a broker keeps the editor on it, except a broker on this PC", () => {
  const { host, port, url, radios } = chooser({});
  host.value = "broker.example.com";
  port.value = "1884";
  host.oninput();
  assert.equal(url.value, "mqtt://broker.example.com:1884");
  radios.find((r) => r.value === "pc").onchange();
  assert.equal(host.value, "192.168.1.68", "the board needs this PC's LAN IP");
  assert.equal(
    url.value,
    "mqtt://127.0.0.1:1883",
    "the editor connects locally",
  );
  radios.find((r) => r.value === "public").onchange();
  assert.equal(url.value, "mqtt://test.mosquitto.org:1883");
});
