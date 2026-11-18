const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  validate,
  analyze,
  build,
  brokerReason,
  LIMITS,
  expandCustom,
} = require("./lib/flow");
const ota = require("./lib/ota");
const brokerfw = require("./lib/brokerfw");
const chipcheck = require("./lib/chipcheck");
const { mqttCommand } = require("./lib/terminal");
const { catalog, RESERVED } = require("./lib/nodes");
const {
  boards,
  parseSize,
  publicBoards,
  uploadFailure,
} = require("./lib/boards");
const { openStore } = require("./lib/store");
const { setupAuth } = require("./lib/auth");
const webfw = require("./lib/webfw");
const { matches } = require("./lib/runtime");
const { SimGroup } = require("./lib/simgroup");
const { validateTest, runTest } = require("./lib/testrunner");
const { verifyBoard, brokerLoopback } = require("./lib/verify");
const { diagnoseRemote } = require("./lib/diagnose");
const { LocalSerialMonitor } = require("./lib/serial");
const png = require("./lib/png");
const { BuildProgress, noise } = require("./lib/progress");
const amebafw = require("./lib/amebafw");
const picofw = require("./lib/picofw");
const app = express();
const dbPath = process.env.DB_PATH || "data/microflow.sqlite";
if (dbPath !== ":memory:")
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const store = openStore(dbPath);
const db = store.db;
// /sim/api takes raw JSON of any kind (numbers too), like the board does.
const json = express.json({ limit: "256kb" });
app.use((req, res, next) =>
  req.path.startsWith("/sim/") ? next() : json(req, res, next),
);
// Only pages of this server may call its API (http here, https behind a proxy).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean);
  if (
    origin &&
    !hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`)
  )
    return res
      .status(403)
      .json({ error: "Cross-origin requests are disabled." });
  next();
});
// Express 4 does not forward rejected promises; wrap async handlers.
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).then(
    (r) => r !== undefined && res.json(r),
    next,
  );
// Accounts and login (lib/auth.js): req.user for everything below.
const auth = setupAuth(app, store, { route });
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Custom nodes (lib/custom.js) run as the nodes inside them: the flows sent to
// analysis, firmware, upload and the simulator are expanded here (saved flows,
// /api/flows…, keep their Custom boxes).
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/flows")) return next();
  try {
    if (req.body?.flow) req.body.flow = expandCustom(req.body.flow);
    if (Array.isArray(req.body?.chips))
      for (const c of req.body.chips) if (c?.flow) c.flow = expandCustom(c.flow);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  }),
);
const notFound = (what) =>
  Object.assign(Error(`${what} not found`), { status: 404 });
const found = (value, what) => {
  if (!value) throw notFound(what);
  return value;
};
const streams = new Set();
const emit = (kind, message, extra = {}) => {
  const data = JSON.stringify({
    kind,
    message,
    time: new Date().toISOString(),
    ...extra,
  });
  for (const res of streams) res.write(`data: ${data}\n\n`);
};
const serialMonitor = new LocalSerialMonitor(emit);
// One chip, or every chip of a project at once (lib/simgroup.js).
const runtime = new SimGroup(emit, {
  onDevice: (id, patch) => {
    try {
      store.touchDevice(id, patch);
    } catch (e) {
      emit("error", `Device store: ${e.message}`);
    }
  },
});
let busy = null; // "compile" | "upload" while Arduino CLI runs
app.get("/api/catalog", (req, res) =>
  res.json({
    nodes: catalog(),
    boards: publicBoards(),
    limits: LIMITS,
    reserved: [...RESERVED], // names a node's variable name may not take
  }),
);
// ── Serial monitor ──────────────────────────────────────────────
app.get(
  "/api/serial/ports",
  route(() => serialMonitor.list()),
);
app.get("/api/serial/status", (req, res) => res.json(serialMonitor.status()));
app.post(
  "/api/serial/connect",
  route((req) => {
    if (busy === "upload")
      throw Object.assign(
        Error("An upload is in progress. Try again after it finishes."),
        { status: 409 },
      );
    return serialMonitor.connect(req.body.path, Number(req.body.baudRate));
  }),
);
app.post(
  "/api/serial/disconnect",
  route(() => serialMonitor.disconnect()),
);
// Chip status poll: sends "mf?" when the port is free; never fails, because a poll
// racing a disconnect is normal and the next one simply tries again.
app.post(
  "/api/serial/poll",
  route(async () => {
    const { connected } = serialMonitor.status();
    if (!connected || serialMonitor.busy) return { sent: false };
    try {
      await serialMonitor.send("mf?\n");
      return { sent: true };
    } catch {
      return { sent: false };
    }
  }),
);
// After an upload error: is the port missing, held by our monitor, or held elsewhere?
app.post(
  "/api/serial/check",
  route(async (req) => checkPort(String(req.body?.path || ""))),
);
app.post(
  "/api/serial/baud",
  route((req) => serialMonitor.setBaud(Number(req.body?.baudRate))),
);
app.post(
  "/api/serial/autobaud",
  route(() => serialMonitor.detectBaud()),
);
app.post(
  "/api/serial/reset",
  route(async () => {
    await serialMonitor.reset();
    emit("serial", "Board reset over USB (RTS pulse)");
    return { ok: true };
  }),
);
app.post(
  "/api/serial/send",
  route(async (req) => {
    await serialMonitor.send(req.body.text);
    return { ok: true };
  }),
);
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  streams.add(res);
  const beat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => {
    clearInterval(beat);
    streams.delete(res);
  });
});
// ── Flows, revisions ────────────────────────────────────────────
// Each user sees their own flows and the shared examples (an admin sees all).
const canRead = (req, flowId) => {
  if (!store.canReadFlow(flowId, req.user)) throw notFound("Flow");
};
const canWrite = (req, flowId) => {
  canRead(req, flowId);
  if (!store.canWriteFlow(flowId, req.user))
    throw Object.assign(
      Error("This is a shared example: save it to get your own copy, then change that."),
      { status: 403 },
    );
};
app.get("/api/flows", (req, res) => res.json(store.listFlows(req.user)));
app.get(
  "/api/flows/:id",
  route((req) => found(store.getFlow(req.params.id, req.user), "Flow")),
);
app.post(
  "/api/flows",
  route((req) => store.saveFlow(validate(req.body), req.user)),
);
// Shared examples (admin): every user sees the flow and can save a copy of it.
app.post(
  "/api/flows/:id/share",
  route((req) => {
    if (req.user && !req.user.admin)
      throw Object.assign(Error("Only an admin can share examples."), { status: 403 });
    canRead(req, req.params.id);
    return { ok: store.shareFlow(req.params.id, req.body?.shared === true) };
  }),
);
app.post(
  "/api/flows/delete",
  route((req) => {
    const ids = req.body?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== "string")
    )
      throw Error("Choose 1–500 flows to delete.");
    return { deleted: store.deleteFlows([...new Set(ids)], req.user) };
  }),
);
app.delete(
  "/api/flows/:id",
  route((req) => {
    if (store.canReadFlow(req.params.id, req.user)) canWrite(req, req.params.id);
    return { ok: store.deleteFlow(req.params.id, req.user) };
  }),
);
app.get(
  "/api/flows/:id/revisions",
  route((req) => {
    canRead(req, req.params.id);
    return store.listRevisions(req.params.id);
  }),
);
app.get(
  "/api/flows/:id/revisions/:rev",
  route((req) => {
    canRead(req, req.params.id);
    return found(
      store.getRevision(req.params.id, Number(req.params.rev)),
      "Revision",
    );
  }),
);
// ── Example flows (examples/*.json: { description, flow, tests }) ──
const EXAMPLES = path.join(__dirname, "examples");
const readExample = (name) => {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw notFound("Example");
  const file = path.join(EXAMPLES, name + ".json");
  if (!fs.existsSync(file)) throw notFound("Example");
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
function exampleProblem(flow, board) {
  if (!boards[board] || flow.chips?.length) return null;
  try {
    return analyze(validate(structuredClone(flow)), board).errors[0] || null;
  } catch (e) {
    return e.message;
  }
}
app.get(
  "/api/examples",
  route((req) =>
    fs
      .readdirSync(EXAMPLES)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const name = f.slice(0, -5);
        const e = readExample(name);
        return {
          name,
          title: e.flow.name,
          description: e.description,
          tests: e.tests.length,
          // ?board=: why it does not run on that board (null: it does; multi-chip
          // projects choose a board per chip, so they are not checked).
          problem: exampleProblem(e.flow, req.query.board),
        };
      }),
  ),
);
// One example as it is (guests keep it in their browser instead of saving it).
app.get(
  "/api/examples/:name",
  route((req) => readExample(req.params.name)),
);
// Adds an example to the saved flows (as a new copy) together with its tests.
app.post(
  "/api/examples/:name",
  route((req) => {
    const example = readExample(req.params.name);
    const flow = store.saveFlow(validate(structuredClone(example.flow)), req.user);
    for (const test of example.tests)
      store.saveTest(flow.id, validateTest(test));
    return flow;
  }),
);
// ── MQTT test cases ─────────────────────────────────────────────
// A test belongs to its flow: read it where the flow is visible, change it where
// the flow may be changed.
const testOf = (req, id, write) => {
  const test = store.getTest(String(id));
  if (!test || !store.canReadFlow(test.flowId, req.user)) throw notFound("Test");
  if (write) canWrite(req, test.flowId);
  return test;
};
app.get(
  "/api/flows/:id/tests",
  route((req) => {
    canRead(req, req.params.id);
    return store.listTests(req.params.id);
  }),
);
app.post(
  "/api/flows/:id/tests",
  route((req) => {
    if (store.canReadFlow(req.params.id, req.user)) canWrite(req, req.params.id);
    return store.saveTest(req.params.id, validateTest(req.body));
  }),
);
app.delete(
  "/api/tests/:id",
  route((req) => {
    testOf(req, req.params.id, true);
    return { ok: store.deleteTest(req.params.id) };
  }),
);
app.get(
  "/api/tests/:id/runs",
  route((req) => {
    testOf(req, req.params.id);
    return store.listRuns(req.params.id);
  }),
);
let testing = false;
app.post(
  "/api/tests/run",
  route(async (req) => {
    const { ids, broker, device } = req.body;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100)
      throw Error("Choose tests to run.");
    if (device && !/^[A-Za-z0-9_-]{1,32}$/.test(device))
      throw Error("Invalid Device ID.");
    if (testing)
      throw Object.assign(Error("Tests are already running."), { status: 409 });
    const tests = ids.map((id) => testOf(req, id));
    testing = true;
    const results = [];
    try {
      for (const test of tests) {
        emit("test", `▶ ${test.name} on ${device || "sim"}`);
        const result = await runTest(test, { broker, device: device || "sim" });
        store.recordRun(test.id, result);
        results.push({ id: test.id, ...result });
        emit(
          result.passed ? "test" : "error",
          `${result.passed ? "✓ PASS" : "✗ FAIL"} ${test.name} · ${result.durationMs} ms`,
          {
            payload:
              result.error || result.steps.find((s) => s.ok === false)?.detail,
          },
        );
      }
    } finally {
      testing = false;
    }
    return {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  }),
);
// ── Runtime (host simulation / device monitor) ──────────────────
app.get("/api/runtime/status", (req, res) =>
  res.json(runtime.status(req.query.chip)),
);
// ── Camera node pictures: PNG files saved on this PC in captures/ ──
const CAPTURES = path.join(__dirname, "captures");
// ── PWA phone pages (lib/pwafw.js) ──────────────────────────────
// Published to <project>/pwa/<name>/ and served at /pwa/<name>/. Served here, the
// page talks through these routes (simulator, or the board being monitored).
const pwafw = require("./lib/pwafw");
const PWA_DIR = path.join(__dirname, "pwa");
// The published pages: [{ folder, node, name, title, device }].
function pwaPages() {
  try {
    return fs
      .readdirSync(PWA_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let cfg = {};
        try {
          cfg = JSON.parse(
            fs.readFileSync(path.join(PWA_DIR, d.name, "pwa.json"), "utf8"),
          );
        } catch {}
        return { folder: d.name, ...cfg };
      });
  } catch {
    return [];
  }
}
// /pwa/ : the published pages, with links (folder = the node's variable name).
app.get(["/pwa", "/pwa/"], (req, res) => {
  const pages = pwaPages().map((p) => ({
    ...p,
    stale: p.node ? runtime.pwaState(p.node, p.folder).problem : "",
  }));
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res.type("html").send(`<!doctype html><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Microflow phone pages</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;max-width:640px}a{font-weight:600}li{margin:10px 0}small{color:#667}</style>
<h1>Phone pages (PWA nodes)</h1>
${
  pages.length
    ? `<ul>${pages
        .map(
          (p) =>
            `<li><a href="/pwa/${encodeURIComponent(p.folder)}/">/pwa/${esc(p.folder)}/</a> · ${esc(p.title)}<br><small>node ${esc(p.name)} (${esc(p.node)})${p.device ? ` · device ${esc(p.device)}` : ""} · folder ${esc(path.join(PWA_DIR, p.folder))}${p.stale ? `<br><b style="color:#b45309">Not in the running flow</b>` : ""}</small></li>`,
        )
        .join("")}</ul>`
    : "<p>None published yet. In Microflow, select a PWA node and click <b>📱 Publish test page</b> in Properties.</p>"
}`);
});
app.use(
  "/pwa",
  express.static(PWA_DIR, {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  }),
);
app.post(
  "/api/pwa/publish",
  route((req) => {
    const n = req.body?.node;
    if (!n || n.type !== "pwa") throw Error("Choose a PWA node.");
    validate({ nodes: [n], edges: [] }); // checks its settings
    const deviceId = String(req.body.deviceId || "").trim();
    if (deviceId && !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId))
      throw Error("Device ID may use letters, digits, - and _.");
    const folder = pwafw.folderOf(n);
    const dir = path.join(PWA_DIR, folder);
    // Renamed node (new variable name): its page moves to the new folder, keeping
    // files added there (images); an old copy beside an existing one is merged.
    let moved = null;
    for (const p of pwaPages()) {
      if (p.node !== n.id || p.folder === folder) continue;
      const old = path.join(PWA_DIR, p.folder);
      if (!fs.existsSync(dir)) fs.renameSync(old, dir);
      else {
        fs.cpSync(old, dir, { recursive: true, force: false });
        fs.rmSync(old, { recursive: true, force: true });
      }
      moved = p.folder;
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(
      pwafw.files(n, { device: deviceId }),
    ))
      fs.writeFileSync(path.join(dir, name), text);
    return { url: `/pwa/${folder}/`, folder: dir, moved };
  }),
);
app.get(
  "/api/pwa/pages",
  route(() => pwaPages().map(({ folder, node }) => ({ folder, node }))),
);
app.get(
  "/api/pwa/state",
  route((req) =>
    runtime.pwaState(String(req.query.node || ""), String(req.query.folder || "")),
  ),
);
app.post(
  "/api/pwa/key",
  route((req) => {
    const json = String(req.body?.payload ?? "");
    if (json.length > 1000) throw Error("Key message too long.");
    runtime.pwaKey(
      String(req.body?.node || ""),
      json,
      String(req.body?.folder || ""),
    );
    return { ok: true };
  }),
);
const SIM_STILL = /^\/api\/camera\/sim\/([A-Za-z0-9_-]+)\.png(\?shot=\d+)?$/;
const BOARD_STILL =
  /^http:\/\/[A-Za-z0-9.-]+(:\d+)?\/camera\/[A-Za-z0-9_-]+\.png$/;
// The simulator's latest picture of a Camera node.
app.get("/api/camera/sim/:file", (req, res) => {
  const picture = runtime.stills.get(req.params.file.replace(/\.png$/, ""));
  if (!picture) return res.status(404).type("text").send("no picture yet");
  res.set("Cache-Control", "no-store").type("png").send(picture);
});
// Fetches a picture (from the simulator or a board) and saves it as a PNG file.
app.post(
  "/api/camera/save",
  route(async (req) => {
    const url = String(req.body?.url || "");
    let picture;
    const sim = SIM_STILL.exec(url);
    if (sim) picture = runtime.stills.get(sim[1]);
    else if (BOARD_STILL.test(url)) {
      let r;
      try {
        r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      } catch (e) {
        throw Error(
          `The board did not send the picture (${e.cause?.code || e.message}). Is it on this network?`,
        );
      }
      if (!r.ok)
        throw Error(`The board answered ${r.status}: ${await r.text()}`);
      picture = Buffer.from(await r.arrayBuffer());
    } else
      throw Object.assign(Error("Not the address of a Camera picture."), {
        status: 400,
      });
    const head = png.info(picture);
    if (!head) throw Error("The picture is not a PNG file.");
    fs.mkdirSync(CAPTURES, { recursive: true });
    const base = `${String(req.body?.label || "camera")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .slice(
        0,
        40,
      )}-${new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "")}`;
    let name = base + ".png";
    for (let k = 2; fs.existsSync(path.join(CAPTURES, name)); k++)
      name = `${base}-${k}.png`;
    fs.writeFileSync(path.join(CAPTURES, name), picture);
    return { name, bytes: picture.length, ...head, folder: CAPTURES };
  }),
);
// A saved picture.
app.get("/api/camera/file/:name", (req, res) => {
  const name = req.params.name;
  const file = path.join(CAPTURES, name);
  if (!/^[A-Za-z0-9_-]+\.png$/.test(name) || !fs.existsSync(file))
    return res.status(404).type("text").send("no such picture");
  res.type("png").sendFile(file);
});
app.post(
  "/api/runtime/start",
  route((req) => runtime.start(req.body)),
);
app.post(
  "/api/runtime/stop",
  route(() => {
    runtime.stop();
    return { ok: true };
  }),
);
app.post(
  "/api/runtime/inject",
  route((req) => {
    runtime.inject(req.body.id, req.body.payload);
    return { ok: true };
  }),
);
app.post(
  "/api/runtime/pin",
  route((req) => {
    runtime.setPin(req.body.pin, req.body.value, req.body.chip);
    return runtime.status(req.body.chip);
  }),
);
// Simulated board web API (Web in/out and Terminal nodes), same paths as the board.
const simBody = express.text({ type: () => true, limit: "16kb" });
// Returns nothing, so route() does not try to send a second response.
const simJson = (res, code, text) => {
  res.status(code).type("application/json").send(text);
};
// The board's own page, served for the simulator (it uses relative URLs).
app.get(
  "/sim/",
  route((req, res) => {
    runtime.webAll(); // throws unless a host simulation runs
    res.type("html").send(webfw.page(webfw.ins(runtime.flow.nodes)));
  }),
);
app.get(
  ["/sim/api", "/sim/api/"],
  route((req, res) => simJson(res, 200, runtime.webAll())),
);
app.get(
  "/sim/api/:name",
  route((req, res) => {
    const out = runtime.webGet(req.params.name);
    if (out === null)
      return simJson(
        res,
        404,
        JSON.stringify({ error: `no Web out node named '${req.params.name}'` }),
      );
    simJson(res, 200, out);
  }),
);
app.post(
  "/sim/api/:name",
  simBody,
  route((req, res) => {
    const out = runtime.webPost(
      req.params.name,
      typeof req.body === "string" ? req.body : "",
    );
    if (out === null)
      return simJson(
        res,
        404,
        JSON.stringify({ error: `no Web in node named '${req.params.name}'` }),
      );
    simJson(res, 200, out);
  }),
);
app.post(
  "/sim/terminal",
  simBody,
  route((req, res) => {
    if (!runtime.flow) throw Error("Start the runtime first.");
    res
      .type("text/plain")
      .send(runtime.command(typeof req.body === "string" ? req.body : ""));
  }),
);
// ── Devices, deployments ────────────────────────────────────────
app.get("/api/devices", (req, res) => res.json(store.listDevices()));
app.delete(
  "/api/devices/:id",
  route((req) => ({ ok: store.deleteDevice(req.params.id) })),
);
app.get("/api/deployments", (req, res) =>
  res.json(store.listDeployments(30, req.user)),
);
// Saved device setup (WiFi credentials). Stored locally in SQLite; the API is loopback-only.
// language: the default for new flows ("nodered" or "arduino", app Settings ⚙).
// customNodes: the library of Custom nodes (JSON text, public/custom.js).
const SETTINGS = { ssid: 32, password: 64, language: 16, customNodes: 200000 };
// With accounts, each user has their own settings; without, the PC's.
const settingsOf = (req) =>
  req.user ? store.getUserSettings(req.user.id) : store.getSettings();
app.get("/api/settings", (req, res) => {
  const all = settingsOf(req);
  res.json(
    Object.fromEntries(
      Object.keys(SETTINGS)
        .filter((k) => k in all)
        .map((k) => [k, all[k]]),
    ),
  );
});
app.put(
  "/api/settings",
  route((req) => {
    const values = {};
    for (const [key, max] of Object.entries(SETTINGS)) {
      const value = req.body?.[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || Buffer.byteLength(value) > max)
        throw Error(`${key} must be text of at most ${max} bytes.`);
      if (key === "language" && !["nodered", "arduino"].includes(value))
        throw Error("language must be nodered or arduino.");
      if (key === "customNodes") {
        let list;
        try {
          list = JSON.parse(value);
        } catch {
          throw Error("customNodes must be JSON.");
        }
        if (!Array.isArray(list) || list.length > 100)
          throw Error("customNodes: a list of at most 100 custom nodes.");
      }
      values[key] = value;
    }
    if (req.user) store.saveUserSettings(req.user.id, values);
    else store.saveSettings(values);
    return settingsOf(req);
  }),
);
// ── Firmware, compile, upload ───────────────────────────────────
app.post(
  "/api/firmware",
  route((req) => {
    const flow = validate(req.body.flow);
    if (!req.body.settings?.board || !boards[req.body.settings.board])
      return { flow };
    // Preview uses placeholder OTA keys; real keys are only added when compiling.
    const { otaKeys, ...settings } = req.body.settings;
    const { source, build: id, warnings, features } = build(flow, settings);
    const clash = deviceIdClash(settings);
    if (clash) warnings.unshift(clash);
    return {
      source,
      build: id,
      warnings,
      features,
      flow,
      // Why the board needs a broker (null: it does not), and this PC's LAN IP.
      broker: brokerReason(flow, settings),
      lan: lanAddress(),
    };
  }),
);
// Checks that an MQTT broker accepts TCP connections, as the board would connect.
app.post(
  "/api/broker/probe",
  route(async (req) => {
    const host = String(req.body.host || "").trim();
    const port = Number(req.body.port || 1883);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host))
      throw Error("Enter a broker host name or IP address.");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("Invalid broker port.");
    if (/^(127\.|localhost$|0\.0\.0\.0$)/.test(host))
      return {
        ok: false,
        message: `${host} means “this device” on the board itself, not this PC. Use this PC's LAN IP or a public broker.`,
      };
    const started = Date.now();
    return new Promise((resolve) => {
      const socket = require("node:net").connect({ host, port });
      const finish = (ok, message) => {
        socket.destroy();
        resolve({ ok, message });
      };
      socket.setTimeout(4000, () =>
        finish(false, `${host}:${port} did not answer within 4 s.`),
      );
      socket.once("connect", () =>
        finish(true, `${host}:${port} answers (${Date.now() - started} ms).`),
      );
      socket.once("error", (e) =>
        finish(
          false,
          e.code === "ECONNREFUSED"
            ? `Nothing is listening at ${host}:${port}. Start an MQTT broker there (e.g. Mosquitto) or choose another broker.`
            : e.code === "ENOTFOUND"
              ? `${host} was not found (check the spelling and the internet connection).`
              : `${host}:${port} cannot be reached: ${e.message}`,
        ),
      );
    });
  }),
);
app.post(
  "/api/validate",
  route((req) => validate(req.body)),
);
app.post(
  "/api/analyze",
  route((req) => analyze(req.body.flow, req.body.board)),
);
const CLI_TIMEOUT = Number(process.env.ARDUINO_CLI_TIMEOUT) || 300000;
// ARDUINO_CLI wins; otherwise use the copy bundled with Arduino IDE 2 if present,
// falling back to arduino-cli on PATH.
function findCli() {
  if (process.env.ARDUINO_CLI) return process.env.ARDUINO_CLI;
  const bundled = "resources/app/lib/backend/resources/arduino-cli";
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
          process.env.LOCALAPPDATA &&
            path.join(process.env.LOCALAPPDATA, "Programs"),
        ]
          .filter(Boolean)
          .map((dir) => path.join(dir, "Arduino IDE", bundled + ".exe"))
      : process.platform === "darwin"
        ? [
            "/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli",
          ]
        : ["/opt/arduino-ide/" + bundled, "/usr/share/arduino-ide/" + bundled];
  return candidates.find((file) => fs.existsSync(file)) || "arduino-cli";
}
const CLI_PATH = findCli();
// Two boards sharing a Device ID also share an MQTT client ID and keep
// disconnecting each other, so warn when the ID was seen on another board type.
function deviceIdClash(settings) {
  if (!settings?.deviceId) return null;
  const seen = store.listDevices().find((d) => d.id === settings.deviceId);
  const other = seen?.telemetry?.board;
  if (!other || other === settings.board) return null;
  return `Device ID ${settings.deviceId} already belongs to another board (${boards[other]?.label || other}, last seen ${new Date(seen.last_seen).toLocaleString()}). Two boards with one ID disconnect each other on the broker: leave Device ID blank for an automatic, unique ID, or choose a new one.`;
}
// Every failed USB upload reminds the user that another program may hold the port.
function withPortHint(message, port) {
  if (/in use by another program/.test(message)) return message;
  return `${message}\n\nReminder: ${port} may be in use by another program (Arduino IDE Serial Monitor, PuTTY, a browser tab using Web Serial, or another Microflow window). Close it and try again.`;
}
// Arduino CLI's data folder (where the board cores and their tools are).
let arduinoData;
async function arduinoDataDir() {
  if (arduinoData) return arduinoData;
  let dir = "";
  try {
    await cli(["config", "get", "directories.data"], {
      quiet: () => true,
      onLine: (l) => l.trim() && (dir = l.trim()),
      timeout: 15000,
    });
  } catch {}
  return (arduinoData = dir || null);
}
// Before a USB upload compiles anything: the port must be there, and the chip on it
// must be the chosen board's (lib/chipcheck.js). Throws with the reason otherwise.
async function uploadPreflight(port, boardId) {
  const board = boards[boardId];
  emit("build", `Checking ${port} and the chip on it…\n`);
  let r;
  try {
    r = await chipcheck.checkUploadTarget({
      port,
      board,
      boards,
      listPorts: () => serialMonitor.list(),
      esptool: chipcheck.findEsptool(await arduinoDataDir()),
    });
  } catch (e) {
    // A Pico held in BOOTSEL mode (or a new one) is a USB drive, not a serial port:
    // the upload copies the firmware onto that drive (RPI-RP2 / RP2350).
    if (board?.family === "rp2040" && / is not connected/.test(e.message)) {
      emit(
        "build",
        `⚠ ${port} is not connected. If the Pico is in BOOTSEL mode (a USB drive named RPI-RP2 or RP2350), the upload copies the firmware onto it.
`,
      );
      return { chip: null, notes: [] };
    }
    throw Object.assign(e, { stage: "board" }); // the upload window explains it
  }
  if (r.chip)
    emit("build", `Found an ${r.chip} on ${port}: it matches ${board.label}.\n`);
  for (const note of r.notes) emit("build", `⚠ ${note}\n`);
  return r;
}
async function checkPort(path) {
  if (!/^(COM\d+|\/dev\/[a-zA-Z0-9._/-]+)$/.test(path))
    throw Error("Enter a serial port such as COM3.");
  const mine = serialMonitor.status();
  if (mine.connected && mine.path === path)
    return {
      path,
      state: "monitor",
      message: `${path} is open in Microflow's serial monitor. Click Disconnect serial, then upload.`,
    };
  const ports = await serialMonitor.list();
  if (!ports.some((p) => p.path === path))
    return {
      path,
      state: "missing",
      message: `${path} is not connected. Plug the board in with a data cable and refresh the port list (↻).`,
    };
  const { SerialPort } = require("serialport");
  const probe = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  const error = await new Promise((resolve) => probe.open((e) => resolve(e)));
  if (error)
    return {
      path,
      state: "busy",
      message: `${path} is in use by another program right now (${error.message.replace(/^Opening [^:]+: /, "")}). Close Arduino IDE's Serial Monitor, PuTTY, or a browser tab connected with Web Serial, then upload again.`,
    };
  await new Promise((resolve) => probe.close(() => resolve()));
  return {
    path,
    state: "free",
    message: `${path} is free now. Try the upload again; if it fails the same way, hold the board's FLASH/BOOT button while uploading.`,
  };
}
// opts.onLine(line): each output line (progress); opts.quiet(line): true for lines
// kept out of the console and the error message (verbose compiler commands).
// The compiler's error lines come early in a long output; repeat them at the end, so
// the message (and its last 500 characters in the deployment log) shows the cause.
function withErrors(output) {
  const errors = [
    ...new Set(
      output
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .filter((l) => /\b(fatal )?error:/.test(l))
        .map((l) => l.replace(/^.*[\\/]([^\\/]+:\d+:\d+:)/, "$1").trim()),
    ),
  ].slice(0, 8);
  const tail = output.slice(-3000);
  return errors.length
    ? `${tail}\nCompiler errors:\n${errors.join("\n")}`
    : tail;
}
function cli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(CLI_PATH, args, {
      shell: false,
      windowsHide: true,
    });
    let output = "";
    const partial = new Map(); // per stream: the line not yet ended
    const limit = opts.timeout || CLI_TIMEOUT;
    const timeout = setTimeout(() => {
      p.kill();
      reject(Error(`Arduino CLI timed out after ${limit / 1000} seconds.`));
    }, limit);
    for (const s of [p.stdout, p.stderr])
      s.on("data", (d) => {
        if (!opts.onLine && !opts.quiet) {
          output = (output + d).slice(-50000);
          emit("build", d.toString());
          return;
        }
        // Line by line (\r too: esptool's progress), keeping a partial last line.
        const lines = ((partial.get(s) || "") + d).split(/\r\n|\n|\r/);
        partial.set(s, lines.pop());
        const shown = [];
        for (const line of lines) {
          opts.onLine?.(line);
          if (!opts.quiet?.(line)) shown.push(line);
        }
        if (shown.length) {
          const text = shown.join("\n") + "\n";
          output = (output + text).slice(-50000);
          emit("build", text);
        }
      });
    p.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        Error(
          err.code === "ENOENT"
            ? `Arduino CLI not found (tried ${CLI_PATH}). Install Arduino IDE 2 or Arduino CLI, or set ARDUINO_CLI to its full path, then restart npm start.`
            : err.message,
        ),
      );
    });
    p.on("close", (code) => {
      clearTimeout(timeout);
      // The last lines, if they had no newline (line mode only).
      for (const rest of partial.values())
        if (rest) {
          opts.onLine?.(rest);
          if (!opts.quiet?.(rest)) {
            output = (output + rest + "\n").slice(-50000);
            emit("build", rest + "\n");
          }
        }
      partial.clear();
      code === 0
        ? resolve(output)
        : reject(Error(withErrors(output) || `Arduino CLI exited ${code}`));
    });
  });
}
app.get(
  "/api/boards",
  route(async () =>
    JSON.parse(await cli(["board", "list", "--format", "json"])),
  ),
);
// One sketch folder per board, overwritten each build, and a persistent build cache
// so repeat compiles are incremental and credentials do not pile up in old folders.
// This PC's IPv4 address on the LAN, for a broker running here (null if none).
function lanAddress() {
  for (const list of Object.values(require("node:os").networkInterfaces()))
    for (const a of list || [])
      if (
        a.family === "IPv4" &&
        !a.internal &&
        /^(10|172|192)\./.test(a.address)
      )
        return a.address;
  return null;
}
// Progress bar for a compile or an upload (lib/progress.js), sent as "progress"
// events; stage times are kept per board for the next estimate.
function buildProgress(action, settings, method) {
  return new BuildProgress({
    action,
    method,
    family: boards[settings.board]?.family,
    timingFile: path.join(
      __dirname,
      "builds",
      String(settings.board),
      "timing.json",
    ),
    send: (p) => emit("progress", p.label, { ...p, action, quiet: true }),
  });
}
// Microflow's own server code, as loaded at start and as it is on disk now. When
// the files are updated while npm start runs, the old code would build old firmware
// (new options ignored), so builds stop and ask for a restart.
function codeHash() {
  const h = require("node:crypto").createHash("sha256");
  const lib = path.join(__dirname, "lib");
  const files = [
    path.join(__dirname, "server.js"),
    ...fs.readdirSync(lib).filter((f) => f.endsWith(".js")).sort().map((f) => path.join(lib, f)),
  ];
  for (const f of files) {
    h.update(path.basename(f));
    try {
      h.update(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
    } catch {}
  }
  return h.digest("hex").slice(0, 12);
}
const CODE_LOADED = codeHash();
const RESTART_NEEDED =
  "Microflow's files were updated after it started, so this server still runs the old code (it would build old firmware and ignore new options). Restart it: in its window press Ctrl+C, then run npm start again, and reload this page.";
app.get("/api/version", (req, res) => {
  const disk = codeHash();
  res.json({ loaded: CODE_LOADED, disk, stale: disk !== CODE_LOADED, restart: RESTART_NEEDED });
});
async function compile(flow, rawSettings, progress, guest = false) {
  if (codeHash() !== CODE_LOADED)
    throw Object.assign(Error(RESTART_NEEDED), { status: 409 });
  // Real OTA keys are added only here (never in previews or responses). A guest's
  // firmware never has remote update, so it never carries this project's keys.
  const settings = guest
    ? { ...rawSettings, ota: false, otaKeys: undefined }
    : { ...rawSettings, otaKeys: ota.projectKeys(store) };
  // Never flash the placeholder host: the board would silently fail to reach MQTT.
  const reason = brokerReason(flow, settings);
  if (reason && !String(settings.host || "").trim()) {
    const lan = lanAddress();
    throw Object.assign(
      Error(
        `Firmware broker host is empty. The upload method does not matter (USB too): ${reason}, so once the firmware runs, the board connects to an MQTT broker, and that address is built into the firmware. Enter the Firmware broker host in the Device panel: test.mosquitto.org (public test broker) or ${lan ? `${lan} (this PC)` : "this PC's LAN IP"} if a broker runs here.${/^Debug|^Remote/.test(reason) ? " For firmware without MQTT, choose Release and untick Remote update." : ""}`,
      ),
      { stage: "settings", lan },
    );
  }
  const fw = build(flow, settings);
  await ensureCore(fw.fqbn);
  await ensureLibraries(fw.libraries);
  return {
    ...fw,
    ...(await compileSketch(settings.board, "microflow", fw, progress)),
  };
}
// Board packages Microflow installs itself on first use: Realtek's core for the BW16
// (RTL8720DN) and Earle Philhower's core for the Raspberry Pi Pico boards. The ESP8266 /
// ESP32 cores are installed with Arduino IDE / CLI as before.
const EXTRA_CORES = [
  {
    core: amebafw.CORE,
    url: amebafw.INDEX_URL,
    note: "Realtek's Arduino core for the BW16 (first time only: about 110 MB from GitHub, a few minutes)",
  },
  {
    core: picofw.CORE,
    url: picofw.INDEX_URL,
    note: "the Raspberry Pi Pico Arduino core (first time only: about 300 MB from GitHub, several minutes)",
  },
];
async function ensureCore(fqbn) {
  const extra = EXTRA_CORES.find((c) => String(fqbn).startsWith(c.core + ":"));
  if (!extra) return;
  const have = await cli(["core", "list", "--format", "json"]);
  if (have.includes(`"${extra.core}"`)) return;
  emit("build", `Installing ${extra.note}…
`);
  const urls = ["--additional-urls", extra.url];
  await cli(["core", "update-index", ...urls], { timeout: 300000 });
  await cli(["core", "install", extra.core, ...urls], { timeout: 1800000 });
}
// Installs Arduino libraries a build needs (e.g. DS18B20 / DHT sensors) once.
async function ensureLibraries(names = []) {
  if (!names.length) return;
  const have = await cli(["lib", "list", "--format", "json"]);
  for (const name of names)
    if (!have.includes(`"${name}"`)) {
      emit("build", `Installing the ${name} library (first time only)…\n`);
      await cli(["lib", "install", name]);
    }
}
// Compiles generated source as builds/<folder>/<name>/<name>.ino (persistent cache).
async function compileSketch(folder, name, fw, progress) {
  const root = path.join(__dirname, "builds", folder);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + ".ino"), fw.source);
  emit(
    "build",
    `Compiling build ${fw.build} for ${boards[fw.board || folder]?.label || folder}…\n`,
  );
  // With a progress bar: --verbose names the stages (its command lines are hidden).
  const output = await cli(
    [
      "compile",
      "--fqbn",
      fw.fqbn,
      "--build-path",
      path.join(root, "cache"),
      "--output-dir",
      path.join(root, "out"),
      ...(progress ? ["--verbose"] : []),
      dir,
    ],
    progress ? { onLine: (l) => progress.compileLine(l), quiet: noise } : {},
  );
  // Realtek boards: the image stays in the build folder as km0_km4_image2.bin; a copy
  // under the sketch's name is what Arduino CLI's upload looks for.
  if (boards[fw.board || folder]?.family === "ameba") {
    fs.mkdirSync(path.join(root, "out"), { recursive: true });
    fs.copyFileSync(
      path.join(root, "cache", amebafw.IMAGE),
      path.join(root, "out", name + ".ino.bin"),
    );
  }
  return {
    dir,
    root,
    bin: path.join(root, "out", name + ".ino.bin"),
    size: parseSize(output),
  };
}
const exclusive = (kind, fn) =>
  route(async (req) => {
    if (busy)
      throw Object.assign(Error(`A ${busy} is already running.`), {
        status: 409,
      });
    busy = kind;
    try {
      return await fn(req);
    } finally {
      busy = null;
    }
  });
