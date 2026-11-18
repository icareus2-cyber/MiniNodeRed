// Bluetooth LE link firmware (ESP32 family only), used by the BLE in / BLE out nodes.
// Connectionless: BLE out broadcasts each message as a non-connectable advertisement
// for BURST_MS; every board scanning for the same link name receives it. No pairing,
// no roles, and any number of boards can share a link. Advertisement payload:
//   flags (3 B) + manufacturer data: FF FF | link id (3 B) | sequence (1 B) | value (≤ 20 B)
// The library callback runs in the BLE task, so received values are queued and the
// flow runs from loop(), like every other source.
const MAX_PAYLOAD = 20;
const BURST_MS = 250;
const QUEUE = 8;

// 3-byte link id: FNV-1a of the link name. Bytes are kept non-zero.
function linkId(name) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from("microflow-ble:" + name, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255].map((b) => b || 1);
}
const hex = (b) => "0x" + b.toString(16).padStart(2, "0");
// C++ arguments for mfBleSend: the link's id bytes.
const sendArgs = (name) => linkId(name).map(hex).join(", ");

// Distinct link names in node order; their index is used in the generated code.
const links = (nodes) => [
  ...new Set(
    nodes
      .filter((n) => n.type === "ble-in" || n.type === "ble-out")
      .map((n) => n.config.link),
  ),
];
const uses = (nodes) => links(nodes).length > 0;

const includes = "#include <BLEDevice.h>\n";

function globals(nodes, index) {
  const all = links(nodes.filter((n) => n.type === "ble-in"));
  const receive = nodes.some((n) => n.type === "ble-in");
  const send = nodes.some((n) => n.type === "ble-out");
  const table = all
    .map((l) => `  {${linkId(l).map(hex).join(", ")}}, // ${l}`)
    .join("\n");
  const dispatch = nodes
    .filter((n) => n.type === "ble-in")
    .map(
      (n) =>
        `    if (m.link == ${all.indexOf(n.config.link)}) node${index.get(n.id)}(v);`,
    )
    .join("\n");
  return `// Bluetooth LE link (connectionless advertising)
${
  send
    ? `struct MfBleOut { uint8_t id[3]; String value; };
MfBleOut mfBleOut[${QUEUE}];
uint8_t mfBleOutHead = 0, mfBleOutCount = 0, mfBleSeq = 1;
// Queues a value; each one is advertised for ${BURST_MS} ms in turn. A full queue drops the oldest.
void mfBleSend(uint8_t a, uint8_t b, uint8_t c, const String& value) {
  if (mfBleOutCount == ${QUEUE}) { mfBleOutHead = (mfBleOutHead + 1) % ${QUEUE}; mfBleOutCount--; }
  MfBleOut& o = mfBleOut[(mfBleOutHead + mfBleOutCount++) % ${QUEUE}];
  o.id[0] = a; o.id[1] = b; o.id[2] = c;
  o.value = value.substring(0, ${MAX_PAYLOAD});
}
void mfBleAdvertise() {
  static bool on = false;
  static unsigned long since = 0;
  if (on && millis() - since < ${BURST_MS}UL) return;
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  if (on) { adv->stop(); on = false; }
  if (!mfBleOutCount) return;
  MfBleOut& o = mfBleOut[mfBleOutHead];
  mfBleOutHead = (mfBleOutHead + 1) % ${QUEUE};
  mfBleOutCount--;
  if (++mfBleSeq == 0) mfBleSeq = 1;
  String m;
  m.reserve(6 + o.value.length());
  m += (char)0xFF; m += (char)0xFF; // company ID 0xFFFF: no company (testing)
  for (int i = 0; i < 3; i++) m += (char)o.id[i];
  m += (char)mfBleSeq;
  m += o.value;
  BLEAdvertisementData data;
  data.setFlags(0x04); // BLE only, not discoverable
  data.setManufacturerData(m);
  adv->setAdvertisementData(data);
  adv->start();
  on = true;
  since = millis();
}
`
    : ""
}${
    receive
      ? `const uint8_t MF_BLE_LINK[][3] = {
${table}
};
struct MfBleMsg { uint8_t link; uint8_t len; char data[${MAX_PAYLOAD}]; };
QueueHandle_t mfBleQueue;
volatile bool mfBleScanDone = true;
void mfBleScanEnd(BLEScanResults) { mfBleScanDone = true; }
class MfBleScan : public BLEAdvertisedDeviceCallbacks {
  // Last sequence number per sender: each message is heard many times during its burst.
  struct Seen { uint8_t mac[6]; uint8_t seq; };
  Seen seen[8] = {};
  uint8_t next = 0;
  void onResult(BLEAdvertisedDevice d) override {
    if (!d.haveManufacturerData()) return;
    String m = d.getManufacturerData();
    const uint8_t* p = (const uint8_t*)m.c_str();
    if (m.length() < 6 || m.length() > ${6 + MAX_PAYLOAD} || p[0] != 0xFF || p[1] != 0xFF) return;
    for (uint8_t k = 0; k < sizeof(MF_BLE_LINK) / 3; k++) {
      if (memcmp(p + 2, MF_BLE_LINK[k], 3)) continue;
      BLEAddress address = d.getAddress();
      const uint8_t* mac = address.getNative();
      Seen* s = nullptr;
      for (Seen& e : seen) if (!memcmp(e.mac, mac, 6)) s = &e;
      if (s && s->seq == p[5]) return; // already delivered
      if (!s) { s = &seen[next]; next = (next + 1) % 8; memcpy(s->mac, mac, 6); }
      s->seq = p[5];
      MfBleMsg msg;
      msg.link = k;
      msg.len = m.length() - 6;
      memcpy(msg.data, p + 6, msg.len);
      xQueueSend(mfBleQueue, &msg, 0);
      return;
    }
  }
};
void mfBleReceive() {
  BLEScan* scan = BLEDevice::getScan();
  // Scan in 30 s rounds and clear the stored results between them, so nearby
  // devices do not slowly fill the heap.
  if (mfBleScanDone) { mfBleScanDone = false; scan->clearResults(); scan->start(30, mfBleScanEnd, false); }
  MfBleMsg m;
  while (xQueueReceive(mfBleQueue, &m, 0) == pdTRUE) {
    String v;
    v.reserve(m.len);
    for (uint8_t i = 0; i < m.len; i++) v += m.data[i];
${dispatch}
  }
}
`
      : ""
  }`;
}

