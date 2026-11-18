// Before a USB upload: is the serial port there, and is the chip on it the one the
// chosen board has? The chip type comes from esptool (the copy the ESP32 core
// installs), which resets the board into its boot ROM, asks, and resets it again.
// A different chip stops the upload before anything is compiled; when the chip
// cannot be read (e.g. a board that needs BOOT held), the upload goes ahead with a
// warning, since the upload itself may still work.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// The chip a board's firmware is built for, as esptool names it (null: not checked).
function expectedChip(board) {
  if (!board) return null;
  if (board.family === "esp8266") return "ESP8266";
  if (board.family !== "esp32") return null; // e.g. Realtek BW16: no esptool
  const id = String(board.fqbn || "").split(":")[2] || "";
  const m = /^esp32(s2|s3|c2|c3|c5|c6|h2|p4)/.exec(id);
  return m ? `ESP32-${m[1].toUpperCase()}` : "ESP32";
}
// The chip esptool found, from its output (esptool 4 and 5 word it differently).
function parseChip(output) {
  const text = String(output).replace(/\x1b\[[0-9;]*m/g, "");
  const m =
    /Chip type:\s+(ESP[\w-]+)/i.exec(text) ||
    /Chip is (ESP[\w-]+)/i.exec(text) ||
    /Connected to (ESP[\w-]+) on/i.exec(text) ||
    /Detecting chip type\.*\s*(ESP[\w-]+)/i.exec(text);
  if (!m) return null;
  const chip = m[1].toUpperCase().replace(/^ESP32(?=[A-Z])/, "ESP32-");
  if (/^ESP8266/.test(chip)) return "ESP8266";
  // The family: ESP32-S3, -C3, …; the classic ESP32's packages (D0WD-V3, PICO-D4,
  // U4WDH, …) are all "ESP32".
  const family = /^ESP32-(S2|S3|C2|C3|C5|C61|C6|H2|P4)(?![0-9])/.exec(chip);
  if (family) return `ESP32-${family[1]}`;
  return /^ESP32/.test(chip) ? "ESP32" : chip;
}
// Why esptool could not read the chip, in a few words (null: not a known reason).
function failureReason(output) {
  const text = String(output);
  // esptool 5 says "the port is busy or doesn't exist" for both: the OS error decides.
  if (/Access is denied|Permission denied|PermissionError|Resource busy|in use by/i.test(text))
    return "busy";
  if (/No such file|FileNotFoundError|cannot find the file|doesn't exist|could not open port/i.test(text))
    return "missing";
  if (/Failed to connect|No serial data received|Timed out|Wrong boot mode/i.test(text))
    return "no answer";
  return null;
}
const versionKey = (v) =>
  String(v)
    .split(/[.-]/)
    .map((x) => String(Number(x) || 0).padStart(6, "0"))
    .join(".");
// The newest esptool the ESP32 core installed under the Arduino data folder.
function findEsptool(dataDir, platform = process.platform) {
  if (!dataDir) return null;
  const root = path.join(dataDir, "packages", "esp32", "tools", "esptool_py");
  let versions = [];
  try {
    versions = fs.readdirSync(root).sort((a, b) => (versionKey(b) > versionKey(a) ? 1 : -1));
  } catch {
    return null;
  }
  for (const v of versions)
    for (const name of platform === "win32" ? ["esptool.exe"] : ["esptool"]) {
      const file = path.join(root, v, name);
      if (fs.existsSync(file)) return { file, major: Number(v.split(".")[0]) || 0 };
    }
  return null;
}
// esptool 5 spells its commands with "-", esptool 4 with "_".
const chipArgs = (port, major) =>
  major >= 5
    ? ["--port", port, "--before", "default-reset", "--after", "hard-reset", "chip-id"]
    : ["--port", port, "--before", "default_reset", "--after", "hard_reset", "chip_id"];
function runTool(file, args, timeout = 25000) {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try {
      p = spawn(file, args, { shell: false, windowsHide: true });
    } catch (e) {
      return resolve(String(e.message));
    }
    const timer = setTimeout(() => {
      p.kill();
      out += "\nTimed out";
    }, timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => (out += "\n" + e.message));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
const describePort = (p) =>
  `${p.path}${p.friendlyName || p.manufacturer ? ` (${String(p.friendlyName || p.manufacturer).replace(/\s*\(COM\d+\)$/, "")})` : ""}`;
// The check. opts: port, board (lib/boards entry), boards ({ id: board }, for suggestions),
// listPorts() → [{ path, … }], esptool ({ file, major } or null), run(file, args)
// → output. Returns { chip, notes: [] }; throws when the upload must not start.
async function checkUploadTarget(opts) {
  const { port, board } = opts;
  const notes = [];
  const ports = await opts.listPorts();
  if (!ports.some((p) => p.path === port))
    throw Error(
      `${port} is not connected, so nothing was compiled or uploaded. ` +
        (ports.length
          ? `Serial ports found: ${ports.map(describePort).join(", ")}. Choose the board's port in the Device panel (↻ refreshes the list).`
          : "No serial ports were found: plug the board in with a data cable (some USB cables only charge) and refresh the port list (↻)."),
    );
  const want = expectedChip(board);
  if (!want) return { chip: null, notes };
  if (!opts.esptool) {
    notes.push(
      `Chip type not checked: esptool was not found (it comes with the ESP32 core). Uploading to ${port} as ${board.label}.`,
    );
    return { chip: null, notes };
  }
  const output = await (opts.run || runTool)(opts.esptool.file, chipArgs(port, opts.esptool.major));
  const chip = parseChip(output);
  if (!chip) {
    const why = failureReason(output);
    if (why === "busy")
      throw Error(
        `${port} is in use by another program (Arduino IDE Serial Monitor, PuTTY, a browser tab using Web Serial, or another Microflow window). Close it and upload again. Nothing was compiled or uploaded.`,
      );
    if (why === "missing")
      throw Error(`${port} could not be opened: is the board still plugged in? Nothing was compiled or uploaded.`);
    notes.push(
      `Could not read the chip type on ${port} (${why === "no answer" ? "the chip did not answer" : "esptool gave no chip type"}). Uploading anyway as ${board.label}; if the upload fails, hold BOOT while it starts.`,
    );
    return { chip: null, notes };
  }
  if (chip !== want) {
    const matching = Object.entries(opts.boards || {}).filter(
      ([, b]) => b && expectedChip(b) === chip,
    );
    const fits = matching.map(([, b]) => b.label);
    throw Object.assign(Error(
      `The board on ${port} is an ${chip}, but the Device panel is set to ${board.label} (${want}). ` +
        (fits.length
          ? `Choose a board for the ${chip} (${fits.slice(0, 4).join("; ")}${fits.length > 4 ? "; …" : ""})`
          : `Microflow has no ${chip} board yet; choose the right board`) +
        ` or plug in the ${want} board. Nothing was compiled or uploaded.`,
      ),
      { chip, fits: matching.map(([id]) => id) },
    );
  }
  return { chip, notes };
}
module.exports = {
  expectedChip,
  parseChip,
  failureReason,
  findEsptool,
  chipArgs,
  checkUploadTarget,
};
