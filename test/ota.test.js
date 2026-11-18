const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createHmac, randomBytes } = require("node:crypto");
const mqtt = require("mqtt");
const aedes = require("aedes");
const ota = require("../lib/ota");
const { OTA_CHUNK } = require("../lib/otafw");
const { openStore } = require("../lib/store");
let broker, tcp, url;
before(async () => {
  broker = aedes();
  tcp = net.createServer(broker.handle);
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  url = `mqtt://127.0.0.1:${tcp.address().port}`;
});
after(async () => {
  await new Promise((r) => tcp.close(r));
  await new Promise((r) => broker.close(r));
});
// Line-by-line port of mfChacha() from lib/otafw.js.
function chachaBlock(key, counter, nonce) {
  const le32 = (b, o) => b.readUInt32LE(o);
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = le32(key, 4 * i);
  s[12] = counter;
  s[13] = le32(nonce, 0);
  s[14] = le32(nonce, 4);
  s[15] = le32(nonce, 8);
  const x = Uint32Array.from(s);
  const rotl = (a, b) => ((a << b) | (a >>> (32 - b))) >>> 0;
  const qr = (a, b, c, d) => {
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 16);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 8);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, 4 * i);
  return out;
}
const decrypt = (key, nonce, data, offset) => {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 64) {
    const ks = chachaBlock(key, (offset + i) / 64, nonce);
    for (let j = 0; j < 64 && i + j < out.length; j++) out[i + j] ^= ks[j];
  }
  return out;
};
test("the firmware's ChaCha20 matches OpenSSL (RFC 8439)", () => {
  const key = randomBytes(32),
    nonce = randomBytes(12);
  const image = randomBytes(5 * OTA_CHUNK + 123);
  const cipher = ota.encrypt(image, key, nonce);
  // Decrypting chunk by chunk with the firmware algorithm restores the image.
  const parts = [];
  for (let o = 0; o < cipher.length; o += OTA_CHUNK)
    parts.push(decrypt(key, nonce, cipher.subarray(o, o + OTA_CHUNK), o));
  assert.deepEqual(Buffer.concat(parts), image);
  assert.equal(OTA_CHUNK % 64, 0, "chunks start on keystream blocks");
});
// A board speaking the firmware's OTA protocol (see mfOtaMessage in lib/otafw.js).
async function fakeBoard(id, keys, { drop = () => false } = {}) {
  const c = mqtt.connect(url);
  await new Promise((r) => c.once("connect", r));
  await new Promise((r) => c.subscribe(`microflow/${id}/ota/+`, r));
  const board = { flashed: null, errors: [] };
  let st = null;
  const reply = (t) => c.publish(`microflow/${id}/ota-ack`, t);
  c.on("message", (topic, payload) => {
    const kind = topic.split("/").at(-1);
    if (kind === "begin") {
      const [size, nonceHex] = payload.toString().split(" ");
      const challenge = randomBytes(16).toString("hex");
      const nonce = Buffer.from(nonceHex, "hex");
      st = {
        size: +size,
        next: 0,
        nonce,
        parts: [],
        held: null,
        mac: createHmac("sha256", keys.mac).update(challenge).update(nonce),
      };
      reply("ready " + challenge);
    } else if (kind === "data" && st) {
      if (drop()) return; // simulate a lost packet
      const offset = payload.readUInt32LE(0),
        data = payload.subarray(4);
      if (offset !== st.next) return reply("next " + st.next);
      st.mac.update(data);
      if (offset + data.length === st.size) st.held = data;
      else st.parts.push(decrypt(keys.enc, st.nonce, data, offset));
      st.next += data.length;
      reply("next " + st.next);
    } else if (kind === "end" && st) {
      if (payload.toString() !== st.mac.digest("hex")) {
        board.errors.push("mismatch");
        st = null;
        return reply(
          "error signature mismatch (built with another project key?)",
        );
      }
      st.parts.push(
        decrypt(keys.enc, st.nonce, st.held, st.size - st.held.length),
      );
      board.flashed = Buffer.concat(st.parts);
      st = null;
      reply("done");
    }
  });
  board.close = () => new Promise((r) => c.end(true, r));
  return board;
}
const keysOf = () => ({ enc: randomBytes(32), mac: randomBytes(32), lan: "x" });
test(
  "over-MQTT update delivers the exact image, even with lost packets",
  { timeout: 30000 },
  async () => {
    const keys = keysOf();
    let n = 0;
    const board = await fakeBoard("ota-1", keys, { drop: () => ++n % 7 === 3 });
    try {
      const image = randomBytes(40 * OTA_CHUNK + 17);
      const progress = [];
      const r = await ota.overMqtt({
        broker: { url },
        deviceId: "ota-1",
        image,
        keys,
        onProgress: (done) => progress.push(done),
        timeouts: { stall: 300 },
      });
      assert.deepEqual(board.flashed, image);
      assert.equal(r.bytes, image.length);
      assert.equal(progress.at(-1), image.length);
    } finally {
      await board.close();
    }
  },
);
test(
  "a board built with another project key rejects the update",
  { timeout: 15000 },
  async () => {
    const board = await fakeBoard("ota-2", keysOf());
    try {
      await assert.rejects(
        ota.overMqtt({
          broker: { url },
          deviceId: "ota-2",
          image: randomBytes(2000),
          keys: keysOf(),
        }),
        /signature mismatch/,
      );
      assert.equal(board.flashed, null, "nothing committed");
    } finally {
      await board.close();
    }
  },
);
test(
  "an offline board or bad target fails with advice",
  { timeout: 15000 },
  async () => {
    await assert.rejects(
      ota.overMqtt({
        broker: { url },
        deviceId: "nobody",
        image: randomBytes(100),
        keys: keysOf(),
        timeouts: { ready: 300 },
      }),
      /did not answer the update request.*first install must be over USB/,
    );
    await assert.rejects(
      ota.overMqtt({
        broker: { url },
        deviceId: "",
        image: Buffer.alloc(1),
        keys: keysOf(),
      }),
      /Device ID/,
    );
    assert.throws(
      () =>
        ota.overLan({ ip: "nope", family: "esp8266", bin: "x", password: "p" }),
      /IP address/,
    );
  },
);
test("project keys are stable, derived per purpose and never exposed as settings", () => {
  const store = openStore(":memory:");
  try {
    const a = ota.projectKeys(store),
      b = ota.projectKeys(store);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.enc, a.mac);
    assert.match(a.lan, /^[0-9a-f]{32}$/);
    store.saveSettings({ ssid: "lab" });
    assert.deepEqual(store.getSettings(), { ssid: "lab" });
  } finally {
    store.close();
  }
});
