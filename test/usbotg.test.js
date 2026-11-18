const { test } = require("node:test");
const assert = require("node:assert/strict");
const { keepsDtr, portKeepsDtr } = require("../lib/usbotg");

test("Espressif native USB ports keep DTR on; USB-Serial-JTAG and bridges do not", () => {
  assert.equal(keepsDtr(0x303a, 0x4001), true);
  assert.equal(keepsDtr(0x303a, 0x1001), false);
  assert.equal(keepsDtr(0x10c4, 0xea60), false);
  assert.equal(portKeepsDtr({ vendorId: "303A", productId: "4001" }), true);
  assert.equal(portKeepsDtr(undefined), false);
});
