// Radio in/out (formerly MQTT in/out): protocol MQTT, ESP-NOW or I2C.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze } = require("../lib/flow");
const { FlowRuntime } = require("../lib/runtime");
const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  label,
  config,
});
const pair = (
  protocol,
  extra = {},
  topics = ["lab/{{device}}/x", "lab/+/x"],
) => ({
  name: "Radio",
  nodes: [
    node("go", "inject", { payload: "1" }),
    node("out", "mqtt-out", { protocol, topic: topics[0], ...extra }, "Send"),
    node("in", "mqtt-in", { protocol, topic: topics[1], ...extra }, "Hear"),
    node("led", "digital-write", { pin: 2 }, "LED"),
  ],
  edges: [
    { from: "go", to: "out" },
    { from: "in", to: "led" },
  ],
});
const fw = (flow, settings = {}) =>
  build(flow, {
    board: "esp32",
    ssid: "net",
    host: "broker",
    ...settings,
  });
test("saved MQTT in/out boxes load as Radio in/out with MQTT", () => {
  const r = fw(pair(undefined));
  assert.match(
    r.source,
    /mqtt\.publish\(mfTopic\("lab\/\{\{device\}\}\/x"\)\.c_str\(\)/,
  );
  assert.match(r.source, /mqtt\.subscribe\("lab\/\+\/x"\)/);
  assert.doesNotMatch(r.source, /esp_now|Wire\.h/);
});
test("ESP-NOW: broadcast topic + payload, topic filters, no broker needed", () => {
  // Release without remote update: no WiFi join, so a fixed channel.
  const r = fw(pair("espnow", { channel: 6 }), {
    profile: "release",
    ota: false,
  });
  const src = r.source;
  assert.equal(r.features.net, false, "no broker or router needed");
  assert.match(src, /#include <esp_now\.h>/);
  assert.match(
    src,
    /mfNowSend\(mfTopic\("lab\/\{\{device\}\}\/x"\)\.c_str\(\), value\);/,
  );
  assert.match(
    src,
    /if \(mqttTopicMatch\("lab\/\+\/x", topic\)\) node2\(payload\);/,
  );
  assert.match(src, /esp_wifi_set_channel\(6, WIFI_SECOND_CHAN_NONE\)/);
  assert.match(
    src,
    /String mfTopic\(const char\* topic\)/,
    "{{device}} works offline",
  );
  // Own messages are queued, never dispatched directly (no recursion through a flow).
  assert.match(src, /mfNowStore\(buf, 4 \+ tl \+ pl\);/);
  assert.match(src, /mfNowBegin\(\);/);
  // Joined to the router (debug build): the router's channel is used.
  const joined = fw(pair("espnow", { channel: 6 })).source;
  assert.doesNotMatch(joined, /esp_wifi_set_channel/);
  assert.match(joined, /ESP-NOW uses the router's channel/);
});
test("I2C controller writes and polls; peripheral replies and receives", () => {
  const ctl = fw(
    pair("i2c", { i2cRole: "controller", address: 9, interval: 150 }),
  ).source;
  assert.match(ctl, /#include <Wire\.h>/);
  assert.match(ctl, /Wire\.begin\(21, 22\); \/\/ I2C controller/);
  assert.match(ctl, /mfI2cWrite\(9, value\);/);
  assert.match(
    ctl,
    /if \(millis\(\) - t2 >= 150UL\) \{ t2 = millis\(\); String v = mfI2cRead\(9\); if \(v\.length\(\) && v != last2\) \{ last2 = v; node2\(v\); \} \}/,
  );
  const per = fw(pair("i2c", { i2cRole: "peripheral", address: 9 })).source;
  assert.match(per, /Wire\.onReceive\(mfI2cOnReceive\);/);
  assert.match(per, /Wire\.onRequest\(mfI2cOnRequest\);/);
  assert.match(
    per,
    /Wire\.begin\(\(uint8_t\)9, 21, 22, 100000\); \/\/ I2C peripheral/,
  );
  assert.match(per, /mfI2cReply\(value\);/);
  assert.match(per, /if \(mfI2cGot\) \{/);
});
test("radio checks: roles, addresses, pins and board support", () => {
  const errors = (flow, board = "esp32") =>
    analyze(flow, board).errors.join(" ");
  const mixed = pair("i2c");
  mixed.nodes[2].config.i2cRole = "peripheral";
  assert.match(errors(mixed), /same I2C role/);
  assert.match(
    errors(pair("i2c", { i2cRole: "peripheral", sda: 4, scl: 5 }), "esp8266"),
    /cannot be an I2C peripheral/,
  );
  const clash = pair("i2c");
  clash.nodes[3].config.pin = 21;
  assert.match(
    errors(clash),
    /GPIO 21 is the I2C SDA pin and also used by LED/,
  );
  assert.match(errors(pair("espnow"), "esp8266"), /ESP-NOW/);
  const channels = pair("espnow");
  channels.nodes[2].config.channel = 11;
  assert.match(errors(channels), /same channel/);
  assert.throws(
    () => analyze(pair("i2c", { sda: 21, scl: 21 }), "esp32"),
    /SDA and SCL must be different/,
  );
  // Wiring advice for I2C.
  assert.match(
    analyze(pair("i2c"), "esp32").warnings.join(" "),
    /4\.7 kΩ pull-ups/,
  );
});
test("the simulator loops ESP-NOW back and logs I2C as board-only", async () => {
  const events = [];
  const runtime = new FlowRuntime((kind, message, extra) =>
    events.push({ kind, message, ...extra }),
  );
  runtime.start({ flow: pair("espnow"), offline: true });
  try {
    runtime.inject("go", "1");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      events.some(
        (e) => e.kind === "radio" && /ESP-NOW → lab\/sim\/x/.test(e.message),
      ),
    );
    assert.equal(
      runtime.status().pins[2],
      1,
      "Radio in heard it and lit the LED",
    );
  } finally {
    runtime.stop();
  }
  events.length = 0;
  runtime.start({ flow: pair("i2c", { address: 9 }), offline: true });
  try {
    runtime.inject("go", "1");
    assert.ok(
      events.some((e) => /I2C → address 9 \(board only/.test(e.message)),
    );
  } finally {
    runtime.stop();
  }
});
