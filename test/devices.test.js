// Input device (sensors) and Output device (motors) nodes: settings checks, board
// checks, the simulator, and the generated firmware run with the host g++ and the
// stand-in headers in test/fixtures/arduino (which model the sensors and record
// what the motors are told).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, analyze, build } = require("../lib/flow");
const { types, catalog, pinsOf, autoName, varType } = require("../lib/nodes");
const devices = require("../lib/devices");

const dev = (config, id = "d", type = "input-device") => ({
  id,
  type,
  label: type === "input-device" ? "Sensor" : "Motor",
  config,
});
const motor = (config) => dev(config, "m", "output-device");
const out = { id: "o", type: "mqtt-out", config: { topic: "q" } };
const flowOf = (nodes, pairs, language) => ({
  name: "t",
  ...(language ? { language } : {}),
  nodes,
  edges: pairs.map(([from, to]) => ({ from, to })),
});
// A sensor reporting to Radio out (its readings appear as "q <value>").
const sensorFlow = (config, language) =>
  flowOf([dev(config), out], [["d", "o"]], language);
// Inject → motor → Radio out (the motor's "done" messages appear as "q <value>").
const motorFlow = (config) =>
  flowOf(
    [
      { id: "i", type: "inject", config: { payload: "0", interval: 0 } },
      motor(config),
      out,
    ],
    [
      ["i", "m"],
      ["m", "o"],
    ],
  );
const problem = (fn) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e.message;
  }
};

test("catalog: two device nodes with a device choice, pins and per-device help", () => {
  const c = catalog();
  assert.deepEqual(Object.keys(c["input-device"].fields[0].options), [
    "temp",
    "volt",
    "gyro",
    "scope",
    "camera",
  ]);
  assert.deepEqual(Object.keys(c["output-device"].fields[0].options), [
    "servo",
    "stepper",
    "i2cdisplay",
  ]);
  assert.equal(c["input-device"].group, "INPUT");
  assert.equal(c["output-device"].group, "OUTPUT");
  assert.equal(c["input-device"].summaryBy, "device");
  assert.ok(c["input-device"].helpBy.texts.gyro.includes("MPU-6050"));
  assert.ok(c["output-device"].pinSpec.length >= 5);
  // Names and C++ types follow the device.
  const name = (n) => autoName({ ...n, config: { ...n.config } }, new Set());
  assert.equal(name(dev({ device: "temp" })), "TEMP1");
  assert.equal(name(dev({ device: "gyro" })), "GYRO1");
  assert.equal(name(motor({ device: "stepper" })), "STEPPER1");
  const typeOf = (n) => varType(validate(flowOf([n], [])).nodes[0], () => []);
  assert.equal(typeOf(dev({ device: "temp" })), "double");
  assert.equal(typeOf(dev({ device: "gyro" })), "String"); // JSON
  assert.equal(typeOf(dev({ device: "gyro", gyroOut: "pitch" })), "double");
  assert.equal(typeOf(dev({ device: "camera", camOut: "brightness" })), "int");
});

test("settings are checked", () => {
  const check = (n) => problem(() => validate(flowOf([n], [])));
  assert.equal(check(dev({ device: "temp" })), "ok");
  assert.match(
    check(dev({ device: "temp", sensor: "dht22", interval: 1000 })),
    /DHT22: Read every must be at least 2000 ms/,
  );
  assert.match(
    check(dev({ device: "scope", samples: 500, rate: 1000 })),
    /takes 500 ms/,
  );
  assert.match(
    check(
      dev({ device: "scope", scopeOut: "samples", samples: 100, rate: 2000 }),
    ),
    /at most 80 samples/,
  );
  assert.match(check(dev({ device: "gyro", sda: 5, scl: 5 })), /SDA and SCL/);
  assert.match(
    check(motor({ device: "servo", minUs: 1500, maxUs: 1500 })),
    /must be shorter/,
  );
  assert.match(
    check(motor({ device: "stepper", rpm: 1000, microsteps: "16" })),
    /53333 steps per second/,
  );
  assert.match(
    check(motor({ device: "stepper", idle: "release" })),
    /ENABLE pin/,
  );
  assert.equal(
    check(motor({ device: "stepper", idle: "release", enPin: 15 })),
    "ok",
  );
  assert.match(
    check(motor({ device: "stepper", dirPin: 13 })),
    /each pin may be used once/,
  );
});

