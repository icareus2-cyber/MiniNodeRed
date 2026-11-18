// PWA node: a phone page (Progressive Web App) that looks like a keyboard, talking
// to the board over MQTT with JSON messages.
//
//   phone → board   microflow/<device>/pwa/<node id>/in    {"key":"7"}
//   board → phone   microflow/<device>/pwa/<node id>/out   {"text":"Door open","image":"alert"}
//                   (retained, so the page shows the last state when it opens)
//
// The node's output is each key pressed (the key, or the whole JSON); what reaches
// its input is shown on the phone: JSON with "text" and / or "image", or plain text.
// Images are static: the page carries them (Images, name → URL or data URI) and the
// board names one ({"image":"alert"}); a small picture can also come as a data URI
// over MQTT (up to about 6 KB on ESP32 boards).
//
// "Publish test page" writes the page (index.html, pwa.json, manifest, service worker,
// icon) to the project's pwa/<name>/ folder and serves it at /pwa/<name>/. Served by
// Microflow it talks to the simulator or the board through the IDE (no broker setup);
// copied to any HTTPS static host it connects to the broker's WebSocket URL itself.

const KEYBOARD = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M", "Back"],
  ["Esc", "Space", "Enter"],
];
const KEYPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
  ["Left", "Up", "Down", "Right"],
  ["Cancel", "OK"],
];
const svg = (body) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
  );
const IMAGES = {
  ok: svg(
    '<circle cx="32" cy="32" r="30" fill="#2f9e5b"/><path d="M18 33l9 9 19-20" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>',
  ),
  alert: svg(
    '<path d="M32 4L62 58H2z" fill="#e0a21b"/><rect x="29" y="22" width="6" height="20" rx="3" fill="#222"/><circle cx="32" cy="49" r="3.5" fill="#222"/>',
  ),
  lock: svg(
    '<rect x="12" y="28" width="40" height="30" rx="5" fill="#4a5a7a"/><path d="M20 28v-8a12 12 0 0124 0v8" fill="none" stroke="#4a5a7a" stroke-width="6"/><circle cx="32" cy="43" r="4" fill="#fff"/>',
  ),
};
const fields = [
  {
    key: "title",
    label: "Page title",
    type: "text",
    default: "Microflow keyboard",
  },
  {
    key: "layout",
    label: "Keys",
    type: "select",
    default: "keyboard",
    options: {
      keyboard: "Keyboard (digits, letters, Space, Enter, Back)",
      keypad: "Keypad (0–9, * #, arrows, OK)",
      custom: "Custom (Keys JSON below)",
    },
  },
  {
    key: "keys",
    label: 'Keys JSON: rows of key labels, e.g. [["A","B"],["OK"]]',
    type: "textarea",
    default: JSON.stringify(KEYPAD),
    when: { layout: ["custom"] },
  },
  {
    key: "images",
    label: 'Images JSON: name → URL or data URI; the board shows one with {"image":"name"}',
    type: "textarea",
    default: JSON.stringify(IMAGES, null, 1),
  },
  {
    key: "sends",
    label: "Sends",
    type: "select",
    default: "key",
    options: {
      key: 'The key pressed ("7", "Enter")',
      json: 'The JSON from the phone ({"key":"7"})',
    },
  },
  {
    key: "pageUrl",
    label:
      "Published page address (where you copied the pwa/<name>/ folder, https://…) — for the QR code",
    type: "text",
    default: "",
    empty: true,
  },
  {
    key: "wsUrl",
    label:
      "Broker WebSocket URL for the published page (wss://…, e.g. wss://broker.emqx.io:8084/mqtt)",
    type: "text",
    default: "",
    empty: true,
  },
];
const keysOf = (c) =>
  c.layout === "keypad"
    ? KEYPAD
    : c.layout === "custom"
      ? JSON.parse(c.keys || "[]")
      : KEYBOARD;
