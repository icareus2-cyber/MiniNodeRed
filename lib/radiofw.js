// C++ for Radio in/out with the ESP-NOW and I2C protocols (MQTT lives in flow.js).
//
// ESP-NOW: broadcast to every ESP32 board on the same WiFi channel, no router.
//   Frame: "MF" | version 1 | topic length | topic | payload  (≤ 250 bytes).
//   Radio in boxes keep messages whose topic matches their topic filter (+ / #).
//   The receive callback runs in the WiFi task, so frames go through a small queue
//   and are handed to the flow from loop().
// Local MQTT (ESP32): the board runs its own MQTT broker (sMQTTBroker library, QoS
//   0, retained messages kept in RAM) on the LAN. Radio out publishes there; Radio
//   in boxes receive what clients publish and what this board's Radio out sends.
//   Messages go through a queue handled in loop(), so a flow never calls itself.
// I2C: one role per board.
//   Controller: Radio out writes the value to an address; Radio in polls an
//   address and passes on each new value (the peripheral's latest reply).
//   Peripheral (ESP32 family): Radio in receives what the controller writes; Radio
//   out sets the reply returned to the controller's polls.
const { checkPin } = require("./boards");
const { cTopic, quoted } = require("./nodes");
const MAX_TOPIC = 64;
const MAX_I2C = 120; // bytes per I2C message (ESP32 Wire buffers hold 128)
const LIBRARY = "sMQTTBroker"; // Local MQTT (installed on the first compile)
const radio = (nodes, protocol) =>
  nodes.filter(
    (n) =>
      (n.type === "mqtt-in" || n.type === "mqtt-out") &&
      n.config.protocol === protocol,
  );
const uses = (nodes) => {
  const i2c = radio(nodes, "i2c");
  return {
    espnow: radio(nodes, "espnow").length > 0,
    i2c: i2c.length ? i2c[0].config.i2cRole : null,
    local: radio(nodes, "local").length > 0,
  };
};
// Board checks: errors block the build, warnings are shown.
function check(flow, boardId, board) {
  const errors = [],
    warnings = [];
  const i2c = radio(flow.nodes, "i2c");
  if (i2c.length) {
    const first = i2c[0].config;
    if (i2c.some((n) => n.config.i2cRole !== first.i2cRole))
      errors.push(
        "All I2C Radio boxes on one board need the same I2C role (controller or peripheral).",
      );
    if (
      i2c.some((n) => n.config.sda !== first.sda || n.config.scl !== first.scl)
    )
      errors.push(
        "All I2C Radio boxes on one board need the same SDA and SCL pins.",
      );
    if (first.i2cRole === "peripheral") {
      if (board.family !== "esp32")
        errors.push(
          `${board.label} cannot be an I2C peripheral here: use an ESP32 board, or make this board the controller.`,
        );
      if (i2c.some((n) => n.config.address !== first.address))
        errors.push(
          "An I2C peripheral has one address: give all its I2C Radio boxes the same address.",
        );
    }
    for (const [pin, name] of [
      [first.sda, "SDA"],
      [first.scl, "SCL"],
    ]) {
      const r = checkPin(boardId, pin, "out", `I2C ${name}`);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      const clash = flow.nodes.find(
        (n) =>
          n.config.pin === pin && n.type !== "mqtt-in" && n.type !== "mqtt-out",
      );
      if (clash)
        errors.push(
          `GPIO ${pin} is the I2C ${name} pin and also used by ${clash.label}.`,
        );
    }
    warnings.push(
      `I2C: connect SDA (GPIO ${first.sda}), SCL (GPIO ${first.scl}) and GND between the boards, with 4.7 kΩ pull-ups to 3.3 V on SDA and SCL. Keep wires short (under about 1 m).`,
    );
  }
  const local = radio(flow.nodes, "local");
  if (local.length) {
    const first = local[0].config;
    const differ = (key) =>
      local.some((n) => (n.config[key] || "") !== (first[key] || ""));
    if (differ("localPort") || differ("localUser") || differ("localPass"))
      errors.push(
        "A board runs one local MQTT broker: give all its Local MQTT Radio boxes the same port and login.",
      );
    if (
      first.localPort === 80 &&
      flow.nodes.some((n) => ["web-in", "web-out", "camera"].includes(n.type))
    )
      errors.push(
        "Local MQTT port 80 is taken by the board's web page (Web in/out, Camera): use another port, e.g. 1883.",
      );
    warnings.push(
      `Local MQTT: this board is the broker. Other boards and PCs connect to mqtt://<this board's IP>:${first.localPort}${first.localUser ? " with the login set here" : " (no login: anyone on the network can use it)"}; the address is printed on USB serial once WiFi is up. Give the board a fixed IP in your router so they always find it.`,
    );
  }
  const now = radio(flow.nodes, "espnow");
  if (new Set(now.map((n) => n.config.channel)).size > 1)
    errors.push("All ESP-NOW Radio boxes on one board need the same channel.");
  return { errors, warnings };
}
const includes = ({ espnow, i2c, local }) =>
  (espnow ? "#include <esp_now.h>\n#include <esp_wifi.h>\n" : "") +
  (i2c ? "#include <Wire.h>\n" : "") +
  (local
    ? "#include <sMQTTBroker.h>\n#include <vector>\n#include <string>\n"
    : "");
