// Multi-chip PC simulation: every chip runs at once on the built-in MQTT, so a
// Radio out on one chip reaches a Radio in on another without a broker or upload.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimGroup } = require("../lib/simgroup");
const { createBus } = require("../lib/localbus");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chipA = (protocol = "mqtt") => ({
  name: "A",
  nodes: [
    { id: "go", type: "inject", config: { payload: "21.5", interval: 0 } },
    {
      id: "tx",
      type: "mqtt-out",
      config: { topic: "lab/{{device}}/temp", protocol },
    },
  ],
  edges: [{ from: "go", to: "tx" }],
});
const chipB = (protocol = "mqtt") => ({
  name: "B",
  nodes: [
    { id: "rx", type: "mqtt-in", config: { topic: "lab/+/temp", protocol } },
    { id: "log", type: "debug", label: "Got", config: {} },
  ],
  edges: [{ from: "rx", to: "log" }],
});

test("built-in MQTT: wildcards, retained messages, last will", async () => {
  const bus = createBus();
  const a = bus.connect("mqtt://x", {
    will: { topic: "w/a", payload: "gone", retain: true },
  });
  const b = bus.connect("mqtt://x");
  const got = [];
  b.on("message", (t, p, packet) => got.push([t, String(p), packet.retain]));
  // Both connected (a fixed wait can end first when the PC is busy).
  await Promise.all([a, b].map((c) => new Promise((r) => c.once("connect", r))));
  a.publish("keep/1", "one", { retain: true });
  b.subscribe(["x/#", "keep/+", "w/a"]);
  a.publish("x/y/z", "hi");
  a.publish("other", "no");
  await wait(5);
  a.end(true); // dropped: the will goes out
  await wait(5);
  assert.deepEqual(got, [
    ["keep/1", "one", true],
    ["x/y/z", "hi", false],
    ["w/a", "gone", false],
  ]);
});

for (const [protocol, heard = protocol] of [
  ["mqtt"],
  ["espnow"],
  ["local", "mqtt"], // MQTT Radio in hears another chip's Local MQTT broker
])
  test(`two chips talk over ${protocol} → ${heard} on the PC`, async () => {
    const events = [];
    const sims = new SimGroup((kind, message, extra = {}) =>
      events.push({ kind, message, ...extra }),
    );
    const status = sims.start({
      mode: "host",
      chip: "c2",
      chips: [
        { chip: "c1", name: "Sender", deviceId: "", flow: chipA(protocol) },
        { chip: "c2", name: "Receiver", deviceId: "", flow: chipB(heard) },
      ],
    });
    assert.equal(status.chip, "c2");
    assert.deepEqual(
      status.chips.map((c) => c.deviceId),
      ["sim", "sim2"],
    );
    await wait(20); // clients connect and subscribe
    sims.inject("go"); // a node id names its chip
    await wait(30);
    const got = events.find((e) => e.kind === "debug" && e.chip === "c2");
    assert.ok(got, JSON.stringify(events, null, 1));
    assert.equal(got.payload, "21.5");
    assert.match(got.message, /^Receiver · Got/);
    sims.stop();
    assert.equal(sims.status().running, false);
  });

test("each chip needs its own Device ID", () => {
  const sims = new SimGroup(() => {});
  assert.throws(
    () =>
      sims.start({
        chips: [
          { chip: "c1", name: "A", deviceId: "lab", flow: chipA() },
          { chip: "c2", name: "B", deviceId: "lab", flow: chipB() },
        ],
      }),
    /Two chips use the Device ID "lab"/,
  );
});

test("Radio in boxes that hear nothing are reported", () => {
  const { radioCheck } = require("../lib/simgroup");
  const out = (topic, protocol) => ({
    nodes: [{ id: "o", type: "mqtt-out", config: { topic, protocol } }],
  });
  const inn = (topic, protocol) => ({
    nodes: [
      { id: "i", type: "mqtt-in", label: "Temp in", config: { topic, protocol } },
    ],
  });
  const check = (a, b) =>
    radioCheck(
      [
        { chip: "c1", name: "A", flow: a },
        { chip: "c2", name: "B", flow: b },
      ],
      ["sim", "sim2"],
    );
  assert.deepEqual(check(out("lab/t", "mqtt"), inn("lab/+", "mqtt")), []);
  const [w] = check(
    out("workshop/status", "local"),
    inn("workshop/sensor", "mqtt"),
  );
  assert.equal(w.chip, "c2");
  assert.match(w.text, /B · Temp in listens to "workshop\/sensor" \(MQTT\)/);
  assert.match(w.text, /same topic/);
  assert.match(w.text, /A "workshop\/status" \(Local MQTT\)/);
  // MQTT Radio in hears another chip's Local MQTT broker.
  assert.deepEqual(check(out("x", "local"), inn("x", "mqtt")), []);
  assert.match(check(out("x", "mqtt"), inn("x", "espnow"))[0].text, /same protocol \(ESP-NOW\)/);
  assert.match(check(out("x", "local"), inn("x", "local"))[0].text, /only hears its own chip/);
});
