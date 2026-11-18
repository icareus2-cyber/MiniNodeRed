// Serial monitor strip (public/serialmon.js): present in the page, after panels.js,
// with Start / Stop and a baud selector that defaults to 115200.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pub = (f) => fs.readFileSync(path.join(__dirname, "../public", f), "utf8");

test("serial monitor markup: Start, Stop, baud 115200 by default", () => {
  const html = pub("index.html");
  for (const id of ["serialMon", "monBaud", "monStart", "monStop", "monOut", "monForm"])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<option selected>115200<\/option>\s*<option>230400/);
  assert.ok(html.indexOf("panels.js") < html.indexOf("serialmon.js"));
  // The monitor sits in the console panel, above the log.
  assert.ok(html.indexOf('id="serialMon"') < html.indexOf('id="logArea"'));
});
test("the board's text reaches the monitor, and the log skips it while it is open", () => {
  const app = pub("app.js");
  assert.match(app, /serialMonText\(event\.payload\)/);
  assert.match(app, /serialMonRunning\(\)\s*\)\s*return;/);
});
test("serialmon.js parses", () => {
  new Function(pub("serialmon.js"));
});
