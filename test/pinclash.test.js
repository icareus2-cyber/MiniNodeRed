// One pin for two nodes: an input and an output, or two outputs, are reported
// (with the nodes' names); two inputs, or sensors on one I2C bus, are not.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("../lib/flow");

const clashes = (nodes) =>
  analyze({ name: "t", nodes, edges: [] }, "esp32").warnings.filter((w) =>
    /not both|fight each other/.test(w),
  );
const node = (id, type, config, name) => ({ id, type, name, config });

test("input and output on one pin", () => {
  assert.deepEqual(
    clashes([
      node("a", "gpio-watch", { pin: 4 }, "BTN"),
      node("b", "digital-write", { pin: 4 }, "LED"),
    ]),
    [
      "GPIO 4 is an input for BTN (GPIO input (change)) and an output for LED (GPIO output). A pin can be an input or an output, not both: choose another pin for one of them.",
    ],
  );
});
test("two outputs on one pin", () => {
  assert.deepEqual(
    clashes([
      node("a", "digital-write", { pin: 13 }, "LED"),
      node("b", "pwm-write", { pin: 13 }, "DIM"),
    ]),
    [
      "GPIO 13 is driven by LED (GPIO output) and DIM (PWM out): two outputs on one pin fight each other. Choose another pin for one of them.",
    ],
  );
});
test("two inputs, and a shared I2C bus, are fine; device pins count", () => {
  assert.deepEqual(
    clashes([
      node("a", "gpio-watch", { pin: 4 }),
      node("b", "digital-read", { pin: 4 }),
      node("g1", "input-device", { device: "gyro" }),
      node("g2", "input-device", { device: "gyro", address: "105" }),
    ]),
    [],
  );
  assert.equal(
    clashes([
      node("g1", "input-device", { device: "gyro" }, "GYRO1"),
      node("o", "digital-write", { pin: 22 }, "OUT22"),
    ]).length,
    1,
  );
  assert.match(
    clashes([
      node("s", "output-device", { device: "stepper", pin: 25 }, "STEPPER1"),
      node("i", "gpio-watch", { pin: 25 }, "SW"),
    ])[0],
    /GPIO 25 is an input for SW .* and an output for STEPPER1 \(Output device\)/,
  );
});
