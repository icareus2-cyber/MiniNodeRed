// Opt-in: compiles generated firmware with the real ESP toolchains.
// Run with ARDUINO_CLI=/path/to/arduino-cli npm test (needs esp8266/esp32 cores and PubSubClient).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../lib/flow");
const { parseSize } = require("../lib/boards");
const cli = process.env.ARDUINO_CLI;
const everyNode = (adc) => ({
  name: 'Every "node"',
  nodes: [
    { id: "inj", type: "inject", config: { payload: "28" } },
    { id: "tick", type: "inject", config: { payload: "x", interval: 2000 } },
    { id: "in", type: "mqtt-in", config: { topic: "t/{{device}}/+/v" } },
    { id: "btn", type: "gpio-watch", config: { pin: 4 } },
    { id: "adc", type: "analog-in", config: { pin: adc } },
    { id: "th", type: "threshold", config: { value: 25, refresh: 5000 } },
    { id: "eq", type: "compare", config: { op: "eq", value: "1" } },
    { id: "has", type: "compare", config: { op: "contains", value: "on?" } },
    { id: "sc", type: "scale", config: {} },
    { id: "thr", type: "throttle", config: {} },
    { id: "tpl", type: "template", config: { template: '{"t":{{payload}}}' } },
    { id: "rd", type: "digital-read", config: { pin: 5 } },
    { id: "wr", type: "digital-write", config: { pin: 2 } },
    { id: "pwm", type: "pwm-write", config: { pin: 14 } },
    {
      id: "out",
      type: "mqtt-out",
      config: { topic: "t/{{device}}/out", retain: "yes" },
    },
    { id: "dbg", type: "debug", label: "Log */ °", config: {} },
    {
      id: "train",
      type: "pulse-train",
      config: { high: 200, low: 800, count: 5 },
    },
    {
      id: "shot",
      type: "pulse",
      config: { pin: 12, fromPayload: "yes", retrigger: "ignore" },
    },
    { id: "sw", type: "test-switch", config: {} },
    { id: "push", type: "test-button", config: {} },
    { id: "scope", type: "test-scope", config: {} },
    // Logic: a gate over two inputs, an SR latch by input names, an on-delay timer.
    { id: "lx", type: "logic", config: { fn: "xor" } },
    {
      id: "lsr",
      type: "logic",
      config: { fn: "sr", set: "SW1", reset: "BTN1", output: "every" },
    },
    { id: "lton", type: "logic", config: { fn: "ton", time: 1500 } },
    // Advanced: a broker of its own with a login, and a template payload.
    {
      id: "cloud",
      type: "mqtt-out",
      config: {
        topic: "t/{{device}}/cloud",
        broker: "mqtt://broker.example.com:1884",
        clientId: "mf-cloud",
        username: "u",
        password: "p",
        payloadMode: "template",
        payloadText: '{"v":{{payload}}}',
      },
    },
    {
      id: "code",
      type: "arduino",
      label: "C/C++",
      config: {
        vars: "int count = 0;\nunsigned long last = 0;\nstruct Avg { float sum = 0; int n = 0; } avg;\nfloat mean(const Avg& a) { return a.n ? a.sum / a.n : 0; }",
        setup: "count = 0;",
        message:
          'count++;\navg.sum += value.toFloat(); avg.n++;\nsend(count);\nsend(mean(avg), 1);\nsend("text");\nif (from == "SW1" && SW1) send(-1);\nif (jsonHas(value, "t") && jsonBool(value, "on")) send(Json().add("t", jsonNumber(value, "t", 0)).add("name", jsonText(value, "a.b[0]")).add("n", count).add("ok", true));',
        loop: "if (millis() - last >= 1000) { last = millis(); send(count); }",
      },
    },
  ],
  edges: [
    ["inj", "th"],
    ["in", "th"],
    ["th", "tpl"],
    ["tpl", "out"],
    ["btn", "eq"],
    ["eq", "wr"],
    ["adc", "sc"],
    ["sc", "thr"],
    ["thr", "pwm"],
    ["thr", "dbg"],
    ["tick", "rd"],
    ["rd", "has"],
    ["has", "dbg"],
    ["train", "shot"],
    ["shot", "dbg"],
    ["sw", "scope"],
    ["push", "scope"],
    ["inj", "code"],
    ["sw", "code"],
    ["th", "cloud"],
    ["sw", "lx"],
    ["push", "lx"],
    ["sw", "lsr"],
    ["push", "lsr"],
    ["lx", "lton"],
    ["lsr", "dbg"],
    ["lton", "dbg"],
    ["code", "dbg"],
  ].map(([from, to]) => ({ from, to })),
});
const { randomBytes } = require("node:crypto");
const keys = {
  enc: randomBytes(32),
  mac: randomBytes(32),
  lan: randomBytes(16).toString("hex"),
};
const offline = {
  name: "Offline blink",
  nodes: [
    { id: "tick", type: "inject", config: { payload: "1", interval: 500 } },
    { id: "led", type: "digital-write", config: { pin: 2 } },
  ],
  edges: [{ from: "tick", to: "led" }],
};
const variants = [
  ["debug + OTA", (adc) => everyNode(adc), { profile: "debug", ota: true }],
  ["release + OTA", (adc) => everyNode(adc), { profile: "release", ota: true }],
  [
    "debug without OTA",
    (adc) => everyNode(adc),
    { profile: "debug", ota: false },
  ],
  ["offline release", () => offline, { profile: "release", ota: false }],
  [
    "debug + PC input emulation",
    (adc) => everyNode(adc),
    { profile: "debug", ota: true, emulate: true },
  ],
  // Node-RED language: JSON messages on every wire, Debug showing whole messages.
  [
    "debug + Node-RED language",
    (adc) => {
      const flow = everyNode(adc);
      flow.language = "nodered";
      flow.nodes.find((n) => n.id === "dbg").config.show = "msg";
      flow.nodes.find((n) => n.id === "tpl").msg = '{"room":"lab"}';
      return flow;
    },
    { profile: "debug", ota: true, emulate: true },
  ],
];
const compile = (fw) => {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mf-")),
    "sketch",
  );
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "sketch.ino"), fw.source);
  const run = spawnSync(cli, ["compile", "--fqbn", fw.fqbn, dir], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return parseSize(run.stdout + run.stderr); // ESP8266 prints its size table on stderr
};
for (const [board, adc] of [
  ["esp8266", 17],
  ["esp32", 34],
])
  for (const [name, flow, options] of variants)
    test(
      `${name} firmware compiles for ${board}`,
      { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
      () => {
        const fw = build(flow(adc), {
          board,
          ssid: "net",
          password: "pw",
          host: "broker.local",
          username: "u",
          mqttPassword: "p",
          otaKeys: keys,
          ...options,
        });
        const size = compile(fw);
        assert.ok(size.flash.used > 0 && size.ram.used > 0);
        console.log(
          `# ${board} ${name}: flash ${size.flash.used} B, RAM ${size.ram.used} B`,
        );
      },
    );
// The TTGO T-Display example also needs the Adafruit ST7789 + GFX libraries.
for (const profile of ["debug", "release"])
  test(
    `TTGO T-Display example compiles (${profile})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const example = require("../examples/ttgo-t-display.json");
      const fw = build(structuredClone(example.flow), {
        board: "ttgo-t-display",
        ssid: "n",
        password: "p",
        host: "broker.local",
        profile,
        otaKeys: keys,
      });
      const size = compile(fw);
      console.log(
        `# ttgo-t-display ${profile}: flash ${size.flash.used} B, RAM ${size.ram.used} B`,
      );
    },
  );
