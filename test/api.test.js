const { test } = require("node:test");
const assert = require("node:assert/strict");
const { api } = require("../public/api");
test("API helper accepts JSON and disables request caching", async () => {
  let request;
  const result = await api(
    "serial/status",
    undefined,
    undefined,
    async (path, options) => {
      request = { path, options };
      return new Response('{"connected":false}', {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  assert.deepEqual(result, { connected: false });
  assert.equal(request.path, "/api/serial/status");
  assert.equal(request.options.cache, "no-store");
});
test("HTML 404 and HTML fallback identify the request without JSON parsing errors", async () => {
  for (const status of [404, 200])
    await assert.rejects(
      api(
        "serial/ports",
        undefined,
        undefined,
        async () =>
          new Response("<!DOCTYPE html><title>Error</title>", {
            status,
            headers: { "Content-Type": "text/html" },
          }),
      ),
      (error) =>
        error.message.includes("GET /api/serial/ports") &&
        error.message.includes("an HTML page") &&
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes("Unexpected token"),
    );
});
test("invalid JSON, API errors and network failures provide useful context", async () => {
  await assert.rejects(
    api(
      "flows",
      undefined,
      undefined,
      async () =>
        new Response("broken", {
          headers: { "Content-Type": "application/json" },
        }),
    ),
    /GET \/api\/flows returned invalid JSON/,
  );
  await assert.rejects(
    api(
      "serial/connect",
      { path: "missing" },
      undefined,
      async () =>
        new Response('{"error":"Port not found"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    /Port not found.*POST \/api\/serial\/connect/,
  );
  await assert.rejects(
    api("serial/status", undefined, undefined, async () => {
      throw new TypeError("fetch failed");
    }),
    /Cannot reach the server.*\/api\/serial\/status/,
  );
});