test("board checks: pins per device, camera board, shared I2C bus", () => {
  const errors = (flow, board = "esp32") =>
    analyze(flow, board).errors.join(" ");
  const pins = (n) =>
    pinsOf(validate(flowOf([n], [])).nodes[0]).map((p) => `${p.pin}:${p.use}`);
  assert.deepEqual(pins(dev({ device: "temp" })), ["4:in"]);
  assert.deepEqual(pins(dev({ device: "temp", sensor: "ntc", pin: 34 })), [
    "34:adc",
  ]);
  assert.deepEqual(pins(dev({ device: "gyro" })), ["21:out", "22:out"]);
  assert.deepEqual(pins(motor({ device: "stepper", enPin: 15 })), [
    "13:out",
    "14:out",
    "15:out",
  ]);
  assert.deepEqual(pins(motor({ device: "stepper", driver: "uln2003" })), [
    "25:out",
    "26:out",
    "27:out",
    "14:out",
  ]);
  // A voltmeter needs an analog pin.
  assert.match(
    errors(sensorFlow({ device: "volt", pin: 4 })),
    /GPIO 4 is not an analog input/,
  );
  assert.equal(errors(sensorFlow({ device: "volt", pin: 34 })), "");
  // The camera needs the ESP32-CAM board.
  assert.match(errors(sensorFlow({ device: "camera" })), /has no camera/);
  assert.equal(errors(sensorFlow({ device: "camera" }), "esp32cam"), "");
  // Two gyroscopes: one bus, two addresses; Radio I2C peripheral cannot share it.
  const two = (a, b) =>
    flowOf(
      [
        dev({ device: "gyro", ...a }, "g1"),
        dev({ device: "gyro", ...b }, "g2"),
        out,
      ],
      [
        ["g1", "o"],
        ["g2", "o"],
      ],
    );
  assert.match(errors(two({}, {})), /same I2C address/);
  assert.match(
    errors(two({}, { address: "105", sda: 18 })),
    /same SDA and SCL/,
  );
  assert.equal(errors(two({}, { address: "105" })), "");
  const peripheral = flowOf(
    [
      dev({ device: "gyro" }),
      {
        id: "r",
        type: "mqtt-in",
        config: { protocol: "i2c", i2cRole: "peripheral", topic: "x" },
      },
      out,
    ],
    [
      ["d", "o"],
      ["r", "o"],
    ],
  );
  assert.match(errors(peripheral), /I2C peripheral/);
  // A motor's output may stay unconnected; a sensor's may not.
  const lone = analyze(
    flowOf(
      [{ id: "i", type: "inject", config: {} }, motor({ device: "servo" })],
      [["i", "m"]],
    ),
    "esp32",
  );
  assert.ok(!lone.warnings.some((w) => /output is not connected/.test(w)));
});