// Runs before WiFi starts. With WiFi on, the scan listens half the time so WiFi keeps its share of the radio.
function setup(nodes, net) {
  const receive = nodes.some((n) => n.type === "ble-in");
  const send = nodes.some((n) => n.type === "ble-out");
  return [
    'BLEDevice::init("");',
    send &&
      `{ BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->setScanResponse(false);
#if defined(CONFIG_NIMBLE_ENABLED)
    adv->setAdvertisementType(BLE_GAP_CONN_MODE_NON);
#else
    adv->setAdvertisementType(ADV_TYPE_NONCONN_IND);
#endif
    adv->setMinInterval(0x20); // 20 ms (units of 0.625 ms)
    adv->setMaxInterval(0x30);
    mfBleSeq = esp_random(); } // a rebooted sender must not repeat the sequence receivers saw last`,
    receive &&
      `mfBleQueue = xQueueCreate(${QUEUE}, sizeof(MfBleMsg));
  { BLEScan* scan = BLEDevice::getScan();
    scan->setAdvertisedDeviceCallbacks(new MfBleScan(), true); // true: report every advertisement
    scan->setActiveScan(false);
    scan->setInterval(100);
    scan->setWindow(${net ? 50 : 99}); }`,
  ].filter(Boolean);
}

const loop = (nodes) =>
  [
    nodes.some((n) => n.type === "ble-out") && "mfBleAdvertise();",
    nodes.some((n) => n.type === "ble-in") && "mfBleReceive();",
  ].filter(Boolean);

module.exports = {
  MAX_PAYLOAD,
  BURST_MS,
  linkId,
  sendArgs,
  links,
  uses,
  includes,
  globals,
  setup,
  loop,
};
