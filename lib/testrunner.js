const mqtt = require("mqtt");
const { randomBytes } = require("node:crypto");
const { checkTopic, toNumber } = require("./nodes");
const { matches, checkBroker, brokerHint } = require("./runtime");
// A test is a list of steps run against any MQTT target (host simulator or real board):
//   publish     { topic, payload, retain }
//   expect      { topic, match, value, timeout }  match: any|equals|contains|regex|gte|lte
//   expect-none { topic, timeout }                 no matching message may arrive
//   wait        { timeout }
// {{device}} in topics and payloads is replaced with the target Device ID.
const OPS = ["publish", "expect", "expect-none", "wait"];
const MATCH = ["any", "equals", "contains", "regex", "gte", "lte"];
function validateTest(test) {
  if (!test || typeof test !== "object") throw Error("Test must be an object.");
  const name = String(test.name || "")
    .trim()
    .slice(0, 100);
  if (!name) throw Error("Give the test a name.");
  if (
    !Array.isArray(test.steps) ||
    !test.steps.length ||
    test.steps.length > 50
  )
    throw Error("A test needs 1–50 steps.");
  const steps = test.steps.map((s, i) => {
    const where = `Step ${i + 1}`;
    if (!OPS.includes(s?.op)) throw Error(`${where}: unknown action.`);
    const step = { op: s.op };
    if (s.op !== "wait") {
      step.topic = String(s.topic || "");
      try {
        checkTopic(
          step.topic.replaceAll("{{device}}", "x"),
          s.op !== "publish",
        );
      } catch (e) {
        throw Error(`${where}: ${e.message}`);
      }
    }
    if (s.op === "publish") {
      step.payload = String(s.payload ?? "");
      step.retain = !!s.retain;
      if (Buffer.byteLength(step.payload) > 4096)
        throw Error(`${where}: payload is limited to 4096 bytes.`);
    }
    if (s.op === "expect") {
      step.match = MATCH.includes(s.match) ? s.match : "equals";
      step.value = String(s.value ?? "");
      if (step.match === "regex")
        try {
          new RegExp(step.value);
        } catch {
          throw Error(`${where}: invalid regular expression.`);
        }
      if (
        (step.match === "gte" || step.match === "lte") &&
        toNumber(step.value) === null
      )
        throw Error(`${where}: numeric match needs a number.`);
    }
    if (s.op !== "publish") {
      step.timeout = Number(s.timeout ?? 2000);
      if (
        !Number.isInteger(step.timeout) ||
        step.timeout < 10 ||
        step.timeout > 60000
      )
        throw Error(`${where}: timeout must be 10–60000 ms.`);
    }
    return step;
  });
  return { ...(test.id ? { id: String(test.id) } : {}), name, steps };
}
function accepts(step, payload) {
  const n = toNumber(payload);
  switch (step.match) {
    case "any":
      return true;
    case "contains":
      return payload.includes(step.value);
    case "regex":
      return new RegExp(step.value).test(payload);
    case "gte":
      return n !== null && n >= Number(step.value);
    case "lte":
      return n !== null && n <= Number(step.value);
    default:
      return payload === step.value;
  }
}
const describe = (s) =>
  s.op === "publish"
    ? `publish ${s.topic} ← ${JSON.stringify(s.payload)}`
    : s.op === "expect"
      ? `expect ${s.topic} ${s.match === "any" ? "any message" : `${s.match} ${JSON.stringify(s.value)}`} within ${s.timeout} ms`
      : s.op === "expect-none"
        ? `expect no message on ${s.topic} for ${s.timeout} ms`
        : `wait ${s.timeout} ms`;
async function runTest(
  rawTest,
  { broker, device = "sim", connect = mqtt.connect, onStep = () => {} } = {},
) {
  const test = validateTest(rawTest);
  const options = checkBroker(broker);
  const fill = (text) => text.replaceAll("{{device}}", device);
  const steps = test.steps.map((s) => ({
    ...s,
    ...(s.topic !== undefined ? { topic: fill(s.topic) } : {}),
    ...(s.payload !== undefined ? { payload: fill(s.payload) } : {}),
    ...(s.op === "expect" && s.match !== "regex"
      ? { value: fill(s.value) }
      : {}),
  }));
  const started = Date.now();
  const results = steps.map((s) => ({
    op: s.op,
    text: describe(s),
    ok: null,
    detail: "skipped",
  }));
  const inbox = [];
  const used = new Set();
  let wake = () => {};
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-test-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {}); // reported through the connect promise; avoids unhandled 'error'
  // Retained messages are history, not responses to this test.
  client.on("message", (topic, payload, packet) => {
    if (packet.retain) return;
    inbox.push({ topic, payload: payload.toString(), at: Date.now() });
    wake();
  });
  const nextMessage = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  let failure = null;
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", (e) => reject(Error(brokerHint(e, options.url))));
      client.once("close", () =>
        reject(Error("Broker closed the connection.")),
      );
    });
    const filters = [
      ...new Set(
        steps.filter((s) => s.op.startsWith("expect")).map((s) => s.topic),
      ),
    ];
    if (filters.length)
      await new Promise((resolve, reject) =>
        client.subscribe(filters, { qos: 0 }, (e) =>
          e ? reject(e) : resolve(),
        ),
      );
    let mark = 0;
    for (const [i, s] of steps.entries()) {
      const t0 = Date.now();
      const r = results[i];
      if (s.op === "publish") {
        mark = inbox.length;
        await new Promise((resolve, reject) =>
          client.publish(
            s.topic,
            s.payload,
            { qos: 0, retain: s.retain },
            (e) => (e ? reject(e) : resolve()),
          ),
        );
        Object.assign(r, { ok: true, detail: "sent" });
      } else if (s.op === "wait") {
        await new Promise((resolve) => setTimeout(resolve, s.timeout));
        Object.assign(r, { ok: true, detail: "done" });
      } else if (s.op === "expect") {
        const deadline = t0 + s.timeout;
        let hit = null;
        for (;;) {
          hit = inbox.findIndex(
            (m, k) =>
              k >= mark &&
              !used.has(k) &&
              matches(s.topic, m.topic) &&
              accepts(s, m.payload),
          );
          if (hit >= 0 || Date.now() >= deadline) break;
          await nextMessage(deadline - Date.now());
        }
        if (hit >= 0) {
          used.add(hit);
          Object.assign(r, {
            ok: true,
            detail: `got ${JSON.stringify(inbox[hit].payload)} on ${inbox[hit].topic}`,
          });
        } else {
          const seen = inbox
            .filter((m, k) => k >= mark && matches(s.topic, m.topic))
            .map((m) => JSON.stringify(m.payload));
          Object.assign(r, {
            ok: false,
            detail: seen.length
              ? `timed out; saw ${seen.slice(-3).join(", ")}`
              : "timed out; no message on topic",
          });
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, s.timeout));
        const extra = inbox.find(
          (m, k) => k >= mark && !used.has(k) && matches(s.topic, m.topic),
        );
        Object.assign(
          r,
          extra
            ? {
                ok: false,
                detail: `unexpected ${JSON.stringify(extra.payload)}`,
              }
            : { ok: true, detail: "quiet" },
        );
      }
      r.ms = Date.now() - t0;
      onStep(i, r);
      if (!r.ok) break;
    }
  } catch (e) {
    failure = e.message || String(e);
  } finally {
    client.end(true);
  }
  const passed = !failure && results.every((r) => r.ok);
  return {
    name: test.name,
    device,
    passed,
    error: failure,
    durationMs: Date.now() - started,
    steps: results,
  };
}
module.exports = { validateTest, runTest, OPS, MATCH };
