const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const mqtt = require("mqtt");
const aedes = require("aedes");
const { verifyBoard } = require("../lib/verify");
const { FlowRuntime } = require("../lib/runtime");
const fast = {
  quick: 300,
  respond: 600,
  wifi: 600,
  mqtt: 600,
  ping: 1500,
  poll: 40,
};
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
// Serial port that behaves like Microflow firmware answering "mf?".
// `script(n)` returns the status for the n-th query, or null to stay silent.
// `rom` simulates the boot ROM at 74880 baud: { crash: true } prints a crash loop
// until reset, { bootMode: 1 } boots into download mode after a reset.
const fakeBoard = (script, opened = [], rom = {}) =>
  class extends EventEmitter {
    constructor(options) {
      super();
      this.path = options.path;
      this.isOpen = false;
      this.queries = 0;
      this.resets = 0;
      this.baudRate = options.baudRate;
      opened.push(this);
    }
    open(cb) {
      this.isOpen = true;
      cb();
    }
    set(signals, cb) {
      if (this.signals?.rts && !signals.rts) {
        this.resets++; // EN released: the chip reboots
        if (this.baudRate === 74880)
          setTimeout(
            () =>
              this.emit(
                "data",
                Buffer.from(
                  `ets Jan  8 2013,rst cause:2, boot mode:(${rom.bootMode || 3},6)\r\n`,
                  "latin1",
                ),
              ),
            5,
          );
      }
      this.signals = signals;
      cb();
    }
    update(options, cb) {
      this.baudRate = options.baudRate;
      if (rom.crash && !this.resets && this.baudRate === 74880)
        setTimeout(
          () =>
            this.emit(
              "data",
              Buffer.from(
                "Fatal exception (0):\r\nepc1=0x40100002, epc2=0x00000000\r\n",
                "latin1",
              ),
            ),
          5,
        );
      cb();
    }
    write(text) {
      if (text !== "mf?\n") return;
      if (this.baudRate !== 115200) return;
      const status = script(this.queries++, this);
      // Split the reply across chunks with boot noise, like real UART reads.
      if (status)
        setTimeout(() => {
          const line = `garbage\r\nMF:${JSON.stringify(status)}\r\n`;
          this.emit("data", Buffer.from(line.slice(0, 12), "latin1"));
          this.emit("data", Buffer.from(line.slice(12), "latin1"));
        }, 5);
    }
    close(cb) {
      this.isOpen = false;
      cb();
    }
  };
