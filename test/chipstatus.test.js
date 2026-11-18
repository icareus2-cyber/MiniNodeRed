const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  ChipStatusParser,
  describeWifi,
  describeMqtt,
} = require("../public/chipstatus");
const { BrowserSerialMonitor } = require("../public/serial");
const { LocalSerialMonitor } = require("../lib/serial");
const report =
  '{"build":"abc","id":"esp-1","wifi":3,"mqtt":-2,"ip":"10.0.0.5","rssi":-60,"heap":40000,"uptime":12}';
test("status lines are parsed across chunks and hidden from the console", () => {
  const seen = [];
  const p = new ChipStatusParser((s) => seen.push(s));
  let shown = "";
  // The reply arrives split mid-line, surrounded by ordinary output.
  for (const chunk of [
    "Temp: 21\r\nM",
    "F:" + report.slice(0, 20),
    report.slice(20) + "\r\nTemp: 22\r\n",
  ])
    shown += p.feed(chunk);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "esp-1");
  assert.equal(shown, "Temp: 21\r\nTemp: 22\r\n");
  // Text that cannot become a status line is shown immediately, even without a newline.
  assert.equal(p.feed("> prompt"), "> prompt");
  // Noise before the status on the same line is kept, the status removed.
  assert.equal(p.feed("boot noise MF:" + report + "\n"), "boot noise \n");
  assert.equal(seen.length, 2);
  // A broken status line is shown as-is rather than swallowed.
  assert.equal(p.feed('MF:{"build":\n'), 'MF:{"build":\n');
});
test("garbled input (boot ROM / crash loop at the wrong baud) is detected", () => {
  const p = new ChipStatusParser();
  p.feed("\u0004\f\u0003\u0004\f\f\u0004\ufffd\ufffd".repeat(8), 1000);
  assert.equal(p.garbled(), true);
  const q = new ChipStatusParser();
  q.feed("Received: hello world, all good here\r\n".repeat(3), 1000);
  assert.equal(q.garbled(), false);
});
test("status codes are decoded per chip family", () => {
  assert.equal(describeWifi(6, "esp8266"), "wrong WiFi password");
  assert.equal(describeWifi(6, "esp32"), "connecting…");
  assert.match(describeMqtt(-2), /TCP connection/);
  assert.equal(describeMqtt(0), "connected");
  assert.equal(describeMqtt(42), "state 42");
});
test("both serial transports reset the board with RTS while GPIO0 stays released", async () => {
  const signals = [];
  const web = new BrowserSerialMonitor(
    null,
    () => {},
    () => {},
  );
  await assert.rejects(web.reset(), /Connect serial first/);
  web.port = { setSignals: async (s) => signals.push(s) };
  await web.reset();
  assert.deepEqual(signals, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false },
  ]);
  class Port extends EventEmitter {
    static async list() {
      return [{ path: "COM_T" }];
    }
    constructor(o) {
      super();
      Object.assign(this, o);
      this.sets = [];
    }
    open(cb) {
      this.isOpen = true;
      cb();
    }
    set(s, cb) {
      this.sets.push(s);
      cb();
    }
    close(cb) {
      this.isOpen = false;
      cb();
    }
  }
  const local = new LocalSerialMonitor(() => {}, Port);
  await assert.rejects(local.reset(), /Connect serial first/);
  await local.connect("COM_T", 115200);
  await local.reset();
  assert.deepEqual(local.port.sets, [
    { dtr: false, rts: false }, // on open: both released, so the board runs
    { dtr: false, rts: true },
    { dtr: false, rts: false },
  ]);
  await local.disconnect();
});
test("node reports from PC input emulation builds are parsed and hidden", () => {
  const seen = [];
  const p = new ChipStatusParser((s) => seen.push(s));
  // As the firmware's mfTrace escapes them: quotes and backslashes.
  const shown = p.feed(
    'MF:{"n":"led","v":"1"}\r\nDebug: 1\r\nMF:{"n":"tpl","v":"{\\"t\\":2} C:\\\\"}\r\n',
  );
  assert.equal(shown, "Debug: 1\r\n");
  assert.deepEqual(seen, [
    { n: "led", v: "1" },
    { n: "tpl", v: '{"t":2} C:\\' },
  ]);
});