// Globals; dispatch functions hand received values to the matching Radio in boxes.
function globals(nodes, index, { net }) {
  const u = uses(nodes);
  const ins = (protocol) =>
    radio(nodes, protocol).filter((n) => n.type === "mqtt-in");
  let out = "";
  if (u.espnow) {
    const channel = radio(nodes, "espnow")[0].config.channel;
    out += `
// ── ESP-NOW radio (Radio in/out, protocol ESP-NOW) ──
const uint8_t MF_NOW_ALL[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
struct MfNowMsg { char topic[${MAX_TOPIC + 1}]; char payload[247]; };
const uint8_t MF_NOW_SLOTS = 8;
MfNowMsg mfNowQueue[MF_NOW_SLOTS];
volatile uint8_t mfNowHead = 0, mfNowTail = 0;
portMUX_TYPE mfNowMux = portMUX_INITIALIZER_UNLOCKED;
static void mfNowStore(const uint8_t* data, int len) {
  if (len < 4 || data[0] != 'M' || data[1] != 'F' || data[2] != 1) return;
  int tl = data[3], pl = len - 4 - tl;
  if (tl > ${MAX_TOPIC} || pl < 0 || pl > 246) return;
  portENTER_CRITICAL(&mfNowMux);
  uint8_t next = (mfNowHead + 1) % MF_NOW_SLOTS;
  if (next != mfNowTail) { // queue full: the newest message is dropped
    memcpy(mfNowQueue[mfNowHead].topic, data + 4, tl);
    mfNowQueue[mfNowHead].topic[tl] = 0;
    memcpy(mfNowQueue[mfNowHead].payload, data + 4 + tl, pl);
    mfNowQueue[mfNowHead].payload[pl] = 0;
    mfNowHead = next;
  }
  portEXIT_CRITICAL(&mfNowMux);
}
#if ESP_ARDUINO_VERSION_MAJOR >= 3
static void mfNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) { mfNowStore(data, len); }
#else
static void mfNowRecv(const uint8_t* mac, const uint8_t* data, int len) { mfNowStore(data, len); }
#endif
// Hands a message to every ESP-NOW Radio in box whose topic filter matches.
void mfNowDispatch(const char* topic, const String& payload) {
${
  ins("espnow")
    .map(
      (n) =>
        `  if (mqttTopicMatch(${cTopic(n.config.topic)}, topic)) node${index.get(n.id)}(payload);`,
    )
    .join("\n") || "  (void)topic; (void)payload;"
}
}
// Broadcasts topic + payload; this board's own Radio in boxes hear it on the next loop.
bool mfNowSend(const String& topic, const String& value) {
  uint8_t buf[250];
  size_t tl = topic.length() > ${MAX_TOPIC} ? ${MAX_TOPIC} : topic.length();
  size_t pl = value.length() > 246 - tl ? 246 - tl : value.length();
  buf[0] = 'M'; buf[1] = 'F'; buf[2] = 1; buf[3] = tl;
  memcpy(buf + 4, topic.c_str(), tl);
  memcpy(buf + 4 + tl, value.c_str(), pl);
  bool ok = esp_now_send(MF_NOW_ALL, buf, 4 + tl + pl) == ESP_OK;
  mfNowStore(buf, 4 + tl + pl); // queued, not called directly: no loops through a flow
  return ok;
}
void mfNowBegin() {
  if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
${
  net
    ? "  // Joined to the router: ESP-NOW uses the router's channel."
    : `  esp_wifi_set_channel(${channel}, WIFI_SECOND_CHAN_NONE); // no router: fixed channel`
}
  if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW: init failed"); return; }
  esp_now_register_recv_cb(mfNowRecv);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, MF_NOW_ALL, 6);
  peer.channel = 0; // the current channel
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}
`;
  }
  if (u.local) {
    const c = radio(nodes, "local")[0].config;
    out += `