const status = (extra) => ({
  build: "abcdef0123",
  id: "esp-a",
  wifi: 6,
  mqtt: -1,
  ip: "0.0.0.0",
  rssi: 0,
  heap: 40000,
  uptime: 1,
  ...extra,
});
test("USB probe walks through boot, WiFi and MQTT", async () => {
  const opened = [];
  const Port = fakeBoard(
    (n) =>
      n === 0
        ? null
        : n < 3
          ? status()
          : n < 5
            ? status({ wifi: 3, ip: "192.168.1.50", rssi: -55 })
            : status({ wifi: 3, mqtt: 0, ip: "192.168.1.50" }),
    opened,
  );
  const seen = [];
  const report = await verifyBoard({
    serialPort: "COM9",
    build: "abcdef0123",
    family: "esp8266",
    Port,
    limits: fast,
    onStep: (i, s) => seen.push(s.name),
  });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(seen, [
    "Board answers over USB",
    "Runs the uploaded build",
    "WiFi connected",
    "MQTT connected (board)",
  ]);
  assert.equal(report.device.id, "esp-a");
  assert.equal(report.device.ip, "192.168.1.50");
  assert.deepEqual(
    opened[0].signals,
    { dtr: false, rts: false },
    "probe must not hold the chip in reset/bootloader",
  );
  assert.equal(opened[0].isOpen, false, "port released afterwards");
});
test("USB probe explains the first failure and skips the rest", async () => {
  const silent = await verifyBoard({
    serialPort: "COM9",
    build: "abcdef0123",
    Port: fakeBoard(() => null),
    limits: fast,
  });
  assert.equal(silent.ok, false);
  assert.match(silent.steps[0].detail, /no answer on COM9/);
  assert.equal(silent.steps[1].ok, null);
  const stale = await verifyBoard({
    serialPort: "COM9",
    build: "1111111111",
    Port: fakeBoard(() => status()),
    limits: fast,
  });
  assert.match(
    stale.steps[1].detail,
    /runs build abcdef0123, expected 1111111111/,
  );
  const wrongPass = await verifyBoard({
    serialPort: "COM9",
    family: "esp8266",
    Port: fakeBoard(() => status({ wifi: 6 })),
    limits: fast,
  });
  assert.match(wrongPass.steps[1].detail, /wrong WiFi password/);
  const noBroker = await verifyBoard({
    serialPort: "COM9",
    Port: fakeBoard(() => status({ wifi: 3, mqtt: -2 })),
    limits: fast,
  });
  assert.match(noBroker.steps[2].detail, /cannot open a TCP connection/);
  const auth = await verifyBoard({
    serialPort: "COM9",
    Port: fakeBoard(() => status({ wifi: 3, mqtt: 4 })),
    limits: fast,
  });
  assert.match(auth.steps[2].detail, /bad MQTT username or password/);
  await assert.rejects(verifyBoard({}), /serial port or enter its Device ID/);
  class Unplugged extends EventEmitter {
    open(cb) {
      cb(Error("Opening COM7: File not found"));
    }
  }
  const unplugged = await verifyBoard({
    serialPort: "COM7",
    Port: Unplugged,
    limits: fast,
  });
  assert.match(unplugged.steps[0].detail, /COM7 does not exist/);
});
test(
  "MQTT ping reaches a board and checks its build",
  { timeout: 10000 },
  async () => {
    // A fake board answering pings the way the firmware does.
    const board = mqtt.connect(url);
    await new Promise((r) => board.once("connect", r));
    await new Promise((r) => board.subscribe("microflow/esp-b/ping", r));
    board.on("message", (t, p) =>
      board.publish("microflow/esp-b/pong", `${p} abcdef0123`),
    );
    try {
      const ok = await verifyBoard({
        deviceId: "esp-b",
        build: "abcdef0123",
        broker: { url },
        limits: fast,
      });
      assert.equal(ok.ok, true, JSON.stringify(ok.steps));
      assert.match(ok.steps[0].detail, /reply in \d+ ms · build abcdef0123/);
      const stale = await verifyBoard({
        deviceId: "esp-b",
        build: "2222222222",
        broker: { url },
        limits: fast,
      });
      assert.match(stale.steps[0].detail, /expected 2222222222/);
      const missing = await verifyBoard({
        deviceId: "nobody",
        broker: { url },
        limits: fast,
      });
      assert.match(missing.steps[0].detail, /no reply from nobody/);
      const offline = await verifyBoard({
        deviceId: "esp-b",
        broker: { url: "mqtt://127.0.0.1:1" },
        limits: fast,
      });
      assert.match(
        offline.steps[0].detail,
        /No MQTT broker is running on this PC/,
      );
    } finally {
      await new Promise((r) => board.end(true, r));
    }
    // USB probe then ping: the Device ID learnt over USB is used for the ping.
    const both = await verifyBoard({
      serialPort: "COM9",
      broker: { url },
      Port: fakeBoard(() => status({ id: "sim-x", wifi: 3, mqtt: 0 })),
      limits: fast,
    });
    assert.equal(both.steps.at(-1).ok, false);
    assert.match(both.steps.at(-1).detail, /no reply from sim-x/);
  },
);
test(
  "host simulator answers pings like firmware",
  { timeout: 10000 },
  async () => {
    const runtime = new FlowRuntime(() => {});
    const flow = { nodes: [{ id: "d", type: "debug", config: {} }], edges: [] };
    const ready = new Promise((r) =>
      broker.on(
        "subscribe",
        (subs) => subs.some((s) => s.topic === "microflow/bench/ping") && r(),
      ),
    );
    runtime.start({ flow, broker: { url }, deviceId: "bench" });
    await ready;
    try {
      const r = await verifyBoard({
        deviceId: "bench",
        broker: { url },
        limits: fast,
      });
      assert.equal(r.ok, true, JSON.stringify(r.steps));
      assert.match(r.steps[0].detail, /build sim/);
    } finally {
      runtime.stop();
    }
  },
);
test(
  "broker loopback checks the broker without a board",
  { timeout: 15000 },
  async () => {
    const { brokerLoopback } = require("../lib/verify");
    const ok = await brokerLoopback({ url });
    assert.equal(ok.ok, true, JSON.stringify(ok.steps));
    assert.match(
      ok.steps[2].detail,
      /^5\/5 received · min \d+ \/ avg \d+ \/ max \d+ ms$/,
    );
    assert.match(ok.steps[3].detail, /PUBACK/);
    // QoS 0-only brokers (the ESP32 broker board) skip the QoS 1 step and still pass.
    const qos0 = await brokerLoopback({ url }, { qos1: false });
    assert.equal(qos0.ok, true, JSON.stringify(qos0.steps));
    assert.equal(qos0.steps[3].ok, null);
    assert.match(qos0.steps[3].detail, /QoS 0 only/);
    const down = await brokerLoopback({ url: "mqtt://127.0.0.1:1" });
    assert.equal(down.ok, false);
    assert.match(down.steps[0].detail, /No MQTT broker is running on this PC/);
    assert.equal(down.steps[1].ok, null);
    // A broker whose permissions refuse the subscription.
    const strict = aedes({
      authorizeSubscribe: (client, sub, done) => done(Error("denied")),
    });
    const server = net.createServer(strict.handle);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const denied = await brokerLoopback({
        url: `mqtt://127.0.0.1:${server.address().port}`,
      });
      assert.equal(denied.steps[1].ok, false);
      assert.match(denied.steps[1].detail, /refused the subscription/);
      // Mosquitto-style refusal: SUBACK with failure code 0x80 instead of a disconnect.
      strict.authorizeSubscribe = (client, sub, done) => done(null, null);
      const refused = await brokerLoopback({
        url: `mqtt://127.0.0.1:${server.address().port}`,
      });
      assert.match(
        refused.steps[1].detail,
        /^broker refused the subscription \(check/,
      );
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => strict.close(r));
    }
  },
);