const record = (req, action, fw, ok, message, size) =>
  store.addDeployment({
    owner: req.user?.id ?? null,
    flowId: req.body.flow?.id || null,
    flowName: String(req.body.flow?.name || "flow").slice(0, 100),
    action,
    board: req.body.settings.board,
    port: action === "upload" ? String(req.body.settings.serialPort) : null,
    build: fw?.build || "-",
    ok,
    size,
    message: message ? String(message).slice(-500) : null,
  });
// Test terminal over MQTT: one command line in, the board's reply out.
app.post(
  "/api/terminal",
  route(async (req) => {
    const { broker, deviceId, line } = req.body || {};
    return mqttCommand({ broker, deviceId, line });
  }),
);
// Broker-only loopback test (no board involved).
app.post(
  "/api/broker/test",
  route(async (req) => {
    const report = await brokerLoopback(req.body?.broker, {
      qos1: req.body?.qos1 !== false,
    });
    emit(
      report.ok ? "test" : "error",
      `${report.ok ? "✓" : "✗"} Broker loopback · ${report.url}`,
      {
        payload:
          report.steps.find((s) => s.ok === false)?.detail ||
          report.steps[2].detail,
      },
    );
    return report;
  }),
);
// Confirms the board is alive: USB status probe (build, WiFi, MQTT) and/or MQTT ping.
app.post(
  "/api/verify",
  exclusive("verify", async (req) => {
    const { serialPort, deviceId, build, broker, board } = req.body || {};
    if (serialPort && !/^(COM\d+|\/dev\/[a-zA-Z0-9._/-]+)$/.test(serialPort))
      throw Error("Enter a serial port such as COM3 or /dev/ttyUSB0.");
    if (deviceId && !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId))
      throw Error("Invalid Device ID.");
    if (build && !/^[a-f0-9]{10}$/.test(build))
      throw Error("Invalid build ID.");
    if (serialPort) await serialMonitor.disconnect(); // the probe needs the port
    emit("verify", `Verifying ${deviceId || serialPort}…`);
    const report = await verifyBoard({
      serialPort,
      deviceId,
      build,
      broker: broker?.url ? broker : null,
      family: boards[board]?.family,
      onStep: (index, step) =>
        emit(
          step.ok ? "verify" : "error",
          `${step.ok ? "✓" : "✗"} ${step.name}`,
          {
            payload: step.detail,
            index,
            step,
          },
        ),
    });
    if (boards[board])
      store.addDeployment({
        flowName: report.device.id || deviceId || serialPort,
        action: "verify",
        board,
        port: serialPort || null,
        build: report.device.build || build || "-",
        ok: report.ok,
        message: report.steps
          .map(
            (s) =>
              `${s.ok ? "✓" : s.ok === false ? "✗" : "–"} ${s.name}: ${s.detail}`,
          )
          .join("\n"),
      });
    if (report.device.id && report.ok) {
      // Keep what the board reported over USB (IP, build, heap…), so Devices shows
      // it before any MQTT heartbeat arrives; a broker board adds port and traffic.
      const d = report.device;
      const telemetry = d.ip
        ? Object.fromEntries(
            Object.entries({
              uptime: d.uptime,
              heap: d.heap,
              rssi: d.rssi,
              ip: d.ip,
              build: d.build,
              board: boards[board] ? board : undefined,
              ota: d.ota,
              broker: d.broker,
              port: d.port,
              login: d.login,
              clients: d.clients,
              messages: d.messages,
              flow: d.broker ? "MQTT broker" : undefined,
            }).filter(([, v]) => v !== undefined),
          )
        : undefined;
      store.touchDevice(d.id, { status: "online", telemetry });
    }
    return report;
  }),
);
// ── MQTT broker board: an ESP32 programmed as this network's broker ──
app.post(
  "/api/broker-board/upload",
  exclusive("upload", async (req) => {
    const fw = brokerfw.generate(req.body || {});
    const port = String(req.body.serialPort || "");
    if (!/^(COM\d+|\/dev\/[a-zA-Z0-9._/-]+)$/.test(port))
      throw Error("Enter the broker board's serial port, such as COM3.");
    const deploy = (ok, message, size) =>
      store.addDeployment({
        owner: req.user?.id ?? null,
        flowId: null,
        flowName: "MQTT broker board",
        action: "upload",
        board: fw.settings.board,
        port,
        build: fw.build,
        ok,
        size,
        message: message ? String(message).slice(-500) : null,
      });
    try {
      // The broker (and screen) libraries are not part of the ESP32 core: install once.
      await ensureLibraries(fw.libraries || [brokerfw.LIBRARY]);
      await serialMonitor.disconnect();
      await uploadPreflight(port, fw.settings.board); // before compiling
      const out = await compileSketch(
        "broker-" + fw.settings.board,
        "microflow_broker",
        { ...fw, board: fw.settings.board },
      );
      emit("build", `Uploading the broker to ${port}…\n`);
      let output;
      try {
        output = await cli([
          "upload",
          "--fqbn",
          fw.fqbn,
          "--port",
          port,
          "--input-dir",
          path.join(out.root, "out"),
          out.dir,
        ]);
      } catch (e) {
        throw Object.assign(
          Error(
            withPortHint(uploadFailure(e.message, port, boards[fw.settings.board]?.family) || e.message, port),
          ),
          { stage: "upload" },
        );
      }
      const failure = uploadFailure(output, port, boards[fw.settings.board]?.family);
      if (failure)
        throw Object.assign(Error(withPortHint(failure, port)), {
          stage: "upload",
        });
      deploy(true, null, out.size);
      return {
        ok: true,
        build: fw.build,
        size: out.size,
        port: fw.settings.port,
      };
    } catch (e) {
      deploy(false, e.message);
      throw e;
    }
  }),
);
// Guests compile at most once per GUEST_COMPILE_MS from one address (a compile keeps
// a CPU core busy for up to a minute).
const GUEST_COMPILE_MS = 30000;
const guestCompiles = new Map(); // address → time of the last compile
function guestCompileAllowed(req) {
  const who =
    req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress;
  const now = Date.now();
  for (const [k, t] of guestCompiles)
    if (now - t > GUEST_COMPILE_MS) guestCompiles.delete(k);
  const last = guestCompiles.get(who);
  if (last)
    throw Object.assign(
      Error(
        `Guests can compile once every ${GUEST_COMPILE_MS / 1000} s: try again in ${Math.ceil((GUEST_COMPILE_MS - (now - last)) / 1000)} s, or log in.`,
      ),
      { status: 429 },
    );
  guestCompiles.set(who, now);
}
// The firmware image to flash at address 0: ESP32 cores write a merged image
// (bootloader + partitions + app); an ESP8266 .bin already starts at 0.
function firmwareImage(fw, since) {
  if (boards[fw.board]?.family === "ameba") return null; // Realtek's own tool
  // Raspberry Pi Pico: a UF2 file, copied onto the board's USB drive (BOOTSEL).
  if (boards[fw.board]?.family === "rp2040") {
    const uf2 = fw.bin.replace(/\.bin$/, ".uf2");
    if (!fs.existsSync(uf2) || fs.statSync(uf2).mtimeMs < since) return null;
    return {
      name: `microflow-${fw.board}-${fw.build}.uf2`,
      format: "uf2",
      base64: fs.readFileSync(uf2).toString("base64"),
    };
  }
  const merged = fw.bin.replace(/\.bin$/, ".merged.bin");
  const file = [merged, fw.bin].find(
    (f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= since,
  );
  if (!file) return null;
  return {
    name: `microflow-${fw.board}-${fw.build}.bin`,
    // Where it goes in flash: a merged image (bootloader + partitions + app) and an
    // ESP8266 image at 0x0; an ESP32 app alone at 0x10000 (the browser flasher uses it).
    address: file === merged || boards[fw.board]?.family !== "esp32" ? 0 : 0x10000,
    base64: fs.readFileSync(file).toString("base64"),
  };
}
app.post(
  "/api/compile",
  exclusive("compile", async (req) => {
    let fw;
    if (req.guest) guestCompileAllowed(req);
    const started = Date.now() - 1000;
    const progress = buildProgress("compile", req.body.settings || {});
    try {
      fw = await compile(
        validate(req.body.flow),
        req.body.settings || {},
        progress,
        !!req.guest,
      );
      progress.finish(true);
      if (!req.guest) record(req, "compile", fw, true, null, fw.size);
      return {
        ok: true,
        build: fw.build,
        size: fw.size,
        warnings: fw.warnings,
        // download: the image to flash yourself (always for guests, who cannot upload).
        firmware:
          req.body.download || req.guest ? firmwareImage(fw, started) : undefined,
      };
    } catch (e) {
      progress.finish(false);
      if (req.body.settings?.board && !req.guest)
        record(req, "compile", fw, false, e.message);
      throw e;
    }
  }),
);
// Upload methods: "usb" (serial cable), "mqtt" (through the broker, no open ports,
// encrypted) and "lan" (ArduinoOTA push on the local network).
app.post(
  "/api/upload",
  exclusive("upload", async (req) => {
    const settings = req.body.settings || {};
    const method = req.body.method || "usb";
    const target = req.body.target || {};
    if (!["usb", "mqtt", "lan"].includes(method))
      throw Error("Unknown upload method.");
    if (method !== "usb" && ["ameba", "rp2040"].includes(boards[settings.board]?.family))
      throw Error(
        `Remote update is not available on ${boards[settings.board].label}: upload over USB.`,
      );
    const port = String(settings.serialPort || "");
    if (method === "usb" && !/^(COM\d+|\/dev\/[a-zA-Z0-9._/-]+)$/.test(port))
      throw Error("Enter a serial port such as COM3 or /dev/ttyUSB0.");
    if (
      method === "mqtt" &&
      !/^[A-Za-z0-9_-]{1,32}$/.test(target.deviceId || "")
    )
      throw Error(
        "Enter the Device ID of the board to update (see Devices or Verify board).",
      );
    if (method === "mqtt" && !req.body.broker?.url)
      throw Error("Enter the Broker URL.");
    const flow = validate(req.body.flow);
    build(flow, settings); // fail fast on validation before touching the board
    if (method === "usb") {
      await serialMonitor.disconnect();
      await uploadPreflight(port, settings.board); // before compiling
    }
    let fw;
    const where =
      method === "usb"
        ? port
        : method === "mqtt"
          ? "mqtt:" + target.deviceId
          : "lan:" + target.ip;
    const progressBar = buildProgress("upload", settings, method);
    try {
      fw = await compile(flow, settings, progressBar);
      try {
        progressBar.appBytes = fs.statSync(fw.bin).size;
      } catch {}
      if (method === "usb") {
        emit("build", `Uploading to ${port}…\n`);
        let output;
        try {
          output = await cli(
            [
              "upload",
              "--fqbn",
              fw.fqbn,
              "--port",
              port,
              "--input-dir",
              path.join(fw.root, "out"),
              fw.dir,
            ],
            { onLine: (l) => progressBar.uploadLine(l) },
          );
        } catch (e) {
          throw Object.assign(
            Error(
              withPortHint(uploadFailure(e.message, port, boards[settings.board]?.family) || e.message, port),
            ),
            { stage: "upload" },
          );
        }
        // ESP8266's upload.py exits 0 even when esptool fails, so read the output.
        const failure = uploadFailure(output, port, boards[settings.board]?.family);
        if (failure)
          throw Object.assign(Error(withPortHint(failure, port)), {
            stage: "upload",
          });
      } else {
        const image = fs.readFileSync(fw.bin);
        const keys = ota.projectKeys(store);
        let shown = -1;
        const progress = (done, total) => {
          const pct = Math.floor((100 * done) / total);
          progressBar.remote(pct);
          if (pct !== shown && (pct % 5 === 0 || pct === 100)) {
            shown = pct;
            emit("ota", `Remote update ${pct} %`, { pct, done, total });
          }
        };
        if (method === "mqtt") {
          emit(
            "build",
            `Sending ${image.length} bytes to ${target.deviceId} through ${req.body.broker.url} (encrypted)…\n`,
          );
          let r;
          try {
            r = await ota.overMqtt({
              broker: req.body.broker,
              deviceId: target.deviceId,
              image,
              keys,
              onProgress: progress,
            });
          } catch (e) {
            if (!/did not answer the update request/.test(e.message)) throw e;
            // Find out why instead of guessing: ping, stored status, USB.
            emit("build", `${target.deviceId} did not answer; checking why…\n`);
            const port = /^(COM\d+|\/dev\/[a-zA-Z0-9._/-]+)$/.test(
              settings.serialPort || "",
            )
              ? settings.serialPort
              : null;
            if (port) await serialMonitor.disconnect().catch(() => {});
            throw Error(
              "Remote update not started. " +
                (await diagnoseRemote({
                  broker: req.body.broker,
                  deviceId: target.deviceId,
                  serialPort: port,
                  family: boards[settings.board].family,
                })),
            );
          }
          emit(
            "build",
            `Transferred in ${r.seconds.toFixed(1)} s; the board is restarting…\n`,
          );
        } else {
          emit("build", `Uploading to ${target.ip} over the LAN…\n`);
          await ota.overLan({
            ip: target.ip,
            family: boards[settings.board].family,
            bin: fw.bin,
            password: keys.lan,
            onOutput: (text) => {
              const m = /(\d+)%/.exec(text);
              if (m) progress(Number(m[1]), 100);
            },
          });
        }
        // Confirm the new build is running (needs the broker; LAN-only setups may skip).
        if (req.body.broker?.url && fw.features.net) {
          const id = settings.deviceId || target.deviceId;
          if (id) {
            const check = await verifyBoard({
              deviceId: id,
              build: fw.build,
              broker: req.body.broker,
              limits: { ping: 60000 },
            });
            const step = check.steps.at(-1);
            if (!check.ok)
              throw Error(
                `Upload finished, but the new build was not confirmed: ${step.detail}`,
              );
            emit("verify", `✓ ${id} runs build ${fw.build}`, {
              payload: step.detail,
            });
          }
        }
      }
      store.addDeployment({
        flowId: req.body.flow?.id || null,
        flowName: String(req.body.flow?.name || "flow").slice(0, 100),
        action: "upload",
        board: settings.board,
        port: where,
        build: fw.build,
        ok: true,
        size: fw.size,
      });
      progressBar.finish(true);
      return {
        ok: true,
        method,
        port: method === "usb" ? port : null,
        build: fw.build,
        size: fw.size,
        warnings: fw.warnings,
        features: fw.features,
      };
    } catch (e) {
      store.addDeployment({
        flowId: req.body.flow?.id || null,
        flowName: String(req.body.flow?.name || "flow").slice(0, 100),
        action: "upload",
        board: settings.board || "-",
        port: where,
        build: fw?.build || "-",
        ok: false,
        size: fw?.size,
        message: String(e.message).slice(-500),
      });
      progressBar.finish(false);
      throw e;
    }
  }),
);
app.use("/api", (req, res) =>
  res.status(404).json({
    error: `Unknown API endpoint: ${req.method} ${req.originalUrl}. Check that the backend and app files are up to date.`,
  }),
);
app.use((err, req, res, next) =>
  err.stage
    ? res
        .status(err.status || 400)
        .json({
          error: err.message,
          stage: err.stage,
          lan: err.lan,
          chip: err.chip,
          fits: err.fits,
        })
    : res.status(err.status || 400).json({ error: err.message }),
);
const stop = () => runtime.stop();
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "127.0.0.1", () =>
    console.log(`Microflow → http://127.0.0.1:${port}`),
  );
}
module.exports = {
  app,
  db,
  store,
  runtime,
  matches,
  stop,
  withPortHint,
  checkPort,
};
