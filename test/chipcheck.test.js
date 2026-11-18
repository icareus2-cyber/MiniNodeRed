// Upload pre-check (lib/chipcheck.js): the port must be there and the chip on it must
// be the chosen board's, before anything is compiled.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boards } = require("../lib/boards");
const cc = require("../lib/chipcheck");

test("each board names the chip it is built for", () => {
  assert.equal(cc.expectedChip(boards.esp8266), "ESP8266");
  assert.equal(cc.expectedChip(boards.esp32), "ESP32");
  assert.equal(cc.expectedChip(boards["ttgo-t-display"]), "ESP32");
  assert.equal(cc.expectedChip(boards.esp32s3), "ESP32-S3");
  assert.equal(cc.expectedChip(boards.esp32c3), "ESP32-C3");
  assert.equal(cc.expectedChip(boards["esp32c3-dual"]), "ESP32-C3");
  assert.equal(cc.expectedChip(boards["esp32c6-mini"]), "ESP32-C6");
  assert.equal(cc.expectedChip(boards["esp32p4-wifi6"]), "ESP32-P4");
  assert.equal(cc.expectedChip(boards.bw16), null, "Realtek: not checked");
});
test("esptool 4 and 5 output is read", () => {
  assert.equal(cc.parseChip("Connecting....\nChip type:          ESP32-S3 (QFN56) (revision v0.2)"), "ESP32-S3");
  assert.equal(cc.parseChip("Connected to ESP32-C3 on COM5:"), "ESP32-C3");
  assert.equal(cc.parseChip("Detecting chip type... ESP32\nChip is ESP32-D0WD-V3 (revision v3.1)"), "ESP32");
  assert.equal(cc.parseChip("Chip type:          ESP32-PICO-D4 (revision v1.0)"), "ESP32");
  assert.equal(cc.parseChip("Chip is ESP32-S3 (QFN56) (revision v0.2)"), "ESP32-S3");
  assert.equal(cc.parseChip("Detecting chip type... ESP8266\nChip is ESP8266EX"), "ESP8266");
  assert.equal(cc.parseChip("Detecting chip type... ESP32-C3\nChip is ESP32-C3 (QFN32)"), "ESP32-C3");
  assert.equal(cc.parseChip("A fatal error occurred: Failed to connect"), null);
  assert.deepEqual(cc.chipArgs("COM5", 5).slice(-1), ["chip-id"]);
  assert.deepEqual(cc.chipArgs("COM5", 4).slice(-1), ["chip_id"]);
});
const ports = async () => [{ path: "COM5", manufacturer: "wch.cn" }, { path: "COM3" }];
const tool = { file: "esptool", major: 5 };
const check = (board, output, port = "COM5") =>
  cc.checkUploadTarget({
    port,
    board: boards[board],
    boards,
    listPorts: ports,
    esptool: tool,
    run: async () => output,
  });
test("a missing port stops the upload and lists the ports found", async () => {
  await assert.rejects(check("esp32", "", "COM9"), (e) => {
    assert.match(e.message, /^COM9 is not connected, so nothing was compiled or uploaded/);
    assert.match(e.message, /Serial ports found: COM5 \(wch\.cn\), COM3\./);
    return true;
  });
});
test("a different chip stops the upload and names the boards that fit", async () => {
  await assert.rejects(
    check("esp32s3", "Chip type:  ESP32-C3 (QFN32) (revision v0.4)"),
    (e) => {
      assert.match(e.message, /The board on COM5 is an ESP32-C3, but the Device panel is set to ESP32-S3 · Dev Module \(ESP32-S3\)/);
      assert.match(e.message, /ESP32-C3 · SuperMini/);
      assert.match(e.message, /Nothing was compiled or uploaded/);
      assert.equal(e.chip, "ESP32-C3");
      assert.ok(e.fits.includes("esp32c3") && e.fits.includes("esp32c3-dual"));
      return true;
    },
  );
  await assert.rejects(check("esp32", "Chip is ESP8266EX"), /is an ESP8266/);
});
test("the right chip passes; an unreadable chip only warns", async () => {
  assert.equal((await check("esp32s3", "Chip type: ESP32-S3 (QFN56)")).chip, "ESP32-S3");
  assert.equal((await check("esp32", "Chip is ESP32-D0WD-V3 (revision v3.1)")).chip, "ESP32");
  const r = await check("esp32", "A fatal error occurred: Failed to connect to ESP32: No serial data received.");
  assert.equal(r.chip, null);
  assert.match(r.notes[0], /Could not read the chip type on COM5 \(the chip did not answer\)\. Uploading anyway/);
  await assert.rejects(check("esp32", "could not open port 'COM5': PermissionError(13, 'Access is denied.')"), /in use by another program/);
  // Realtek boards: only the port is checked.
  assert.deepEqual(await check("bw16", "never run"), { chip: null, notes: [] });
  // No esptool installed: a note, and the upload goes on.
  const none = await cc.checkUploadTarget({ port: "COM5", board: boards.esp32, listPorts: ports, esptool: null });
  assert.match(none.notes[0], /esptool was not found/);
});
test("the newest esptool of the ESP32 core is found", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-esptool-"));
  for (const v of ["4.9.dev3", "5.3.1", "5.10.0"]) {
    const d = path.join(dir, "packages/esp32/tools/esptool_py", v);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "esptool"), "");
    fs.writeFileSync(path.join(d, "esptool.exe"), "");
  }
  assert.equal(cc.findEsptool(dir, "linux").file, path.join(dir, "packages/esp32/tools/esptool_py/5.10.0/esptool"));
  assert.equal(cc.findEsptool(dir, "win32").major, 5);
  assert.match(cc.findEsptool(dir, "win32").file, /esptool\.exe$/);
  assert.equal(cc.findEsptool(path.join(dir, "nothing")), null);
});
