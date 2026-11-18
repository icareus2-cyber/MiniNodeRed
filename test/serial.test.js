const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LocalSerialMonitor } = require("../lib/serial");
const { BrowserSerialMonitor } = require("../public/serial");
class MockPort extends EventEmitter {
  static async list() {
    return [{ path: "COM_TEST" }];
  }
  constructor(options) {
    super();
    Object.assign(this, options);
    this.isOpen = false;
    this.sent = [];
  }
  open(callback) {
    this.isOpen = true;
    callback();
  }
  close(callback) {
    this.isOpen = false;
    this.emit("close");
    callback();
  }
  write(text, callback) {
    this.sent.push(text);
    callback();
  }
  drain(callback) {
    callback();
  }
  set(signals, callback) {
    (this.signals ??= []).push(signals);
    callback();
  }
}
test("local serial detects ports, validates opens, reads split UTF-8, sends and closes", async () => {
  const events = [];
  const monitor = new LocalSerialMonitor(
    (...event) => events.push(event),
    MockPort,
  );
  await assert.rejects(monitor.connect("COM_MISSING", 115200), /not found/);
  assert.equal(monitor.busy, false);
  await assert.rejects(monitor.connect("COM_TEST", 123), /baud/);
  assert.equal((await monitor.connect("COM_TEST", 115200)).connected, true);
  await assert.rejects(monitor.connect("COM_TEST", 115200), /already/);
  const port = monitor.port;
  // Opening must not reset the board into download mode: DTR and RTS are released,
  // and closing does not drop them (hupcl off).
  assert.deepEqual(port.signals, [{ dtr: false, rts: false }]);
  assert.equal(port.hupcl, false);
  const bytes = Buffer.from("°");
  port.emit("data", bytes.subarray(0, 1));
  port.emit("data", bytes.subarray(1));
  for (let i = 0; i < 1000; i++) port.emit("data", Buffer.from("x"));
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(events.filter((e) => e[0] === "serial").length, 1);
  assert.equal(
    events.find((e) => e[0] === "serial")[2].payload,
    "°" + "x".repeat(1000),
  );
  await monitor.send("hello\n");
  assert.deepEqual(port.sent, ["hello\n"]);
  await assert.rejects(monitor.send("a".repeat(4097)), /4096/);
  assert.equal((await monitor.disconnect()).connected, false);
  await assert.rejects(monitor.send("hello"), /Connect/);
});
test("browser serial requests permission, reads, writes, releases locks and reconnects", async () => {
  let controller,
    requests = 0,
    closed = 0,
    openedRate,
    writes = [],
    messages = [];
  const port = {
    async open(options) {
      openedRate = options.baudRate;
      this.readable = new ReadableStream({
        start(c) {
          controller = c;
        },
      });
      this.writable = new WritableStream({
        write(data) {
          writes.push(new TextDecoder().decode(data));
        },
      });
    },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      closed++;
    },
  };
  const monitor = new BrowserSerialMonitor(
    {
      requestPort() {
        requests++;
        return Promise.resolve(port);
      },
    },
    (text) => messages.push(text),
    () => {},
  );
  const opening = monitor.connect(115200);
  assert.equal(requests, 1);
  await opening;
  assert.equal(openedRate, 115200);
  controller.enqueue(new TextEncoder().encode("hello\n"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ["hello\n"]);
  await monitor.send("command\n");
  assert.deepEqual(writes, ["command\n"]);
  await monitor.disconnect();
  assert.equal(closed, 1);
  assert.equal(monitor.port, null);
  await monitor.connect(9600);
  await monitor.disconnect();
  assert.equal(closed, 2);
});
test("browser serial exposes missing API, cancelled chooser and open failures", async () => {
  const unsupported = new BrowserSerialMonitor(
    null,
    () => {},
    () => {},
  );
  await assert.rejects(unsupported.connect(115200), /unavailable/);
  const cancelled = new BrowserSerialMonitor(
    {
      requestPort: async () => {
        throw new DOMException("cancelled", "NotFoundError");
      },
    },
    () => {},
    () => {},
  );
  await assert.rejects(
    cancelled.connect(115200),
    (error) => error.name === "NotFoundError",
  );
  assert.equal(cancelled.port, null);
  const busy = new BrowserSerialMonitor(
    {
      requestPort: async () => ({
        open: async () => {
          throw Error("Access denied");
        },
      }),
    },
    () => {},
    () => {},
  );
  await assert.rejects(busy.connect(115200), /Close other serial monitors/);
  assert.equal(busy.port, null);
});
