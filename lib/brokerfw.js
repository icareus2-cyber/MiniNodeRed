// Firmware that turns an ESP32-family board into this network's MQTT broker
// (sMQTTBroker library: MQTT 3.1.1, QoS 0, retained messages kept in RAM).
// Other boards and the IDE connect to it instead of a public broker. It answers
// "mf?" on USB serial with the usual MF:{…} status line (plus "broker":1), so the
// board check and the chip status card work as for flow firmware.
//
// Heartbeat: the broker announces itself like a Microflow board (retained
// microflow/<id>/status "online", telemetry every heartbeat interval, ping → pong),
// so it shows in Devices and passes the broker round-trip check. sMQTTBroker drops
// clients that miss their MQTT keep-alive (1.5 × the client's interval) but ignores
// Last Will messages, so the broker publishes a Microflow board's "offline" itself
// when that board's connection ends.
//
// Boards with a screen (TTGO T-Display's LCD, a built-in OLED, or an I2C OLED wired
// to the board's I2C pins and found at start-up) show the broker's address, clients
// and traffic at reset and when a button is pressed, then turn the screen off.
const { createHash } = require("node:crypto");
const { quoted } = require("./nodes");
const { boards, i2cPins } = require("./boards");
const displayfw = require("./displayfw");
const LIBRARY = "sMQTTBroker";
const HOSTNAME = "microflow-broker"; // mDNS: microflow-broker.local
const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Buttons that wake the screen: active-low pins listed in the board's notes.
// Boards not listed use their BOOT button (GPIO 0, or 9 on the ESP32-C3 / C6).
const BUTTONS = { "ttgo-t-display": [0, 35] };
const int = (raw, fallback, min, max, name) => {
  const v = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max)
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  return v;
};
// Validates and normalises broker settings; throws a readable error.
function checkBroker(raw = {}) {
  const board = boards[raw.board];
  if (!board || board.family !== "esp32" || board.wifi === false)
    throw Error("Choose an ESP32-family board (ESP32, ESP32-S3, ESP32-C3).");
  const ssid = String(raw.ssid || "");
  if (!ssid) throw Error("Enter the WiFi SSID in the Device panel first.");
  if (ssid.length > 32 || String(raw.password || "").length > 64)
    throw Error("WiFi SSID or password is too long.");
  const port = int(raw.port, 1883, 1, 65535, "Broker port");
  const username = String(raw.username || "");
  const password = String(raw.brokerPassword || "");
  if (username.length > 64 || password.length > 64)
    throw Error("Broker username and password are limited to 64 characters.");
  if (password && !username)
    throw Error("A broker password needs a username too.");
  const fixed = String(raw.staticIp || "").trim();
  let net = null;
  if (fixed) {
    const gateway = String(raw.gateway || "").trim();
    const subnet = String(raw.subnet || "255.255.255.0").trim();
    for (const [name, v] of [
      ["Fixed IP", fixed],
      ["Gateway", gateway],
      ["Subnet mask", subnet],
    ])
      if (!ipv4.test(v)) throw Error(`${name} must be an IPv4 address.`);
    net = { ip: fixed, gateway, subnet };
  }
  return {
    board: raw.board,
    ssid,
    password: String(raw.password || ""),
    port,
    username,
    brokerPassword: password,
    net,
    heartbeat: int(raw.heartbeat, 30, 5, 3600, "Heartbeat interval (s)"),
    // Screen on time after reset or a button press; 0 = always on.
    screenSeconds: int(raw.screenSeconds, 60, 0, 3600, "Screen on time (s)"),
    // Boards without a screen: use a 128×64 I2C OLED if one is connected.
    oled: raw.oled !== false,
  };
}
// Identifies the broker firmware; secrets are not part of it.
const board = (s) => boards[s.board];
const buildId = (s) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "broker",
        s.board,
        s.ssid,
        s.port,
        s.username,
        s.net,
        s.heartbeat,
        s.screenSeconds,
        ...(board(s).display || !s.oled ? [] : ["oled"]), // (older IDs stay the same)
      ]),
    )
    .digest("hex")
    .slice(0, 10);