// Bluetooth example: Bluedroid on ESP32, NimBLE on ESP32-C3/S3.
for (const [board, profile, ota] of [
  ["esp32", "debug", true],
  ["esp32c3", "release", false],
  ["esp32s3", "debug", false],
])
  test(
    `Bluetooth link example compiles for ${board} (${profile})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const example = require("../examples/bluetooth-link.json");
      const fw = build(structuredClone(example.flow), {
        board,
        ssid: "n",
        password: "p",
        host: "broker.local",
        profile,
        ota,
        otaKeys: keys,
      });
      const size = compile(fw);
      console.log(
        `# bluetooth ${board} ${profile}: flash ${size.flash.used} B, RAM ${size.ram.used} B`,
      );
    },
  );
// Web in/out + Terminal example: web server on both cores, terminal in release builds.
for (const [board, adc, profile] of [
  ["esp32", 34, "debug"],
  ["esp32", 34, "release"],
  ["esp8266", 17, "debug"],
  ["esp8266", 17, "release"],
])
  test(
    `Web + terminal example compiles for ${board} (${profile})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const flow = structuredClone(
        require("../examples/web-and-terminal.json").flow,
      );
      flow.nodes.find((n) => n.id === "light").config.pin = adc;
      const fw = build(flow, {
        board,
        ssid: "n",
        password: "p",
        host: "broker.local",
        profile,
        ota: profile === "debug",
        otaKeys: keys,
      });
      const size = compile(fw);
      console.log(
        `# web ${board} ${profile}: flash ${size.flash.used} B, RAM ${size.ram.used} B`,
      );
    },
  );
