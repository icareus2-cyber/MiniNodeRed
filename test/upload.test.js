const { test, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.DB_PATH = ":memory:";
const { withPortHint, checkPort, db, stop } = require("../server");
after(() => {
  stop();
  db.close();
});
test("every USB upload error reminds that the port may be in use", () => {
  const generic = withPortHint("Arduino CLI exited 2", "COM4");
  assert.match(
    generic,
    /^Arduino CLI exited 2\n\nReminder: COM4 may be in use by another program \(Arduino IDE Serial Monitor, PuTTY, a browser tab using Web Serial/,
  );
  const specific =
    "COM4 is in use by another program (a serial monitor, Arduino IDE, or another Microflow window). Disconnect it and upload again.";
  assert.equal(
    withPortHint(specific, "COM4"),
    specific,
    "no duplicate reminder",
  );
});
test("the port check explains missing and invalid ports", async () => {
  const missing = await checkPort("COM250");
  assert.equal(missing.state, "missing");
  assert.match(missing.message, /COM250 is not connected/);
  await assert.rejects(checkPort("LPT1"), /serial port such as COM3/);
});