// ── Local MQTT broker (Radio in/out, protocol Local MQTT): port ${c.localPort} ──
struct MfLocalMsg { std::string topic, payload; };
std::vector<MfLocalMsg> mfLocalQueue; // handled in loop(), oldest first
bool mfLocalUp = false;
class MfLocalBroker : public sMQTTBroker {
 public:
  bool onEvent(sMQTTEvent* event) override {
    switch (event->Type()) {${
      c.localUser
        ? `
      case NewClient_sMQTTEventType: {
        sMQTTNewClientEvent* e = (sMQTTNewClientEvent*)event;
        if (e->Login() != ${quoted(c.localUser)} || e->Password() != ${quoted(c.localPass || "")}) return false; // wrong login: refused
        break;
      }`
        : ""
    }
      case Public_sMQTTEventType: {
        sMQTTPublicClientEvent* e = (sMQTTPublicClientEvent*)event;
        if (mfLocalQueue.size() < 16) mfLocalQueue.push_back({e->Topic(), e->Payload()}); // else dropped
        break;
      }
      default:
        break;
    }
    return true;
  }
};
MfLocalBroker mfLocal;
// Publishes on this board's broker; its own Radio in boxes hear it on the next loop.
void mfLocalPublish(const String& topic, const String& value, bool retain) {
  if (mfLocalUp) mfLocal.publish(topic.c_str(), value.c_str(), 0, retain);
  if (mfLocalQueue.size() < 16) mfLocalQueue.push_back({topic.c_str(), value.c_str()});
}
// Hands a message to every Local MQTT Radio in box whose topic filter matches.
void mfLocalDispatch(const char* topic, const String& payload) {
${
  ins("local")
    .map(
      (n) =>
        `  if (mqttTopicMatch(${cTopic(n.config.topic)}, topic)) node${index.get(n.id)}(payload);`,
    )
    .join("\n") || "  (void)topic; (void)payload;"
}
}
`;
  }
  if (u.i2c === "controller")
    out += `
// ── I2C radio, controller (Radio in/out, protocol I2C) ──
bool mfI2cWrite(uint8_t address, const String& value) {
  Wire.beginTransmission(address);
  Wire.write((const uint8_t*)value.c_str(), value.length() > ${MAX_I2C} ? ${MAX_I2C} : value.length());
  return Wire.endTransmission() == 0;
}
// Reads a peripheral's reply: text up to a 0 byte (or 0xFF when nothing is sent).
String mfI2cRead(uint8_t address) {
  String v;
  if (Wire.requestFrom((int)address, (int)${MAX_I2C}) == 0) return v;
  while (Wire.available()) {
    int c = Wire.read();
    if (c <= 0 || c == 255) { while (Wire.available()) Wire.read(); break; }
    v += (char)c;
  }
  return v;
}
`;
  if (u.i2c === "peripheral")
    out += `
