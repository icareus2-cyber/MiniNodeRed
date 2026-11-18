// Voice command (ESP32-S3, PDM mic + ESP-SR) and Speak (SAM through I2S).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build, analyze, validate } = require("../lib/flow");
const speechfw = require("../lib/speechfw");

const settings = { board: "esp32s3", ssid: "n", host: "h", profile: "release", ota: false };
const flow = (voice = {}, speak = {}) => ({
  name: "speech",
  nodes: [
    { id: "v", type: "voice-in", config: voice },
    { id: "s", type: "speak", config: speak },
  ],
  edges: [{ from: "v", to: "s" }],
});

test("commands: lines, | synonyms, what the node sends", () => {
  const c = { commands: "lights on | turn on the light\n\nstart fan", output: "text" };
  assert.deepEqual(
    speechfw.commandsOf(c).map((x) => x.phrases),
    [["lights on", "turn on the light"], ["start fan"]],
  );
  assert.equal(speechfw.result(c, "Turn on the light"), "lights on");
  assert.equal(speechfw.result({ ...c, output: "number" }, "start fan"), "2");
  assert.throws(() => validate(flow({ commands: "turn to 90" })), /English words only/);
  assert.throws(() => validate(flow({ commands: " \n " })), /at least one command/);
});

test("firmware: PDM pins, ESP-SR, speech partition, SAM speaker", () => {
  const r = build(flow({ clk: 42, data: 41, wake: "always" }, { bclk: 5, lrc: 6, din: 7, text: "OK {{payload}}" }), settings);
  assert.equal(r.fqbn, "esp32:esp32:esp32s3:PartitionScheme=esp_sr_16,FlashSize=16M,PSRAM=opi");
  assert.deepEqual(r.libraries, ["ESP8266Audio", "ESP8266SAM"]);
  assert.match(r.source, /#include "ESP_SR.h"/);
  assert.match(r.source, /mfMic\.setPinsPdmRx\(42, 41\)/);
  assert.match(r.source, /\{0, "lights on"\},\n  \{0, "turn on the light"\}/);
  assert.match(r.source, /SR_CHANNELS_MONO, SR_MODE_COMMAND, "M"\)/);
  assert.match(r.source, /mfSpeaker1\.SetPinout\(5, 6, 7\)/);
  assert.match(r.source, /mfVoicePause\(\); mfSam1\.Say\(&mfSpeaker1, mfSay\.c_str\(\)\)/);
  assert.match(r.source, /inline void mfVoicePause\(\) \{ ESP_SR\.pause\(\); \}/);
});

test("boards: Voice command needs an ESP32-S3; one per chip; one speaker", () => {
  assert.match(analyze(flow(), "esp32").errors.join(" "), /needs an ESP32-S3/);
  assert.match(analyze(flow(), "esp8266").errors.join(" "), /cannot run Speak/);
  const two = flow();
  two.nodes.push({ id: "v2", type: "voice-in", config: {} });
  assert.match(analyze(two, "esp32s3").errors.join(" "), /Only one Voice command/);
  const speakers = flow();
  speakers.nodes.push({ id: "s2", type: "speak", config: { bclk: 15, lrc: 16, din: 17 } });
  speakers.edges.push({ from: "v", to: "s2" });
  assert.match(analyze(speakers, "esp32s3").errors.join(" "), /same amplifier pins/);
});

test("Speak alone needs no speech partition and keeps the recognizer calls empty", () => {
  const r = build(
    { name: "s", nodes: [{ id: "i", type: "inject", config: { payload: "hello" } }, { id: "s", type: "speak", config: {} }], edges: [{ from: "i", to: "s" }] },
    settings,
  );
  assert.doesNotMatch(r.fqbn, /esp_sr/);
  assert.match(r.source, /inline void mfVoicePause\(\) \{ \}/);
});
