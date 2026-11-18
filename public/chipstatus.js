// Chip status over a serial terminal (Local serial or Web Serial).
// Microflow firmware answers "mf?" with one line: MF:{"build":…,"wifi":…,"mqtt":…}.
// Shared by the browser (status card) and Node (lib/verify.js).
const CHIP_WIFI = {
  esp8266: {
    0: "idle",
    1: "SSID not found (is it 2.4 GHz and in range?)",
    3: "connected",
    4: "connection failed",
    6: "wrong WiFi password",
    7: "connecting…",
  },
  esp32: {
    0: "idle",
    1: "SSID not found (is it 2.4 GHz and in range?)",
    3: "connected",
    4: "connection failed (often a wrong password)",
    5: "connection lost",
    6: "connecting…",
  },
  // Realtek BW16 (RTL8720DN): Arduino WiFi status codes, 2.4 and 5 GHz.
  ameba: {
    0: "idle",
    1: "SSID not found (is it in range?)",
    3: "connected",
    4: "connection failed (often a wrong password)",
    5: "connection lost",
    6: "disconnected",
  },
  // Raspberry Pi Pico W / Pico 2 W (CYW43439): Arduino WiFi status codes, 2.4 GHz.
  rp2040: {
    0: "idle",
    1: "SSID not found (is it 2.4 GHz and in range?)",
    3: "connected",
    4: "connection failed (often a wrong password)",
    5: "connection lost",
    6: "disconnected",
  },
};
const CHIP_MQTT = {
  "-4": "broker did not answer in time",
  "-3": "connection lost",
  "-2": "cannot open a TCP connection to the broker (wrong Firmware broker host/port, broker not listening on the LAN, or a firewall)",
  "-1": "not connected yet",
  0: "connected",
  1: "broker rejected the MQTT protocol version",
  2: "broker rejected the client ID",
  3: "broker unavailable",
  4: "bad MQTT username or password",
  5: "not authorised by the broker",
};
const describeWifi = (code, family = "esp8266") =>
  CHIP_WIFI[family]?.[code] || `status ${code}`;
const describeMqtt = (state) => CHIP_MQTT[state] || `state ${state}`;
// Splits serial text into status reports and console text. Complete MF: lines are
// removed from the console; a partial line that could still become one is held back.
class ChipStatusParser {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.buffer = "";
    this.samples = []; // [time, bytes, unreadable] for garbage detection
  }
  feed(text, now = Date.now()) {
    let unreadable = 0;
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd)
        unreadable++;
    }
    this.samples.push([now, text.length, unreadable]);
    this.samples = this.samples.filter(([t]) => now - t < 3000);
    this.buffer += text;
    let shown = "",
      i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i + 1);
      this.buffer = this.buffer.slice(i + 1);
      const match = /MF:(\{.*\})/.exec(line);
      let status = null;
      if (match)
        try {
          status = JSON.parse(match[1]);
        } catch {}
      if (status) {
        this.onStatus(status, now);
        const before = line.slice(0, match.index);
        if (before.trim()) shown += before + "\n";
      } else shown += line;
    }
    if (
      !/^\r?(M(F(:(\{.*)?)?)?)?$/.test(this.buffer) ||
      this.buffer.length > 512
    ) {
      shown += this.buffer;
      this.buffer = "";
    }
    return shown;
  }
  // True when most recent bytes are unreadable: typically the ESP boot ROM printing
  // at 74880 baud, e.g. a crash loop, or a wrong baud rate.
  garbled() {
    const bytes = this.samples.reduce((n, s) => n + s[1], 0);
    const bad = this.samples.reduce((n, s) => n + s[2], 0);
    return bytes >= 40 && bad / bytes > 0.3;
  }
}
// ── Baud-rate detection ─────────────────────────────────────────
// Microflow firmware talks at 115200; the ESP8266 boot ROM prints at 74880.
const BAUD_CANDIDATES = [
  115200, 74880, 9600, 57600, 230400, 460800, 921600, 19200, 38400,
];
// Share of bytes that are printable ASCII or line breaks (1 = clean text).
function readability(bytes) {
  if (!bytes.length) return 0;
  let ok = 0;
  for (const b of bytes)
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) ok++;
  return ok / bytes.length;
}
// Tries each rate: switch, ask "mf?", listen, score. A Microflow reply wins at once.
// setBaud(rate), send(text) and take() (returns and clears captured bytes) are
// supplied by the transport (Local serial on the server, Web Serial in the browser).
async function detectBaud({
  setBaud,
  send,
  take,
  wait = 600,
  rates = BAUD_CANDIDATES,
}) {
  const results = [];
  for (const rate of rates) {
    await setBaud(rate);
    await new Promise((r) => setTimeout(r, 60));
    take(); // drop bytes captured while switching
    await send("mf?\n");
    await new Promise((r) => setTimeout(r, wait));
    const bytes = take();
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const microflow = /MF:\{|^» /m.test(text);
    // Readable text at 74880 is usually the ESP8266 boot ROM (boot or crash loop).
    const rom =
      rate === 74880 &&
      /Fatal exception|rst cause|ets Jan|boot mode/.test(text);
    const score = microflow ? 2 : bytes.length >= 8 ? readability(bytes) : 0;
    results.push({
      rate,
      bytes: bytes.length,
      readable: Math.round(readability(bytes) * 100),
      microflow,
      rom,
      sample: text
        .replace(/[^\x20-\x7e\n]/g, "")
        .trim()
        .slice(-160),
    });
    if (microflow) break;
  }
  const best = results.reduce(
    (a, r) => (!a || scoreOf(r) > scoreOf(a) ? r : a),
    null,
  );
  const found = best && scoreOf(best) >= 0.85;
  return {
    rate: found ? best.rate : null,
    microflow: !!best?.microflow,
    // The chip only spoke through its boot ROM: crash loop (or mid-boot), not a baud problem.
    rom: !!(found && best.rom),
    sample: found ? best.sample : "",
    results,
  };
}
const scoreOf = (r) => (r.microflow ? 2 : r.bytes >= 8 ? r.readable / 100 : 0);
if (typeof module !== "undefined")
  module.exports = {
    ChipStatusParser,
    CHIP_WIFI,
    CHIP_MQTT,
    describeWifi,
    describeMqtt,
    detectBaud,
    readability,
    BAUD_CANDIDATES,
  };
