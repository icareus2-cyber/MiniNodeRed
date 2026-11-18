const { test, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.DB_PATH = ":memory:";
const { app, store, db, stop } = require("../server");
after(() => {
  stop();
  db.close();
});
test("upload preview warns when the Device ID belongs to another board", async () => {
  store.touchDevice("microflow-102fbb", {
    status: "online",
    telemetry: { board: "esp8266", build: "x" },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const preview = async (board) => {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/firmware`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow: {
            nodes: [{ id: "i", type: "inject", config: { interval: 1000 } }],
            edges: [],
          },
          settings: {
            board,
            ssid: "n",
            host: "h",
            deviceId: "microflow-102fbb",
          },
        }),
      },
    );
    return (await res.json()).warnings;
  };
  try {
    assert.match(
      (await preview("ttgo-t-display"))[0],
      /already belongs to another board \(ESP8266 · NodeMCU/,
    );
    assert.ok(
      !(await preview("esp8266")).some((w) => /already belongs/.test(w)),
      "same board type: no warning",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