test("libraries and includes follow the devices used", () => {
  const settings = {
    board: "esp32",
    ssid: "n",
    host: "h",
    profile: "release",
    ota: false,
  };
  const r = build(sensorFlow({ device: "temp", sensor: "ds18b20" }), settings);
  assert.deepEqual(r.libraries, ["OneWire", "DallasTemperature"]);
  assert.match(r.source, /#include <DallasTemperature\.h>/);
  assert.deepEqual(
    build(sensorFlow({ device: "temp", sensor: "dht11" }), settings).libraries,
    ["DHT sensor library", "Adafruit Unified Sensor"],
  );
  assert.deepEqual(
    build(sensorFlow({ device: "volt", pin: 34 }), settings).libraries,
    [],
  );
  const g = build(sensorFlow({ device: "gyro" }), settings).source;
  assert.match(g, /#include <Wire\.h>/);
  assert.match(g, /Wire\.begin\(21, 22\); \/\/ I2C for the MPU-6050/);
  const s8266 = build(motorFlow({ device: "servo", pin: 5 }), {
    ...settings,
    board: "esp8266",
  }).source;
  assert.match(s8266, /#include <Servo\.h>/);
  assert.match(s8266, /mfServo1\.attach\(5, 500, 2400\)/);
});

// ── Simulator ──
test("simulator: sensors give readings, motors take their time", () => {
  const sim = (config, pins = {}) => {
    const [n] = validate(sensorFlow(config)).nodes;
    const got = [];
    let tick;
    types["input-device"].simulate(n, {
      every: (ms, fn) => (tick = fn),
      send: (v) => got.push(v),
      readPin: (p) => pins[p] ?? 0,
      warn: (t) => got.push("warning: " + t),
    });
    tick();
    return got[0];
  };
  assert.equal(
    sim({ device: "temp", sensor: "ntc", pin: 34 }, { 34: 2048 }),
    "25.00",
  );
  assert.equal(
    sim({ device: "volt", pin: 34, r1: 30, r2: 7.5 }, { 34: 4095 }),
    "16.50",
  );
  assert.match(
    sim({ device: "gyro" }),
    /^\{"ax":-?[\d.]+,"ay":.*,"pitch":-?[\d.]+,"roll":-?[\d.]+\}$/,
  );
  assert.equal(
    sim({ device: "scope", pin: 34 }, { 34: 700 }),
    '{"min":700,"max":700,"avg":700.0,"vpp":0,"hz":0.0}',
  );
  assert.match(
    sim({ device: "temp", sensor: "dht22", dhtOut: "both", interval: 2000 }),
    /^\{"temperature":2\d\.\d\d,"humidity":\d\d\.\d\d\}$/,
  );

  // Motors: the value is sent on when the move is done, after the board's time.
  const runMotor = (config, values) => {
    const [n] = validate(motorFlow(config)).nodes.filter(
      (m) => m.type === "output-device",
    );
    const later = [];
    const sent = [];
    const ctx = {
      state: {},
      later: (ms, fn) => (later.push({ ms, fn }), later.length),
      cancel: () => {},
      forward: (v) => sent.push(v),
      log: () => {},
    };
    const direct = values.map((v) => types["output-device"].host(v, n, ctx));
    return { direct, later, sent };
  };
  const servo = runMotor({ device: "servo" }, ["45"]);
  assert.deepEqual(servo.direct, ["45.0"]);
  const slow = runMotor({ device: "servo", speed: 90 }, ["180"]);
  assert.equal(slow.direct[0], undefined);
  assert.equal(slow.later[0].ms, 1000); // 90° at 90°/s from the start angle 90
  slow.later[0].fn();
  assert.deepEqual(slow.sent, ["180.0"]);
  const st = runMotor({ device: "stepper", input: "steps" }, ["1000"]);
  assert.equal(Math.round(st.later[0].ms), 5500); // 1000 steps, 200/s, 400/s²
  st.later[0].fn();
  assert.deepEqual(st.sent, ["1000"]);
  assert.equal(devices.moveTime(100, 200, 400), 1); // never reaches top speed
});

// ── Firmware (g++ with stand-in headers) ──
const gxx = spawnSync("g++", ["--version"]).status === 0;
// Each scenario: a flow and C++ that drives it (S is the sketch's namespace).
// Returns one list of published values per scenario.
function firmware(scenarios, board = "esp32", define = []) {
  const parts = scenarios.map(([flow], s) => {
    const { source } = build(structuredClone(flow), {
      board,
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    // Headers are included once, at the top, outside the sketches' namespaces.
    return `namespace s${s} {\n${source.replace(/^#include .*$/gm, "")}\n}`;
  });
  const runs = scenarios.map(
    ([, script], s) =>
      `  { namespace S = s${s}; published.clear(); mfFakeNow = 0; mfFakeMicros = 0; S::setup();\n${script}\n  printf("%s=\\n", published.c_str()); }`,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-devices-"));
  const file = path.join(dir, "t.cpp");
  fs.writeFileSync(
    file,
    `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "Wire.h"
#include "OneWire.h"
#include "DallasTemperature.h"
#include "DHT.h"
#include "Servo.h"
#include "esp_camera.h"
#include <vector>
// Notes from the test scripts, in order with what the flow publishes.
void note(const char* fmt, ...) { char b[200]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a); published += b; }
// Steps seen on the STEP pin (13) and the DIR level (14); ULN2003 coils (25, 26, 27, 14).
long steps = 0; int dirLevel = -1; int coils[48];
void watch(uint8_t p, uint8_t v) { if (p == 13 && v) steps++; if (p == 14) dirLevel = v; coils[p] = v; }
// Runs loop() for ms milliseconds of board time, one loop() per 20 µs.
template <class F> void runFor(F loop, unsigned long ms) {
  for (unsigned long end = mfFakeMicros + ms * 1000; mfFakeMicros < end;) { mfFakeMicros += 20; mfFakeNow = mfFakeMicros / 1000; loop(); }
}
${parts.join("\n")}
int main() {
  mfFakeAuto = false;
  mfOnWrite = watch;
${runs.join("\n")}
}
`,
  );
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
      "-O1",
      ...define,
      "-I",
      path.join(__dirname, "fixtures/arduino"),
      "-Wall",
      "-Wno-unused-function",
      "-Wno-unused-variable",
      "-Wno-unused-but-set-variable",
      "-o",
      exe,
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 40).join("\n"));
  const run = spawnSync(exe, { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout
    .split("=\n")
    .slice(0, scenarios.length)
    .map((block) =>
      block
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/^q /, "")),
    );
}

test("firmware: sensors", { skip: !gxx && "g++ not found" }, () => {
  const tick = (ms = 1000) => `  mfFakeNow += ${ms}; S::loop();`;
  const got = firmware([
    [sensorFlow({ device: "temp", sensor: "ds18b20" }), tick()],
    [
      sensorFlow({ device: "temp", sensor: "ds18b20", unit: "f", decimals: 1 }),
      tick(),
    ],
    [
      sensorFlow({ device: "temp", sensor: "ds18b20" }),
      `  mfDsTemp = DEVICE_DISCONNECTED_C;\n${tick()}\n  mfDsTemp = 21.5f;`,
    ],
    [
      sensorFlow({
        device: "temp",
        sensor: "dht22",
        dhtOut: "both",
        interval: 2000,
      }),
      tick(2000),
    ],
    // NTC at half the supply: 25 °C; LM35 at 0.25 V: 25 °C.
    [
      sensorFlow({ device: "temp", sensor: "ntc", pin: 34 }),
      `  mfOnAnalog = [](uint8_t) { return 2048; };\n${tick()}`,
    ],
    [
      sensorFlow({ device: "temp", sensor: "lm35", pin: 34, decimals: 0 }),
      `  mfOnAnalog = [](uint8_t) { return 311; };\n${tick()}`,
    ],
    // Voltmeter with a 30k / 7.5k divider: 1.65 V on the pin is 8.25 V.
    [
      sensorFlow({ device: "volt", pin: 34, r1: 30, r2: 7.5 }),
      `  mfOnAnalog = [](uint8_t) { return 2048; };\n${tick()}`,
    ],
    // MPU-6050 lying flat (1 g on Z), turning at 10 °/s about X (±500 °/s: 65.5 per °/s).
    [
      sensorFlow({ device: "gyro", calibrate: "no" }),
      `  Wire.regs[0x3F] = 0x40; Wire.regs[0x40] = 0x00; Wire.regs[0x43] = 655 >> 8; Wire.regs[0x44] = 655 & 255;\n${tick()}`,
    ],
    [
      sensorFlow({ device: "gyro", gyroOut: "roll", calibrate: "no" }),
      `  Wire.regs[0x3D] = 0x40; Wire.regs[0x3E] = 0; Wire.regs[0x3F] = 0; Wire.regs[0x40] = 0;\n${tick()}`,
    ],
    // No MPU-6050 answering: nothing sent.
    [
      sensorFlow({ device: "gyro" }),
      `  Wire.present = 0x77;\n${tick()}\n  Wire.present = 0x68;`,
    ],
    // Oscilloscope on a 100 Hz square wave (1000 / 3000), 2000 samples/s.
    [
      sensorFlow({ device: "scope", pin: 34, samples: 100, rate: 2000 }),
      `  mfMicrosStep = 1; mfOnAnalog = [](uint8_t) { return (mfFakeMicros % 10000) < 5000 ? 3000 : 1000; };\n${tick()}\n  mfMicrosStep = 0; mfOnAnalog = nullptr;`,
    ],
    [
      sensorFlow({
        device: "scope",
        pin: 34,
        samples: 10,
        rate: 1000,
        scopeOut: "samples",
      }),
      `  mfMicrosStep = 1; mfOnAnalog = [](uint8_t) { return 7; };\n${tick()}\n  mfMicrosStep = 0; mfOnAnalog = nullptr;`,
    ],
  ]);
  assert.deepEqual(got[0], ["21.50"]);
  assert.deepEqual(got[1], ["70.7"]);
  assert.deepEqual(got[2], []);
  assert.deepEqual(got[3], ['{"temperature":23.25,"humidity":48.50}']);
  assert.deepEqual(got[4], ["25.00"]);
  assert.deepEqual(got[5], ["25"]);
  assert.deepEqual(got[6], ["8.25"]);
  assert.deepEqual(got[7], [
    '{"ax":0.00,"ay":0.00,"az":1.00,"gx":10.00,"gy":0.00,"gz":0.00,"pitch":0.00,"roll":0.00}',
  ]);
  assert.deepEqual(got[8], ["90.00"]);
  assert.deepEqual(got[9], []);
  const scope = JSON.parse(got[10][0]);
  assert.equal(scope.min, 1000);
  assert.equal(scope.max, 3000);
  assert.equal(scope.vpp, 2000);
  assert.ok(Math.abs(scope.hz - 100) < 3, `frequency ${scope.hz}`);
  assert.deepEqual(got[11], ["[7,7,7,7,7,7,7,7,7,7]"]);
});

test(
  "firmware: camera builds for the ESP32-CAM board",
  { skip: !gxx && "g++ not found" },
  () => {
    const got = firmware(
      [
        [
          sensorFlow({ device: "camera", camOut: "brightness" }),
          "  memset(mfCamFrame, 42, sizeof(mfCamFrame)); mfFakeNow += 1000; S::loop();",
        ],
        // A grey picture, then half of it brighter: 50 % motion.
        [
          sensorFlow({ device: "camera" }),
          "  memset(mfCamFrame, 100, sizeof(mfCamFrame)); mfFakeNow += 1000; S::loop();\n  memset(mfCamFrame, 200, sizeof(mfCamFrame) / 2); mfFakeNow += 1000; S::loop();",
        ],
      ],
      "esp32cam",
    );
    assert.deepEqual(got[0], ["42"]);
    assert.deepEqual(got[1], [
      '{"brightness":100,"motion":0.0}',
      '{"brightness":150,"motion":50.0}',
    ]);
    const { source } = build(sensorFlow({ device: "camera" }), {
      board: "esp32cam",
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    assert.match(source, /c\.pin_d0 = 5;/);
    assert.match(source, /c\.pin_sccb_sda = 26;/);
    assert.match(source, /c\.pin_pwdn = 32;/);
    // Freenove ESP32-S3 WROOM CAM: ESP32-S3-EYE camera pins, octal PSRAM.
    const s3 = build(sensorFlow({ device: "camera" }), {
      board: "freenove-s3cam",
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    });
    assert.equal(s3.fqbn, "esp32:esp32:esp32s3:PSRAM=opi");
    assert.match(s3.source, /c\.pin_xclk = 15;/);
    assert.match(s3.source, /c\.pin_d0 = 11;/);
    assert.match(s3.source, /c\.pin_pwdn = -1;/);
    assert.deepEqual(
      firmware(
        [
          [
            sensorFlow({ device: "camera", camOut: "brightness" }),
            "  memset(mfCamFrame, 7, sizeof(mfCamFrame)); mfFakeNow += 1000; S::loop();",
          ],
        ],
        "freenove-s3cam",
      )[0],
      ["7"],
    );
    // Its camera pins are not offered to other nodes.
    assert.match(
      analyze(
        sensorFlow({ device: "volt", pin: 4 }),
        "freenove-s3cam",
      ).errors.join(),
      /not an analog input/,
    );
  },
);

test(
  "firmware: servos (ESP32 cores 2 and 3, ESP8266)",
  { skip: !gxx && "g++ not found" },
  () => {
    // 90° of 180: 500 + 1900 / 2 = 1450 µs; 14-bit duty of a 20 ms period: 1187.
    const scenarios = [
      [
        motorFlow({ device: "servo" }),
        '  S::node1(String("90")); note("duty %u\\n", mfLedc[0] | mfLedc[13]);',
      ],
      [
        motorFlow({ device: "servo", servoIn: "percent" }),
        '  S::node1(String("25"));',
      ],
      // Turn speed 90 °/s from 90° to 180°: sent after about a second.
      [
        motorFlow({ device: "servo", speed: 90 }),
        '  S::node1(String("180")); runFor(S::loop, 900); published += "-\\n"; runFor(S::loop, 200);',
      ],
      [
        motorFlow({ device: "servo", servoIn: "speed" }),
        '  S::node1(String("100")); note("duty %u\\n", mfLedc[0] | mfLedc[13]);',
      ],
    ];
    for (const define of [[], ["-DESP_ARDUINO_VERSION_MAJOR=3"]]) {
      const got = firmware(scenarios, "esp32", define);
      assert.deepEqual(got[0], ["90.0", "duty 1187"]);
      assert.deepEqual(got[1], ["45.0"]);
      assert.deepEqual(got[2], ["-", "180.0"]);
      assert.deepEqual(got[3], ["100", "duty 1966"]);
    }
    const esp8266 = firmware(
      [
        [
          motorFlow({ device: "servo", pin: 5 }),
          '  S::node1(String("0")); note("us %d\\n", mfServoUs);',
        ],
      ],
      "esp8266",
    );
    assert.deepEqual(esp8266[0], ["0.0", "us 500"]);
  },
);

test(
  "firmware: stepper moves, ramps, stops and agrees with the simulator",
  { skip: !gxx && "g++ not found" },
  () => {
    const report =
      'note("steps %ld dir %d at %lu ms\\n", steps, dirLevel, mfFakeMicros / 1000);';
    const scenarios = [
      // 1000 steps at 60 RPM (200 steps/s), 120 RPM/s (400 steps/s²): 5.5 s.
      [
        motorFlow({ device: "stepper", input: "steps" }),
        `  steps = 0; S::node1(String("1000")); for (int k = 0; k < 8000 && !published.size(); k++) runFor(S::loop, 1); ${report}
  S::node1(String("-500")); runFor(S::loop, 6000); ${report}`,
      ],
      // Go to 90° with 1/2 microstepping (400 steps per turn): 100 steps.
      [
        motorFlow({ device: "stepper", input: "angleTo", microsteps: "2" }),
        `  steps = 0; S::node1(String("90")); runFor(S::loop, 3000); ${report}`,
      ],
      // Without acceleration: 200 steps at 200/s take 1 s.
      [
        motorFlow({ device: "stepper", input: "steps", accel: 0 }),
        `  steps = 0; S::node1(String("200")); for (int k = 0; k < 3000 && !published.size(); k++) runFor(S::loop, 1); ${report}`,
      ],
      // stop during a long move: it slows down and sends where it stopped.
      [
        motorFlow({ device: "stepper", input: "steps" }),
        `  steps = 0; S::node1(String("100000")); runFor(S::loop, 2000); S::node1(String("stop")); runFor(S::loop, 2000); ${report}`,
      ],
      // Run at speed, then 0: it slows down and stops.
      [
        motorFlow({ device: "stepper", input: "rpm" }),
        `  steps = 0; S::node1(String("60")); runFor(S::loop, 3000); long a = steps; S::node1(String("0")); runFor(S::loop, 2000); note("running %ld then %ld\\n", a, steps - a);`,
      ],
      // ULN2003: half steps on four coils; 512 half steps = 45° of a 4096-step turn.
      [
        motorFlow({
          device: "stepper",
          driver: "uln2003",
          input: "angle",
          rpm: 10,
          accel: 0,
        }),
        `  S::node1(String("45")); runFor(S::loop, 4000); note("coils %d%d%d%d\\n", coils[25], coils[26], coils[27], coils[14]);`,
      ],
      // zero: the present position becomes 0.
      [
        motorFlow({ device: "stepper", input: "position", accel: 0 }),
        `  S::node1(String("50")); runFor(S::loop, 1000); S::node1(String("zero")); S::node1(String("10")); runFor(S::loop, 1000);`,
      ],
    ];
    const got = firmware(scenarios);
    // Done after 1000 steps, at about the simulator's time.
    const [done, first, doneBack, back] = got[0];
    assert.equal(done, "1000");
    const t = Number(/at (\d+) ms/.exec(first)[1]);
    assert.match(first, /^steps 1000 dir 1 /);
    // Steps are whole, so the ramps end a little sooner than the simulator's smooth ones.
    assert.ok(
      Math.abs(t - devices.moveTime(1000, 200, 400) * 1000) < 220,
      `took ${t} ms`,
    );
    assert.match(back, /^steps 1500 dir 0 /);
    assert.equal(doneBack, "500");
    assert.deepEqual(got[1].slice(0, 1), ["90.0"]);
    assert.match(got[1][1], /^steps 100 /);
    assert.equal(got[2][0], "200");
    assert.ok(
      Math.abs(Number(/at (\d+)/.exec(got[2][1])[1]) - 1000) < 30,
      got[2][1],
    );
    // Stopped from 200 steps/s with 400 steps/s²: about 50 steps after "stop".
    const stopped = Number(got[3][0]);
    assert.ok(stopped > 360 && stopped < 440, `stopped at ${stopped}`);
    assert.match(got[3][1], new RegExp(`^steps ${stopped} `));
    const [, running, after] = /running (\d+) then (\d+)/
      .exec(got[4][2])
      .map(Number);
    assert.ok(running > 520 && running < 590, `ran ${running} steps`);
    assert.ok(after > 20 && after < 80, `${after} steps to stop`);
    assert.deepEqual(got[4].slice(0, 2), ["60", "0"]); // speeds pass on at once
    assert.equal(got[5][0], "45.0");
    assert.match(got[5][1], /^coils (1000|0000)$/);
    assert.deepEqual(got[6], ["50", "0", "10"]);
  },
);

test(
  "firmware: Node-RED language builds with devices",
  { skip: !gxx && "g++ not found" },
  () => {
    const got = firmware([
      [
        sensorFlow({ device: "temp", sensor: "ds18b20" }, "nodered"),
        "  mfFakeNow += 1000; S::loop();",
      ],
    ]);
    assert.deepEqual(got[0], ["21.50"]); // Radio out sends msg.payload
  },
);
