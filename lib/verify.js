const mqtt = require("mqtt");
const { SerialPort } = require("serialport");
const { randomBytes } = require("node:crypto");
const { checkBroker, brokerHint } = require("./runtime");
const { portKeepsDtr } = require("./usbotg");
// Checks that a board is alive and running the expected firmware.
// Over USB serial the firmware answers "mf?" with an MF:{…} status line; over MQTT
// it answers microflow/<id>/ping with "<nonce> <build>" on microflow/<id>/pong.
// WiFi / MQTT status decoding is shared with the browser's chip status card.
const {
  CHIP_WIFI: WIFI,
  CHIP_MQTT: MQTT_STATE,
} = require("../public/chipstatus");
const DEFAULT_LIMITS = {
  quick: 4000, // wait this long before treating the board as stuck and resetting it
  respond: 15000,
  wifi: 45000, // long enough for the firmware's WiFi retries (10 s, 20 s)
  mqtt: 20000,
  ping: 6000,
  poll: 1000,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const romText = (s) => s.replace(/[^\x20-\x7e\n]/g, "");
const CRASH =
  /Fatal exception[^\n]*|Exception \(\d+\)[^\n]*|wdt reset|rst cause:4/i;
async function openProbe(Port, path, poll) {
  const port = new Port({ path, baudRate: 115200, autoOpen: false });
  await new Promise((resolve, reject) =>
    port.open((e) =>
      e
        ? reject(
            Error(
              /not found|ENOENT|No such file/i.test(e.message)
                ? `${path} does not exist. Is the board plugged in with a data cable? Refresh the port list (↻).`
                : `Cannot open ${path}: ${e.message}. Close other serial monitors (Arduino IDE, PuTTY) and try again.`,
            ),
          )
        : resolve(),
    ),
  );
  // DTR/RTS low = run mode on ESP auto-reset circuits (not bootloader, not held in reset).
  // The chip's own USB (TinyUSB) instead passes data only while
  // DTR is on, and has no reset line.
  const info = (await Port.list?.().catch(() => []))?.find(
    (p) => p.path === path,
  );
  const native = portKeepsDtr(info);
  await new Promise((resolve) =>
    port.set({ dtr: native, rts: false }, () => resolve()),
  );
  let buffer = "",
    latest = null,
    sniff = null, // collects boot-ROM text while listening at 74880 baud
    wake = () => {};
  const signals = (s) => new Promise((resolve) => port.set(s, () => resolve()));
  const baud = (baudRate) =>
    new Promise((resolve) => port.update({ baudRate }, () => resolve()));
  port.on("data", (data) => {
    if (sniff !== null) {
      sniff = (sniff + data.toString("latin1")).slice(-4096);
      return;
    }
    buffer += data.toString("latin1");
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      const at = line.indexOf("MF:{");
      if (at >= 0)
        try {
          const report = JSON.parse(line.slice(at + 3));
          // MF:{"n":…} lines are node reports of PC input emulation builds.
          if (report.n === undefined) {
            latest = report;
            wake();
          }
        } catch {}
    }
    if (buffer.length > 4096) buffer = buffer.slice(-512);
  });
  port.on("error", () => {});
  return {
    // Asks "mf?" repeatedly until a status report satisfies `test` or time runs out.
    async waitFor(test, ms) {
      const end = Date.now() + ms;
      while (!(latest && test(latest)) && Date.now() < end) {
        port.write("mf?\n");
        await new Promise((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(poll, Math.max(0, end - Date.now())),
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return latest;
    },
    // Boot-ROM helpers. The ROM prints at 74880 baud; firmware talks at 115200.
    // listenRom() only listens; reset() pulses EN via RTS with GPIO0 released
    // (a normal reset, like pressing RST) and returns what the ROM printed.
    async listenRom(ms) {
      sniff = "";
      await baud(74880);
      await sleep(ms);
      const text = romText(sniff);
      sniff = null;
      buffer = "";
      await baud(115200);
      return text;
    },
    async reset() {
      if (native) return ""; // no reset line on the chip's own USB
      sniff = "";
      await baud(74880);
      await signals({ dtr: false, rts: true });
      await sleep(120);
      await signals({ dtr: false, rts: false });
      await sleep(450);
      const text = romText(sniff);
      sniff = null;
      buffer = "";
      latest = null;
      await baud(115200);
      return text;
    },
    close: () =>
      new Promise((resolve) =>
        port.isOpen ? port.close(() => resolve()) : resolve(),
      ),
  };
}
async function ping(connect, broker, id, build, limits) {
  const options = checkBroker(broker);
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-verify-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", (e) => reject(Error(brokerHint(e, options.url))));
      client.once("close", () =>
        reject(Error(`This PC cannot reach ${options.url}.`)),
      );
    });
    const base = "microflow/" + id;
    await new Promise((resolve, reject) =>
      client.subscribe(base + "/pong", (e) => (e ? reject(e) : resolve())),
    );
    const nonce = randomBytes(6).toString("hex");
    const started = Date.now();
    const reply = new Promise((resolve) =>
      client.on("message", (topic, payload) => {
        // "<nonce> <build> [ota|no-ota]"; older firmware sends no capability flag.
        const [n, replyBuild, flag] = payload.toString().split(" ");
        if (n === nonce)
          resolve({
            build: replyBuild,
            ota: flag === "ota" ? true : flag === "no-ota" ? false : null,
          });
      }),
    );
    let got;
    while (got === undefined && Date.now() - started < limits.ping) {
      client.publish(base + "/ping", nonce);
      got = await Promise.race([reply, sleep(Math.min(1500, limits.ping))]);
    }
    if (got === undefined)
      return {
        ok: false,
        detail: `no reply from ${id} within ${limits.ping / 1000} s`,
      };
    if (build && got.build !== build && got.build !== "sim")
      return {
        ok: false,
        detail: `reply in ${Date.now() - started} ms, but it runs build ${got.build} (expected ${build})`,
        build: got.build,
        ota: got.ota,
      };
    return {
      ok: true,
      detail: `reply in ${Date.now() - started} ms · build ${got.build}`,
      build: got.build,
      ota: got.ota,
    };
  } finally {
    client.end(true);
  }
}
async function verifyBoard({
  serialPort,
  build,
  deviceId,
  broker,
  family = "esp32",
  Port = SerialPort,
  connect = mqtt.connect,
  onStep = () => {},
  limits: custom = {},
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...custom };
  if (!serialPort && !deviceId)
    throw Error("Choose the board's serial port or enter its Device ID.");
  const names = serialPort
    ? [
        "Board answers over USB",
        ...(build ? ["Runs the uploaded build"] : []),
        "WiFi connected",
        "MQTT connected (board)",
      ]
    : [];
  if (broker?.url) names.push("Broker round-trip (ping)");
  const steps = names.map((name) => ({ name, ok: null, detail: "skipped" }));
  let index = 0;
  const done = (ok, detail) => {
    Object.assign(steps[index], { ok, detail });
    onStep(index, steps[index]);
    index++;
    return ok;
  };
  const device = { id: deviceId || null };
  run: {
    if (serialPort) {
      let probe;
      try {
        probe = await openProbe(Port, serialPort, limits.poll);
      } catch (e) {
        done(false, e.message);
        break run;
      }
      try {
        let first = await probe.waitFor(
          () => true,
          Math.min(limits.quick, limits.respond),
        );
        let note = "";
        if (!first) {
          // A silent board is either crashed or busy (e.g. blocked retrying an
          // unreachable broker). Only a crash loop justifies resetting right away.
          const crash = CRASH.exec(await probe.listenRom(300));
          if (!crash) first = await probe.waitFor(() => true, limits.respond);
          if (!first) {
            const boot = await probe.reset();
            first = await probe.waitFor(() => true, limits.respond);
            const mode = /boot mode:\((\d)/.exec(boot)?.[1];
            note = crash
              ? `It was stuck in a crash loop ("${crash[0].trim()}"), so it was reset over USB. `
              : "It was not answering, so it was reset over USB. ";
            if (!first) {
              done(
                false,
                note +
                  (mode === "1"
                    ? "After the reset it started in download mode (GPIO0 held low): release the FLASH/BOOT button or check what is wired to GPIO0, then verify again."
                    : `Still no answer on ${serialPort}. Is this Microflow firmware at 115200 baud? Upload it again.${mode ? ` (boot mode ${mode})` : ""}`),
              );
              break run;
            }
          }
        }
        done(
          true,
          `${note}${first.id} · uptime ${first.uptime} s · heap ${(first.heap / 1024).toFixed(1)} KB`,
        );
        Object.assign(device, first, { id: deviceId || first.id });
        if (
          build &&
          !done(
            first.build === build,
            first.build === build
              ? `build ${build}`
              : `board runs build ${first.build}, expected ${build}. The upload may not have taken effect; press RST and verify again.`,
          )
        )
          break run;
        // Firmware for a board without WiFi: nothing more to check over the network.
        if (first.net === 0) {
          const none = "not used: this board has no WiFi";
          done(true, none);
          done(true, none);
          if (broker?.url) done(true, none);
          break run;
        }
        const wifi = await probe.waitFor((r) => r.wifi === 3, limits.wifi);
        Object.assign(device, wifi);
        if (
          !done(
            wifi.wifi === 3,
            wifi.wifi === 3
              ? `IP ${wifi.ip} · RSSI ${wifi.rssi} dBm`
              : `not connected after ${limits.wifi / 1000} s: ${WIFI[family]?.[wifi.wifi] || "status " + wifi.wifi}. Check the WiFi name and password.`,
          )
        )
          break run;
        const link = await probe.waitFor((r) => r.mqtt === 0, limits.mqtt);
        Object.assign(device, link);
        if (
          !done(
            link.mqtt === 0,
            link.mqtt === 0
              ? "connected to the firmware broker"
              : `not connected after ${limits.mqtt / 1000} s: ${MQTT_STATE[link.mqtt] || "state " + link.mqtt}.`,
          )
        )
          break run;
      } finally {
        await probe.close();
      }
    }
    if (broker?.url) {
      if (!device.id) {
        done(false, "Device ID unknown; enter it or verify over USB.");
        break run;
      }
      try {
        const r = await ping(connect, broker, device.id, build, limits);
        if (r.build)
          Object.assign(device, { build: device.build || r.build, ota: r.ota });
        done(r.ok, r.detail);
      } catch (e) {
        done(false, e.message);
      }
    }
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), device, steps };
}
// Broker loopback: this PC publishes to a private random topic and receives its own
// messages back. Checks the broker alone (reachability, credentials, ACLs, latency).
async function brokerLoopback(
  broker,
  { connect = mqtt.connect, count = 5, timeout = 5000, qos1 = true } = {},
) {
  const options = checkBroker(broker);
  const steps = [
    "Connect to broker",
    "Subscribe to a test topic",
    `Loop back ${count} messages (QoS 0)`,
    "Loop back 1 message (QoS 1)",
  ].map((name) => ({ name, ok: null, detail: "skipped" }));
  let index = 0;
  const done = (ok, detail) => {
    Object.assign(steps[index++], { ok, detail });
    return ok;
  };
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-loopback-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {});
  const waiting = new Map();
  client.on("message", (topic, payload) => waiting.get(payload.toString())?.());
  // Publishes a unique payload and resolves with the round-trip time, or null on timeout.
  const roundTrip = (topic, qos) =>
    new Promise((resolve, reject) => {
      const nonce = randomBytes(6).toString("hex");
      const started = Date.now();
      let acked = null,
        received = null;
      // QoS 1: the echo can arrive before the PUBACK, so wait for both.
      const finish = () => {
        if (received === null || (qos > 0 && acked === null)) return;
        clearTimeout(timer);
        resolve({ ms: received, acked });
      };
      const timer = setTimeout(() => {
        waiting.delete(nonce);
        resolve(null);
      }, timeout);
      waiting.set(nonce, () => {
        waiting.delete(nonce);
        received = Date.now() - started;
        finish();
      });
      client.publish(topic, nonce, { qos }, (e) => {
        if (e) return reject(e);
        acked = Date.now() - started;
        finish();
      });
    });
  const started = Date.now();
  run: try {
    try {
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", (e) => reject(Error(brokerHint(e, options.url))));
        client.once("close", () =>
          reject(Error(`${options.url} closed the connection.`)),
        );
      });
    } catch (e) {
      done(false, e.message);
      break run;
    }
    done(true, `${Date.now() - started} ms · ${options.url}`);
    const topic = `microflow/_loopback/${randomBytes(6).toString("hex")}`;
    const t0 = Date.now();
    let granted;
    try {
      granted = await new Promise((resolve, reject) =>
        client.subscribe(topic, { qos: 1 }, (e, g) =>
          e ? reject(e) : resolve(g),
        ),
      );
    } catch (e) {
      // Some brokers answer a forbidden subscription by dropping the connection.
      done(
        false,
        /closed/i.test(e.message)
          ? "broker refused the subscription and closed the connection (check its ACL / permissions)"
          : /^Subscribe error/i.test(e.message) // mqtt.js reports SUBACK 0x80 this way
            ? "broker refused the subscription (check its ACL / permissions)"
            : e.message,
      );
      break run;
    }
    if (
      !done(
        granted?.[0]?.qos !== 128,
        granted?.[0]?.qos === 128
          ? "broker refused the subscription (check its ACL / permissions)"
          : `${Date.now() - t0} ms · ${topic}`,
      )
    )
      break run;
    const times = [];
    for (let i = 0; i < count; i++) {
      const r = await roundTrip(topic, 0);
      if (!r) {
        done(
          false,
          `message ${i + 1} of ${count} did not come back within ${timeout / 1000} s (publish not allowed, or the broker drops messages)`,
        );
        break run;
      }
      times.push(r.ms);
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    done(
      true,
      `${count}/${count} received · min ${Math.min(...times)} / avg ${avg} / max ${Math.max(...times)} ms`,
    );
    // QoS 0-only brokers (e.g. the ESP32 broker board) skip the QoS 1 check.
    if (!qos1) {
      Object.assign(steps[index++], {
        skip: true,
        detail: "skipped: this broker supports QoS 0 only",
      });
      break run;
    }
    const q1 = await roundTrip(topic, 1);
    done(
      !!q1,
      q1
        ? `delivered in ${q1.ms} ms${q1.acked !== null ? ` · broker acknowledged (PUBACK) in ${q1.acked} ms` : ""}`
        : `not received within ${timeout / 1000} s`,
    );
  } catch (e) {
    if (index < steps.length) done(false, e.message);
  } finally {
    client.end(true);
  }
  return {
    ok: steps.every((s) => s.ok || s.skip),
    url: options.url,
    steps,
  };
}
module.exports = { verifyBoard, brokerLoopback, WIFI, MQTT_STATE };
