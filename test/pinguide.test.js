const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkPin, publicBoards } = require("../lib/boards");
// The pin guide is browser code; load its pure functions from panels.js.
const src = fs.readFileSync(
  path.join(__dirname, "../public/panels.js"),
  "utf8",
);
const start = src.indexOf("function pinAdvice(");
const end = src.indexOf("function pinGuide(");
const { pinAdvice, suitablePins } = new Function(
  `${src.slice(start, end)}; return { pinAdvice, suitablePins };`,
)();
test("the pin guide agrees with the board check for every board, pin and use", () => {
  for (const board of publicBoards())
    for (let pin = 0; pin <= 48; pin++)
      for (const use of ["in", "out", "pwm", "adc"]) {
        const server = checkPin(board.id, pin, use, "n").errors.length > 0;
        const guide = pinAdvice(board, pin, use, "pullup").some(
          ([level]) => level === "bad",
        );
        assert.equal(
          guide,
          server,
          `${board.id} GPIO ${pin} as ${use}: guide ${guide}, board check ${server}`,
        );
      }
});
test("suggested pins are always accepted, and the guide explains TTGO specifics", () => {
  for (const board of publicBoards())
    for (const use of ["in", "out", "pwm", "adc"])
      for (const pin of suitablePins(board, use))
        assert.deepEqual(
          checkPin(board.id, pin, use, "n").errors,
          [],
          `${board.id} suggests GPIO ${pin} for ${use}`,
        );
  const ttgo = publicBoards().find((b) => b.id === "ttgo-t-display");
  const text = (pin, use, pull) =>
    pinAdvice(ttgo, pin, use, pull)
      .map(([, t]) => t)
      .join(" ");
  assert.match(text(38, "out"), /input-only: it cannot drive an output/);
  assert.match(
    text(38, "in", "pullup"),
    /no internal pull-up: wire a 10 kΩ resistor/,
  );
  assert.match(text(38, "in", "none"), /can be read \(input-only pin\)/);
  assert.match(text(5, "out"), /used by the built-in display CS/);
  assert.match(text(0, "in"), /Boot pin .*Shared with button 1/);
  assert.ok(
    !suitablePins(ttgo, "out").some((p) => p >= 34),
    "no input-only pins offered for output",
  );
  assert.ok(
    !suitablePins(ttgo, "out").some((p) => [4, 5, 16, 18, 19, 23].includes(p)),
    "no display pins offered",
  );
});