// The MQTT broker board firmware also needs the sMQTTBroker library.
for (const board of ["esp32", "esp32s3", "ttgo-t-display"])
  test(
    `MQTT broker board firmware compiles for ${board}`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const { generate } = require("../lib/brokerfw");
      const fw = generate({
        board,
        ssid: "net",
        password: "pw",
        username: "u",
        brokerPassword: "p",
        staticIp: "192.168.1.50",
        gateway: "192.168.1.1",
      });
      const size = compile(fw);
      assert.ok(size.flash.used > 0);
      console.log(`# broker ${board}: flash ${size.flash.used} B`);
    },
  );
// Radio in/out over ESP-NOW and I2C (no extra libraries: ESP-NOW and Wire are in the cores).
const radioFlow = (protocol, extra) => ({
  name: "Radio",
  nodes: [
    {
      id: "go",
      type: "inject",
      label: "Go",
      config: { payload: "1", interval: 1000 },
    },
    {
      id: "out",
      type: "mqtt-out",
      label: "Send",
      config: { protocol, topic: "lab/{{device}}/x", ...extra },
    },
    {
      id: "in",
      type: "mqtt-in",
      label: "Hear",
      config: { protocol, topic: "lab/+/x", ...extra },
    },
    { id: "led", type: "digital-write", label: "LED", config: { pin: 2 } },
  ],
  edges: [
    { from: "go", to: "out" },
    { from: "in", to: "led" },
  ],
});
for (const [board, protocol, extra, profile] of [
  ["esp32", "espnow", {}, "debug"],
  ["esp32s3", "espnow", {}, "release"],
  ["esp32", "i2c", { i2cRole: "controller", address: 9 }, "debug"],
  ["esp32", "i2c", { i2cRole: "peripheral", address: 9 }, "release"],
  [
    "esp8266",
    "i2c",
    { i2cRole: "controller", address: 9, sda: 4, scl: 5 },
    "release",
  ],
])
  test(
    `Radio ${protocol} ${extra.i2cRole || ""} firmware compiles for ${board} (${profile})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const fw = build(radioFlow(protocol, extra), {
        board,
        ssid: "net",
        password: "pw",
        host: "broker.local",
        profile,
        ota: false,
        otaKeys: keys,
      });
      const size = compile(fw);
      assert.ok(size.flash.used > 0);
    },
  );
// Input / Output devices: every sensor and motor on one board (the camera on the
// ESP32-CAM). DS18B20 and DHT need the OneWire, DallasTemperature and DHT sensor
// libraries, which the IDE installs on the first compile; installed here too.
const deviceFlow = (board) => {
  const esp8266 = board === "esp8266";
  const adc = esp8266 ? 17 : 34;
  const sensors =
    board === "esp32cam"
      ? [{ device: "camera", camOut: "both" }]
      : [
          { device: "temp", sensor: "ds18b20", pin: esp8266 ? 2 : 4 },
          {
            device: "temp",
            sensor: "dht22",
            pin: esp8266 ? 0 : 16,
            interval: 2000,
            dhtOut: "both",
          },
          { device: "temp", sensor: "ntc", pin: adc, unit: "f" },
          { device: "volt", pin: adc, r1: 30, r2: 7.5 },
          { device: "gyro", ...(esp8266 ? { sda: 4, scl: 5 } : {}) },
          {
            device: "scope",
            pin: adc,
            rate: 1000,
            samples: 100,
            interval: 1000,
          },
        ];
  const motors =
    board === "esp32cam"
      ? [{ device: "servo", pin: 13, speed: 60 }]
      : [
          { device: "servo", pin: esp8266 ? 14 : 13, speed: 60 },
          {
            device: "stepper",
            pin: esp8266 ? 12 : 25,
            dirPin: esp8266 ? 13 : 26,
            enPin: esp8266 ? 15 : 27,
            idle: "release",
            input: "distance",
          },
          ...(esp8266
            ? []
            : [
                {
                  device: "stepper",
                  driver: "uln2003",
                  in1: 17,
                  in2: 18,
                  in3: 19,
                  in4: 23,
                  input: "rpm",
                  rpm: 10,
                },
              ]),
        ];
  const nodes = [
    ...sensors.map((config, k) => ({
      id: "s" + k,
      type: "input-device",
      config,
    })),
    { id: "go", type: "inject", config: { payload: "90", interval: 5000 } },
    ...motors.map((config, k) => ({
      id: "m" + k,
      type: "output-device",
      config,
    })),
    { id: "dbg", type: "debug", config: {} },
  ];
  const edges = [
    ...sensors.map((_, k) => ({ from: "s" + k, to: "dbg" })),
    ...motors.map((_, k) => ({ from: "go", to: "m" + k })),
    ...motors.map((_, k) => ({ from: "m" + k, to: "dbg" })),
  ];
  return { name: "Devices", nodes, edges };
};
for (const [board, profile] of [
  ["esp32", "debug"],
  ["esp32", "release"],
  ["esp8266", "release"],
  ["esp32cam", "release"],
])
  test(
    `Input / Output device firmware compiles for ${board} (${profile})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const fw = build(deviceFlow(board), {
        board,
        ssid: "net",
        password: "pw",
        host: "broker.local",
        profile,
        ota: false,
        otaKeys: keys,
      });
      if (fw.libraries.length)
        spawnSync(cli, ["lib", "install", ...fw.libraries], {
          encoding: "utf8",
        });
      const size = compile(fw);
      assert.ok(size.flash.used > 0);
      console.log(`# devices ${board} ${profile}: flash ${size.flash.used} B`);
    },
  );
