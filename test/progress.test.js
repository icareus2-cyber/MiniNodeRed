// Compile / upload progress bar (lib/progress.js): stages from arduino-cli's verbose
// output, esptool's percentages weighted by size, times remembered per board, and the
// verbose command lines kept out of the console.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BuildProgress, noise } = require("../lib/progress");

const clock = () => {
  let t = 1000000;
  return { now: () => t, wait: (ms) => (t += ms) };
};
const make = (opts, c) => {
  const sent = [];
  const p = new BuildProgress({
    family: "esp32",
    timingFile: opts.timingFile,
    action: opts.action || "compile",
    method: opts.method,
    now: c.now,
    send: (e) => sent.push(e),
  });
  return { p, sent };
};
const tmp = () =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mf-progress-")),
    "esp32",
    "timing.json",
  );
// Verbose output of an ESP32 compile (shortened), with seconds spent per stage.
const COMPILE = [
  ["Detecting libraries used...", 5],
  [
    '"C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Arduino15\\\\packages\\\\esp32\\\\tools\\\\esp-x32\\\\bin/xtensa-esp32s3-elf-g++" -c -w -Os -DF_CPU=240000000L sketch.ino.cpp -o nul',
    0,
  ],
  ["Alternatives for WiFi.h: [WiFi@3.0.7]", 0],
  ["Generating function prototypes...", 2],
  ["Compiling sketch...", 20],
  ["Compiling libraries...", 30],
  ['Compiling library "WiFi"', 0],
  ["Using previously compiled file: C:\\build\\libraries\\WiFi\\WiFi.cpp.o", 0],
  ["Compiling core...", 90],
  ["Linking everything together...", 10],
  [
    "Sketch uses 1097888 bytes (83%) of program storage space. Maximum is 1310720 bytes.",
    0,
  ],
];

test("compile: stages move the bar forward, never back; times are kept for next time", () => {
  const c = clock();
  const file = tmp();
  const { p, sent } = make({ timingFile: file }, c);
  let last = 0;
  for (const [line, secs] of COMPILE) {
    p.compileLine(line);
    for (let k = 0; k < secs; k++) {
      c.wait(1000);
      p.compileLine("");
    }
    const now = sent.at(-1).pct;
    assert.ok(now >= last, `went back at ${line}: ${last} → ${now}`);
    last = now;
  }
  assert.ok(sent.some((e) => e.label === "Compiling the board core"));
  assert.ok(last >= 90 && last <= 99, `before finish ${last}`);
  p.finish(true);
  assert.deepEqual(
    { pct: sent.at(-1).pct, done: sent.at(-1).done, label: sent.at(-1).label },
    { pct: 100, done: true, label: "Compiled" },
  );
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.core, 90000);
  assert.equal(saved.sketch, 20000);

  // The next build here: same stages, so the estimate is right from the start.
  const c2 = clock();
  const { p: p2, sent: s2 } = make({ timingFile: file }, c2);
  p2.compileLine("Detecting libraries used...");
  c2.wait(5000);
  p2.compileLine("Generating function prototypes...");
  c2.wait(2000);
  p2.compileLine("Compiling sketch...");
  c2.wait(10000);
  p2.compileLine("");
  const mid = s2.at(-1);
  // 17 s of 157 s: about 11 %; time left about 140 s.
  assert.ok(Math.abs(mid.pct - 10) <= 2, `pct ${mid.pct}`);
  assert.ok(mid.left >= 120 && mid.left <= 160, `left ${mid.left}`);
});

test("upload: esptool parts weighted by size; failure keeps the bar", () => {
  const c = clock();
  const { p, sent } = make(
    { timingFile: tmp(), action: "upload", method: "usb" },
    c,
  );
  for (const [line] of COMPILE) p.compileLine(line);
  const before = sent.at(-1).pct;
  p.appBytes = 1097888;
  const lines = [
    "esptool.py v4.6",
    "Connecting....",
    "Compressed 20224 bytes to 13024...",
    "Writing at 0x00000000... (100 %)",
    "Wrote 20224 bytes (13024 compressed) at 0x00000000 in 0.4 seconds",
    "Compressed 3072 bytes to 146...",
    "Writing at 0x00008000... (100 %)",
    "Compressed 1097888 bytes to 690000...",
    "Writing at 0x00010000... (2 %)",
  ];
  for (const l of lines) {
    c.wait(300);
    p.uploadLine(l);
  }
  p.update(true);
  const early = sent.at(-1);
  assert.equal(early.label, "Uploading over USB");
  assert.ok(
    early.pct >= before && early.pct < before + 5,
    `small parts barely move it: ${early.pct}`,
  );
  c.wait(300);
  p.uploadLine("Writing at 0x00090000... (50 %)");
  p.update(true);
  const half = sent.at(-1).pct;
  assert.ok(half >= early.pct + 4, `half the app: ${half} (from ${early.pct})`);
  p.uploadLine("Writing at 0x00110000... (100 %)");
  p.update(true);
  assert.ok(sent.at(-1).pct <= 99);
  p.finish(false);
  assert.equal(sent.at(-1).done, true);
  assert.equal(sent.at(-1).ok, false);
  assert.equal(sent.at(-1).pct, sent.at(-2).pct);
});

test("remote update: its own percentage", () => {
  const c = clock();
  const { p, sent } = make(
    { timingFile: tmp(), action: "upload", method: "mqtt" },
    c,
  );
  for (const [line] of COMPILE) p.compileLine(line);
  p.remote(0);
  const start = sent.at(-1).pct;
  p.remote(50);
  assert.equal(sent.at(-1).label, "Sending the update");
  assert.ok(sent.at(-1).pct > start);
});

test("verbose command lines are hidden, warnings and errors are not", () => {
  assert.equal(noise(COMPILE[1][0]), true);
  assert.equal(noise("Using previously compiled file: x.o"), true);
  assert.equal(noise("Alternatives for WiFi.h: [WiFi@3.0.7]"), true);
  assert.equal(noise("Compiling core..."), false);
  assert.equal(
    noise("sketch.ino:12:5: error: 'foo' was not declared in this scope"),
    false,
  );
  assert.equal(
    noise("Sketch uses 1097888 bytes (83%) of program storage space."),
    false,
  );
  assert.equal(noise("Writing at 0x00010000... (2 %)"), false);
});