test("a crash-looping board is detected, reset once over USB and then verified", async () => {
  const opened = [];
  const Port = fakeBoard(
    (n, port) => (port.resets ? status({ wifi: 3, mqtt: 0 }) : null),
    opened,
    { crash: true },
  );
  const report = await verifyBoard({ serialPort: "COM9", Port, limits: fast });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.match(
    report.steps[0].detail,
    /^It was stuck in a crash loop \("Fatal exception \(0\):"\), so it was reset over USB\. esp-a/,
  );
  assert.equal(opened[0].resets, 1, "exactly one reset");
  assert.equal(opened[0].baudRate, 115200, "back to firmware baud");
  assert.deepEqual(
    opened[0].signals,
    { dtr: false, rts: false },
    "left in run mode",
  );
  const download = await verifyBoard({
    serialPort: "COM9",
    Port: fakeBoard(() => null, [], { bootMode: 1 }),
    limits: fast,
  });
  assert.match(download.steps[0].detail, /download mode \(GPIO0 held low\)/);
});
test(
  "a remote update with no answer is diagnosed, not guessed",
  { timeout: 20000 },
  async () => {
    const { diagnoseRemote, storedStatus } = require("../lib/diagnose");
    const online = (ota) => async () => ({
      steps: [{ ok: true }],
      device: { build: "b1", ota },
    });
    const silent = async () => ({ steps: [{ ok: false }], device: {} });
    const base = {
      broker: { url: "mqtt://broker.example:1883" },
      deviceId: "esp-9",
    };
    assert.match(
      await diagnoseRemote({ ...base, ping: online(false) }),
      /online on broker\.example:1883 \(build b1\) but its firmware was built with Remote update off/,
    );
    assert.match(
      await diagnoseRemote({ ...base, ping: online(null) }),
      /probably built with Remote update off or by an older Microflow/,
    );
    assert.match(
      await diagnoseRemote({
        ...base,
        ping: silent,
        status: async () => "offline",
      }),
      /not connected to broker\.example:1883 \(the broker's last status for it: offline\)\. Connect it over USB/,
    );
    assert.match(
      await diagnoseRemote({ ...base, ping: silent, status: async () => null }),
      /never reported to broker\.example:1883: check the Device ID/,
    );
    const crashed = async () => ({
      steps: [
        {
          ok: true,
          name: "Board answers over USB",
          detail:
            'It was stuck in a crash loop ("Fatal exception (0):"), so it was reset over USB. esp-9',
        },
        { ok: true },
      ],
      device: { build: "b1" },
    });
    assert.match(
      await diagnoseRemote({
        ...base,
        serialPort: "COM4",
        ping: silent,
        status: async () => "offline",
        usb: crashed,
      }),
      /USB check on COM4: the board runs build b1 after being reset \(it was stuck\), with WiFi and MQTT connected now\. Try the remote update again\./,
    );
    const noWifi = async () => ({
      steps: [
        { ok: true },
        {
          ok: false,
          name: "WiFi connected",
          detail: "not connected after 10 s: wrong WiFi password.",
        },
      ],
      device: {},
    });
    assert.match(
      await diagnoseRemote({
        ...base,
        serialPort: "COM4",
        ping: silent,
        status: async () => "offline",
        usb: noWifi,
      }),
      /wifi connected failed: not connected after 10 s: wrong WiFi password/,
    );
    // Stored status read from a real broker.
    const pub = mqtt.connect(url);
    await new Promise((r) => pub.once("connect", r));
    await new Promise((r) =>
      pub.publish("microflow/esp-st/status", "offline", { retain: true }, r),
    );
    assert.equal(await storedStatus({ url }, "esp-st"), "offline");
    assert.equal(
      await storedStatus({ url }, "nobody-here", { wait: 300 }),
      null,
    );
    await new Promise((r) => pub.end(true, r));
  },
);
test("the diagnosis names the board actually on the USB port", async () => {
  const { diagnoseRemote } = require("../lib/diagnose");
  const r = await diagnoseRemote({
    broker: { url: "mqtt://b.example:1883" },
    deviceId: "microflow-typo",
    serialPort: "COM4",
    ping: async () => ({ steps: [{ ok: false }], device: {} }),
    status: async () => null,
    usb: async () => ({
      steps: [{ ok: true, detail: "microflow-102fbb" }, { ok: true }],
      device: { id: "microflow-102fbb", build: "04177b3883" },
    }),
  });
  assert.match(
    r,
    /The board on COM4 is microflow-102fbb \(build 04177b3883\), not microflow-typo: use Device ID microflow-102fbb\./,
  );
});
test("a board without WiFi passes the USB check without network steps", async () => {
  const Port = fakeBoard(() => ({
    build: "abcdef0123",
    id: "p4-a",
    net: 0,
    heap: 400000,
    uptime: 3,
    ota: 0,
  }));
  const report = await verifyBoard({
    serialPort: "COM9",
    build: "abcdef0123",
    Port,
    limits: fast,
  });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(
    report.steps.slice(2).map((s) => s.detail),
    ["not used: this board has no WiFi", "not used: this board has no WiFi"],
  );
});
test("the chip's own USB keeps DTR on during the board check", async () => {
  const opened = [];
  const Base = fakeBoard(() => status({ net: 0 }), opened);
  const listing = (vid, pid) =>
    class extends Base {
      static list = async () => [
        { path: "COM7", vendorId: vid, productId: pid },
      ];
    };
  for (const [vid, pid, dtr] of [
    ["303A", "4001", true], // TinyUSB: data only flows with DTR on
    ["303A", "1001", false], // USB-Serial-JTAG: classic reset emulation
    ["10C4", "EA60", false], // CP210x bridge
  ]) {
    opened.length = 0;
    await verifyBoard({
      serialPort: "COM7",
      Port: listing(vid, pid),
      limits: fast,
    });
    assert.equal(opened[0].signals.dtr, dtr, `${vid}:${pid}`);
    assert.equal(opened[0].signals.rts, false);
  }
});
test("node reports of PC input emulation builds do not hide the status", async () => {
  const Board = fakeBoard(() => null);
  // The flow reports node outputs right after the status line, in the same read.
  class Port extends Board {
    write(text) {
      if (text !== "mf?\n" || this.baudRate !== 115200) return;
      const ready = status({ wifi: 3, mqtt: 0, ip: "192.168.1.50", emu: 1 });
      setTimeout(
        () =>
          this.emit(
            "data",
            Buffer.from(
              `MF:${JSON.stringify(ready)}\r\nMF:{"n":"led","v":"1"}\r\n`,
              "latin1",
            ),
          ),
        5,
      );
    }
  }
  const report = await verifyBoard({
    serialPort: "COM9",
    build: "abcdef0123",
    family: "esp32",
    Port,
    limits: fast,
  });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.equal(report.device.ip, "192.168.1.50");
});
