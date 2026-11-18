// Advanced node settings: Radio out with a broker of its own (login, client ID,
// payload options) and Threshold refresh. Firmware, simulator and a whole-sketch
// compile with the host g++ (stand-in headers in test/fixtures/arduino).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, build } = require("../lib/flow");
const { types, parseBroker, catalog } = require("../lib/nodes");

const out = (config, extra = {}) => ({
  id: "o",
  type: "mqtt-out",
  label: "Cloud",
  config: { topic: "home/{{device}}/t", ...config },
  ...extra,
});
const flowOf = (nodes, pairs, language) => ({
  name: "t",
  ...(language ? { language } : {}),
  nodes,
  edges: pairs.map(([from, to]) => ({ from, to })),
});
const release = {
  board: "esp32",
  ssid: "n",
  host: "h",
  profile: "release",
  ota: false,
  deviceId: "board1",
};

test("advanced fields are marked and folded in the catalog", () => {
  const advanced = (type) =>
    catalog()
      [type].fields.filter((f) => f.advanced)
      .map((f) => f.key);
  assert.deepEqual(advanced("mqtt-out"), [
    "broker",
    "clientId",
    "username",
    "password",
    "payloadMode",
    "payloadText",
  ]);
  assert.deepEqual(advanced("threshold"), ["refresh"]);
  assert.deepEqual(advanced("mqtt-in"), []);
  assert.equal(
    catalog()["mqtt-out"].fields.find((f) => f.key === "password").type,
    "secret",
  );
});
test("broker addresses and logins are checked", () => {
  assert.equal(parseBroker(""), null);
  assert.deepEqual(parseBroker("mqtt://b.example.com:1884"), {
    host: "b.example.com",
    port: 1884,
  });
  assert.deepEqual(parseBroker("192.168.1.5"), {
    host: "192.168.1.5",
    port: 1883,
  });
  const problem = (config) => {
    try {
      validate({ nodes: [out(config)], edges: [] });
      return "ok";
    } catch (e) {
      return e.message;
    }
  };
  assert.match(problem({ broker: "mqtts://b" }), /without TLS/);
  assert.match(problem({ broker: "a b" }), /host, host:port/);
  assert.match(problem({ broker: "b:70000" }), /port must be/);
  assert.match(problem({ username: "u" }), /broker of its own/);
  assert.match(problem({ clientId: "x" }), /needs a broker of its own/);
  assert.match(problem({ broker: "b", clientId: "a b" }), /Client ID may use/);
  assert.match(problem({ broker: "b", password: "x".repeat(65) }), /64/);
  assert.equal(problem({ broker: "b", username: "u", password: "p" }), "ok");
  assert.match(
    (() => {
      try {
        validate({
          nodes: [{ id: "t", type: "threshold", config: { refresh: 50 } }],
          edges: [],
        });
      } catch (e) {
        return e.message;
      }
    })(),
    /at least 100 ms/,
  );
  // Fixed text may be empty; defaults stay off.
  const [n] = validate({
    nodes: [out({ payloadMode: "text", payloadText: "" })],
    edges: [],
  }).nodes;
  assert.equal(n.config.payloadText, "");
  assert.equal(n.config.broker, "");
});
test("firmware: own broker client with back-off, login and payload options", () => {
  const { source } = build(
    flowOf(
      [
        { id: "i", type: "inject", config: { payload: "30", interval: 0 } },
        out({
          broker: "b.example.com:1884",
          username: "u1",
          password: 'p"w',
          payloadMode: "template",
          payloadText: '{"t":{{payload}}}',
        }),
      ],
      [["i", "o"]],
    ),
    release,
  );
  assert.match(source, /PubSubClient mfMqtt1\(mfNet1\);/);
  assert.match(source, /mfMqtt1\.setServer\("b\.example\.com", 1884\);/);
  assert.match(source, /String id = mfId \+ "-o";/);
  assert.match(source, /mfMqtt1\.connect\(id\.c_str\(\), "u1", "p\\"w"\)/);
  assert.match(source, /if \(wait < 30000\) wait \*= 2;/);
  assert.match(source, /if \(mfBroker1\(\)\) mfMqtt1\.loop\(\);/);
  assert.match(
    source,
    /String mfPayload = \(String\("\{\\"t\\":"\) \+ value \+ String\("\}"\)\); if \(mfBroker1\(\)\) mfMqtt1\.publish\(mfTopic\("home\/\{\{device\}\}\/t"\)\.c_str\(\), mfPayload\.c_str\(\), false\);/,
  );
  // Without Advanced settings nothing changes.
  const plain = build(
    flowOf(
      [
        { id: "i", type: "inject", config: { payload: "1", interval: 0 } },
        out({}),
      ],
      [["i", "o"]],
    ),
    release,
  ).source;
  assert.doesNotMatch(plain, /mfBroker|mfPayload/);
  assert.match(
    plain,
    /mqtt\.publish\(mfTopic\("home\/\{\{device\}\}\/t"\)\.c_str\(\), value\.c_str\(\), false\);/,
  );
});
test("firmware: Threshold refresh re-runs the last message", () => {
  for (const language of ["arduino", "nodered"]) {
    const { source } = build(
      flowOf(
        [
          { id: "i", type: "inject", config: { payload: "30", interval: 0 } },
          { id: "th", type: "threshold", config: { value: 25, refresh: 2000 } },
          { id: "d", type: "debug", config: {} },
        ],
        [
          ["i", "th"],
          ["th", "d"],
        ],
        language,
      ),
      release,
    );
    const kept = language === "nodered" ? "mfIn" : "value";
    assert.match(
      source,
      new RegExp(
        `mfThLast1 = ${kept}; mfThHas1 = true; mfThAt1 = millis\\(\\); double x;`,
      ),
    );
    assert.match(
      source,
      /if \(mfThHas1 && millis\(\) - mfThAt1 >= 2000UL\) node1\(mfThLast1\);/,
    );
  }
});
test("simulator: Threshold refresh resends the last value while it passes", () => {
  const timers = [];
  const forwarded = [];
  const ctx = {
    state: {},
    later: (ms, fn) => (timers.push({ ms, fn }), timers.length),
    cancel: () => {},
    forward: (v) => forwarded.push(v),
  };
  const [n] = validate({
    nodes: [
      { id: "t", type: "threshold", config: { value: 25, refresh: 1000 } },
    ],
    edges: [],
  }).nodes;
  assert.equal(types.threshold.host("30", n, ctx), "30");
  timers.at(-1).fn(); // the period passes
  assert.deepEqual(forwarded, ["30"]);
  assert.equal(types.threshold.host("10", n, ctx), undefined);
  timers.at(-1).fn(); // 10 no longer passes: nothing resent
  assert.deepEqual(forwarded, ["30"]);
  assert.equal(timers.at(-1).ms, 1000);
});
test("simulator: own broker client, dropped until connected, closed on stop", async () => {
  // Without the mqtt package installed (e.g. a fresh checkout) the runtime cannot load.
  let FlowRuntime;
  try {
    ({ FlowRuntime } = require("../lib/runtime"));
  } catch {
    return;
  }
  const clients = [];
  const connect = (url, options) => {
    const c = new EventEmitter();
    Object.assign(c, { url, options, connected: false, sent: [] });
    c.publish = (t, p, o, cb) => (c.sent.push(`${t} ${p}`), cb?.());
    c.end = () => (c.ended = true);
    clients.push(c);
    return c;
  };
  const events = [];
  const runtime = new FlowRuntime(
    (kind, message, extra) => events.push([kind, message, extra?.payload]),
    { connect },
  );
  runtime.start({
    offline: true,
    deviceId: "pc",
    flow: flowOf(
      [
        { id: "i", type: "inject", config: { payload: "21", interval: 0 } },
        out({
          broker: "mqtt://b.example.com:1884",
          username: "u1",
          password: "pw",
          payloadMode: "template",
          payloadText: "t={{payload}}",
        }),
      ],
      [["i", "o"]],
    ),
  });
  try {
    assert.equal(clients.length, 1);
    assert.equal(clients[0].url, "mqtt://b.example.com:1884");
    assert.equal(clients[0].options.clientId, "pc-o");
    assert.equal(clients[0].options.username, "u1");
    runtime.run("i", "21");
    assert.ok(events.some(([k, m]) => k === "warning" && /dropped/.test(m)));
    clients[0].connected = true;
    runtime.run("i", "22");
    assert.deepEqual(clients[0].sent, ["home/pc/t t=22"]);
  } finally {
    runtime.stop();
  }
  assert.equal(clients[0].ended, true);
});

// Whole generated sketch (release build), compiled with stand-in headers and run.
const gxx = spawnSync("g++", ["--version"]).status === 0;
test(
  "whole sketch with advanced settings compiles and runs (g++, stand-in headers)",
  { skip: !gxx && "g++ not found" },
  () => {
    const flow = (language) =>
      flowOf(
        [
          {
            id: "i",
            type: "inject",
            msg: '{"topic":"T"}',
            config: { payload: "30", interval: 0 },
          },
          { id: "th", type: "threshold", config: { value: 25, refresh: 2000 } },
          out(
            {
              broker: "mqtt://b.example.com:1884",
              username: "u1",
              password: 'p"w',
              payloadMode: language === "nodered" ? "msg" : "template",
              payloadText: '{"t":{{payload}}}',
            },
            language === "nodered" ? { msg: '{"room":"lab"}' } : {},
          ),
          {
            id: "o2",
            type: "mqtt-out",
            config: { topic: "a/b", payloadMode: "text", payloadText: "fixed" },
          },
        ],
        [
          ["i", "th"],
          ["th", "o"],
          ["th", "o2"],
        ],
        language,
      );
    const run = (language) => {
      const { source } = build(flow(language), release);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sketch-"));
      // millis() in the stand-in advances 10 ms per call.
      fs.writeFileSync(
        path.join(dir, "sketch.cpp"),
        `#include "Arduino.h"\nstd::string published;\n${source}\nint main() { setup(); node0(String("30")); printf("%s", published.c_str()); }\n`,
      );
      const exe = path.join(dir, "sketch");
      const cc = spawnSync(
        "g++",
        [
          "-std=gnu++17",
          "-I",
          path.join(__dirname, "fixtures/arduino"),
          "-Wall",
          "-Wno-unused-function",
          "-Wno-unused-variable",
          "-o",
          exe,
          path.join(dir, "sketch.cpp"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(cc.status, 0, cc.stderr);
      return spawnSync(exe, { encoding: "utf8" }).stdout.trim().split("\n");
    };
    assert.deepEqual(run("arduino"), ['home/board1/t {"t":30}', "a/b fixed"]);
    // Complete msg: the message received plus the node's Message fields.
    assert.deepEqual(run("nodered"), [
      'home/board1/t {"payload":30,"room":"lab","topic":"T"}',
      "a/b fixed",
    ]);
  },
);
