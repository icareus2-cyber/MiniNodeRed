// Guest mode: a visitor who is not logged in on a server with accounts. The server
// keeps nothing for a guest (lib/auth.js), so their flows and settings live in this
// browser (localStorage), and Backup / Restore move them as one file. api() (api.js)
// asks guestApi() first; it answers what is kept here and returns undefined for the
// rest, which goes to the server (allowed: design, check, compile, download).
let guestCheck = null;
// Resolves true for a guest (asked once per page: /api/auth/me).
function isGuest() {
  guestCheck ||= fetch("/api/auth/me", { cache: "no-store" })
    .then((r) => r.json())
    .then((me) => !!me.guest)
    .catch(() => false);
  return guestCheck;
}

const GUEST_FLOWS = "microflow.guest.flows"; // { id: flow document }
const GUEST_SETTINGS = "microflow.guest.settings"; // WiFi, language, custom nodes

function guestRead(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
function guestWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw Error(
      `This browser could not save it (${e.name === "QuotaExceededError" ? "its storage is full" : "storage is blocked"}). Use Backup in the account menu to keep a file.`,
    );
  }
}

// The API calls a guest's browser answers itself, or undefined (ask the server).
async function guestApi(url, body, verb) {
  const flows = () => guestRead(GUEST_FLOWS, {});
  const one = /^flows\/([^/]+)$/.exec(url);
  if (url === "flows" && verb === "GET")
    return Object.values(flows())
      .map((f) => ({ id: f.id, name: f.name, updated: f.updated, tests: 0, shared: false, owner: null, mine: true }))
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  if (url === "flows" && verb === "POST") {
    const doc = await api("validate", body); // the server checks it, keeps nothing
    doc.id = body.id || doc.id || crypto.randomUUID();
    doc.name = String(doc.name || "Untitled flow").slice(0, 100);
    doc.updated = new Date().toISOString();
    guestWrite(GUEST_FLOWS, { ...flows(), [doc.id]: doc });
    return doc;
  }
  if (one && verb === "GET") {
    const doc = flows()[decodeURIComponent(one[1])];
    if (!doc) throw Object.assign(Error("Flow not found in this browser."), { status: 404 });
    return doc;
  }
  if (one && verb === "DELETE") {
    const all = flows();
    const id = decodeURIComponent(one[1]);
    const ok = id in all;
    delete all[id];
    guestWrite(GUEST_FLOWS, all);
    return { ok };
  }
  if (url === "flows/delete") {
    const all = flows();
    let deleted = 0;
    for (const id of body.ids || [])
      if (id in all) {
        delete all[id];
        deleted++;
      }
    guestWrite(GUEST_FLOWS, all);
    return { deleted };
  }
  if (/^flows\/[^/]+\/(revisions|tests)$/.test(url) && verb === "GET") return [];
  if (url === "settings" && verb === "GET") return guestRead(GUEST_SETTINGS, {});
  if (url === "settings" && verb === "PUT") {
    const next = { ...guestRead(GUEST_SETTINGS, {}), ...body };
    guestWrite(GUEST_SETTINGS, next);
    return next;
  }
  // Examples: a copy in this browser instead of the server's saved flows.
  const example = /^examples\/([a-z0-9-]+)$/.exec(url);
  if (example && verb === "POST") {
    const e = await api(url, undefined, "GET");
    return guestApi("flows", e.flow, "POST");
  }
  return undefined;
}

// ── Backup / restore: one file with this browser's Microflow data ──
// Guests: their flows and settings. Logged-in users: their settings (flows are on
// the server, Export saves one). The file can hold the WiFi password.
async function downloadBackup() {
  const guest = await isGuest();
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith("microflow.") && !k.startsWith("microflow.guest.")) local[k] = localStorage.getItem(k);
  }
  const backup = {
    microflowBackup: 1,
    made: new Date().toISOString(),
    settings: await api("settings"),
    flows: guest ? Object.values(guestRead(GUEST_FLOWS, {})) : [],
    local,
  };
  download(
    `microflow-backup-${backup.made.slice(0, 10)}.json`,
    JSON.stringify(backup, null, 2),
    "application/json",
  );
  toast(
    backup.settings.password
      ? "Backup downloaded. It contains your WiFi password: keep it private."
      : "Backup downloaded.",
  );
}

async function restoreBackup(file) {
  const backup = JSON.parse(await file.text());
  if (backup?.microflowBackup !== 1) throw Error("This is not a Microflow backup file.");
  const guest = await isGuest();
  const keep = ["ssid", "password", "language", "customNodes"];
  const saved = Object.fromEntries(
    Object.entries(backup.settings || {}).filter(([k, v]) => keep.includes(k) && typeof v === "string"),
  );
  if (Object.keys(saved).length) await api("settings", saved, "PUT");
  for (const [k, v] of Object.entries(backup.local || {}))
    if (k.startsWith("microflow.") && !k.startsWith("microflow.guest.") && typeof v === "string")
      try {
        localStorage.setItem(k, v);
      } catch {}
  // Flows: into this browser (guest) or the server (logged in), as new copies.
  let added = 0;
  for (const f of Array.isArray(backup.flows) ? backup.flows : []) {
    const copy = { ...f };
    if (!guest) delete copy.id;
    await api("flows", copy);
    added++;
  }
  toast(`Backup restored${added ? `: ${added} flow${added > 1 ? "s" : ""}` : ""}. Reloading…`);
  setTimeout(() => location.reload(), 900);
}

function pickBackup() {
  const input = Object.assign(document.createElement("input"), {
    type: "file",
    accept: ".json,application/json",
  });
  input.onchange = () => input.files[0] && attempt(() => restoreBackup(input.files[0]))();
  input.click();
}

// Saves a compiled image (base64) as a file.
function saveFirmware(firmware) {
  const bytes = Uint8Array.from(atob(firmware.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: firmware.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
