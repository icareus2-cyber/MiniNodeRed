const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mqtt = require("mqtt");
const aedes = require("aedes");
const Database = require("better-sqlite3");
const { FlowRuntime } = require("../lib/runtime");
const { runTest, validateTest } = require("../lib/testrunner");
const { openStore, migrations } = require("../lib/store");
let broker, tcp, url;
before(async () => {
  broker = aedes();
  tcp = net.createServer(broker.handle);
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  url = `mqtt://127.0.0.1:${tcp.address().port}`;
});
after(async () => {
  await new Promise((r) => tcp.close(r));
  await new Promise((r) => broker.close(r));
});
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const flow = {
  name: "Thermostat",
  nodes: [
    { id: "temp", type: "mqtt-in", config: { topic: "lab/temp" } },
    { id: "go", type: "inject", config: { payload: "30" } },
    { id: "hot", type: "threshold", config: { value: 25 } },
    { id: "json", type: "template", config: { template: '{"t":{{payload}}}' } },
    { id: "alert", type: "mqtt-out", config: { topic: "lab/alert" } },
    { id: "fan", type: "digital-write", config: { pin: 5 } },
    { id: "log", type: "debug", label: "Hot", config: {} },
    { id: "button", type: "gpio-watch", config: { pin: 4 } },
    { id: "state", type: "mqtt-out", config: { topic: "lab/button" } },
  ],
  edges: [
    { from: "temp", to: "hot" },
    { from: "go", to: "hot" },
    { from: "hot", to: "json" },
    { from: "json", to: "alert" },
    { from: "hot", to: "fan" },
    { from: "hot", to: "log" },
    { from: "button", to: "state" },
  ],
};
const suite = validateTest({
  name: "Hot reading raises alert",
  steps: [
    { op: "publish", topic: "lab/temp", payload: "20" },
    { op: "expect-none", topic: "lab/alert", timeout: 150 },
    { op: "publish", topic: "lab/temp", payload: "28" },
    {
      op: "expect",
      topic: "lab/alert",
      match: "equals",
      value: '{"t":28}',
      timeout: 1500,
    },
    {
      op: "expect",
      topic: "microflow/{{device}}/debug/log",
      match: "gte",
      value: "25",
      timeout: 1500,
    },
    { op: "publish", topic: "microflow/{{device}}/inject/go", payload: "" },
    {
      op: "expect",
      topic: "lab/alert",
      match: "contains",
      value: "30",
      timeout: 1500,
    },
  ],
});
test(
  "host simulation passes an MQTT test suite through the real broker",
  { timeout: 15000 },
  async () => {
    const events = [];
    const devices = [];
    const runtime = new FlowRuntime(
      (kind, message, extra) => events.push({ kind, message, ...extra }),
      {
        onDevice: (id, patch) => devices.push({ id, ...patch }),
      },
    );
    const subscribed = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "lab/temp") && r(),
      ),
    );
    runtime.start({
      flow: structuredClone(flow),
      broker: { url },
      deviceId: "bench",
    });
    await subscribed;
    try {
      const result = await runTest(suite, { broker: { url }, device: "bench" });
      assert.equal(result.passed, true, JSON.stringify(result.steps, null, 1));
      assert.equal(runtime.status().pins[5], 1, "fan pin driven high");
      // Virtual button press fires GPIO input nodes on change only.
      const peer = mqtt.connect(url);
      await new Promise((r) => peer.once("connect", r));
      await new Promise((r) => peer.subscribe("lab/button", r));
      const got = [];
      peer.on("message", (t, p) => got.push(p.toString()));
      runtime.setPin(4, 0);
      runtime.setPin(4, 0);
      runtime.setPin(4, 1);
      await until(() => got.length === 2);
      assert.deepEqual(got, ["0", "1"]);
      assert.throws(() => runtime.setPin(13, 1), /not used/);
      // A real board reporting telemetry is tracked; our own sim id is ignored.
      peer.publish(
        "microflow/esp-a/telemetry",
        JSON.stringify({ heap: 30000, build: "abc" }),
      );
      peer.publish("microflow/bench/status", "online");
      await until(() => devices.some((d) => d.id === "esp-a"));
      assert.equal(devices.find((d) => d.id === "esp-a").telemetry.heap, 30000);
      assert.ok(!devices.some((d) => d.id === "bench"));
      await new Promise((r) => peer.end(true, r));
    } finally {
      runtime.stop();
    }
    assert.ok(events.some((e) => e.kind === "gpio" && e.pin === 5));
  },
);
test(
  "failing expectations report what was seen",
  { timeout: 10000 },
  async () => {
    const runtime = new FlowRuntime(() => {});
    const subscribed = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "lab/temp") && r(),
      ),
    );
    runtime.start({ flow: structuredClone(flow), broker: { url } });
    await subscribed;
    try {
      const result = await runTest(
        {
          name: "Wrong expectation",
          steps: [
            { op: "publish", topic: "lab/temp", payload: "26" },
            {
              op: "expect",
              topic: "lab/alert",
              match: "equals",
              value: "nope",
              timeout: 300,
            },
            { op: "wait", timeout: 10 },
          ],
        },
        { broker: { url } },
      );
      assert.equal(result.passed, false);
      assert.match(result.steps[1].detail, /saw "\{\\"t\\":26\}"/);
      assert.equal(result.steps[2].detail, "skipped");
    } finally {
      runtime.stop();
    }
    const offline = await runTest(
      { name: "x", steps: [{ op: "wait", timeout: 10 }] },
      { broker: { url: "mqtt://127.0.0.1:1" } },
    );
    assert.equal(offline.passed, false);
    assert.ok(offline.error);
  },
);
test(
  "device mode forwards injects to the board's MQTT topic",
  { timeout: 10000 },
  async () => {
    const runtime = new FlowRuntime(() => {});
    assert.throws(
      () =>
        runtime.start({
          flow: structuredClone(flow),
          broker: { url },
          mode: "device",
        }),
      /Device ID/,
    );
    const peer = mqtt.connect(url);
    await new Promise((r) => peer.once("connect", r));
    await new Promise((r) => peer.subscribe("microflow/board-7/inject/+", r));
    runtime.start({
      flow: structuredClone(flow),
      broker: { url },
      mode: "device",
      deviceId: "board-7",
    });
    try {
      await until(() => runtime.status().connected);
      const message = new Promise((r) =>
        peer.once("message", (t, p) => r([t, p.toString()])),
      );
      runtime.inject("go", "99");
      assert.deepEqual(await message, ["microflow/board-7/inject/go", "99"]);
    } finally {
      runtime.stop();
      await new Promise((r) => peer.end(true, r));
    }
  },
);
test(
  "{{device}} topics are scoped per device in the simulator",
  { timeout: 10000 },
  async () => {
    const runtime = new FlowRuntime(() => {});
    const echo = {
      nodes: [
        { id: "in", type: "mqtt-in", config: { topic: "lab/{{device}}/cmd" } },
        {
          id: "out",
          type: "mqtt-out",
          config: { topic: "lab/{{device}}/echo" },
        },
      ],
      edges: [{ from: "in", to: "out" }],
    };
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "lab/unit-9/cmd") && r(),
      ),
    );
    runtime.start({ flow: echo, broker: { url }, deviceId: "unit-9" });
    await ready;
    try {
      const result = await runTest(
        {
          name: "Echo",
          steps: [
            { op: "publish", topic: "lab/other/cmd", payload: "x" },
            { op: "expect-none", topic: "lab/+/echo", timeout: 200 },
            { op: "publish", topic: "lab/{{device}}/cmd", payload: "hi" },
            {
              op: "expect",
              topic: "lab/{{device}}/echo",
              match: "equals",
              value: "hi",
              timeout: 1500,
            },
          ],
        },
        { broker: { url }, device: "unit-9" },
      );
      assert.equal(result.passed, true, JSON.stringify(result.steps));
    } finally {
      runtime.stop();
    }
  },
);
test(
  "status names the broker and reports a dropped connection once",
  { timeout: 15000 },
  async () => {
    const events = [];
    const runtime = new FlowRuntime((kind, message) =>
      events.push([kind, message]),
    );
    const host = new URL(url).host;
    runtime.start({
      flow: structuredClone(flow),
      broker: { url },
      deviceId: "drop-1",
    });
    try {
      await until(() => runtime.status().connected);
      assert.ok(
        events.some(
          ([k, m]) =>
            k === "status" &&
            m === `MQTT connected to ${host} · simulating as drop-1`,
        ),
      );
      // The broker kicks the client: expect one "lost" report, then an automatic reconnect.
      for (const c of Object.values(broker.clients))
        if (c.id === runtime.client.options.clientId) c.close();
      await until(() =>
        events.some(
          ([k, m]) =>
            k === "warning" && m.startsWith(`Lost the connection to ${host}`),
        ),
      );
      const reconnects = () =>
        events.filter(
          ([k, m]) => k === "status" && m.startsWith("MQTT connected"),
        ).length;
      await until(() => reconnects() === 2, 8000);
      assert.ok(!events.some(([, m]) => /Broker offline/.test(m)));
    } finally {
      runtime.stop();
    }
  },
);
test("test definitions are validated", () => {
  assert.throws(() => validateTest({ name: "", steps: [] }), /name/);
  assert.throws(
    () => validateTest({ name: "a", steps: [{ op: "publish", topic: "a/#" }] }),
    /cannot contain/,
  );
  assert.throws(
    () =>
      validateTest({
        name: "a",
        steps: [{ op: "expect", topic: "a", match: "regex", value: "(" }],
      }),
    /regular/,
  );
  assert.throws(
    () => validateTest({ name: "a", steps: [{ op: "wait", timeout: 0 }] }),
    /timeout/,
  );
  assert.equal(
    validateTest({ name: "a", steps: [{ op: "expect", topic: "a/+" }] })
      .steps[0].timeout,
    2000,
  );
});
test("SQLite store migrates legacy databases and keeps history", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "microflow-")),
    "legacy.sqlite",
  );
  const legacy = new Database(file);
  legacy.exec(
    "CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL, updated TEXT NOT NULL)",
  );
  legacy.prepare("INSERT INTO flows VALUES ('old','Old',?, '2025-01-01')").run(
    JSON.stringify({
      id: "old",
      name: "Old",
      nodes: [
        { id: "a", type: "mqtt-in", label: "MQTT in", config: { topic: "x" } },
        { id: "b", type: "mqtt-out", label: "Report", config: { topic: "y" } },
      ],
      edges: [],
    }),
  );
  legacy.close();
  const store = openStore(file);
  try {
    assert.equal(
      store.db.pragma("user_version", { simple: true }),
      migrations.length,
    );
    // MQTT in/out → Radio in/out: default names renamed, custom names kept.
    const [a, b] = store.getFlow("old").nodes;
    assert.equal(a.label, "Radio in");
    assert.equal(b.label, "Report");
    assert.equal(a.config.protocol, "mqtt");
    assert.equal(b.config.protocol, "mqtt");
    store.saveSettings({ ssid: "Lab WiFi", password: "s3cret" });
    assert.deepEqual(store.getSettings(), {
      ssid: "Lab WiFi",
      password: "s3cret",
    });
    store.saveSettings({ ssid: "", password: "" });
    assert.deepEqual(store.getSettings(), {});
    assert.equal(
      store.listRevisions("old").length,
      1,
      "existing flows get a first revision",
    );
    const saved = store.saveFlow({ name: "Lab", nodes: [], edges: [] });
    store.saveFlow({ ...saved });
    assert.equal(
      store.listRevisions(saved.id).length,
      1,
      "identical saves do not add revisions",
    );
    store.saveFlow({ ...saved, name: "Lab 2" });
    const revs = store.listRevisions(saved.id);
    assert.equal(revs.length, 2);
    assert.equal(store.getRevision(saved.id, revs[1].id).name, "Lab");
    const t = store.saveTest(saved.id, {
      name: "T",
      steps: [{ op: "wait", timeout: 10 }],
    });
    assert.throws(
      () => store.saveTest("missing", { name: "T", steps: [] }),
      /Save the flow/,
    );
    assert.throws(() => store.saveTest("old", t), /another flow/);
    store.recordRun(t.id, {
      device: "sim",
      passed: true,
      durationMs: 5,
      steps: [],
    });
    assert.equal(store.listTests(saved.id)[0].last.passed, true);
    store.addDeployment({
      flowName: "Lab",
      action: "upload",
      board: "esp32",
      build: "b1",
      ok: true,
      size: { flash: { used: 1, max: 2 } },
    });
    store.touchDevice("esp-1", { status: "online" });
    store.touchDevice("esp-1", { telemetry: { build: "b1", heap: 1 } });
    const [device] = store.listDevices();
    assert.equal(device.status, "online");
    assert.equal(device.deployment.flow_name, "Lab");
    const extra = [1, 2].map((i) =>
      store.saveFlow({ name: "Bulk " + i, nodes: [], edges: [] }),
    );
    store.saveTest(extra[0].id, {
      name: "T",
      steps: [{ op: "wait", timeout: 10 }],
    });
    assert.equal(store.deleteFlows([...extra.map((f) => f.id), "missing"]), 2);
    assert.equal(store.getFlow(extra[0].id), null);
    assert.equal(store.listTests(extra[0].id).length, 0);
    assert.ok(store.deleteFlow(saved.id));
    assert.equal(
      store.listTests(saved.id).length,
      0,
      "tests cascade with their flow",
    );
    assert.equal(store.listRevisions(saved.id).length, 0);
  } finally {
    store.close();
  }
});
test(
  "test terminal commands reach the simulator over MQTT",
  { timeout: 15000 },
  async () => {
    const { mqttCommand } = require("../lib/terminal");
    const runtime = new FlowRuntime(() => {});
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "microflow/term-1/cmd") && r(),
      ),
    );
    runtime.start({
      flow: structuredClone(flow),
      broker: { url },
      deviceId: "term-1",
    });
    await ready;
    try {
      const ask = (line) =>
        mqttCommand({ broker: { url }, deviceId: "term-1", line }).then(
          (r) => r.reply,
        );
      assert.match(await ask("help"), /^commands: status \| wifi/);
      assert.equal(
        await ask("gpio read 4"),
        "GPIO 4 = 1",
        "GPIO input idles high (pull-up)",
      );
      assert.equal(await ask("send temp 30"), 'sent "30" to temp');
      assert.equal(
        runtime.status().pins[5],
        1,
        "send ran the flow: threshold passed, fan on",
      );
      assert.match(await ask("nodes"), /^9 nodes: temp go hot/);
      assert.match(await ask("frobnicate"), /unknown command 'frobnicate'/);
      await assert.rejects(
        mqttCommand({
          broker: { url },
          deviceId: "nobody",
          line: "status",
          timeout: 300,
        }),
        /did not answer.*Debug build/,
      );
      await assert.rejects(
        mqttCommand({ broker: { url }, deviceId: "term-1", line: "a\nb" }),
        /one command/,
      );
    } finally {
      runtime.stop();
    }
  },
);
test(
  "pulse generator example passes its own timing tests on the simulator",
  { timeout: 30000 },
  async () => {
    const example = require("../examples/pulse-generator.json");
    const gpio = [];
    const runtime = new FlowRuntime(
      (kind, message, extra) =>
        kind === "gpio" && gpio.push([extra.pin, extra.value, Date.now()]),
    );
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) =>
          subs.some((s) => s.topic === "microflow/pulse-1/pulse/trigger") &&
          r(),
      ),
    );
    runtime.start({
      flow: structuredClone(example.flow),
      broker: { url },
      deviceId: "pulse-1",
    });
    await ready;
    try {
      for (const t of example.tests) {
        const result = await runTest(t, { broker: { url }, device: "pulse-1" });
        assert.equal(
          result.passed,
          true,
          `${t.name}: ${JSON.stringify(result.steps)}`,
        );
      }
      // GPIO 14 pulsed high then low; the LED on GPIO 2 toggled with the train.
      const p14 = gpio.filter(([pin]) => pin === 14);
      assert.deepEqual(
        p14.slice(0, 2).map(([, v]) => v),
        [1, 0],
      );
      assert.ok(p14[1][2] - p14[0][2] >= 480, "pulse width ≈ 500 ms");
      assert.ok(gpio.filter(([pin]) => pin === 2).length >= 4, "LED toggled");
    } finally {
      runtime.stop();
    }
    const before = gpio.length;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(gpio.length, before, "stop() cancels pulse timers");
  },
);
test(
  "web + terminal example passes its own test on the simulator",
  { timeout: 15000 },
  async () => {
    const example = require("../examples/web-and-terminal.json");
    const gpio = [];
    const runtime = new FlowRuntime(
      (kind, message, extra) =>
        kind === "gpio" && gpio.push([extra.pin, extra.value]),
    );
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "microflow/web-1/cmd") && r(),
      ),
    );
    runtime.start({
      flow: structuredClone(example.flow),
      broker: { url },
      deviceId: "web-1",
    });
    await ready;
    try {
      for (const t of example.tests) {
        const result = await runTest(t, { broker: { url }, device: "web-1" });
        assert.equal(result.passed, true, JSON.stringify(result.steps));
      }
      // Terminal and Web in both drive the LED and the shared "led" variable.
      assert.equal(runtime.command("led 1"), '→ led: "1"');
      assert.deepEqual(gpio.at(-1), [2, 1]);
      assert.equal(JSON.parse(runtime.webPost("led", "0")).led, 0);
      assert.deepEqual(gpio.at(-1), [2, 0]);
      assert.equal(runtime.webPost("missing", "1"), null);
      assert.match(runtime.command("bogus x"), /unknown command/);
      // Plain text becomes a JSON string.
      runtime.webPost("message", 'say "hi"');
      assert.equal(runtime.webGet("message"), '{"message":"say \\"hi\\""}');
    } finally {
      runtime.stop();
    }
  },
);
test("the PC simulation runs without a broker when offline", () => {
  const events = [];
  const runtime = new FlowRuntime((kind, message) =>
    events.push({ kind, message }),
  );
  const blink = {
    name: "Blink",
    nodes: [
      { id: "go", type: "inject", config: { payload: "1" } },
      { id: "led", type: "digital-write", config: { pin: 5 } },
    ],
    edges: [{ from: "go", to: "led" }],
  };
  assert.throws(
    () =>
      runtime.start({
        flow: blink,
        mode: "device",
        deviceId: "b",
        offline: true,
      }),
    /Only the PC simulation/,
  );
  const status = runtime.start({ flow: structuredClone(blink), offline: true });
  try {
    assert.equal(status.running, true);
    assert.equal(runtime.client, null, "no broker connection is attempted");
    assert.ok(events.some((e) => /no MQTT/.test(e.message)));
    assert.equal(runtime.status().pins[5], 0);
    runtime.inject("go");
    assert.equal(runtime.status().pins[5], 1, "inject drove the output pin");
  } finally {
    runtime.stop();
  }
});
test("switch and push button drive the simulation; the scope reports samples", () => {
  const events = [];
  const runtime = new FlowRuntime((kind, message, extra) =>
    events.push({ kind, ...extra }),
  );
  runtime.start({
    offline: true,
    flow: {
      name: "Bench",
      nodes: [
        { id: "sw", type: "test-switch", config: {} },
        { id: "push", type: "test-button", config: {} },
        { id: "led", type: "digital-write", config: { pin: 5 } },
        { id: "scope", type: "test-scope", config: {} },
      ],
      edges: [
        { from: "sw", to: "led" },
        { from: "sw", to: "scope" },
        { from: "push", to: "scope" },
      ],
    },
  });
  try {
    runtime.inject("sw", "1");
    assert.equal(runtime.status().pins[5], 1, "switch on drives the LED");
    runtime.inject("sw", "0");
    assert.equal(runtime.status().pins[5], 0, "switch off");
    runtime.inject("push", "1");
    runtime.inject("push", "0");
    assert.deepEqual(
      events.filter((e) => e.kind === "scope").map((e) => [e.node, e.payload]),
      [
        ["scope", "1"],
        ["scope", "0"],
        ["scope", "1"],
        ["scope", "0"],
      ],
    );
    assert.ok(events.filter((e) => e.kind === "scope").every((e) => e.quiet));
    assert.throws(() => runtime.inject("led"), /not in the running flow/);
  } finally {
    runtime.stop();
  }
});
test(
  "template example passes its own tests on the simulator",
  { timeout: 15000 },
  async () => {
    const example = require("../examples/template-messages.json");
    const debug = [];
    const runtime = new FlowRuntime(
      (kind, message, extra) =>
        kind === "debug" && debug.push([message, extra.payload]),
    );
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) =>
          subs.some((s) => s.topic === "microflow/tpl-1/inject/bell") && r(),
      ),
    );
    runtime.start({
      flow: structuredClone(example.flow),
      broker: { url },
      deviceId: "tpl-1",
    });
    await ready;
    try {
      for (const t of example.tests) {
        const result = await runTest(t, { broker: { url }, device: "tpl-1" });
        assert.equal(
          result.passed,
          true,
          `${t.name}: ${JSON.stringify(result.steps)}`,
        );
      }
      runtime.inject("fan", "1");
      assert.equal(runtime.status().pins[2], 1, "Fan switch drives GPIO 2");
      assert.deepEqual(debug.at(-1), ["Fan", "Fan state: 1 (1 = on, 0 = off)"]);
    } finally {
      runtime.stop();
    }
  },
);
// Lessons and ESP-NOW samples (examples/learn-*, espnow-*) must pass their own tests
// and build for an ESP32 (the TTGO T-Display when they use its screen).
for (const file of fs
  .readdirSync(path.join(__dirname, "../examples"))
  .filter((f) => f.startsWith("learn-") || f.startsWith("espnow-"))) {
  test(
    `lesson ${file} passes its own tests on the simulator`,
    { timeout: 30000 },
    async () => {
      const example = require("../examples/" + file);
      const { build } = require("../lib/flow");
      const screen = example.flow.nodes.some((n) => n.type === "display");
      const fw = build(structuredClone(example.flow), {
        board: screen ? "ttgo-t-display" : "esp32",
        ssid: "net",
        host: "broker",
      });
      assert.ok(fw.source.length > 0);
      const device = file
        .slice(0, 15)
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-$/, "");
      const runtime = new FlowRuntime(() => {});
      const ready = new Promise((r) =>
        broker.on(
          "subscribe",
          (subs) =>
            subs.some((s) => s.topic === `microflow/${device}/cmd`) && r(),
        ),
      );
      runtime.start({
        flow: structuredClone(example.flow),
        broker: { url },
        deviceId: device,
      });
      await ready;
      try {
        for (const t of example.tests) {
          const result = await runTest(t, { broker: { url }, device });
          assert.equal(
            result.passed,
            true,
            `${t.name}: ${JSON.stringify(result.steps)}`,
          );
        }
      } finally {
        runtime.stop();
      }
    },
  );
}
test("listen-only mode collects every board's status and heartbeat", async () => {
  const seen = [];
  const runtime = new FlowRuntime(() => {}, {
    onDevice: (id, patch) => seen.push([id, patch]),
  });
  const ready = new Promise((r) =>
    broker.on(
      "subscribe",
      (subs) => subs.some((s) => s.topic === "microflow/+/telemetry") && r(),
    ),
  );
  runtime.start({
    flow: { name: "Any", nodes: [], edges: [] },
    broker: { url },
    mode: "monitor",
  });
  await ready;
  const peer = mqtt.connect(url);
  try {
    await new Promise((r) => peer.once("connect", r));
    peer.publish("microflow/broker-abc123/status", "online");
    peer.publish(
      "microflow/broker-abc123/telemetry",
      JSON.stringify({
        ip: "192.168.1.133",
        broker: 1,
        port: 1883,
        clients: 2,
      }),
    );
    // Every board on the broker is collected (also other tests' retained status).
    const mine = () => seen.filter(([id]) => id === "broker-abc123");
    await until(() => mine().some(([, p]) => p.telemetry));
    assert.ok(mine().some(([, p]) => p.status === "online"));
    assert.equal(mine().find(([, p]) => p.telemetry)[1].telemetry.clients, 2);
    assert.throws(() => runtime.inject("x"), /only listens for devices/);
  } finally {
    peer.end(true);
    runtime.stop();
  }
});
test("Node-RED language: the simulation passes JSON messages like the firmware", () => {
  const debug = [];
  const runtime = new FlowRuntime((kind, message, extra) => {
    if (kind === "debug") debug.push(extra.payload);
  });
  runtime.start({
    offline: true,
    flow: {
      name: "msg",
      language: "nodered",
      nodes: [
        { id: "sw", type: "test-switch", name: "DOOR", config: {} },
        {
          id: "tpl",
          type: "template",
          msg: '{"room":"lab"}',
          config: { template: "door {{payload}}" },
        },
        { id: "all", type: "debug", config: { show: "msg" } },
        { id: "pay", type: "debug", config: {} },
      ],
      edges: [
        { from: "sw", to: "tpl" },
        { from: "tpl", to: "all" },
        { from: "tpl", to: "pay" },
      ],
    },
  });
  try {
    runtime.inject("sw", "1");
    assert.deepEqual(debug, [
      '{"payload":"door 1","room":"lab","topic":"DOOR"}',
      "door 1",
    ]);
  } finally {
    runtime.stop();
  }
});
