// C/C++ node (type "arduino"): the user's own C++ in a namespace of its own, without
// hardware access (lib/nodes.js, lib/flow.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validate, analyze, build } = require("../lib/flow");
const { types, catalog, codeOnly, hardwareUse } = require("../lib/nodes");
const arduino = (id, config = {}, label = "Code") => ({
  id,
  type: "arduino",
  label,
  config,
});
const sw = { id: "sw", type: "test-switch", config: {} };
const dbg = { id: "dbg", type: "debug", config: {} };
const settings = { board: "esp32", ssid: "n", host: "broker.local" };
const flowOf = (nodes, pairs) => ({
  name: "t",
  nodes,
  edges: pairs.map(([from, to]) => ({ from, to })),
});
test("catalog offers the C/C++ node with code fields only", () => {
  const c = catalog().arduino;
  assert.equal(c.label, "C/C++");
  assert.deepEqual(
    c.fields.map((f) => f.key),
    ["vars", "setup", "message", "loop"],
  );
  assert.equal(c.group, "CODE");
  assert.deepEqual(
    c.fields.filter((f) => f.type === "code").map((f) => f.key),
    ["vars", "setup", "message", "loop"],
  );
  assert.equal(c.pin, null); // no pins
});
test("defaults fill missing fields, code may be emptied, old pins are dropped", () => {
  const [n] = validate({ nodes: [arduino("a")], edges: [] }).nodes;
  assert.equal(n.config.message, "count++;\nsend(count);");
  assert.equal(n.config.pins, undefined);
  const [m] = validate({
    nodes: [arduino("a", { message: "", vars: "" })],
    edges: [],
  }).nodes;
  assert.equal(m.config.message, "");
  assert.equal(m.config.vars, "");
  // Flows saved with named pins load; the pins are gone.
  const [old] = validate({
    nodes: [arduino("a", { pins: "LED=2:out", message: "send(1);" })],
    edges: [],
  }).nodes;
  assert.deepEqual(Object.keys(old.config).sort(), [
    "loop",
    "message",
    "setup",
    "vars",
  ]);
  const [w] = validate({
    nodes: [arduino("a", { message: "a();\r\nb();" })],
    edges: [],
  }).nodes;
  assert.equal(w.config.message, "a();\nb();");
  assert.throws(
    () =>
      validate({
        nodes: [arduino("a", { loop: "x".repeat(4001) })],
        edges: [],
      }),
    /limited to 4000/,
  );
});
test("hardware access is refused, with the node to use instead", () => {
  const refused = (code, section = "message") => {
    try {
      validate({
        nodes: [arduino("a", { [section]: code }, "Calc")],
        edges: [],
      });
      return null;
    } catch (e) {
      return e.message;
    }
  };
  for (const [code, name, advice] of [
    ["digitalWrite(2, HIGH);", "digitalWrite", /GPIO output/],
    ["int b = digitalRead(4);", "digitalRead", /GPIO input/],
    ["pinMode(2, OUTPUT);", "pinMode", /GPIO/],
    ["int a = analogRead(34);", "analogRead", /Analog sample/],
    ["analogWrite(2, 128);", "analogWrite", /PWM out/],
    ["ledcWrite(0, 50);", "ledcWrite", /PWM out/],
    ["Serial.println(value);", "Serial", /Debug node/],
    ["Serial2.write(1);", "Serial2", /Debug node/],
    ["WiFi.disconnect();", "WiFi", /Radio in/],
    ['mqtt.publish("a", "b");', "mqtt", /managed by Microflow/],
    ["Wire.begin();", "Wire", /I2C/],
    ["ESP.restart();", "ESP", /Radio/],
    ["EEPROM.write(0, 1);", "EEPROM", /special functions/],
    ["gpio_set_level(GPIO_NUM_2, 1);", "gpio_set_level", /Chip drivers/],
    ["esp_restart();", "esp_restart", /Chip drivers/],
    ["*(volatile uint32_t*)0x3FF44004 = 4;", "volatile", /registers/],
    ["REG_WRITE(0x3FF44004, 4);", "REG_WRITE", /registers/],
    ["#define W digitalWrite\nW(2, 1);", "digitalWrite", /GPIO/],
  ])
    assert.match(
      refused(code) || "",
      new RegExp(
        `^Calc, on message, line \\d+: ${name} accesses hardware, which C/C\\+\\+ nodes do not allow\\. .*${advice.source}`,
      ),
      code,
    );
  // Every section is checked, with the line.
  assert.match(
    refused("int x;\nint y = analogRead(1);", "vars"),
    /Calc, variables, line 2: analogRead/,
  );
  assert.match(refused("pinMode(2, OUTPUT);", "setup"), /Calc, setup, line 1/);
  assert.match(refused("tone(2, 440);", "loop"), /Calc, loop, line 1: tone/);
  // Names in comments and strings, and look-alike names, are fine.
  for (const ok of [
    '// digitalWrite(2, HIGH) is done by the GPIO node\nsend("Serial");',
    "int adc_value = 3; int timer_count = 0; int espresso = 1; send(adc_value + timer_count + espresso);",
    "int digitalWriter = 1; send(digitalWriter);",
  ])
    assert.equal(refused(ok), null, ok);
  assert.equal(hardwareUse("x = 1;"), null);
  // Nodes cannot be named after hardware either.
  assert.throws(
    () =>
      validate({
        nodes: [
          { id: "a", type: "debug", name: "Serial", label: "Log", config: {} },
        ],
        edges: [],
      }),
    /reserved/,
  );
});
test("brackets must balance; comments and strings are ignored", () => {
  const check = (message) =>
    validate({ nodes: [arduino("a", { message }, "Gate")], edges: [] });
  assert.throws(
    () => check("if (x) {\n  send(1);"),
    /Gate, on message, line 1: missing "}"/,
  );
  assert.throws(() => check("send(1);\n}"), /line 2: unexpected "}"/);
  assert.throws(() => check("f(]"), /unexpected "]"/);
  check("send(\"}\"); // }\n/* { */ char c = '{';");
  assert.throws(
    () =>
      validate({
        nodes: [arduino("a", { vars: "#include <Wire.h>" })],
        edges: [],
      }),
    /#include/,
  );
  assert.equal(codeOnly('a("x") // y'), "a(   )     ");
});
test("code gets advice about delay() and endless loops", () => {
  const r = analyze(
    flowOf(
      [sw, arduino("a", { message: "delay(100); while (true) {}" }, "Blinky")],
      [["sw", "a"]],
    ),
    "esp32",
  );
  assert.deepEqual(r.errors, []);
  const w = r.warnings.join("\n");
  assert.match(w, /delay\(\) pauses the whole board/);
  assert.match(w, /endless loop/);
  // No send(): an end point, so an unconnected output is fine.
  assert.doesNotMatch(w, /output is not connected/);
});
test("a node with loop code runs without an input; one that sends needs an output", () => {
  const r = analyze(
    flowOf(
      [arduino("a", { message: "", loop: "send(millis());" }, "Ticker")],
      [],
    ),
    "esp8266",
  );
  assert.doesNotMatch(r.warnings.join("\n"), /no incoming connection/);
  assert.match(r.warnings.join("\n"), /Ticker's output is not connected/);
});
test("firmware: a namespace per node, send() calls the connected nodes", () => {
  const flow = flowOf(
    [
      sw,
      arduino(
        "a",
        {
          vars: "int count = 0; unsigned long last = 0;",
          loop: "if (millis() - last >= 1000) { last = millis(); send(++count); }",
        },
        "First",
      ),
      arduino("b", {}, "Second"),
      dbg,
    ],
    [
      ["sw", "a"],
      ["sw", "b"],
      ["a", "dbg"],
      ["b", "dbg"],
    ],
  );
  const { source } = build(flow, settings);
  // Both nodes may use the same names (count): each has its own namespace.
  assert.match(source, /namespace mfArduino1 \{\nusing namespace ::mfJson;/);
  assert.match(source, /namespace mfArduino2 \{\nusing namespace ::mfJson;/);
  assert.equal(source.match(/^int count = 0;/gm).length, 2);
  assert.match(source, /void send\(const String& v\) \{ node3\(v\); \}/);
  // No pins, no pinMode, no hardware wrappers.
  const block = source.slice(
    source.indexOf("namespace mfArduino1 {"),
    source.indexOf("} // namespace mfArduino1"),
  );
  assert.doesNotMatch(block, /const uint8_t|pinMode/);
  assert.doesNotMatch(source, /inline int digitalRead/);
  // The node function only hands the value to the code: no automatic forwarding.
  assert.match(
    source,
    /void node1\(String value\) \{\n {2}mfArduino1::from = ""; mfArduino1::mfMessage\(value\);\n\}/,
  );
  assert.match(source, /mfArduino1::mfSetup\(\);/);
  assert.match(source, /mfArduino1::mfLoop\(\);/);
  assert.doesNotMatch(source, /mfArduino2::mfLoop/); // empty loop is not called
  // Defined after the node prototypes, so send() can call them.
  assert.ok(
    source.indexOf("void node3(String value);") <
      source.indexOf("namespace mfArduino1"),
  );
  // Compiler messages name the node and section, then return to the sketch's lines.
  assert.match(source, /#line 1 "First: on message"/);
  const lines = source.split("\n");
  lines.forEach((line, k) => {
    const m = /^#line (\d+) "microflow\.ino"$/.exec(line);
    if (m) assert.equal(Number(m[1]), k + 2);
  });
  assert.doesNotMatch(source, /MF_RESUME/);
});
test("PC input emulation: send() reports what the node sends", () => {
  const { source } = build(
    flowOf(
      [sw, arduino("a"), dbg],
      [
        ["sw", "a"],
        ["a", "dbg"],
      ],
    ),
    { ...settings, emulate: true },
  );
  assert.match(
    source,
    /void send\(const String& v\) \{ mfTrace\(1, v\); node2\(v\); \}/,
  );
});
test("simulator: passes values through when the code sends, and says so once", () => {
  const [n] = validate({ nodes: [arduino("a")], edges: [] }).nodes;
  const warnings = [];
  const ctx = { state: {}, warn: (w) => warnings.push(w) };
  assert.equal(types.arduino.host("1", n, ctx), "1");
  assert.equal(types.arduino.host("0", n, ctx), "0");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /runs on the board only/);
  const [quiet] = validate({
    nodes: [arduino("q", { message: "x = 1;" })],
    edges: [],
  }).nodes;
  assert.equal(types.arduino.host("1", quiet, { state: {} }), undefined);
});
test("every node gets a unique variable name; given names are checked", () => {
  const flow = validate({
    nodes: [
      { id: "a", type: "test-switch", config: {} },
      { id: "b", type: "test-switch", config: {} },
      { id: "c", type: "digital-read", config: { pin: 4 } },
      { id: "d", type: "gpio-watch", config: { pin: 4 } },
      { id: "e", type: "test-switch", name: "SW1", config: {} },
      { id: "f", type: "analog-in", config: { pin: 34 } },
    ],
    edges: [],
  });
  assert.deepEqual(
    flow.nodes.map((n) => n.name),
    ["SW2", "SW3", "GPIO4", "GPIO4_2", "SW1", "ADC34"],
  );
  const named = (name) =>
    validate({
      nodes: [{ id: "a", type: "debug", name, label: "Log", config: {} }],
      edges: [],
    });
  assert.equal(named("Temp_1").nodes[0].name, "Temp_1");
  for (const bad of [
    "1st",
    "a-b",
    "int",
    "millis",
    "from",
    "value",
    "B101",
    "mfX",
    "x".repeat(33),
  ])
    assert.throws(() => named(bad), /Log: variable name/, bad);
  assert.throws(
    () =>
      validate({
        nodes: [
          { id: "a", type: "debug", name: "X", config: {} },
          { id: "b", type: "debug", name: "X", config: {} },
        ],
        edges: [],
      }),
    /Two nodes have the variable name X/,
  );
  assert.equal(catalog()["digital-read"].varName, "GPIO{pin}");
});
test("inputs of a C/C++ node are variables named after the connected nodes", () => {
  const flow = flowOf(
    [
      { id: "a", type: "test-switch", name: "SW_A", config: {} },
      { id: "b", type: "test-switch", name: "SW_B", config: {} },
      arduino(
        "g",
        {
          vars: "",
          message: "send(SW_A && SW_B ? 1 : 0);",
        },
        "Gate",
      ),
      dbg,
    ],
    [
      ["a", "g"],
      ["b", "g"],
      ["g", "dbg"],
    ],
  );
  const { source } = build(flow, settings);
  assert.match(
    source,
    /namespace mfArduino2 \{ void mfFrom0\(const String& v\); \}/,
  );
  // Typed: switches are bool.
  assert.match(source, /bool SW_A = false;\nbool SW_B = false;/);
  assert.match(source, /String from = "";/);
  assert.match(
    source,
    /void mfFrom1\(const String& v\) \{ SW_B = mfJson::asBool\(v\); from = "SW_B"; mfMessage\(v\); \}/,
  );
  // The switch hands its value to the gate's input function, not to node2().
  assert.match(
    source,
    /void node0\(String value\) \{\n {2}mfArduino2::mfFrom0\(value\);\n\}/,
  );
  // Called another way (test terminal): no input name.
  assert.match(
    source,
    /mfArduino2::from = ""; mfArduino2::mfMessage\(value\);/,
  );
});
test("the AND gate example is valid for ESP8266 and ESP32", () => {
  const example = require("../examples/arduino-and-gate.json");
  for (const board of ["esp8266", "d1mini", "esp32", "esp32s3"])
    assert.deepEqual(analyze(structuredClone(example.flow), board).errors, []);
});
// Opt-in: compiles the generated Arduino node C++ (with the JSON helpers) using the
// host g++ and a small Arduino stand-in, and runs it. The full sketch needs the ESP
// cores: see compile.test.js.
const gxx = spawnSync("g++", ["--version"]).status === 0;
const STUB = `#include <string>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
using std::isfinite;
struct String {
  std::string s;
  String() {}
  String(const char* c) : s(c) {}
  explicit String(char c) : s(1, c) {}
  explicit String(int v) : s(std::to_string(v)) {}
  explicit String(unsigned int v) : s(std::to_string(v)) {}
  explicit String(long v) : s(std::to_string(v)) {}
  explicit String(unsigned long v) : s(std::to_string(v)) {}
  explicit String(double v, unsigned int d = 2) { char b[64]; snprintf(b, 64, "%.*f", (int)d, v); s = b; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* o) { s += o; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  bool operator==(const char* o) const { return s == o; }
  bool operator==(const String& o) const { return s == o.s; }
  char operator[](unsigned int i) const { return s[i]; }
  int indexOf(char c) const { auto p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  bool endsWith(const char* x) const { size_t n = strlen(x); return s.size() >= n && s.compare(s.size() - n, n, x) == 0; }
  void remove(unsigned int i) { s.erase(i); }
  unsigned int length() const { return s.size(); }
  const char* c_str() const { return s.c_str(); }
  int toInt() const { return atoi(s.c_str()); }
};
inline String operator+(const String& a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const char* a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, const char* b) { String r(a); r += b; return r; }
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
void pinMode(uint8_t, uint8_t) {}
void digitalWrite(uint8_t, uint8_t) {}
int digitalRead(uint8_t) { return 0; }
int analogRead(uint8_t) { return 0; }
unsigned long millis() { return 5000; }
int mfDigitalRead(uint8_t) { return 0; }
int mfAnalogRead(uint8_t) { return 0; }
void mfTrace(size_t, const String&) {}
std::string out;
`;
// The flow's firmware reduced to its Arduino nodes: stand-ins for the other nodes
// (logging "id=value;"), the JSON helpers, prototypes and namespaces, then main.
function program(flow, emulate, main) {
  const { source } = build(flow, { ...settings, emulate });
  const from = source.indexOf("// ── JSON helpers for Arduino nodes ──");
  const to = source.lastIndexOf("} // namespace mfArduino");
  assert.ok(from >= 0 && to > from);
  return [
    STUB,
    ...flow.nodes.map((n, i) =>
      n.type === "arduino"
        ? ""
        : `void node${i}(String value) { out += "${n.id}=" + value.s + ";"; }`,
    ),
    source.slice(from, source.indexOf("\n", to)),
    `int main() {\n${main}\n  puts(out.c_str());\n}`,
  ].join("\n");
}
function compileAndRun(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-arduino-"));
  fs.writeFileSync(path.join(dir, "t.cpp"), code);
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      exe,
      path.join(dir, "t.cpp"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(cc.status, 0, cc.stderr);
  return spawnSync(exe, { encoding: "utf8" }).stdout.trim();
}
test(
  "AND gate example: generated C++ compiles and runs",
  { skip: !gxx && "g++ not found" },
  () => {
    const example = require("../examples/arduino-and-gate.json");
    for (const emulate of [false, true]) {
      const flow = structuredClone(example.flow);
      const at = (id) => flow.nodes.findIndex((n) => n.id === id);
      const [gate, count, and2, swA, swB, btnA, btnB] = [
        "gate",
        "count",
        "and2",
        "swA",
        "swB",
        "btnA",
        "btnB",
      ].map(at);
      const out = compileAndRun(
        program(
          flow,
          emulate,
          `  mfArduino${gate}::mfSetup(); mfArduino${count}::mfSetup(); mfArduino${and2}::mfSetup();
  mfArduino${gate}::mfFrom${btnA}(String("0")); mfArduino${gate}::mfFrom${btnB}(String("0")); mfArduino${gate}::mfFrom${btnA}(String("1"));
  mfArduino${and2}::mfFrom${swA}(String("1")); mfArduino${and2}::mfFrom${swB}(String("1")); mfArduino${and2}::mfFrom${swA}(String("0"));`,
        ),
      );
      // Button A pressed (0): the gate's first result, 0. Both pressed: 1 to the LED,
      // its log and Count, which counts it. A released: 0 (Count ignores 0s).
      // Then the switches: SW_A on (0), SW_B on (1), SW_A off (0).
      assert.equal(
        out,
        "led=0;gateLog=0;led=1;gateLog=1;countLog=1;led=0;gateLog=0;and2Log=0;and2Log=1;and2Log=0;",
      );
    }
  },
);
test(
  "JSON example: reads fields and sends built JSON",
  { skip: !gxx && "g++ not found" },
  () => {
    const flow = structuredClone(require("../examples/arduino-json.json").flow);
    const out = compileAndRun(
      program(
        flow,
        false,
        `  mfArduino1::mfFrom0(String("{\\"temp\\": 35, \\"room\\": \\"at\\\\\\"tic\\"}"));
  mfArduino1::mfFrom0(String("no json"));
  mfArduino1::mfFrom0(String("{\\"temp\\": -1.25}"));`,
      ),
    );
    assert.equal(
      out,
      'result={"room":"at\\"tic","celsius":35,"fahrenheit":95,"hot":true};' +
        'result={"room":"","celsius":-1.25,"fahrenheit":29.8,"hot":false};',
    );
  },
);
test(
  "JSON helpers: paths, escapes, fallbacks and malformed input",
  { skip: !gxx && "g++ not found" },
  () => {
    const flow = flowOf([arduino("a", { pins: "", message: "" })], []);
    const checks = [
      ['jsonNumber(j, "temp")', "21.5"],
      ['jsonText(j, "name")', 'lab "A"\né\u{1F600}'],
      ['jsonNumber(j, "sensor.temp")', "-300"],
      ['jsonText(j, "sensor.tags[1].x")', "[1, 2, 3]"],
      ['jsonNumber(j, "sensor.tags.1.x.2")', "3"],
      ['jsonText(j, "sensor.tags[2]")', "c,]"],
      ['jsonHas(j, "list[3]")', "0"],
      ['jsonBool(j, "on")', "1"],
      ['jsonNumber(j, "off", 7)', "0"],
      ['jsonNumber(j, "n", 5)', "5"],
      ['jsonNumber(j, "s")', "42"],
      ['jsonNumber(j, "missing", -1)', "-1"],
      ['jsonText(j, "missing")', ""],
      ['jsonHas(j, "te")', "0"],
      ['jsonHas(String("{\\"a\\":[1,2"), "a")', "0"],
      ['jsonHas(String("not json"), "a")', "0"],
      ['jsonNumber(String("42"), "")', "42"],
      [
        'Json().add("t", 2.0).add("s", "q\\"").add("b", false).add("x", NAN).text()',
        '{"t":2,"s":"q\\"","b":false,"x":null}',
      ],
      [
        'Json().add("in", Json().add("a", 1)).addJson("arr", "[1,2]").text()',
        '{"in":{"a":1},"arr":[1,2]}',
      ],
    ];
    const json =
      '{ "temp": 21.5, "name": "lab \\"A\\"\\n\\u00e9\\ud83d\\ude00", "on": true, "off": false, "n": null, ' +
      '"sensor": {"temp": -3e2, "tags": ["a", {"x": [1, 2, 3]}, "c,]"]}, "list": [10, 20, 30], "s": "42" }';
    const main = [
      `  using namespace mfJson;`,
      `  String j(${JSON.stringify(json)});`,
      ...checks.map(
        ([expr]) =>
          `  { String r; r += String(${expr}); out += r.s; out += '\\x1f'; }`,
      ),
    ].join("\n");
    // Numbers print through the stand-in's String(double), with 2 decimals.
    const got = compileAndRun(program(flow, false, main)).split("\x1f");
    checks.forEach(([expr, want], k) =>
      expr.startsWith("jsonNumber")
        ? assert.equal(Number(got[k]), Number(want), expr)
        : assert.equal(got[k], want, expr),
    );
  },
);
