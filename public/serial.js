// Right after opening: DTR and RTS are released (DTR first), the running state of the
// usual auto-reset circuit, so the board is not left in download mode. The chip's own
// USB (TinyUSB) needs DTR on to pass data.
async function quietLines(port) {
  if (!port.setSignals) return;
  await port.setSignals(
    port.native
      ? { dataTerminalReady: true, requestToSend: false }
      : { dataTerminalReady: false, requestToSend: false },
  ).catch(() => {});
}
class BrowserSerialMonitor {
  constructor(serial, onData, onStatus) {
    this.serial = serial;
    this.onData = onData;
    this.onStatus = onStatus;
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.writeTask = null;
    this.closing = false;
  }
  // known: a port already chosen (e.g. the one just flashed, webflash.js), so the
  // browser's port list is not shown again.
  async connect(baudRate, known = null) {
    if (!this.serial)
      throw Error(
        "Web Serial is unavailable in this browser. Choose Local serial or open this app in a browser supporting Web Serial.",
      );
    if (this.port) throw Error("Disconnect serial first.");
    // requestPort must be called directly from the user's click, before awaiting other work.
    const port = known || (await this.serial.requestPort());
    try {
      await port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      });
    } catch (error) {
      throw Error(
        `Cannot open the browser serial port: ${error.message}. Close other serial monitors and retry.`,
      );
    }
    // The chip's own USB (Espressif VID 0x303A, TinyUSB) passes
    // data only while DTR is on and has no reset line. 0x1001 (USB-Serial-JTAG)
    // emulates the classic DTR/RTS reset circuit, so it is left alone.
    const info = port.getInfo?.() || {};
    port.native = info.usbVendorId === 0x303a && info.usbProductId !== 0x1001;
    await quietLines(port);
    this.port = port;
    this.closing = false;
    this.onStatus(true, `Web Serial connected · ${baudRate} baud`);
    this.readTask = this.readLoop(port);
  }
  async readLoop(port) {
    const decoder = new TextDecoder();
    try {
      this.reader = port.readable.getReader();
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (this.tap?.(value)) continue; // baud detection captures raw bytes
        const text = decoder.decode(value, { stream: true });
        if (text) this.onData(text);
      }
      const tail = decoder.decode();
      if (tail) this.onData(tail);
    } catch (error) {
      if (!this.closing)
        this.onStatus(false, `Serial read failed: ${error.message}`);
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      if (!this.closing) {
        try {
          await this.writeTask;
          await port.close();
        } catch {}
        if (this.port === port) this.port = null;
        this.onStatus(false, "Web Serial disconnected");
      }
    }
  }
  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    await this.reader?.cancel().catch(() => {});
    await this.readTask;
    await this.writeTask?.catch(() => {});
    try {
      await port.close();
    } finally {
      this.port = null;
      this.onStatus(false, "Web Serial disconnected");
    }
  }
  async send(text) {
    if (!this.port || this.closing) throw Error("Connect serial first.");
    if (this.writeTask) throw Error("A serial write is already in progress.");
    const data = new TextEncoder().encode(text);
    if (data.byteLength > 4096)
      throw Error("Serial messages must be at most 4096 bytes.");
    const writer = this.port.writable.getWriter();
    this.writeTask = writer.write(data);
    try {
      await this.writeTask;
    } finally {
      writer.releaseLock();
      this.writeTask = null;
    }
  }
}
// Pulses EN through RTS with DTR (GPIO0) released: a normal reset, like pressing RST.
BrowserSerialMonitor.prototype.reset = async function () {
  if (!this.port || this.closing) throw Error("Connect serial first.");
  if (this.port.native)
    throw Error(
      "This port is the chip's own USB, which has no reset line. Press RESET on the board, or type reboot in the test terminal (debug builds).",
    );
  if (!this.port.setSignals)
    throw Error("This browser cannot drive the reset line.");
  await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await new Promise((r) => setTimeout(r, 120));
  await this.port.setSignals({
    dataTerminalReady: false,
    requestToSend: false,
  });
};
// Web Serial cannot change speed in place: stop reading, reopen the same port
// (no new permission prompt) at the new rate, and resume.
BrowserSerialMonitor.prototype.setBaud = async function (baudRate) {
  const port = this.port;
  if (!port || this.closing) throw Error("Connect serial first.");
  this.closing = true;
  await this.reader?.cancel().catch(() => {});
  await this.readTask;
  await this.writeTask?.catch(() => {});
  await port.close();
  await port.open({
    baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
  });
  await quietLines(port);
  this.closing = false;
  this.baudRate = baudRate;
  this.readTask = this.readLoop(port);
  this.onStatus(true, `Web Serial connected · ${baudRate} baud`);
};
// Finds the board's baud rate (detectBaud in chipstatus.js); keeps the original if none fits.
BrowserSerialMonitor.prototype.detectBaud = async function (detect, original) {
  let captured = [];
  this.tap = (bytes) => (captured.push(...bytes), true);
  try {
    const result = await detect({
      setBaud: (rate) => this.setBaud(rate),
      send: (text) => this.send(text),
      take: () => {
        const bytes = Uint8Array.from(captured);
        captured = [];
        return bytes;
      },
    });
    await this.setBaud((!result.rom && result.rate) || original); // boot-ROM text is not a baud answer
    return result;
  } finally {
    this.tap = null;
  }
};
if (typeof module !== "undefined") module.exports = { BrowserSerialMonitor };
