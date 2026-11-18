// Speech nodes (ESP32-S3 voice commands in, text-to-speech out).
//
// Voice command (INPUT, ESP32-S3 with 16 MB flash and PSRAM): a PDM microphone
// on two pins (CLK, DATA) feeds Espressif's offline speech recognition (ESP-SR,
// the ESP_SR library in the ESP32 Arduino core 3.x: "Hi ESP" wake word + MultiNet
// commands). Each line of Commands is one command; "|" separates phrases that mean
// the same ("lights on | turn on the light"). When a phrase is heard, the node sends
// the command (its first phrase) or its number. The build uses the "ESP SR 16M"
// partition scheme, which also uploads the speech models.
//
// Speak (OUTPUT, ESP32 boards): says the text it receives through an I2S amplifier
// (e.g. MAX98357A: BCLK, LRC, DIN), with the SAM speech synthesizer (ESP8266SAM +
// ESP8266Audio libraries, English). Speaking blocks the flow while it talks; the
// voice node stops listening meanwhile, so it does not hear the speaker.
//
// In the PC simulation, Voice command gets a 🎤 / text box on its box (the browser's
// speech recognition, matched against the commands) and Speak talks through the
// PC's speakers.

const quoted = (s) => JSON.stringify(String(s));
const MAX_PHRASE = 60; // ESP_SR keeps up to 63 characters per phrase
const MAX_PHRASES = 200;

