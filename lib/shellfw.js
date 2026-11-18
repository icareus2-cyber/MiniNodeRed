// C++ for the test terminal, included in debug builds. Commands arrive as lines on
// USB serial (replies prefixed "» ") or on MQTT microflow/<id>/cmd (replies on
// microflow/<id>/cmd/reply). Pin commands are limited to the board's safe pins.
const emufw = require("./emufw");
const list = (pins) => (pins.length ? pins.join(", ") : "255"); // C forbids empty arrays
const HELP =
  "commands: status | wifi | wifi scan | gpio read <pin> | gpio write <pin> <0|1> | gpio mode <pin> <in|pullup|out> | adc [pin] | pwm <pin> <0-255> | nodes | send <node> <payload> | pub <topic> <payload> | echo <text> | reboot";
// extra: board-specific command code (e.g. the LCD), extraHelp: its help text.
function shell({
  board,
  nodes,
  net,
  terminal = false,
  extra = "",
  extraHelp = "",
  emulate = false,
}) {
  // Camera node: "camera" takes a picture whatever its input is (lib/camerafw.js).
  const cam = nodes.findIndex((n) => n.type === "camera");
  const camera =
    cam < 0
      ? ""
      : `  if (cmd == "camera") {
    uint32_t before = mfStillShot${cam};
    node${cam}(String("0")); node${cam}(String("1")); node${cam}(String("0"));
    if (mfStillShot${cam} == before) return "no picture: see the Camera line above";
    return String("picture ") + String((unsigned long)mfStillShot${cam}) + ": http://" + ${net ? "WiFi.localIP().toString()" : 'String("<board IP>")'} + "/camera/${nodes[cam].id}.png";
  }
`;
  const table = nodes.length
    ? nodes.map((n, i) => `{ ${JSON.stringify(n.id)}, node${i} }`).join(", ")
    : '{ "", nullptr }';
  return `
// ── Test terminal (debug builds) ──
struct MfNode { const char* id; void (*fn)(String); };
const MfNode MF_NODES[] = { ${table} };
const size_t MF_NODE_COUNT = ${nodes.length};
const uint8_t MF_PINS[] = { ${list(board.gpio)} };
const uint8_t MF_INPUT_ONLY[] = { ${list(board.inputOnly)} };
const uint8_t MF_NO_PULL[] = { ${list(board.noPull || [])} };
const uint8_t MF_ADC[] = { ${list(board.adc)} };
const uint8_t MF_PWM[] = { ${list(board.pwm)} };
unsigned long mfRebootAt = 0;
static bool mfIn(const uint8_t* pins, size_t n, long pin) {
  for (size_t i = 0; i < n; i++) if (pins[i] == pin) return true;
  return false;
}
#define MF_HAS(list, pin) mfIn(list, sizeof(list), pin)
// Takes the next space-separated word off the front of rest.
static String mfWord(String& rest) {
  rest.trim();
  int sp = rest.indexOf(' ');
  String w = sp < 0 ? rest : rest.substring(0, sp);
  rest = sp < 0 ? String() : rest.substring(sp + 1);
  rest.trim();
  return w;
}
static bool mfInt(const String& s, long& out) {
  if (!s.length()) return false;
  char* end;
  out = strtol(s.c_str(), &end, 10);
  return *end == 0;
}
static String mfNet() {
  ${
    net
      ? `return String(" · wifi ") + (WiFi.status() == WL_CONNECTED ? String("connected ") + WiFi.localIP().toString() + " " + String(WiFi.RSSI()) + " dBm" : String("status ") + String((int)WiFi.status())) +
    " · mqtt " + (mqtt.connected() ? String("connected") : String("state ") + String(mqtt.state()));`
      : `return " · wifi off";`
  }
}
String mfCommand(String line) {
  line.trim();
  String rest = line;
  String cmd = mfWord(rest);
  cmd.toLowerCase();
  long pin, v;
  if (cmd == "" ) return "";
  if (cmd == "help" || cmd == "?") return ${JSON.stringify(HELP + extraHelp + (cam < 0 ? "" : " | camera") + (emulate ? emufw.HELP : ""))};
${camera}
  if (cmd == "echo") return rest;
  if (cmd == "status") return String("build ") + MF_BUILD + " · id " + mfId + " · uptime " + String(millis() / 1000) + " s · heap " + String(ESP.getFreeHeap()) + " B" + mfNet();
  if (cmd == "wifi") {
${
  net
    ? `    if (mfWord(rest) == "scan") {
      int n = WiFi.scanNetworks();
      String out = String(n < 0 ? 0 : n) + " networks";
      for (int i = 0; i < n && i < 12; i++) out += "\\n" + WiFi.SSID(i) + "  " + String(WiFi.RSSI(i)) + " dBm  ch " + String(WiFi.channel(i));
      WiFi.scanDelete();
      return out;
    }
    return String("ssid ") + WiFi.SSID() + mfNet();`
    : `    return "wifi is off in this build";`
}
  }
  if (cmd == "gpio") {
    String sub = mfWord(rest);
    if (!mfInt(mfWord(rest), pin) || !MF_HAS(MF_PINS, pin)) return "error: not a usable GPIO on this board";
    if (sub == "read") return String("GPIO ") + pin + " = " + digitalRead(pin);
    if (sub == "write") {
      if (!mfInt(mfWord(rest), v) || (v != 0 && v != 1)) return "error: value must be 0 or 1";
      if (MF_HAS(MF_INPUT_ONLY, pin)) return "error: input-only pin";
      pinMode(pin, OUTPUT);
      digitalWrite(pin, v ? HIGH : LOW);
      return String("GPIO ") + pin + " = " + (v ? "HIGH" : "LOW");
    }
    if (sub == "mode") {
      String m = mfWord(rest);
      if (m == "in") pinMode(pin, INPUT);
      else if (m == "pullup") pinMode(pin, INPUT_PULLUP);
      else if (m == "out" && !MF_HAS(MF_INPUT_ONLY, pin)) pinMode(pin, OUTPUT);
      else return "error: mode must be in, pullup or out (not out on input-only pins)";
      if (m == "pullup" && MF_HAS(MF_NO_PULL, pin)) return String("GPIO ") + pin + " mode pullup, but this pin has no internal pull-up: it floats without an external resistor";
      return String("GPIO ") + pin + " mode " + m;
    }
    return "error: use gpio read|write|mode";
  }
  if (cmd == "adc") {
    String p = mfWord(rest);
    pin = MF_ADC[0];
    if (p.length() && !mfInt(p, pin)) return "error: bad pin";
    if (pin == 255 || !MF_HAS(MF_ADC, pin)) return "error: not an analog pin on this board";
    return String("ADC ") + pin + " = " + analogRead(pin);
  }
  if (cmd == "pwm") {
    if (!mfInt(mfWord(rest), pin) || !MF_HAS(MF_PWM, pin) || MF_HAS(MF_INPUT_ONLY, pin)) return "error: not a PWM pin on this board";
    if (!mfInt(mfWord(rest), v) || v < 0 || v > 255) return "error: duty must be 0-255";
    pinMode(pin, OUTPUT);
    analogWrite(pin, v);
    return String("PWM ") + pin + " = " + v;
  }
  if (cmd == "nodes") {
    String out = String(MF_NODE_COUNT) + " nodes:";
    for (size_t i = 0; i < MF_NODE_COUNT; i++) out += String(" ") + MF_NODES[i].id;
    return out;
  }
  if (cmd == "send") {
    String id = mfWord(rest);
    for (size_t i = 0; i < MF_NODE_COUNT; i++)
      if (id == MF_NODES[i].id) { MF_NODES[i].fn(rest); return String("sent \\"") + rest + "\\" to " + id; }
    return String("error: no node '") + id + "' (try nodes)";
  }
  if (cmd == "pub") {
${
  net
    ? `    String topic = mfWord(rest);
    if (!topic.length()) return "error: pub <topic> <payload>";
    return mqtt.publish(topic.c_str(), rest.c_str()) ? String("published to ") + topic : String("error: MQTT not connected");`
    : `    return "error: no MQTT in this build";`
}
  }
${extra}${emulate ? emufw.command : ""}${terminal ? "  { String t = mfTerminal(line); if (t.length()) return t; } // Terminal nodes\n" : ""}  if (cmd == "reboot") { mfRebootAt = millis() + 300; return "rebooting…"; }
  return String("error: unknown command '") + cmd + "' (try help)";
}
// Prints a reply on USB serial, one "» " line per reply line.
static void mfSerialReply(const String& reply) {
  if (!reply.length()) return;
  String out = String("» ") + reply;
  out.replace("\\n", "\\n» ");
  Serial.println(out);
}
`;
}
const mqttSubscribe = `      mqtt.subscribe((mfBase + "/cmd").c_str());`;
const mqttDispatch = `  if ((mfBase + "/cmd") == topicCopy) {
    String reply = mfCommand(value);
    if (reply.length() > 480) reply = reply.substring(0, 480);
    mqtt.publish((mfBase + "/cmd/reply").c_str(), reply.c_str());
    return;
  }`;
const loop = `  if (mfRebootAt && (long)(millis() - mfRebootAt) >= 0) { Serial.flush(); ESP.restart(); }`;
module.exports = { shell, mqttSubscribe, mqttDispatch, loop, HELP };
