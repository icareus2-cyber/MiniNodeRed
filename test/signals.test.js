// Analog values do not go straight into Logic / Timer, nor on / off values straight
// into analog outputs (PWM out, Output device): a converter must go between them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("../lib/flow");
const { catalog } = require("../lib/nodes");

const node = (id, type, config = {}) => ({ id, type, config });
const errors = (nodes, pairs) =>
  analyze(
    { name: "t", nodes, edges: pairs.map(([from, to]) => ({ from, to })) },
    "esp32",
  ).errors.filter((e) => e.includes("→"));
const adc = node("a", "analog-in", { pin: 34 });

test("analog into Logic or Timer needs a Threshold or Compare", () => {
  assert.match(
    errors([adc, node("l", "logic")], [["a", "l"]])[0],
    /^Analog sample → Logic: an analog value is not on \/ off.*Threshold/,
  );
  assert.equal(
    errors([node("s", "input-device"), node("t", "timer")], [["s", "t"]])
      .length,
    1,
  );
  // Through a pass-on node it is still analog; a converter makes it on / off.
  assert.equal(
    errors(
      [adc, node("th", "throttle"), node("l", "logic")],
      [
        ["a", "th"],
        ["th", "l"],
      ],
    ).length,
    1,
  );
  for (const conv of ["threshold", "compare"])
    assert.deepEqual(
      errors(
        [adc, node("c", conv), node("l", "logic")],
        [
          ["a", "c"],
          ["c", "l"],
        ],
      ),
      [],
    );
});
test("Logic or Timer into an analog output needs a Map range", () => {
  const sw = node("s", "test-switch");
  assert.match(
    errors(
      [sw, node("l", "logic"), node("p", "pwm-write", { pin: 13 })],
      [
        ["s", "l"],
        ["l", "p"],
      ],
    )[0],
    /^Logic → PWM out: an on \/ off value.*Map range/,
  );
  assert.equal(
    errors(
      [sw, node("t", "timer"), node("m", "output-device")],
      [
        ["s", "t"],
        ["t", "m"],
      ],
    ).length,
    1,
  );
  assert.deepEqual(
    errors(
      [
        sw,
        node("l", "logic"),
        node("r", "scale"),
        node("p", "pwm-write", { pin: 13 }),
      ],
      [
        ["s", "l"],
        ["l", "r"],
        ["r", "p"],
      ],
    ),
    [],
  );
  // Digital inputs into Logic, and analog into analog outputs, are fine.
  assert.deepEqual(
    errors(
      [node("g", "gpio-watch", { pin: 4 }), node("l", "logic")],
      [["g", "l"]],
    ),
    [],
  );
  assert.deepEqual(
    errors([adc, node("p", "pwm-write", { pin: 13 })], [["a", "p"]]),
    [],
  );
});
test("the editor gets the signal kinds", () => {
  const c = catalog();
  assert.equal(c["analog-in"].signal, "analog");
  assert.equal(c["pwm-write"].signal, "analog-out");
  assert.equal(c.timer.signal, "logic");
  assert.equal(c.threshold.signal, null);
});