// ── I2C radio, peripheral (Radio in/out, protocol I2C) ──
// Wire callbacks run in their own task: values cross over under a lock.
char mfI2cIn[${MAX_I2C + 1}];
char mfI2cOut[${MAX_I2C + 1}] = "";
volatile bool mfI2cGot = false;
portMUX_TYPE mfI2cMux = portMUX_INITIALIZER_UNLOCKED;
void mfI2cOnReceive(int len) {
  char buf[${MAX_I2C + 1}];
  int n = 0;
  while (Wire.available()) { int c = Wire.read(); if (n < ${MAX_I2C}) buf[n++] = (char)c; }
  buf[n] = 0;
  portENTER_CRITICAL(&mfI2cMux);
  memcpy(mfI2cIn, buf, n + 1);
  mfI2cGot = true;
  portEXIT_CRITICAL(&mfI2cMux);
}
void mfI2cOnRequest() {
  char buf[${MAX_I2C + 1}];
  portENTER_CRITICAL(&mfI2cMux);
  memcpy(buf, mfI2cOut, sizeof(buf));
  portEXIT_CRITICAL(&mfI2cMux);
  Wire.write((const uint8_t*)buf, strlen(buf) + 1); // the 0 ends the text
}
void mfI2cReply(const String& value) {
  portENTER_CRITICAL(&mfI2cMux);
  strncpy(mfI2cOut, value.c_str(), ${MAX_I2C});
  mfI2cOut[${MAX_I2C}] = 0;
  portEXIT_CRITICAL(&mfI2cMux);
}
`;
  return out;
}
function setup(nodes) {
  const i2c = radio(nodes, "i2c");
  if (!i2c.length) return [];
  const c = i2c[0].config;
  return c.i2cRole === "peripheral"
    ? [
        "Wire.onReceive(mfI2cOnReceive);",
        "Wire.onRequest(mfI2cOnRequest);",
        `Wire.begin((uint8_t)${c.address}, ${c.sda}, ${c.scl}, 100000); // I2C peripheral`,
      ]
    : [`Wire.begin(${c.sda}, ${c.scl}); // I2C controller`];
}
// Loop code: ESP-NOW start + queue, I2C polls (controller) or received values.
function loop(nodes, index) {
  const lines = [];
  if (uses(nodes).espnow)
    lines.push(
      "{ static bool begun = false; if (!begun) { begun = true; mfNowBegin(); } }",
      "while (mfNowTail != mfNowHead) { MfNowMsg m; portENTER_CRITICAL(&mfNowMux); m = mfNowQueue[mfNowTail]; mfNowTail = (mfNowTail + 1) % MF_NOW_SLOTS; portEXIT_CRITICAL(&mfNowMux); mfNowDispatch(m.topic, String(m.payload)); }",
    );
  if (uses(nodes).local) {
    const port = radio(nodes, "local")[0].config.localPort;
    lines.push(
      `if (!mfLocalUp && WiFi.status() == WL_CONNECTED) { mfLocal.init(${port}); mfLocalUp = true; Serial.println(String("Local MQTT broker: mqtt://") + WiFi.localIP().toString() + ":${port}"); }`,
      "if (mfLocalUp) mfLocal.update();",
      "if (!mfLocalQueue.empty()) { std::vector<MfLocalMsg> q; q.swap(mfLocalQueue); for (auto& m : q) mfLocalDispatch(m.topic.c_str(), String(m.payload.c_str())); }",
    );
  }
  const i2cIn = radio(nodes, "i2c").filter((n) => n.type === "mqtt-in");
  if (uses(nodes).i2c === "controller")
    for (const n of i2cIn) {
      const i = index.get(n.id);
      lines.push(
        `{ static unsigned long t${i} = 0; static String last${i}; if (millis() - t${i} >= ${n.config.interval}UL) { t${i} = millis(); String v = mfI2cRead(${n.config.address}); if (v.length() && v != last${i}) { last${i} = v; node${i}(v); } } }`,
      );
    }
  if (uses(nodes).i2c === "peripheral" && i2cIn.length)
    lines.push(
      `if (mfI2cGot) { char buf[${MAX_I2C + 1}]; portENTER_CRITICAL(&mfI2cMux); memcpy(buf, mfI2cIn, sizeof(buf)); mfI2cGot = false; portEXIT_CRITICAL(&mfI2cMux); String v(buf); ${i2cIn.map((n) => `node${index.get(n.id)}(v);`).join(" ")} }`,
    );
  return lines;
}
module.exports = {
  uses,
  check,
  includes,
  globals,
  setup,
  loop,
  MAX_I2C,
  LIBRARY,
};
