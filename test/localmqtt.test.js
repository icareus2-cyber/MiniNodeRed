// Radio in/out with Local MQTT: the board runs its own MQTT broker (sMQTTBroker).
// Board checks, the simulator, and the firmware with the host g++ and a stand-in
// broker (test/fixtures/arduino/sMQTTBroker.h).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyze, build, validate } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");

const local = (extra = {}) => ({ protocol: "local", ...extra });
// Inject → Radio out (local, lab/kitchen/temp); Radio in (local, lab/+/temp) →
// Radio out over MQTT "q" (to see what it receives).
const flowOf = (extra = {}) => ({
  name: "t",
  nodes: [
    { id: "i", type: "inject", config: { payload: "1", interval: 0 } },
    {
      id: "lo",
      type: "mqtt-out",
      config: local({ topic: "lab/kitchen/temp", retain: "yes", ...extra }),
    },
    {
      id: "li",
      type: "mqtt-in",
      config: local({ topic: "lab/+/temp", ...extra }),
    },
    { id: "q", type: "mqtt-out", config: { topic: "q" } },
  ],
  edges: [
    { from: "i", to: "lo" },
    { from: "li", to: "q" },
  ],
});
const settings = {
  board: "esp32",
  ssid: "n",
  host: "h",
  profile: "release",
  ota: false,
};

test("catalog and checks: ESP32 only, one broker per board", () => {
  const fields = catalog()["mqtt-in"].fields;
  assert.equal(
    fields[0].options.local,
    "Local MQTT (this board is the broker)",
  );
  assert.deepEqual(
    fields.filter((f) => f.when?.protocol?.includes("local")).map((f) => f.key),
    ["topic", "localPort", "localUser", "localPass"],
  );
  assert.equal(analyze(flowOf(), "esp32").errors.length, 0);
  assert.match(
    analyze(flowOf(), "esp32").warnings.join(),
    /this board is the broker.*mqtt:\/\/<this board's IP>:1883 \(no login/,
  );
  assert.match(
    analyze(flowOf(), "esp8266").errors.join(),
    /cannot run a local MQTT broker/,
  );
  const mixed = flowOf();
  mixed.nodes[2].config.localPort = 1884;
  assert.match(analyze(mixed, "esp32").errors.join(), /same port and login/);
  assert.match(
    (() => {
      try {
        validate({
          nodes: [
            { id: "x", type: "mqtt-in", config: local({ localPass: "p" }) },
          ],
          edges: [],
        });
      } catch (e) {
        return e.message;
      }
    })(),
    /needs a username/,
  );
  // The library is installed on the first compile; WiFi starts in a release build.
  const r = build(flowOf(), settings);
  assert.deepEqual(r.libraries, ["sMQTTBroker"]);
  assert.match(r.source, /#include <sMQTTBroker\.h>/);
  assert.match(r.source, /WiFi\.begin\(MF_SSID, MF_PASS\);/);
});

test("simulator: Radio out (local) reaches this board's Radio in", () => {
  const f = validate(flowOf());
  const out = f.nodes.find((n) => n.id === "lo");
  const sent = [];
  types["mqtt-out"].host("19", out, {
    localMqtt: (t, v) => sent.push(`${t} ${v}`),
  });
  assert.deepEqual(sent, ["lab/kitchen/temp 19"]);
});

const gxx = spawnSync("g++", ["--version"]).status === 0;
test(
  "firmware: clients and this board publish; Radio in hears both",
  { skip: !gxx && "g++ not found" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-local-"));
    const sketch = (extra) =>
      build(flowOf(extra), settings).source.replace(/^#include .*$/gm, "");
    fs.writeFileSync(
      path.join(dir, "t.cpp"),
      `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "sMQTTBroker.h"
#include <vector>
namespace open {
${sketch({})}
}
namespace login {
${sketch({ localUser: "lab", localPass: "s3cret" })}
}
int main() {
  open::setup();
  open::loop(); // WiFi is up: the broker starts
  published += open::mfLocal.port == 1883 ? "port 1883\\n" : "port ?\\n";
  open::mfLocal.clientPublish("lab/garage/temp", "21");  // a client publishes
  open::mfLocal.clientPublish("other/topic", "x");       // not for Radio in
  open::loop();
  open::node0(String("19"));                            // this board's Radio out
  open::loop();
  printf("%s=\\n", published.c_str());
  published.clear();
  login::setup();
  login::loop();
  printf("wrong %d right %d\\n", (int)login::mfLocal.clientLogin("lab", "nope"), (int)login::mfLocal.clientLogin("lab", "s3cret"));
}
`,
    );
    const exe = path.join(dir, "t");
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
        path.join(dir, "t.cpp"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 30).join("\n"));
    const run = spawnSync(exe, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const [first, second] = run.stdout.split("=\n");
    assert.deepEqual(first.trim().split("\n"), [
      "port 1883",
      "q 21",
      "local lab/kitchen/temp 19 (retained)",
      "q 19",
    ]);
    assert.equal(second.trim(), "wrong 0 right 1");
  },
);
