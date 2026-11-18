const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { detectBaud, readability } = require("../public/chipstatus");
const { LocalSerialMonitor } = require("../lib/serial");
const { BrowserSerialMonitor } = require("../public/serial");
// What a board "sounds like" at each rate: readable text at its real rate,
// noise at other rates, nothing if silent.
const noise = Buffer.from([
  0x0c, 0x04, 0x8f, 0xfe, 0x03, 0x1c, 0x80, 0x12, 0xe4, 0x9b, 0x02, 0x7f,
]);
const boardAt = (realRate, reply) => (rate) =>
  rate === realRate ? Buffer.from(reply) : noise;
// Transport stub for detectBaud.
function stub(sound) {
  let rate = 0,
    captured = [];
  return {
    setBaud: async (r) => (rate = r),
    send: async () => captured.push(sound(rate)),
    take: () => {
      const b = Buffer.concat(captured);
      captured = [];
      return b;
    },
    get rate() {
      return rate;
    },
  };
}
test("readability separates text from noise", () => {
  assert.equal(readability(Buffer.from("hello\r\n")), 1);
  assert.ok(readability(noise) < 0.5);
  assert.equal(readability(Buffer.alloc(0)), 0);
});
test("Microflow firmware is found at 115200 on the first try", async () => {
  const t = stub(boardAt(115200, 'MF:{"build":"abc"}\r\n'));
  const r = await detectBaud({ ...t, take: t.take, wait: 1 });
  assert.equal(r.rate, 115200);
  assert.equal(r.microflow, true);
  assert.equal(r.results.length, 1);
});
test("other firmware is found by readable text, silence gives no rate", async () => {
  const t = stub(boardAt(9600, "Temperature: 21.5 C\r\n"));
  const r = await detectBaud({ ...t, take: t.take, wait: 1 });
  assert.equal(r.rate, 9600);
  assert.equal(r.microflow, false);
  const quiet = stub(() => Buffer.alloc(0));
  const none = await detectBaud({ ...quiet, take: quiet.take, wait: 1 });
  assert.equal(none.rate, null);
  assert.ok(none.results.every((x) => x.bytes === 0));
});
test("Local serial changes speed live and auto-detects", async () => {
  class Port extends EventEmitter {
    static async list() {
      return [{ path: "COM_B" }];
    }
    constructor(o) {
      super();
      this.path = o.path;
      this.baudRate = o.baudRate;
    }
    open(cb) {
      this.isOpen = true;
      cb();
    }
    update(o, cb) {
      this.baudRate = o.baudRate;
      cb();
    }
    write(text, cb) {
      if (text === "mf?\n")
        setTimeout(
          () =>
            this.emit(
              "data",
              boardAt(115200, "» unknown\r\nMF:{}\r\n")(this.baudRate),
            ),
          5,
        );
      cb?.();
    }
    drain(cb) {
      cb();
    }
    close(cb) {
      this.isOpen = false;
      cb();
    }
  }
  const events = [];
  const m = new LocalSerialMonitor((...e) => events.push(e), Port);
  await m.connect("COM_B", 9600);
  assert.equal((await m.setBaud(74880)).baudRate, 74880);
  await assert.rejects(m.setBaud(1234), /Unsupported/);
  const r = await m.detectBaud();
  assert.equal(r.rate, 115200);
  assert.equal(m.port.baudRate, 115200, "keeps the detected rate");
  assert.ok(
    !events.some((e) => e[0] === "serial"),
    "detection bytes are not echoed to the console",
  );
  await m.disconnect();
});
test("Web Serial reopens the same port at a new speed", async () => {
  const opened = [];
  const port = {
    async open(o) {
      opened.push(o.baudRate);
      this.readable = new ReadableStream({ start() {} });
      this.writable = new WritableStream({});
    },
    async close() {},
  };
  const statuses = [];
  const m = new BrowserSerialMonitor(
    { requestPort: async () => port },
    () => {},
    (c, msg) => statuses.push(msg),
  );
  await m.connect(9600);
  await m.setBaud(115200);
  assert.deepEqual(opened, [9600, 115200]);
  assert.match(statuses.at(-1), /115200 baud/);
  assert.equal(m.port, port, "no new permission prompt: same port object");
  await m.disconnect();
});
test("boot-ROM crash text at 74880 is reported as a crash, not a baud rate", async () => {
  const crashing = stub((rate) =>
    rate === 74880
      ? Buffer.from(
          "Fatal exception (0):\r\nepc1=0x40100002, epc2=0x00000000\r\n",
        )
      : noise,
  );
  const r = await detectBaud({ ...crashing, take: crashing.take, wait: 1 });
  assert.equal(r.rate, 74880);
  assert.equal(r.rom, true);
  assert.match(r.sample, /Fatal exception \(0\)/);
  const other = stub(boardAt(74880, "Hello from my own sketch at 74880\r\n"));
  assert.equal(
    (await detectBaud({ ...other, take: other.take, wait: 1 })).rom,
    false,
    "plain text at 74880 is a real baud rate",
  );
});