const ipList = (ip) => ip.split(".").join(", ");
// The broker's screen: the board's own display, or else (when "oled" is on) a 128×64
// I2C OLED on the board's usual I2C pins, used only if one answers at start-up.
function screenOf(board, s) {
  if (board.display) return board.display;
  if (!s.oled) return null;
  const { sda, scl } = i2cPins(s.board);
  return {
    driver: "ssd1306",
    width: 128,
    height: 64,
    builtIn: false,
    pins: { sda, scl, rst: -1, vext: -1 },
  };
}
// Buttons that wake the screen (active low): the board's own, else its BOOT button.
function buttonsOf(board, s) {
  if (BUTTONS[s.board]) return BUTTONS[s.board];
  return /esp32c[36]/.test(board.fqbn) ? [9] : [0];
}
// Screen code: address, clients and traffic at reset, when a button is pressed and
// when WiFi comes or goes; then the screen turns off (backlight, or OLED off).
function screen(board, s, d) {
  const buttons = buttonsOf(board, s);
  const small = displayfw.isOled(d); // 21 characters a row, one text size
  const tft = !small;
  return {
    globals: `${displayfw.globals(d)}
const uint8_t MF_BUTTONS[] = { ${buttons.join(", ") || "255"} };
bool mfScreenOn = false;
unsigned long mfScreenSince = 0, mfScreenDrawn = 0;
// Address, clients and traffic; rows that did not change are not redrawn.
String mfRows[7];
void mfRow(uint8_t row, uint8_t size, uint16_t color, const String& text) {
  if (mfRows[row] == text) return;
  mfRows[row] = text;
${tft ? `  // Clear the whole row band: the text size of a row can change (URL row).
  mfTft.fillRect(0, 2 + row * ${displayfw.ROW_HEIGHT}, mfTft.width(), ${displayfw.ROW_HEIGHT}, ST77XX_BLACK);
` : ""}  mfLcd(row, size, color, text);
}
// Large text when it fits the 240 px row (19 characters), else small (39).
uint8_t mfFit(const String& text) { return ${tft ? "text.length() <= 19 ? 2 : 1" : "1"}; }
void mfScreenDraw() {
  mfRow(0, 2, ST77XX_CYAN, "MQTT BROKER");
  if (WiFi.status() != WL_CONNECTED) {
    mfRow(1, 2, ST77XX_YELLOW, mfStarted ? "WiFi lost..." : "Joining WiFi...");
    mfRow(2, mfFit(MF_SSID), ST77XX_WHITE, MF_SSID);
    for (uint8_t r = 3; r < 7; r++) mfRow(r, 1, ST77XX_WHITE, "");
    return;
  }
  unsigned long up = millis() / 1000;
${
  small
    ? `  // Small screen: the address clients use (IP:port) and the mDNS name.
  mfRow(1, 1, ST77XX_GREEN, WiFi.localIP().toString() + ":" + MF_PORT);
  mfRow(2, 1, ST77XX_GREEN, "${HOSTNAME}.local");
  mfRow(3, 1, ST77XX_WHITE, String("Clients ") + broker.clients + (${s.username ? "true" : "false"} ? " login" : " open"));
  mfRow(4, 1, ST77XX_WHITE, String("Msgs ") + broker.messages);
  mfRow(5, 1, ST77XX_WHITE, String("WiFi ") + WiFi.RSSI() + " dBm");
  mfRow(6, 1, ST77XX_WHITE, String("Up ") + (up / 3600) + "h " + ((up / 60) % 60) + "m");`
    : `  // The address clients use, e.g. mqtt://192.168.1.50:1883, and its mDNS name.
  String url = String("mqtt://") + WiFi.localIP().toString() + ":" + MF_PORT;
  mfRow(1, mfFit(url), ST77XX_GREEN, url);
  mfRow(2, 1, ST77XX_GREEN, String("mqtt://${HOSTNAME}.local:") + MF_PORT);
  mfRow(3, 2, ST77XX_WHITE, String("Clients ") + broker.clients + (${s.username ? "true" : "false"} ? "  login" : "  open"));
  mfRow(4, 2, ST77XX_WHITE, String("Msgs ") + broker.messages);
  mfRow(5, 1, ST77XX_WHITE, String("WiFi ") + MF_SSID + "  " + WiFi.RSSI() + " dBm");
  mfRow(6, 1, ST77XX_WHITE, String("Up ") + (up / 3600) + "h " + ((up / 60) % 60) + "m  " + mfId);`
}
}
void mfScreenWake() {
  if (!mfLcdFound) return;
  if (!mfScreenOn) {
    for (uint8_t r = 0; r < 7; r++) mfRows[r] = "\\x01"; // force a full redraw
    mfLcdClear();
    mfLcdPower(true);
  }
  mfScreenOn = true;
  mfScreenSince = millis();
  mfScreenDraw();
}
void mfScreenLoop() {
  if (!mfLcdFound) return; // no screen (an I2C OLED is optional)
  static bool was[sizeof(MF_BUTTONS)];
  static bool wifi = false;
  for (size_t i = 0; i < sizeof(MF_BUTTONS); i++) {
    if (MF_BUTTONS[i] == 255) continue;
    bool down = digitalRead(MF_BUTTONS[i]) == LOW;
    if (down && !was[i]) mfScreenWake(); // press: show the details
    was[i] = down;
  }
  bool now = WiFi.status() == WL_CONNECTED;
  if (now != wifi) { wifi = now; mfScreenWake(); } // joined or lost WiFi
  mfLcdFlush();
  if (!mfScreenOn) return;
${
  s.screenSeconds
    ? `  if (millis() - mfScreenSince >= ${s.screenSeconds}000UL) { mfScreenOn = false; mfLcdPower(false); return; } // screen off
`
    : ""
}  if (millis() - mfScreenDrawn >= 1000UL) { mfScreenDrawn = millis(); mfScreenDraw(); }
}
`,
    setup: `${displayfw.setup(d)}
  for (size_t i = 0; i < sizeof(MF_BUTTONS); i++) if (MF_BUTTONS[i] != 255) pinMode(MF_BUTTONS[i], MF_BUTTONS[i] >= 34 && MF_BUTTONS[i] <= 39 ? INPUT : INPUT_PULLUP);
  mfScreenWake();`,
  };
}
function generate(raw) {
  const s = checkBroker(raw);
  const board = boards[s.board];
  const build = buildId(s);
  const auth = !!s.username;
  const d = screenOf(board, s);
  const lcd = d ? screen(board, s, d) : null;
  const source = `// Microflow MQTT broker for ${board.label} (generated, build ${build}).
// Clients connect to mqtt://<this board's IP>:${s.port}${auth ? " with the username and password set in Microflow" : " (no login)"}.
#include <WiFi.h>
#include <ESPmDNS.h>
#include <sMQTTBroker.h>
#include <map>
#include <vector>
${d ? displayfw.includesFor(d) : ""}
const char* MF_BUILD = ${quoted(build)};
const char* MF_SSID = ${quoted(s.ssid)};
const char* MF_PASS = ${quoted(s.password)};
const uint16_t MF_PORT = ${s.port};
${auth ? `const char* MF_USER = ${quoted(s.username)};\nconst char* MF_USER_PASS = ${quoted(s.brokerPassword)};\n` : ""}String mfId, mfBase; // broker-xxxxxx, microflow/broker-xxxxxx
bool mfStarted = false;

// Publishes made from broker events are queued and sent from loop().
struct MfOut { std::string topic, payload; bool retain; };
std::vector<MfOut> mfOut;
// Microflow boards announce "online" on their status topic: client ID → topic,
// so "offline" can be published when the connection ends (no Last Will support).
std::map<std::string, std::string> mfStatus;
static bool mfIsStatus(const std::string& t) {
  return t.rfind("microflow/", 0) == 0 && t.size() > 17 && t.compare(t.size() - 7, 7, "/status") == 0;
}

class MfBroker : public sMQTTBroker {
 public:
  long clients = 0;
  unsigned long messages = 0;
  bool onEvent(sMQTTEvent* event) override {
    switch (event->Type()) {
      case NewClient_sMQTTEventType: {
${
  auth
    ? `        sMQTTNewClientEvent* e = (sMQTTNewClientEvent*)event;
        if (e->Login() != MF_USER || e->Password() != MF_USER_PASS) return false; // wrong login: refused
`
    : ""
}        clients++;
        break;
      }
      case RemoveClient_sMQTTEventType: {
        if (clients > 0) clients--;
        sMQTTRemoveClientEvent* e = (sMQTTRemoveClientEvent*)event;
        auto it = mfStatus.find(e->Client()->getClientId());
        if (it != mfStatus.end()) { // a Microflow board left: tell the others
          mfOut.push_back({it->second, "offline", true});
          mfStatus.erase(it);
        }
        break;
      }
      case Public_sMQTTEventType: {
        messages++;
        sMQTTPublicClientEvent* e = (sMQTTPublicClientEvent*)event;
        std::string topic = e->Topic(), payload = e->Payload();
        if (mfIsStatus(topic)) {
          if (payload == "online") mfStatus[e->Client()->getClientId()] = topic;
          else if (payload == "offline") mfStatus.erase(e->Client()->getClientId());
        }
        // Same ping/pong contract as Microflow firmware (broker round-trip check).
        if (topic == std::string((mfBase + "/ping").c_str()))
          mfOut.push_back({std::string((mfBase + "/pong").c_str()), payload + " " + MF_BUILD + " no-ota", false});
        break;
      }
      case LostConnect_sMQTTEventType:
        WiFi.reconnect();
        break;
    }
    return true;
  }
};
MfBroker broker;
${lcd ? lcd.globals : ""}
// Heartbeat: the same telemetry as Microflow boards, so the broker shows in Devices.
void mfHeartbeat() {
  String t = String("{\\"uptime\\":") + (millis() / 1000) + ",\\"heap\\":" + ESP.getFreeHeap() + ",\\"rssi\\":" + WiFi.RSSI() +
    ",\\"ip\\":\\"" + WiFi.localIP().toString() + "\\",\\"build\\":\\"" + MF_BUILD + "\\",\\"board\\":\\"${s.board}\\",\\"ota\\":0,\\"flow\\":\\"MQTT broker\\"" +
    ",\\"broker\\":1,\\"port\\":" + MF_PORT + ",\\"login\\":${s.username ? 1 : 0},\\"clients\\":" + broker.clients + ",\\"messages\\":" + broker.messages + "}";
  broker.publish((mfBase + "/telemetry").c_str(), t.c_str());
}
// Answers "mf?" with the status line the IDE reads (board check, chip status card).
void mfReport() {
  Serial.println(String("MF:{\\"build\\":\\"") + MF_BUILD + "\\",\\"id\\":\\"" + mfId + "\\",\\"wifi\\":" + (int)WiFi.status() +
    ",\\"mqtt\\":" + (mfStarted ? 0 : -1) + ",\\"ip\\":\\"" + WiFi.localIP().toString() + "\\",\\"rssi\\":" + WiFi.RSSI() +
    ",\\"heap\\":" + ESP.getFreeHeap() + ",\\"uptime\\":" + (millis() / 1000) + ",\\"ota\\":0,\\"net\\":1,\\"broker\\":1,\\"port\\":" + MF_PORT +
    ",\\"clients\\":" + broker.clients + ",\\"messages\\":" + broker.messages + ",\\"heartbeat\\":${s.heartbeat},\\"login\\":${s.username ? 1 : 0}}");
}
void mfSerialPoll() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 10 || c == 13) {
      if (line == "mf?") mfReport();
      line = "";
    } else if (line.length() < 32) line += c;
  }
}

void setup() {
  Serial.begin(115200);
  char id[24];
  snprintf(id, sizeof(id), "broker-%06lx", (unsigned long)(ESP.getEfuseMac() & 0xFFFFFF));
  mfId = id;
  mfBase = String("microflow/") + mfId;
${lcd ? lcd.setup + "\n" : ""}  WiFi.mode(WIFI_STA);
  WiFi.setHostname(${quoted(HOSTNAME)});
${
  s.net
    ? `  // Fixed address, so boards built for this broker always find it.
  WiFi.config(IPAddress(${ipList(s.net.ip)}), IPAddress(${ipList(s.net.gateway)}), IPAddress(${ipList(s.net.subnet)}), IPAddress(${ipList(s.net.gateway)}));
`
    : ""
}  WiFi.begin(MF_SSID, MF_PASS);
  Serial.println("Microflow MQTT broker: joining WiFi…");
}

void loop() {
  mfSerialPoll();
  if (!mfStarted && WiFi.status() == WL_CONNECTED) {
    broker.init(MF_PORT);
    if (MDNS.begin(${quoted(HOSTNAME)})) MDNS.addService("mqtt", "tcp", MF_PORT);
    mfStarted = true;
    broker.publish((mfBase + "/status").c_str(), "online", 0, true);
    Serial.println(String("Microflow MQTT broker ready: mqtt://") + WiFi.localIP().toString() + ":" + MF_PORT + " (${HOSTNAME}.local)");
  }
  if (mfStarted) {
    broker.update();
    for (auto& m : mfOut) broker.publish(m.topic, m.payload, 0, m.retain);
    mfOut.clear();
    static unsigned long beat = 0;
    if (beat == 0 || millis() - beat >= ${s.heartbeat}000UL) { beat = millis() | 1; mfHeartbeat(); }
  }
${lcd ? "  mfScreenLoop();\n" : ""}}
`;
  return {
    source,
    build,
    fqbn: board.fqbn,
    settings: s,
    // Arduino libraries to install before compiling.
    libraries: [LIBRARY, ...(d ? displayfw.libraries(d) : [])],
  };
}
module.exports = { generate, checkBroker, LIBRARY, HOSTNAME, BUTTONS };