// Peripheral nodes: servo, stepper and gyroscope with parameters from inputs.
for (const board of ["esp32", "esp8266"])
  test(
    `Peripheral firmware compiles for ${board}`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const esp8266 = board === "esp8266";
      const flow = {
        name: "Peripherals",
        nodes: [
          {
            id: "v",
            type: "inject",
            name: "VAL",
            config: { payload: "45", interval: 3000 },
          },
          { id: "go", type: "test-button", name: "GO", config: {} },
          {
            id: "s",
            type: "peripheral",
            config: {
              kind: "servo",
              pin: esp8266 ? 14 : 13,
              trigger: "GO",
              angleFrom: "VAL",
            },
          },
          {
            id: "m",
            type: "peripheral",
            config: {
              kind: "stepper",
              pin: esp8266 ? 12 : 25,
              dirPin: esp8266 ? 13 : 26,
              trigger: "GO",
              turnFrom: "VAL",
            },
          },
          {
            id: "g",
            type: "peripheral",
            config: {
              kind: "gyro",
              trigger: "GO",
              ...(esp8266 ? { sda: 4, scl: 5 } : {}),
            },
          },
          { id: "d", type: "debug", config: {} },
        ],
        edges: [
          ...["s", "m", "g"].flatMap((p) => [
            { from: "v", to: p },
            { from: "go", to: p },
            { from: p, to: "d" },
          ]),
        ],
      };
      const fw = build(flow, {
        board,
        ssid: "net",
        password: "pw",
        host: "broker.local",
        profile: "debug",
        ota: false,
        otaKeys: keys,
      });
      const size = compile(fw);
      assert.ok(size.flash.used > 0);
    },
  );
