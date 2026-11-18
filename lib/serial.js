const { SerialPort } = require("serialport");
const { detectBaud } = require("../public/chipstatus");
const { StringDecoder } = require("node:string_decoder");
const { portKeepsDtr } = require("./usbotg");
const NO_RESET_LINE =
  "This port is the chip's own USB, which has no reset line. Press RESET on the board, or type reboot in the test terminal (debug builds).";
const baudRates = [
  9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600,
];
class LocalSerialMonitor {
  constructor(emit, Port = SerialPort) {
    this.emit = emit;
    this.Port = Port;
    this.port = null;
    this.busy = false;
  }
  status() {
    return {
      connected: !!this.port?.isOpen,
      path: this.port?.path || null,
      baudRate: this.port?.baudRate || null,
    };
  }
  async list() {
    return this.Port.list();
  }
  async connect(path, baudRate) {
    if (this.busy || this.port?.isOpen)
      throw Error(
        "A serial port is already connected or changing state. Disconnect first.",
      );
    if (!baudRates.includes(baudRate)) throw Error("Unsupported baud rate.");
    this.busy = true;
    try {
      const ports = await this.list();
      if (!ports.some((port) => port.path === path))
        throw Error("Serial port not found. Refresh the port list.");
      const port = new this.Port({ path, baudRate, autoOpen: false, hupcl: false });
      const decoder = new StringDecoder("utf8");
      let pendingText = "",
        flushTimer;
      const flush = () => {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (pendingText) {
          this.emit("serial", `${path} ←`, { payload: pendingText });
          pendingText = "";
        }
      };
      port.on("data", (data) => {
        if (this.tap?.(data)) return; // baud detection captures raw bytes
        const text = decoder.write(data);
        if (text) {
          pendingText = (pendingText + text).slice(-8192);
          if (!flushTimer) {
            flushTimer = setTimeout(flush, 100);
            flushTimer.unref?.();
          }
        }
      });
      port.on("error", (error) =>
        this.emit("error", `Serial ${path}: ${error.message}`),
      );
      port.on("close", () => {
        pendingText += decoder.end();
        flush();
        if (this.port === port) this.port = null;
        this.emit("serial-status", "Serial disconnected", { connected: false });
      });
      await new Promise((resolve, reject) =>
        port.open((error) =>
          error
            ? reject(
                Error(
                  `Cannot open ${path}: ${error.message}. Close other serial monitors and try again.`,
                ),
              )
            : resolve(),
        ),
      );
      // The chip's own USB (TinyUSB) passes data only while DTR is on.
      port.native = portKeepsDtr(ports.find((p) => p.path === path));
      // Other ports: DTR and RTS are released at once (DTR first), which is the
      // running state of the usual auto-reset circuit. Opening a port otherwise leaves
      // them as the OS set them, and the board can reset into download mode.
      if (port.set)
        await new Promise((resolve) =>
          port.set(
            port.native ? { dtr: true, rts: false } : { dtr: false, rts: false },
            () => resolve(),
          ),
        );
      this.port = port;
      this.emit(
        "serial-status",
        `Serial connected: ${path} · ${baudRate} baud`,
        this.status(),
      );
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async disconnect() {
    if (this.busy)
      throw Error(
        "Serial port is busy. Try again when the current operation finishes.",
      );
    const port = this.port;
    if (!port?.isOpen) {
      this.port = null;
      return this.status();
    }
    this.busy = true;
    try {
      await new Promise((resolve, reject) =>
        port.close((error) => (error ? reject(error) : resolve())),
      );
      this.port = null;
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async send(text) {
    if (!this.port?.isOpen) throw Error("Connect serial first.");
    if (this.busy) throw Error("Serial port is busy.");
    if (typeof text !== "string" || Buffer.byteLength(text) > 4096)
      throw Error("Serial messages must be at most 4096 bytes.");
    this.busy = true;
    const port = this.port;
    try {
      await new Promise((resolve, reject) =>
        port.write(text, (error) =>
          error
            ? reject(error)
            : port.drain((error) => (error ? reject(error) : resolve())),
        ),
      );
    } finally {
      this.busy = false;
    }
  }
}
// Pulses EN through RTS with DTR (GPIO0) released: a normal reset, like pressing RST
// on ESP auto-reset circuits. The port stays open, so the boot output is captured.
LocalSerialMonitor.prototype.reset = async function () {
  const port = this.port;
  if (!port?.isOpen) throw Error("Connect serial first.");
  if (port.native) throw Error(NO_RESET_LINE);
  const set = (signals) =>
    new Promise((resolve, reject) =>
      port.set(signals, (e) => (e ? reject(e) : resolve())),
    );
  await set({ dtr: false, rts: true });
  await new Promise((r) => setTimeout(r, 120));
  await set({ dtr: false, rts: false });
};
// Changes the speed of the open port without closing it.
LocalSerialMonitor.prototype.setBaud = async function (baudRate) {
  const port = this.port;
  if (!port?.isOpen) throw Error("Connect serial first.");
  if (!baudRates.includes(baudRate)) throw Error("Unsupported baud rate.");
  await new Promise((resolve, reject) =>
    port.update({ baudRate }, (e) => (e ? reject(e) : resolve())),
  );
  this.emit(
    "serial-status",
    `Serial connected: ${port.path} · ${baudRate} baud`,
    this.status(),
  );
  return this.status();
};
// Finds the board's baud rate (see detectBaud in public/chipstatus.js) and keeps it;
// if nothing readable arrives, the original rate is restored.
LocalSerialMonitor.prototype.detectBaud = async function () {
  const port = this.port;
  if (!port?.isOpen) throw Error("Connect serial first.");
  if (this.busy) throw Error("Serial port is busy.");
  const original = port.baudRate;
  let captured = [];
  this.tap = (data) => (captured.push(data), true);
  try {
    const result = await detectBaud({
      setBaud: (rate) =>
        new Promise((r, j) =>
          port.update({ baudRate: rate }, (e) => (e ? j(e) : r())),
        ),
      send: (text) =>
        new Promise((r) => port.write(text, () => port.drain(() => r()))),
      take: () => {
        const bytes = Buffer.concat(captured);
        captured = [];
        return bytes;
      },
    });
    await new Promise((r) =>
      port.update({ baudRate: (!result.rom && result.rate) || original }, () =>
        r(),
      ),
    );
    return { ...result, status: this.status() };
  } finally {
    this.tap = null;
    this.emit(
      "serial-status",
      `Serial connected: ${port.path} · ${port.baudRate} baud`,
      this.status(),
    );
  }
};
module.exports = { LocalSerialMonitor, baudRates };