// Commands → [{ id, text, phrases: [...] }] (blank lines skipped).
function commandsOf(config) {
  return String(config.commands || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("|")
        .map((p) => p.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    )
    .filter((phrases) => phrases.length)
    .map((phrases, id) => ({ id, text: phrases[0], phrases }));
}
function checkCommands(config) {
  const cmds = commandsOf(config);
  if (!cmds.length)
    throw Error("Voice command: enter at least one command (one per line).");
  const all = cmds.flatMap((c) => c.phrases);
  if (all.length > MAX_PHRASES)
    throw Error(`Voice command: at most ${MAX_PHRASES} phrases.`);
  for (const p of all) {
    if (p.length > MAX_PHRASE)
      throw Error(`Voice command: "${p.slice(0, 20)}…" is too long (max ${MAX_PHRASE} characters).`);
    if (!/^[A-Za-z][A-Za-z' ]*$/.test(p))
      throw Error(
        `Voice command: "${p}": use English words only (letters, spaces and '), no digits or symbols; write numbers as words ("twenty").`,
      );
  }
}
// Phrase heard → what the node sends: the command text or its number (1, 2, …).
function result(config, phrase) {
  const cmd = commandsOf(config).find((c) =>
    c.phrases.some((p) => p.toLowerCase() === String(phrase).toLowerCase()),
  );
  if (!cmd) return null;
  return config.output === "number" ? String(cmd.id + 1) : cmd.text;
}

const voiceFields = [
  {
    key: "clk",
    label: "Microphone CLK pin (PDM clock)",
    type: "number",
    default: 42,
    min: 0,
    max: 48,
    integer: true,
  },
  {
    key: "data",
    label: "Microphone DATA pin",
    type: "number",
    default: 41,
    min: 0,
    max: 48,
    integer: true,
  },
  {
    key: "commands",
    label: "Commands (one per line; | separates phrases with the same meaning)",
    type: "textarea",
    default:
      "lights on | turn on the light\nlights off | turn off the light\nstart fan\nstop fan",
  },
  {
    key: "wake",
    label: "Listening",
    type: "select",
    default: "wakeword",
    options: {
      wakeword: 'After the wake word "Hi ESP" (fewer false commands)',
      always: "Always (commands without a wake word)",
    },
  },
  {
    key: "output",
    label: "Sends",
    type: "select",
    default: "text",
    options: {
      text: "The command (its first phrase) as text",
      number: "The command number (1, 2, 3 …)",
    },
  },
];

const VOICES = {
  sam: "SAM (default)",
  elf: "Elf",
  robot: "Robot",
  stuffy: "Stuffy",
  oldlady: "Old lady",
  et: "E.T.",
};
const speakFields = [
  {
    key: "bclk",
    label: "Amplifier BCLK pin",
    type: "number",
    default: 5,
    min: 0,
    max: 48,
    integer: true,
  },
  {
    key: "lrc",
    label: "Amplifier LRC (WS) pin",
    type: "number",
    default: 6,
    min: 0,
    max: 48,
    integer: true,
  },
  {
    key: "din",
    label: "Amplifier DIN pin",
    type: "number",
    default: 7,
    min: 0,
    max: 48,
    integer: true,
  },
  {
    key: "text",
    label: "Text to say ({{payload}} = the value received)",
    type: "text",
    default: "{{payload}}",
  },
  {
    key: "voice",
    label: "Voice",
    type: "select",
    default: "sam",
    options: VOICES,
  },
  {
    key: "speed",
    label: "Speed (1 fast – 255 slow; 0 = the voice's own)",
    type: "number",
    default: 0,
    min: 0,
    max: 255,
    integer: true,
  },
];
const sayText = (config, value) =>
  String(config.text ?? "{{payload}}").replaceAll("{{payload}}", value);

// ── Firmware ──
const LIBRARIES = ["ESP8266Audio", "ESP8266SAM"];
const uses = (nodes) => ({
  voice: nodes.filter((n) => n.type === "voice-in"),
  speak: nodes.filter((n) => n.type === "speak"),
});
function includes(nodes) {
  const u = uses(nodes);
  const listening = u.voice.length > 0;
  return (
    (listening ? '#include "ESP_I2S.h"\n#include "ESP_SR.h"\n' : "") +
    (u.speak.length
      ? "#include <AudioOutputI2S.h>\n#include <ESP8266SAM.h>\n" +
        // Speak stops the recognizer while talking, so it does not hear itself.
        `inline void mfVoicePause() {${listening ? " ESP_SR.pause();" : ""} }\ninline void mfVoiceResume() {${listening ? " ESP_SR.resume();" : ""} }\n`
      : "")
  );
}
const SAM_VOICE = {
  sam: "VOICE_SAM",
  elf: "VOICE_ELF",
  robot: "VOICE_ROBOT",
  stuffy: "VOICE_STUFFY",
  oldlady: "VOICE_OLDLADY",
  et: "VOICE_ET",
};
const voiceFw = {
  globals: (n, i) => {
    const cmds = commandsOf(n.config);
    const rows = cmds.flatMap((c) =>
      c.phrases.map((p) => `  {${c.id}, ${quoted(p.toLowerCase())}},`),
    );
    const sends = cmds.map((c) =>
      quoted(n.config.output === "number" ? String(c.id + 1) : c.text),
    );
    const always = n.config.wake === "always";
    return `// Voice command: PDM microphone (CLK ${n.config.clk}, DATA ${n.config.data}) + ESP-SR.
I2SClass mfMic;
static const sr_cmd_t mfSrPhrases[] = {
${rows.join("\n")}
};
static const char* mfSrSends[] = {${sends.join(", ")}};
static volatile int mfSrHeard = -1; // command id, set by the recognizer task
void mfSrEvent(sr_event_t event, int command_id, int phrase_id) {
  switch (event) {
    case SR_EVENT_WAKEWORD:
    case SR_EVENT_WAKEWORD_CHANNEL:
      Serial.println("Voice: wake word heard, listening for a command");
      ESP_SR.setMode(SR_MODE_COMMAND);
      break;
    case SR_EVENT_TIMEOUT:
      ESP_SR.setMode(${always ? "SR_MODE_COMMAND" : "SR_MODE_WAKEWORD"});
      break;
    case SR_EVENT_COMMAND:
      mfSrHeard = command_id;
      ESP_SR.setMode(SR_MODE_COMMAND); // more commands before the timeout
      break;
    default:
      break;
  }
}`;
  },
  setup: (n) =>
    `mfMic.setTimeout(1000);
  mfMic.setPinsPdmRx(${n.config.clk}, ${n.config.data});
  if (!mfMic.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_RIGHT)) Serial.println("Voice: microphone did not start (check CLK / DATA pins)");
  ESP_SR.onEvent(mfSrEvent);
  if (!ESP_SR.begin(mfMic, mfSrPhrases, sizeof(mfSrPhrases) / sizeof(sr_cmd_t), SR_CHANNELS_MONO, ${n.config.wake === "always" ? "SR_MODE_COMMAND" : "SR_MODE_WAKEWORD"}, "M")) Serial.println("Voice: speech recognition did not start (needs the ESP SR 16M partition scheme and PSRAM)");`,
  loop: (n, i) =>
    `{ int heard = mfSrHeard; if (heard >= 0) { mfSrHeard = -1; if (heard < (int)(sizeof(mfSrSends) / sizeof(mfSrSends[0]))) node${i}(String(mfSrSends[heard])); } }`,
};
const speakFw = {
  globals: (n, i) =>
    `// Speak: SAM speech through an I2S amplifier (BCLK ${n.config.bclk}, LRC ${n.config.lrc}, DIN ${n.config.din}).
AudioOutputI2S mfSpeaker${i};
ESP8266SAM mfSam${i};`,
  setup: (n, i) =>
    `mfSpeaker${i}.SetPinout(${n.config.bclk}, ${n.config.lrc}, ${n.config.din});
  mfSam${i}.SetVoice(ESP8266SAM::${SAM_VOICE[n.config.voice] || "VOICE_SAM"});${Number(n.config.speed) ? `\n  mfSam${i}.SetSpeed(${Number(n.config.speed)});` : ""}`,
  // Say() opens the I2S output, talks (blocking) and the output is closed again.
  body: (n, i) => {
    const text = String(n.config.text ?? "{{payload}}");
    const expr = text.includes("{{payload}}")
      ? `([&]() { String t(${quoted(text)}); t.replace("{{payload}}", value); return t; })()`
      : quoted(text);
    return `{ String mfSay = ${expr}; if (mfSay.length() > 250) mfSay = mfSay.substring(0, 250); mfVoicePause(); mfSam${i}.Say(&mfSpeaker${i}, mfSay.c_str()); delay(60); mfSpeaker${i}.stop(); mfVoiceResume(); }`;
  },
};
// Project-level checks (analyze): one voice node; distinct speaker pin sets fit
// the two I2S units of an ESP32-S3 (the microphone takes one).
function check(flow) {
  const errors = [],
    warnings = [];
  const u = uses(flow.nodes);
  if (u.voice.length > 1)
    errors.push(
      "Only one Voice command box per chip: put all commands in one box (one per line) and wire it to a Compare or Map to split them.",
    );
  const sets = new Set(
    u.speak.map((n) => `${n.config.bclk}/${n.config.lrc}/${n.config.din}`),
  );
  if (u.speak.length > 1 && sets.size > 1)
    errors.push(
      "Speak boxes on one chip must use the same amplifier pins (BCLK, LRC, DIN): there is one speaker.",
    );
  if (u.voice.length)
    warnings.push(
      'Voice command needs an ESP32-S3 with 16 MB flash and PSRAM (e.g. N16R8): the build uses the "ESP SR 16M" partition scheme, which uploads the speech models too (first upload over USB). Say "Hi ESP" first unless Listening is "Always".',
    );
  if (u.speak.length)
    warnings.push(
      "Speak pauses the flow while it talks (SAM speech, English). The ESP8266Audio and ESP8266SAM libraries are installed on the first build.",
    );
  return { errors, warnings };
}
// FQBN options a voice build needs (partition with the speech models, PSRAM).
function fqbnOptions(nodes) {
  return uses(nodes).voice.length
    ? ["PartitionScheme=esp_sr_16", "FlashSize=16M", "PSRAM=opi"]
    : [];
}
const libraries = (nodes) => (uses(nodes).speak.length ? LIBRARIES : []);

module.exports = {
  commandsOf,
  checkCommands,
  result,
  sayText,
  voiceFields,
  speakFields,
  voiceFw,
  speakFw,
  includes,
  check,
  fqbnOptions,
  libraries,
};
