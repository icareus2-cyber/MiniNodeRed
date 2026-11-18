// Remote firmware updates from the IDE.
//   overMqtt: through the broker; PC and board only make outgoing connections, so no
//             router ports are needed. Encrypted (ChaCha20) and signed (HMAC-SHA256).
//   overLan:  ArduinoOTA/espota push to the board's IP on the same network.
const mqtt = require("mqtt");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCipheriv, createHmac, randomBytes } = require("node:crypto");
const { checkBroker, brokerHint } = require("./runtime");
const { OTA_CHUNK } = require("./otafw");
// One secret per Microflow database; keys for encryption, signing and the LAN
// password are derived from it. Boards flashed with it accept updates only from here.
function projectKeys(store) {
  let master = store.getSecret("otaKey");
  if (!master) {
    master = randomBytes(32).toString("hex");
    store.setSecret("otaKey", master);
  }
  const derive = (label) =>
    createHmac("sha256", Buffer.from(master, "hex")).update(label).digest();
  return {
    enc: derive("microflow-ota-enc"),
    mac: derive("microflow-ota-mac"),
    lan: derive("microflow-ota-lan").toString("hex").slice(0, 32),
  };
}
// RFC 8439 ChaCha20 with block counter 0; OpenSSL's IV is counter (LE) || nonce.
const encrypt = (image, key, nonce) =>
  createCipheriv(
    "chacha20",
    key,
    Buffer.concat([Buffer.alloc(4), nonce]),
  ).update(image);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overMqtt({
  broker,
  deviceId,
  image,
  keys,
  connect = mqtt.connect,
  onProgress = () => {},
  window = 4,
  timeouts = {},
}) {
  const t = { ready: 10000, stall: 4000, done: 20000, retries: 8, ...timeouts };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(deviceId || ""))
    throw Error("Enter the board's Device ID (see Devices or Verify board).");
  const options = checkBroker(broker);
  const base = `microflow/${deviceId}`;
  const nonce = randomBytes(12);
  const cipher = encrypt(image, keys.enc, nonce);
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-ota-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {});
  let onAck = () => {};
  client.on("message", (topic, payload) => onAck(payload.toString()));
  // Resolves with the first ack accepted by `pick` (which returns a value or undefined).
  const waitAck = (pick, ms, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(what)), ms);
      onAck = (text) => {
        if (text.startsWith("error ")) {
          clearTimeout(timer);
          return reject(Error("Board refused the update: " + text.slice(6)));
        }
        const v = pick(text);
        if (v !== undefined) {
          clearTimeout(timer);
          resolve(v);
        }
      };
    });
  const publish = (kind, payload) =>
    new Promise((resolve, reject) =>
      client.publish(`${base}/ota/${kind}`, payload, { qos: 0 }, (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", (e) => reject(Error(brokerHint(e, options.url))));
    });
    await new Promise((resolve, reject) =>
      client.subscribe(`${base}/ota-ack`, (e) => (e ? reject(e) : resolve())),
    );
    const ready = waitAck(
      (text) => (text.startsWith("ready ") ? text.slice(6, 38) : undefined),
      t.ready,
      `${deviceId} did not answer the update request. Is it online on this broker, and was its current firmware built with Remote update on? (The first install must be over USB.)`,
    );
    await publish("begin", `${image.length} ${nonce.toString("hex")}`);
    const challenge = await ready;
    const mac = createHmac("sha256", keys.mac)
      .update(challenge)
      .update(nonce)
      .update(cipher)
      .digest("hex");
    // Sliding window with cumulative acks ("next <offset>"); go back on stalls.
    let lastError = "";
    let acked = 0,
      sent = 0,
      stalls = 0,
      lastProgress = Date.now();
    const started = Date.now();
    let wake = () => {};
    onAck = (text) => {
      if (text.startsWith("error ")) {
        acked = -1;
        lastError = text.slice(6);
      } else if (text.startsWith("next ")) {
        const next = Number(text.slice(5));
        if (next > acked) {
          acked = next;
          stalls = 0;
          lastProgress = Date.now();
          onProgress(acked, image.length);
        }
      }
      wake();
    };
    while (acked < image.length) {
      if (acked < 0) throw Error("Board refused the update: " + lastError);
      while (sent < image.length && sent - acked < window * OTA_CHUNK) {
        const end = Math.min(sent + OTA_CHUNK, image.length);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(sent);
        await publish(
          "data",
          Buffer.concat([header, cipher.subarray(sent, end)]),
        );
        sent = end;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (Date.now() - lastProgress > t.stall) {
        if (++stalls > t.retries)
          throw Error(
            `Transfer stalled at ${Math.round((100 * acked) / image.length)} %.`,
          );
        sent = acked; // resend from the last acknowledged offset
        lastProgress = Date.now();
      }
    }
    const done = waitAck(
      (text) => (text === "done" ? true : undefined),
      t.done,
      "The board did not confirm the update.",
    );
    await publish("end", mac);
    await done;
    return { seconds: (Date.now() - started) / 1000, bytes: image.length };
  } finally {
    client.end(true);
  }
}
// Finds espota for the installed ESP core (Arduino15 package folder).
function espota(family) {
  const root = path.join(
    process.env.ARDUINO15 ||
      path.join(
        process.env.LOCALAPPDATA ||
          path.join(require("node:os").homedir(), ".arduino15"),
        "Arduino15",
      ),
    "packages",
  );
  const latest = (dir) => {
    try {
      return fs
        .readdirSync(dir)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((v) => path.join(dir, v))
        .at(-1);
    } catch {
      return null;
    }
  };
  if (family === "esp8266") {
    const core = latest(path.join(root, "esp8266", "hardware", "esp8266"));
    const py = latest(path.join(root, "esp8266", "tools", "python3"));
    const exe =
      py &&
      path.join(py, process.platform === "win32" ? "python3.exe" : "python3");
    if (!core || !exe || !fs.existsSync(exe)) return null;
    return {
      cmd: exe,
      args: ["-I", path.join(core, "tools", "espota.py")],
      port: 8266,
    };
  }
  const core = latest(path.join(root, "esp32", "hardware", "esp32"));
  if (!core) return null;
  const exe = path.join(
    core,
    "tools",
    process.platform === "win32" ? "espota.exe" : "espota.py",
  );
  if (!fs.existsSync(exe)) return null;
  return process.platform === "win32"
    ? { cmd: exe, args: [], port: 3232 }
    : { cmd: "python3", args: [exe], port: 3232 };
}
function overLan({
  ip,
  family,
  bin,
  password,
  onOutput = () => {},
  timeout = 180000,
}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || ""))
    throw Error(
      "Enter the board's IP address (shown in Chip status or Devices).",
    );
  const tool = espota(family);
  if (!tool) throw Error("espota was not found in the installed ESP core.");
  return new Promise((resolve, reject) => {
    const p = spawn(
      tool.cmd,
      [
        ...tool.args,
        "-i",
        ip,
        "-p",
        String(tool.port),
        `--auth=${password}`,
        "-f",
        bin,
        "-r",
      ],
      { windowsHide: true },
    );
    let output = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(Error("LAN upload timed out."));
    }, timeout);
    for (const s of [p.stdout, p.stderr])
      s.on("data", (d) => {
        output = (output + d).slice(-8000);
        onOutput(d.toString());
      });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        Error(
          /No response|Listen Failed|timed out/i.test(output)
            ? `The board at ${ip} did not connect back. LAN upload needs the PC and board on the same network, and Windows Firewall must allow incoming connections for espota/python. Try Over MQTT instead.`
            : /Authentication Failed/i.test(output)
              ? "The board rejected the LAN password: its firmware was built with another project key. Use USB once."
              : output.slice(-600) || `espota exited ${code}`,
        ),
      );
    });
  });
}
module.exports = { projectKeys, encrypt, overMqtt, overLan, espota };
