// PWA node (lib/pwafw.js): keys from a phone page in, what the phone shows out,
// JSON over MQTT; the published page files.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, validate, analyze } = require("../lib/flow");
const pwafw = require("../lib/pwafw");
const { types } = require("../lib/nodes");

const flowOf = (config = {}) => ({
  name: "p",
  nodes: [
    { id: "kb", type: "pwa", name: "PHONE", config },
    { id: "o", type: "mqtt-out", config: { topic: "q" } },
    { id: "t", type: "template", config: { template: '{"text":"got {{payload}}"}' } },
  ],
  // keys → Radio out, and keys → Template → back to the phone (no cycle).
  edges: [
    { from: "kb", to: "o" },
    { from: "kb", to: "t" },
    { from: "t", to: "kb" },
  ],
});

test("settings: layouts, custom keys and images are checked", () => {
  assert.equal(validate(flowOf()).nodes[0].config.layout, "keyboard");
  assert.throws(() => validate(flowOf({ layout: "custom", keys: "[1,2]" })), /rows of key labels/);
  assert.throws(() => validate(flowOf({ images: "[]" })), /Images must be/);
  assert.throws(() => validate(flowOf({ wsUrl: "http://x" })), /wss:\/\//);
  assert.equal(analyze(flowOf(), "esp32").errors.length, 0, "a loop back into the PWA node is allowed");
});

test("simulator: a key message goes on, anything else is shown on the phone", () => {
  const n = validate(flowOf()).nodes[0];
  const shown = [];
  const ctx = { pwa: (_, json) => shown.push(json) };
  assert.equal(types.pwa.host(pwafw.KEY + '{"key":"7"}', n, ctx), "7");
  assert.equal(types.pwa.host("Door open", n, ctx), undefined);
  assert.equal(types.pwa.host('{"image":"ok"}', n, ctx), undefined);
  assert.deepEqual(shown, ['{"text":"Door open"}', '{"image":"ok"}']);
  assert.equal(pwafw.sends({ sends: "json" }, '{"key":"7"}'), '{"key":"7"}');
});

test("published page: settings file with keys, images and topics", () => {
  const n = validate(flowOf({ layout: "keypad" })).nodes[0];
  const files = pwafw.files(n, { device: "lab1" });
  assert.deepEqual(Object.keys(files), ["index.html", "pwa.json", "manifest.webmanifest", "sw.js", "icon.svg"]);
  const cfg = JSON.parse(files["pwa.json"]);
  assert.deepEqual(cfg.keys[0], ["1", "2", "3"]);
  assert.equal(cfg.topics.in, "microflow/lab1/pwa/kb/in");
  assert.ok(cfg.images.alert.startsWith("data:image/svg+xml,"));
  assert.match(files["index.html"], /mqtt@5\.10\.1/);
  assert.equal(JSON.parse(files["manifest.webmanifest"]).display, "standalone");
});

const gxx = spawnSync("g++", ["--version"]).status === 0;
test("firmware: keys from …/pwa/<id>/in go on; inputs are published to …/out", { skip: !gxx && "g++ not found" }, () => {
  const { source } = build(flowOf(), { board: "esp32", ssid: "n", host: "h", profile: "release", ota: false });
  assert.match(source, /mqtt\.setBufferSize\(8192\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-pwa-"));
  fs.writeFileSync(
    path.join(dir, "t.cpp"),
    `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
${source.replace(/^#include .*$/gm, "")}
int main() {
  setup(); loop();
  String t = mfBase + "/pwa/kb/in";
  received((char*)t.c_str(), (byte*)"{\\"key\\":\\"7\\"}", 11);
  printf("%s", published.c_str());
}
`,
  );
  const cc = spawnSync("g++", ["-std=gnu++17", "-w", "-I", path.join(__dirname, "fixtures/arduino"), "-o", path.join(dir, "t"), path.join(dir, "t.cpp")], { encoding: "utf8" });
  assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 20).join("\n"));
  const out = spawnSync(path.join(dir, "t"), { encoding: "utf8" }).stdout;
  assert.match(out, /q 7/); // the key went on to Radio out
  assert.match(out, /pwa\/kb\/out \{"text":"got 7"\} \(retained\)/); // and back to the phone
});
