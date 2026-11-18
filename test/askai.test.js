// public/askai.js: questions offered when right-clicking items, run in a VM.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { catalog } = require("../lib/nodes");
const source = fs.readFileSync(
  path.join(__dirname, "../public/askai.js"),
  "utf8",
);
// A fake element whose closest() answers for the selectors listed in `matches`.
const target = (matches = {}, props = {}) => ({
  closest: (selector) =>
    Object.entries(matches).find(([key]) => selector.includes(key))?.[1] ||
    null,
  ...props,
});
function page() {
  const ctx = {
    catalog: catalog(),
    flow: {
      nodes: [
        {
          id: "t1",
          type: "throttle",
          label: "Calm down",
          config: { interval: 1000 },
        },
        {
          id: "r1",
          type: "mqtt-out",
          label: "Send",
          config: { protocol: "espnow", topic: "x" },
        },
      ],
    },
    selected: "t1",
    $: () => ({
      value: "",
      hidden: true,
      classList: { add() {}, remove() {} },
    }),
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    el: () => ({}),
    button: () => ({}),
    toast: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
test("right-clicking Throttle in the palette offers a Node-RED question", () => {
  const ctx = page();
  const topic = ctx.aiTopic(
    target({ ".palette-node": { dataset: { type: "throttle" } } }),
  );
  assert.equal(topic.title, "Throttle");
  assert.equal(
    topic.questions[0],
    "How do I use the throttle in Node-RED (the delay node in rate-limit mode)? Show a simple example flow.",
  );
  assert.ok(
    topic.questions.some((q) => q.includes("Drops messages")),
    "explains with the box help",
  );
});
test("a Radio box on the canvas asks about its protocol", () => {
  const ctx = page();
  const topic = ctx.aiTopic(target({ ".flow-node": { id: "node-r1" } }));
  assert.equal(topic.title, "Send (Radio out)");
  assert.match(topic.questions[0], /ESP-NOW between ESP32 boards/);
  assert.ok(
    !topic.questions.some((q) => /mqtt out node/.test(q)),
    "no MQTT comparison for an ESP-NOW box",
  );
});
test("a setting in Node properties asks about that setting", () => {
  const ctx = page();
  const label = {
    firstChild: { textContent: "Minimum gap (ms)" },
    textContent: "Minimum gap (ms)1000",
  };
  const topic = ctx.aiTopic(target({ "#properties label": label }));
  assert.equal(topic.title, "Throttle · Minimum gap (ms)");
  assert.match(
    topic.questions[0],
    /node-red's throttle node, what does the "Minimum gap \(ms\)" setting do/i,
  );
});
test("buttons and other text get a general question; empty items none", () => {
  const ctx = page();
  const upload = {
    textContent: "Compile and upload",
    getAttribute: () => null,
  };
  const topic = ctx.aiTopic(target({ button: upload }));
  assert.equal(topic.title, "Compile and upload");
  assert.match(topic.questions[0], /What does "Compile and upload" do/);
  const blank = { textContent: "  ", getAttribute: () => null };
  assert.equal(ctx.aiTopic(target({ button: blank }, blank)), null);
});