// Radio in/out with Local MQTT: the board runs its own broker (sMQTTBroker library).
test(
  "Local MQTT firmware compiles for esp32",
  { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
  () => {
    const flow = {
      name: "Local MQTT",
      nodes: [
        { id: "i", type: "inject", config: { payload: "1", interval: 2000 } },
        {
          id: "o",
          type: "mqtt-out",
          config: {
            protocol: "local",
            topic: "lab/{{device}}/x",
            localUser: "u",
            localPass: "p",
          },
        },
        {
          id: "r",
          type: "mqtt-in",
          config: {
            protocol: "local",
            topic: "lab/+/x",
            localUser: "u",
            localPass: "p",
          },
        },
        { id: "d", type: "debug", config: {} },
      ],
      edges: [
        { from: "i", to: "o" },
        { from: "r", to: "d" },
      ],
    };
    const fw = build(flow, {
      board: "esp32",
      ssid: "net",
      password: "pw",
      host: "broker.local",
      profile: "release",
      ota: false,
      otaKeys: keys,
    });
    spawnSync(cli, ["lib", "install", ...fw.libraries], { encoding: "utf8" });
    assert.ok(compile(fw).flash.used > 0);
  },
);
// Status display: GPIO, PWM, a Counter's outputs and a C/C++ node's send() on a
// 16×2 LCD (ESP32, debug + PC input emulation, Node-RED language), and more nodes
// than lines on an OLED, so it pages (ESP8266, release).
for (const [board, screen, profile, language] of [
  ["esp32", "lcd1602", "debug", "nodered"],
  ["esp8266", "oled64", "release", "arduino"],
])
  test(
    `Status display firmware compiles for ${board} (${screen})`,
    { skip: !cli && "set ARDUINO_CLI to compile", timeout: 600000 },
    () => {
      const esp8266 = board === "esp8266";
      const flow = {
        name: "Status",
        language,
        nodes: [
          { id: "sw", type: "gpio-watch", config: { pin: esp8266 ? 14 : 4 }, status: true },
          { id: "led", type: "digital-write", config: { pin: esp8266 ? 2 : 13 }, status: true },
          { id: "pwm", type: "pwm-write", config: { pin: esp8266 ? 12 : 25 }, status: true },
          { id: "cnt", type: "counter", config: {}, status: true },
          { id: "tm", type: "timer", config: {}, status: true },
          { id: "code", type: "arduino", config: { message: "send(value);" }, status: true },
          {
            id: "st",
            type: "status",
            config: { screen, ...(esp8266 ? { sda: 4, scl: 5, textSize: "2" } : {}) },
          },
        ],
        edges: ["led", "pwm", "cnt", "tm", "code"].map((to) => ({ from: "sw", to })),
      };
      const fw = build(flow, {
        board,
        ssid: "net",
        password: "pw",
        host: "broker.local",
        profile,
        ota: false,
        emulate: profile === "debug",
        otaKeys: keys,
      });
      spawnSync(cli, ["lib", "install", ...fw.libraries], { encoding: "utf8" });
      const size = compile(fw);
      assert.ok(size.flash.used > 0);
      console.log(`# status ${board} ${screen}: flash ${size.flash.used} B, RAM ${size.ram.used} B`);
    },
  );
