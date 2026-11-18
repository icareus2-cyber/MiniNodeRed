// Progress of a compile and an upload, for the IDE's progress bar.
//
// Compiling: arduino-cli runs with --verbose, which names its stages (detecting
// libraries, function prototypes, sketch, libraries, core, linking). How long each
// stage took last time on this PC (builds/<board>/timing.json) gives the share of the
// bar and the time left; the first build uses typical times. Within a stage the bar
// moves with the time, and never past what the stage took last time.
// Uploading over USB: esptool prints "Writing at 0x… (45 %)" for each part it writes
// (bootloader, partitions, app…), after "Compressed N bytes"; the parts are weighted
// by their size. Remote updates report a percentage themselves.
const fs = require("node:fs");
const path = require("node:path");

const STAGES = [
  ["detect", /^Detecting libraries used/i, "Detecting libraries"],
  ["prototypes", /^Generating function prototypes/i, "Preparing the sketch"],
  ["sketch", /^Compiling sketch/i, "Compiling the sketch"],
  ["libraries", /^Compiling libraries/i, "Compiling libraries"],
  ["core", /^Compiling core/i, "Compiling the board core"],
  ["link", /^Linking everything together/i, "Linking"],
];
// Typical seconds per stage for a first build (no cache), per chip family.
const TYPICAL = {
  esp32: {
    detect: 20,
    prototypes: 4,
    sketch: 30,
    libraries: 60,
    core: 150,
    link: 20,
    upload: 30,
  },
  esp8266: {
    detect: 10,
    prototypes: 3,
    sketch: 15,
    libraries: 25,
    core: 50,
    link: 10,
    upload: 25,
  },
};
// Lines of the verbose output that only show commands and cache use: kept out of
// the console and error messages (warnings and errors stay).
function noise(line) {
  const t = line.trim();
  if (!t) return false;
  if (
    /^(Using previously compiled file|Using cached library dependencies|Using precompiled core|Using library |Using core |Using board |Alternatives for|ResolveLibrary\(|  -> candidates|  -> found|Skipping dependencies detection|Archiving built core|Using cached core|Using cached)/.test(
      t,
    )
  )
    return true;
  // Compiler, archiver and tool invocations: a quoted executable or a long command.
  if (
    /^"[^"]+(gcc|g\+\+|ar|objcopy|esptool[^"]*|python[^"]*|size|elf2image)[^"]*"\s/i.test(
      t,
    )
  )
    return true;
  if (t.length > 400 && /\s-[cIDo]\S*/.test(t)) return true;
  return false;
}
const SECOND = 1000;
class BuildProgress {
  // action: "compile" | "upload"; method: "usb" | "mqtt" | "lan"; send(event fields)
  constructor({
    action,
    method = "usb",
    family = "esp32",
    timingFile,
    send,
    now = Date.now,
  }) {
    this.action = action;
    this.method = method;
    this.now = now;
    this.send = send;
    this.timingFile = timingFile;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(timingFile, "utf8"));
    } catch {}
    this.known = !!saved;
    const typical = TYPICAL[family] || TYPICAL.esp32;
    // Expected milliseconds per stage, from the last build here or typical times.
    this.expect = Object.fromEntries(
      [...STAGES.map(([k]) => k), "upload"].map((k) => [
        k,
        Math.max(300, saved?.[k] ?? typical[k] * SECOND),
      ]),
    );
    this.took = {};
    this.start = now();
    this.stage = "start";
    this.stageStart = this.start;
    this.uploadPct = 0;
    this.parts = []; // upload: { bytes, pct }
    this.shown = -1;
    this.lastSend = 0;
  }
  // Milliseconds the whole job is expected to take.
  total() {
    const compile = STAGES.reduce((s, [k]) => s + this.expect[k], 0);
    return compile + (this.action === "upload" ? this.expect.upload : 0);
  }
  // Expected milliseconds before stage k starts.
  before(k) {
    let sum = 0;
    for (const [key] of STAGES) {
      if (key === k) return sum;
      sum += this.expect[key];
    }
    return sum; // "upload"
  }
  enter(stage) {
    if (stage === this.stage) return;
    const t = this.now();
    if (this.stage !== "start") this.took[this.stage] = t - this.stageStart;
    this.stage = stage;
    this.stageStart = t;
    this.update(true);
  }
  // One line of arduino-cli compile output.
  compileLine(line) {
    const t = line.trim();
    for (const [key, re] of STAGES) if (re.test(t)) return this.enter(key);
    if (
      /^Sketch uses|^Global variables use|IROM|Variables and constants in RAM/.test(
        t,
      )
    )
      this.enter("size");
    this.update();
  }
  // One line of arduino-cli upload (esptool) output.
  uploadLine(line) {
    if (this.stage !== "upload") this.enter("upload");
    const t = line.trim();
    const size = /^Compressed (\d+) bytes/.exec(t);
    if (size) this.parts.push({ bytes: Number(size[1]), pct: 0 });
    const pct = /\((\d{1,3}) ?%\)/.exec(t);
    if (pct && this.parts.length) this.parts.at(-1).pct = Number(pct[1]);
    if (/^Wrote \d+ bytes/.test(t) && this.parts.length)
      this.parts.at(-1).pct = 100;
    // Done share of the bytes written so far; the app (by far the largest part)
    // counts from the start, so the bar does not race through the small parts.
    if (this.parts.length) {
      const app = Math.max(
        this.appBytes || 0,
        ...this.parts.map((p) => p.bytes),
      );
      const known = this.parts.reduce((s, p) => s + p.bytes, 0);
      const all = Math.max(known, app + 64 * 1024);
      const done = this.parts.reduce((s, p) => s + (p.bytes * p.pct) / 100, 0);
      this.uploadPct = Math.min(99, (100 * done) / all);
    }
    this.update();
  }
  // Remote update progress (0–100).
  remote(pct) {
    if (this.stage !== "upload") this.enter("upload");
    this.uploadPct = Math.min(100, pct);
    this.update(true);
  }
  // 0–100 for the whole job.
  percent() {
    const total = this.total();
    if (this.stage === "start") return 0;
    if (this.stage === "upload")
      return (
        ((this.before("upload") + (this.expect.upload * this.uploadPct) / 100) /
          total) *
        100
      );
    if (this.stage === "size")
      return (this.before("upload") / total) * 100 - 0.5;
    // Within a compile stage: by time, up to 95 % of what it took last time.
    const within = Math.min(
      this.now() - this.stageStart,
      this.expect[this.stage] * 0.95,
    );
    return ((this.before(this.stage) + within) / total) * 100;
  }
  label() {
    if (this.stage === "start") return "Starting the compiler";
    if (this.stage === "size") return "Checking the size";
    if (this.stage === "upload")
      return this.method === "usb"
        ? "Uploading over USB"
        : "Sending the update";
    return STAGES.find(([k]) => k === this.stage)[2];
  }
  // Sends the progress (at most 4 times a second unless forced).
  update(force = false) {
    const t = this.now();
    if (!force && t - this.lastSend < 250) return;
    this.lastSend = t;
    const pct = Math.max(this.shown, Math.min(99, Math.floor(this.percent())));
    this.shown = pct;
    const elapsed = t - this.start;
    // Time left: from the share done and the time so far, or the expected total.
    const left =
      this.known || pct > 15
        ? Math.max(
            0,
            Math.round(
              (pct > 15
                ? (elapsed * (100 - pct)) / pct
                : this.total() - elapsed) / SECOND,
            ),
          )
        : null;
    this.send({
      pct,
      stage: this.stage,
      label: this.label(),
      elapsed: Math.round(elapsed / SECOND),
      left,
    });
  }
  // The job ended: 100 % (or the failure), and the stage times kept for next time.
  finish(ok) {
    const t = this.now();
    if (this.stage !== "start" && this.stage !== "size")
      this.took[this.stage] = t - this.stageStart;
    if (ok) {
      try {
        const saved = { ...this.expectSaved(), ...this.took };
        fs.mkdirSync(path.dirname(this.timingFile), { recursive: true });
        fs.writeFileSync(this.timingFile, JSON.stringify(saved));
      } catch {}
    }
    this.send({
      pct: ok ? 100 : this.shown,
      stage: ok ? "done" : "failed",
      label: ok
        ? this.action === "upload"
          ? "Uploaded"
          : "Compiled"
        : "Stopped: see the console",
      elapsed: Math.round((t - this.start) / SECOND),
      left: 0,
      done: true,
      ok,
    });
  }
  // Stage times measured before (kept when this run skipped a stage, e.g. upload).
  expectSaved() {
    try {
      return JSON.parse(fs.readFileSync(this.timingFile, "utf8"));
    } catch {
      return {};
    }
  }
}
module.exports = { BuildProgress, noise, STAGES };
