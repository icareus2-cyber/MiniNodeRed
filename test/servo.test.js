// Servo boxes in the PC simulation: Output device (servo) and Peripheral (servo) say
// where the servo goes ("servo" events) so the IDE can turn the robot arm on the box.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { types, catalog } = require("../lib/nodes");

const cat = catalog();
const node = (type, config) => ({
  id: "s",
  type,
  label: "Arm",
  config: {
    ...Object.fromEntries(cat[type].fields.map((f) => [f.key, f.default])),
    ...config,
  },
});
const context = (extra = {}) => {
  const moves = [];
  return {
    moves,
    ctx: {
      state: {},
      cancel() {},
      later() {},
      log() {},
      motion: (d) => moves.push(d),
      ...extra,
    },
  };
};

test("Output device servo: angle, travel time at its speed, continuous speed", () => {
  const n = node("output-device", { device: "servo", pin: 13, start: 90, speed: 90 });
  const { ctx, moves } = context();
  assert.equal(types["output-device"].host("180", n, ctx), undefined, "sent on when it arrives");
  assert.deepEqual(moves, [{ angle: 180, ms: 1000 }]);
  const fast = node("output-device", { device: "servo", pin: 13, servoIn: "percent" });
  const f = context();
  assert.equal(types["output-device"].host("50", fast, f.ctx), "90.0");
  assert.deepEqual(f.moves, [{ angle: 90, ms: 0 }]);
  const spin = node("output-device", { device: "servo", pin: 13, servoIn: "speed" });
  const s = context();
  types["output-device"].host("-40", spin, s.ctx);
  assert.deepEqual(s.moves, [{ speed: -40 }]);
});

test("Peripheral servo: turns on the trigger's rising edge", () => {
  const n = node("peripheral", { kind: "servo", trigger: "BTN1", angle: 45, pin: 12 });
  const { ctx, moves } = context({ inputs: [{ id: "b", name: "BTN1" }], from: "b" });
  types.peripheral.host("1", n, ctx);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].angle, 45);
});
