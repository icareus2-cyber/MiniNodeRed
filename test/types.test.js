// Input and output types (Properties → Input type / Output type): each value a node
// receives, and each it sends, becomes the chosen type, in the simulator and in the
// firmware alike; a conversion that changes values is reported as a warning.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyze, build, validate } = require("../lib/flow");
const { convertValue, conversionNote, catalog } = require("../lib/nodes");

test("conversions: bool, int, float, String", () => {
  assert.equal(convertValue("12.4", "bool"), "1");
  assert.equal(convertValue("0", "bool"), "0");
  assert.equal(convertValue("on", "bool"), "1");
  assert.equal(convertValue("off", "bool"), "0");
  assert.equal(convertValue("12.75", "int"), "12");
  assert.equal(convertValue("-3.9", "int"), "-3");
  assert.equal(convertValue("true", "int"), "1");
  assert.equal(convertValue("12.400", "double"), "12.4");
  assert.equal(convertValue("1/3", "double"), "1");
  assert.equal(convertValue("abc", "double"), "0");
  assert.equal(convertValue(String(1 / 3), "double"), "0.333333");
  assert.equal(convertValue('{"angle":12.4}', "String"), '{"angle":12.4}');
  assert.equal(convertValue("\x1f1", "bool"), "\x1f1"); // private signals pass
  assert.equal(
    conversionNote("double", "bool"),
    "float → bool: true when not 0, else false",
  );
  assert.equal(conversionNote("int", "double"), "");
  assert.equal(conversionNote("double", "String"), "");
});

test("each node has an input type (none for sources) and an output type", () => {
  const c = catalog();
  assert.equal(c["digital-write"].inType, "bool");
  assert.equal(c["pwm-write"].inType, "int");
  assert.equal(c["output-device"].inType, "double");
  assert.equal(c["test-button"].inType, null);
  assert.equal(c.arduino.inType, null);
  assert.equal(c["test-button"].varType, "bool");
});

const flowOf = (scale, out) => ({
  name: "t",
  nodes: [
    { id: "a", type: "inject", config: { payload: "12.75" } },
    { id: "s", type: "debug", config: {}, ...scale },
    { id: "o", type: "mqtt-out", config: { topic: "q" }, ...out },
  ],
  edges: [
    { from: "a", to: "s" },
    { from: "s", to: "o" },
  ],
});

test("validation and warnings", () => {
  assert.throws(() => validate(flowOf({ itype: "pwm" })), /input type must be/);
  assert.equal(validate(flowOf({ itype: "auto" })).nodes[1].itype, undefined);
  const w = analyze(flowOf({ itype: "bool" }), "esp32").warnings.join("\n");
  assert.match(w, /→ Debug \(DEBUG1\): float → bool: true when not 0/);
  // Auto types: no conversion, no warning (flows behave as before).
  assert.doesNotMatch(analyze(flowOf(), "esp32").warnings.join("\n"), /→ bool/);
});

const gxx = spawnSync("g++", ["--version"]).status === 0;
test(
  "firmware converts like the simulator",
  { skip: !gxx && "g++ not found" },
  () => {
    const settings = {
      board: "esp32",
      ssid: "n",
      host: "h",
      profile: "release",
      ota: false,
    };
    const { source } = build(flowOf({ itype: "int", vtype: "bool" }), settings);
    assert.match(source, /value = mfJson::toInt\(value\); \/\/ as int/);
    assert.match(source, /value = mfJson::toBool\(value\); \/\/ as bool/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-"));
    const cases = ["12.75", "0.4", "-3.9", "on", "abc", "1e3"];
    const fns = { toBool: "bool", toInt: "int", toFloat: "double" };
    fs.writeFileSync(
      path.join(dir, "t.cpp"),
      `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
${source.replace(/^#include .*$/gm, "")}
int main() {
${cases
  .flatMap((v) =>
    Object.keys(fns).map(
      (f) => `  printf("%s\\n", mfJson::${f}(String("${v}")).c_str());`,
    ),
  )
  .join("\n")}
  node0(String("12.75"));
  printf("%s", published.c_str());
}
`,
    );
    const cc = spawnSync(
      "g++",
      [
        "-std=gnu++17",
        "-w",
        "-I",
        path.join(__dirname, "fixtures/arduino"),
        "-o",
        path.join(dir, "t"),
        path.join(dir, "t.cpp"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 20).join("\n"));
    const lines = spawnSync(path.join(dir, "t"), { encoding: "utf8" })
      .stdout.trim()
      .split("\n");
    const want = cases.flatMap((v) =>
      Object.values(fns).map((t) => convertValue(v, t)),
    );
    assert.deepEqual(lines.slice(0, want.length), want);
    // 12.75 → Debug as int (12) → sent as bool (1).
    assert.equal(lines[want.length], "q 1");
  },
);