function validate(c) {
  let keys, images;
  try {
    keys = keysOf(c);
  } catch {
    throw Error("PWA: Keys JSON is not valid JSON.");
  }
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 12 ||
    keys.some(
      (row) =>
        !Array.isArray(row) ||
        !row.length ||
        row.length > 12 ||
        row.some((k) => typeof k !== "string" || !k.trim() || k.length > 12),
    )
  )
    throw Error(
      'PWA: Keys must be rows of key labels, e.g. [["1","2"],["OK"]] (up to 12 rows of 12 keys, 12 characters each).',
    );
  try {
    images = JSON.parse(c.images || "{}");
  } catch {
    throw Error("PWA: Images JSON is not valid JSON.");
  }
  if (
    !images ||
    typeof images !== "object" ||
    Array.isArray(images) ||
    Object.values(images).some((v) => typeof v !== "string")
  )
    throw Error('PWA: Images must be {"name": "URL or data:…"}.');
  if (c.pageUrl && !/^https?:\/\/[^\s]+$/.test(c.pageUrl))
    throw Error("PWA: the published page address starts with https:// (or http://).");
  if (c.wsUrl && !/^wss?:\/\/[^\s]+$/.test(c.wsUrl))
    throw Error("PWA: the broker WebSocket URL starts with wss:// (or ws://).");
}
// The page's settings file (pwa.json).
function pageConfig(n, { device = "", broker = "" } = {}) {
  const c = n.config;
  return {
    title: c.title || "Microflow",
    node: n.id,
    name: n.name || "PWA",
    device,
    keys: keysOf(c),
    images: JSON.parse(c.images || "{}"),
    broker: c.wsUrl || broker || "",
    topics: {
      in: `microflow/${device || "{device}"}/pwa/${n.id}/in`,
      out: `microflow/${device || "{device}"}/pwa/${n.id}/out`,
    },
  };
}
// What the board (or the simulator) shows: JSON as it is, plain text as {"text": …}.
function displayJson(v) {
  const t = String(v);
  if (/^\s*\{/.test(t)) {
    try {
      JSON.parse(t);
      return t;
    } catch {}
  }
  return JSON.stringify({ text: t });
}
// What the node sends for a key message from the phone.
function sends(c, json) {
  if (c.sends === "json") return json;
  try {
    return String(JSON.parse(json).key ?? "");
  } catch {
    return json;
  }
}
const KEY = "\x1e"; // marks a key message from the phone (not something to show)
// ── Simulator ──
function host(v, n, ctx) {
  const t = String(v);
  if (t.startsWith(KEY)) {
    const out = sends(n.config, t.slice(1));
    return out === "" ? undefined : out;
  }
  ctx.pwa?.(n, displayJson(t));
  return undefined;
}
// ── Firmware ──
const quoted = (s) => JSON.stringify(String(s));
const topic = (n, dir) => `(mfBase + ${quoted(`/pwa/${n.id}/${dir}`)})`;
function body(n) {
  const key =
    n.config.sends === "json" ? "" : ` value = mfJson::jsonText(value, "key");`;
  return `if (value.length() && value[0] == 30) { value = value.substring(1);${key} if (!value.length()) return; } else {
  // Shown on the phone (retained: the page gets it when it opens).
  String out = value;
  out.trim();
  if (!out.startsWith("{")) out = String("{\\"text\\":") + mfJson::jsonQuote(value) + "}";
  if (!mqtt.connected() || !mqtt.publish(${topic(n, "out")}.c_str(), out.c_str(), true))
    Serial.println("PWA: not sent (no broker connection, or the message is too big)");
  return; }`;
}
const received = (n, i) =>
  `  if (${topic(n, "in")} == topicCopy) node${i}(String((char)30) + value);`;
const subscribe = (n) => `      mqtt.subscribe(${topic(n, "in")}.c_str());`;

// ── The page ──
const manifest = (cfg) =>
  JSON.stringify(
    {
      name: cfg.title,
      short_name: cfg.title.slice(0, 12),
      start_url: "./",
      scope: "./",
      display: "standalone",
      background_color: "#1d2420",
      theme_color: "#1d2420",
      icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    },
    null,
    1,
  );
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d2420"/><g fill="#c3e7aa">${[0, 1, 2]
  .flatMap((r) =>
    [0, 1, 2].map(
      (k) =>
        `<rect x="${10 + k * 16}" y="${12 + r * 15}" width="12" height="11" rx="3"/>`,
    ),
  )
  .join("")}</g></svg>`;
const SW = `// Service worker: the page opens offline (the messages still need the network).
const CACHE = "mf-pwa-v1";
const FILES = ["./", "index.html", "pwa.json", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  // Network first (new settings arrive), the cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request)),
  );
});
`;
const MQTT_JS = "https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js";
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
<meta name="theme-color" content="#1d2420" />
<title>Microflow PWA</title>
<link rel="manifest" href="manifest.webmanifest" />
<link rel="icon" href="icon.svg" />
<style>
  :root { --bg:#1d2420; --panel:#2a332e; --key:#3b4640; --key2:#4a5650; --ink:#eef3ee; --muted:#9fb1a6; --accent:#c3e7aa; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 16px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; padding: max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom)); gap: 10px; }
  header { display: flex; align-items: center; gap: 8px; }
  header h1 { font-size: 16px; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #dot { width: 10px; height: 10px; border-radius: 50%; background: #b5463a; flex: none; }
  #dot.on { background: #4cc46f; }
  #state { font-size: 12px; color: var(--muted); }
  header button { background: none; border: 1px solid #4a5650; color: var(--muted); border-radius: 8px; padding: 4px 8px; }
  #screen { flex: 1; min-height: 120px; background: #10140f; border: 2px solid #3b4640; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 12px; text-align: center; overflow: hidden; }
  #screen img { max-width: 100%; max-height: 45vh; object-fit: contain; }
  #screen img[hidden] { display: none; }
  #text { font: 22px ui-monospace, monospace; color: var(--accent); white-space: pre-wrap; word-break: break-word; }
  #typed { font: 13px ui-monospace, monospace; color: var(--muted); min-height: 16px; }
  #keys { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; justify-content: center; }
  .key { flex: 1 1 0; min-width: 0; height: 52px; border: none; border-radius: 9px; background: var(--key); color: var(--ink); font: 600 18px system-ui, sans-serif; box-shadow: 0 3px 0 #141a16; user-select: none; touch-action: manipulation; }
  .key.wide { flex-grow: 2.4; font-size: 15px; }
  .key:active, .key.down { background: var(--accent); color: #1d2420; transform: translateY(2px); box-shadow: 0 1px 0 #141a16; }
  dialog { background: var(--panel); color: var(--ink); border: 1px solid #4a5650; border-radius: 12px; width: min(420px, 92vw); }
  dialog label { display: block; margin: 8px 0; font-size: 13px; color: var(--muted); }
  dialog input { width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #4a5650; background: #1d2420; color: var(--ink); }
  dialog menu { display: flex; gap: 8px; justify-content: flex-end; padding: 0; }
  dialog button { padding: 8px 14px; border-radius: 8px; border: none; background: var(--key2); color: var(--ink); }
  dialog button.go { background: var(--accent); color: #1d2420; font-weight: 700; }
</style>
</head>
<body>
<header>
  <span id="dot" title="Connection"></span><h1 id="title">Microflow</h1><span id="state">connecting…</span>
  <button id="setup" aria-label="Connection settings">⚙</button>
</header>
<div id="screen" aria-live="polite"><img id="image" alt="" hidden /><div id="text">—</div></div>
<div id="typed"></div>
<div id="keys"></div>
<dialog id="dlg"><form method="dialog">
  <b>Connection</b>
  <label>Broker WebSocket URL<input id="fBroker" placeholder="wss://broker.example.com:8084/mqtt" /></label>
  <label>Device ID (the board's)<input id="fDevice" /></label>
  <label>Username (if the broker needs one)<input id="fUser" autocomplete="username" /></label>
  <label>Password<input id="fPass" type="password" autocomplete="current-password" /></label>
  <menu><button value="cancel">Cancel</button><button class="go" value="ok">Connect</button></menu>
</form></dialog>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const WIDE = /^(Space|Enter|Back|Esc|OK|Cancel|Shift|Tab)$/;
let cfg, link = null, typed = "";
const store = {
  get: (k) => { try { return localStorage.getItem("mfpwa." + k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem("mfpwa." + k, v); } catch {} },
};
function setState(on, text) { $("dot").classList.toggle("on", on); $("state").textContent = text; }
// Something to show: {"text": …, "image": name or URL / data URI}, or plain text.
function show(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { m = { text: String(raw) }; }
  if (typeof m !== "object" || m === null) m = { text: String(m) };
  if ("text" in m) $("text").textContent = String(m.text);
  if ("image" in m) {
    const src = m.image ? cfg.images?.[m.image] || (/^(data:image\\/|https?:)/.test(m.image) ? m.image : "") : "";
    $("image").hidden = !src;
    if (src) $("image").src = src;
  }
}
function key(k) {
  if (k === "Back") typed = typed.slice(0, -1);
  else if (k === "Space") typed += " ";
  else if (k === "Enter" || k === "Esc") typed = "";
  else if (k.length === 1) typed = (typed + k).slice(-40);
  $("typed").textContent = typed;
  if (navigator.vibrate) navigator.vibrate(15);
  link?.send(JSON.stringify({ key: k }));
}
function buildKeys() {
  const box = $("keys");
  box.replaceChildren();
  for (const row of cfg.keys) {
    const r = document.createElement("div");
    r.className = "row";
    for (const k of row) {
      const b = document.createElement("button");
      b.className = "key" + (WIDE.test(k) || k.length > 2 ? " wide" : "");
      b.textContent = k === "Space" ? "␣" : k === "Back" ? "⌫" : k === "Enter" ? "⏎" : k;
      b.title = k;
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.classList.add("down"); key(k); });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => b.classList.remove("down"));
      r.append(b);
    }
    box.append(r);
  }
}
// Served by Microflow: talk through the IDE (simulator or the board it monitors).
// The page's folder (/pwa/<folder>/): the node's variable name.
const FOLDER = decodeURIComponent(location.pathname.split("/").filter(Boolean).slice(-1)[0] || "");
let nodeId = "";
async function viaMicroflow() {
  nodeId = cfg.node;
  const r = await fetch("/api/pwa/state?node=" + encodeURIComponent(cfg.node) + "&folder=" + encodeURIComponent(FOLDER), { cache: "no-store" });
  if (!r.ok) throw Error("no Microflow");
  const s = await r.json();
  const via = { host: "simulator", device: "board" };
  const state = (s) => {
    if (s.node) nodeId = s.node; // the running node (it may have a new id)
    if (s.problem) { setState(false, "Not in the running flow"); show(JSON.stringify({ text: s.problem })); return; }
    if (s.payload) show(s.payload);
    setState(s.running, s.running ? "via Microflow · " + (via[s.mode] || s.mode) : "Microflow: start ▶ Simulate");
  };
  state(s);
  const again = () => fetch("/api/pwa/state?node=" + encodeURIComponent(cfg.node) + "&folder=" + encodeURIComponent(FOLDER), { cache: "no-store" }).then((r) => r.json()).then(state).catch(() => {});
  const events = new EventSource("/api/events");
  events.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === "pwa" && ev.node === nodeId) show(ev.payload);
    if (ev.kind === "status") setTimeout(again, 300); // started, stopped, restarted
  };
  events.onerror = () => setState(false, "Microflow not reachable");
  return {
    send: (json) =>
      fetch("/api/pwa/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node: cfg.node, folder: FOLDER, payload: json }) })
        .then((r) => r.ok || r.json().then((e) => { setState(false, "Key not sent"); show(JSON.stringify({ text: e.error || "not sent" })); })),
  };
}
// Published on a static host: MQTT over WebSocket straight to the broker.
function loadMqtt() {
  return new Promise((ok, fail) => {
    if (window.mqtt) return ok();
    const s = document.createElement("script");
    s.src = "${MQTT_JS}";
    s.onload = ok; s.onerror = () => fail(Error("mqtt.js did not load (offline?)"));
    document.head.append(s);
  });
}
async function viaBroker() {
  const url = store.get("broker") || cfg.broker;
  const device = store.get("device") || cfg.device;
  if (!url || !device) { $("dlg").showModal(); throw Error("set the broker and the Device ID"); }
  if (location.protocol === "https:" && url.startsWith("ws:")) setState(false, "https page: use a wss:// broker URL");
  await loadMqtt();
  const t = (dir) => "microflow/" + device + "/pwa/" + cfg.node + "/" + dir;
  const client = mqtt.connect(url, { username: store.get("user") || undefined, password: store.get("pass") || undefined, reconnectPeriod: 3000, clean: true });
  client.on("connect", () => { setState(true, "broker · " + device); client.subscribe(t("out")); });
  client.on("reconnect", () => setState(false, "reconnecting…"));
  client.on("error", (e) => setState(false, e.message));
  client.on("message", (topic, payload) => show(payload.toString()));
  return { send: (json) => client.connected ? client.publish(t("in"), json) : setState(false, "not connected") };
}
async function start() {
  link = null;
  try { link = await viaMicroflow(); }
  catch { try { link = await viaBroker(); } catch (e) { setState(false, e.message); } }
}
$("setup").onclick = () => {
  $("fBroker").value = store.get("broker") || cfg.broker; $("fDevice").value = store.get("device") || cfg.device;
  $("fUser").value = store.get("user"); $("fPass").value = store.get("pass");
  $("dlg").showModal();
};
$("dlg").addEventListener("close", () => {
  if ($("dlg").returnValue !== "ok") return;
  store.set("broker", $("fBroker").value.trim()); store.set("device", $("fDevice").value.trim());
  store.set("user", $("fUser").value.trim()); store.set("pass", $("fPass").value);
  location.reload();
});
document.addEventListener("keydown", (e) => {
  if ($("dlg").open) return;
  const k = e.key === " " ? "Space" : e.key === "Backspace" ? "Back" : e.key === "Escape" ? "Esc" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (cfg.keys.flat().includes(k)) { e.preventDefault(); key(k); }
});
// Set up by QR code: …/#setup=<base64 JSON {broker, device}> (from Microflow).
try {
  const m = /#setup=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    const s = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (s.broker) store.set("broker", s.broker);
    if (s.device) store.set("device", s.device);
    history.replaceState(null, "", location.pathname + location.search);
  }
} catch {}
fetch("pwa.json", { cache: "no-store" }).then((r) => r.json()).then((c) => {
  cfg = c;
  document.title = $("title").textContent = c.title;
  buildKeys();
  start();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
</script>
</body>
</html>
`;
// The files of a published page: { "index.html": text, … }.
function files(n, opts) {
  const cfg = pageConfig(n, opts);
  return {
    "index.html": PAGE,
    "pwa.json": JSON.stringify(cfg, null, 1),
    "manifest.webmanifest": manifest(cfg),
    "sw.js": SW,
    "icon.svg": ICON,
  };
}
// Folder name of a node's page: its variable name, lower case.
const folderOf = (n) =>
  String(n.name || n.id)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 40) || "pwa";
module.exports = {
  fields,
  validate,
  host,
  body,
  received,
  subscribe,
  files,
  pageConfig,
  displayJson,
  sends,
  folderOf,
  KEY,
  KEYBOARD,
  KEYPAD,
};
