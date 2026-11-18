const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const mqtt = require("mqtt");
const aedes = require("aedes");
process.env.DB_PATH = ":memory:";
const { app, db, stop, matches } = require("../server");
const { validate, generate } = require("../lib/flow");
const flow = {
  name: "Test",
  nodes: [
    { id: "in", type: "mqtt-in", config: { topic: "test/input" } },
    { id: "gate", type: "threshold", config: { value: 25 } },
    { id: "out", type: "mqtt-out", config: { topic: "test/output" } },
  ],
  edges: [
    { from: "in", to: "gate" },
    { from: "gate", to: "out" },
  ],
};
after(() => {
  stop();
  db.close();
});
test("reject cycles, invalid pins and dangling edges", () => {
  assert.throws(
    () =>
      validate({
        ...flow,
        edges: [...flow.edges, { from: "out", to: "gate" }],
      }),
    /Cycles/,
  );
  assert.throws(
    () =>
      validate({ ...flow, edges: [...flow.edges, { from: "out", to: "in" }] }),
    /cannot receive connections/,
  );
  assert.throws(
    () => validate({ ...flow, edges: [{ from: "in", to: "missing" }] }),
    /missing/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [{ id: "a", type: "digital-write", config: { pin: 99 } }],
        edges: [],
      }),
    /GPIO/,
  );
});
test("MQTT wildcard matching", () => {
  assert.ok(matches("test/+/value", "test/device/value"));
  assert.ok(matches("test/#", "test"));
  assert.ok(!matches("test/+", "test"));
  assert.ok(!matches("#", "$SYS/status"));
});
test("firmware targets both architectures and escapes credentials", () => {
  for (const board of ["esp32", "esp8266"]) {
    const source = generate(flow, {
      board,
      ssid: 'a"; malicious(); //',
      password: "secret",
    });
    assert.match(source, /PubSubClient/);
    assert.ok(source.includes(JSON.stringify('a"; malicious(); //')));
    assert.ok(source.includes(board === "esp32" ? "WiFi.h" : "ESP8266WiFi.h"));
    assert.match(source, /mqtt.subscribe\("test\/input"\)/);
  }
});
test(
  "SQLite round trip and real MQTT routing",
  { timeout: 10000 },
  async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api/`;
    const request = async (path, body) => {
      const res = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const broker = aedes(),
      tcp = net.createServer(broker.handle);
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    const url = `mqtt://127.0.0.1:${tcp.address().port}`;
    const peer = mqtt.connect(url);
    try {
      const missing = await fetch(base + "missing-endpoint");
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get("content-type"), /application\/json/);
      assert.match((await missing.json()).error, /Unknown API endpoint/);
      assert.equal(missing.headers.get("cache-control"), "no-store");
      const script = await fetch(base.replace("/api/", "/app.js"));
      assert.equal(script.headers.get("cache-control"), "no-store");
      const examples = await request("examples");
      assert.ok(
        examples.some((e) => e.name === "pulse-generator" && e.tests === 3),
      );
      const added = await request("examples/pulse-generator", {});
      assert.equal(added.name, "Pulse generator test");
      assert.equal((await request(`flows/${added.id}/tests`)).length, 3);
      const saved = await request("flows", flow);
      assert.deepEqual((await request("flows/" + saved.id)).edges, flow.edges);
      if (!peer.connected)
        await new Promise((r, j) => {
          peer.once("connect", r);
          peer.once("error", j);
        });
      await new Promise((r, j) =>
        peer.subscribe("test/output", (e) => (e ? j(e) : r())),
      );
      const subscribed = new Promise((r) => {
        broker.on("subscribe", (subscriptions, c) => {
          if (
            c.id !== peer.options.clientId &&
            subscriptions.some((s) => s.topic === "test/input")
          )
            r();
        });
      });
      await request("runtime/start", { flow, broker: { url } });
      await subscribed;
      let outputs = [];
      peer.on("message", (topic, p) => outputs.push(p.toString()));
      peer.publish("test/input", "10");
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(outputs, []);
      const message = new Promise((r) =>
        peer.once("message", (topic, p) => r(p.toString())),
      );
      peer.publish("test/input", "28");
      assert.equal(await message, "28");
      await request("runtime/stop", {});
      const deleted = await fetch(base + "flows/" + saved.id, {
        method: "DELETE",
      });
      assert.equal(deleted.status, 200);
      assert.equal((await fetch(base + "flows/" + saved.id)).status, 404);
      assert.ok(
        !(await request("flows")).some((entry) => entry.id === saved.id),
      );
    } finally {
      stop();
      await new Promise((r) => peer.end(true, r));
      await new Promise((r) => tcp.close(r));
      await new Promise((r) => broker.close(r));
      await new Promise((r) => server.close(r));
    }
  },
);
test(
  "simulated board web API: /sim/api, /sim/terminal and the page",
  { timeout: 10000 },
  async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const root = `http://127.0.0.1:${server.address().port}`;
    const broker = aedes(),
      tcp = net.createServer(broker.handle);
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    const url = `mqtt://127.0.0.1:${tcp.address().port}`;
    const send = async (path, body, type = "application/json") => {
      const res = await fetch(root + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": type },
        body,
      });
      return { status: res.status, text: await res.text() };
    };
    try {
      assert.equal((await send("/sim/api")).status, 400); // not running yet
      const example = require("../examples/web-and-terminal.json");
      await send(
        "/api/runtime/start",
        JSON.stringify({ flow: example.flow, broker: { url } }),
      );
      assert.deepEqual(JSON.parse((await send("/sim/api")).text), {
        led: null,
        light: null,
        message: null,
      });
      // A bare JSON number is accepted (not only objects) and the reply holds the outputs.
      const posted = await send("/sim/api/led", "1");
      assert.equal(posted.status, 200);
      assert.equal(JSON.parse(posted.text).led, 1);
      const obj = await send("/sim/api/message", '{"text":"hi","n":2}');
      assert.deepEqual(JSON.parse(obj.text).message, { text: "hi", n: 2 });
      assert.deepEqual(JSON.parse((await send("/sim/api/message")).text), {
        message: { text: "hi", n: 2 },
      });
      assert.equal((await send("/sim/api/nope", "1")).status, 404);
      assert.equal((await send("/sim/api/nope")).status, 404);
      const term = await send("/sim/terminal", "say hello world", "text/plain");
      assert.equal(term.text, '→ say: "hello world"');
      assert.deepEqual(JSON.parse((await send("/sim/api/message")).text), {
        message: "hello world",
      });
      assert.match(
        (await send("/sim/terminal", "nodes", "text/plain")).text,
        /10 nodes/,
      );
      const page = await send("/sim/");
      assert.equal(page.status, 200);
      assert.match(page.text, /const IN=\["led","message"\]/);
      await send("/api/runtime/stop", "{}");
    } finally {
      stop();
      await new Promise((r) => tcp.close(r));
      await new Promise((r) => broker.close(r));
      await new Promise((r) => server.close(r));
    }
  },
);
test("a USB upload without a broker host explains why MQTT needs it", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "usb",
          flow,
          settings: { board: "esp32", serialPort: "COM99", ssid: "net" },
        }),
      },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.stage, "settings");
    assert.match(body.error, /The upload method does not matter \(USB too\)/);
    assert.ok(
      body.error.includes("this flow uses MQTT (Radio in, Radio out)"),
      body.error,
    );
    assert.match(body.error, /test\.mosquitto\.org/);
  } finally {
    server.close();
  }
});
test("the upload window learns why a broker is needed and can check one", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const post = async (path, body) =>
    (
      await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  // A port that was just free: nothing listens there.
  const closed = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "0.0.0.0", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const listener = net.createServer((s) => s.end()).listen(0, "0.0.0.0");
  await new Promise((r) => listener.once("listening", r));
  try {
    const fw = await post("firmware", {
      flow,
      settings: { board: "esp32", ssid: "net" },
    });
    assert.equal(fw.broker, "this flow uses MQTT (Radio in, Radio out)");
    const loop = await post("broker/probe", { host: "127.0.0.1", port: 1883 });
    assert.equal(loop.ok, false);
    assert.match(loop.message, /on the board itself, not this PC/);
    const bad = await post("broker/probe", { host: "a b", port: 1883 });
    assert.match(bad.error, /Enter a broker host/);
    // Real connections need a non-loopback address: this PC's LAN IP, if any.
    if (fw.lan) {
      const up = await post("broker/probe", {
        host: fw.lan,
        port: listener.address().port,
      });
      assert.equal(up.ok, true, up.message);
      const down = await post("broker/probe", { host: fw.lan, port: closed });
      assert.equal(down.ok, false);
      assert.match(down.message, /Nothing is listening/);
    }
  } finally {
    listener.close();
    server.close();
  }
});
test("the broker board upload rejects bad settings before touching a port", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const post = async (body) => {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/broker-board/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, ...(await res.json()) };
  };
  try {
    const wrongBoard = await post({
      board: "esp8266",
      ssid: "n",
      serialPort: "COM9",
    });
    assert.equal(wrongBoard.status, 400);
    assert.match(wrongBoard.error, /ESP32-family/);
    const noPort = await post({ board: "esp32", ssid: "n", serialPort: "" });
    assert.equal(noPort.status, 400);
    assert.match(noPort.error, /serial port/);
  } finally {
    server.close();
  }
});
