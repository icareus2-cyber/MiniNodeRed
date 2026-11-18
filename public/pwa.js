// ── PWA node: publish and open its phone page (lib/pwafw.js) ──────────
// Publish test page writes the page to the project's pwa/<name>/ folder and opens
// it: served by Microflow it talks through the simulator (or the monitored board).
// The folder is also the finished PWA: copy it to any HTTPS static host, with the
// broker's WebSocket URL set in the node.
async function publishPwa(n) {
  storeChipSettings?.();
  const r = await api("pwa/publish", {
    node: n,
    deviceId: $("deviceId").value.trim(),
  });
  return r;
}
function downloadText(name, text, type = "application/json") {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: name,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function pwaProps(n) {
  const area = el("div", "pwa-props");
  area.append(
    el("b", "", "Messages (JSON)"),
    el(
      "pre",
      "pwa-formats",
      `phone → board  microflow/<device>/pwa/${n.id}/in\n  {"key":"7"}\nboard → phone  microflow/<device>/pwa/${n.id}/out  (retained)\n  {"text":"Door open","image":"alert"}  or plain text`,
    ),
  );
  const folder =
    String(n.name || n.id)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 40) || "pwa";
  area.append(
    el(
      "p",
      "muted",
      `Page address: http://localhost:3000/pwa/${folder}/ (the folder is the node's variable name, ${n.name}). All published pages: http://localhost:3000/pwa/`,
    ),
  );
  // Published under another (old) variable name? Publishing again moves it.
  const where = el("p", "muted");
  area.append(where);
  api("pwa/pages")
    .then((pages) => {
      const mine = pages.filter((p) => p.node === n.id).map((p) => p.folder);
      if (!mine.length)
        where.textContent = "Not published yet: click 📱 Publish test page.";
      else if (!mine.includes(folder)) {
        where.className = "pwa-warn";
        where.textContent = `Published as /pwa/${mine.join("/, /pwa/")}/ (an older variable name). Click 📱 Publish test page to move it to /pwa/${folder}/.`;
      } else where.textContent = `Published at /pwa/${folder}/.`;
    })
    .catch(() => {});
  area.append(pwaQr(n));
  const row = el("div", "step-row");
  const open = button(
    "📱 Publish test page",
    attempt(async () => {
      // Opened now (inside the click) so pop-up blockers allow it.
      const tab = window.open("about:blank", "_blank");
      try {
        const r = await publishPwa(n);
        if (tab) tab.location = r.url;
        else window.open(r.url, "_blank");
        toast(
          `Published to ${r.folder}${r.moved ? ` (moved from /pwa/${r.moved}/)` : ""}. Save, then start ▶ (Simulate on this PC) and press keys on the page.`,
        );
        if (typeof showNode === "function") showNode();
      } catch (e) {
        tab?.close();
        throw e;
      }
    }),
    "primary",
  );
  open.title =
    "Write the page to the project's pwa/<name>/ folder and open it here; copy that folder to any HTTPS static host for the phone";
  const json = button("⬇ pwa.json", () => {
    const keys =
      n.config.layout === "custom"
        ? JSON.parse(n.config.keys || "[]")
        : null;
    downloadText(
      "pwa.json",
      JSON.stringify(
        {
          title: n.config.title,
          node: n.id,
          device: $("deviceId").value.trim(),
          layout: n.config.layout,
          ...(keys ? { keys } : {}),
          images: JSON.parse(n.config.images || "{}"),
          broker: n.config.wsUrl || "",
        },
        null,
        1,
      ),
    );
  });
  json.title = "The page's settings as a JSON file";
  row.append(open, json);
  area.append(row);
  if (!$("deviceId").value.trim())
    area.append(
      el(
        "p",
        "muted",
        "Tip: set the board's Device ID (Device panel) before publishing, so the published page knows its topics (it can also be set on the phone, ⚙).",
      ),
    );
  return area;
}

// ── QR code for the phone: the published page, set up with the broker and the
// Device ID (…/#setup=…; the page stores them and connects). No passwords in it.
function pwaSetupUrl(n) {
  const page = String(n.config.pageUrl || "").trim();
  if (!page) return "";
  const setup = {
    broker: n.config.wsUrl || "",
    device: $("deviceId").value.trim(),
  };
  const b64 = btoa(JSON.stringify(setup))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return page.replace(/#.*$/, "") + "#setup=" + b64;
}
function pwaQr(n) {
  const box = el("div", "pwa-qr");
  box.append(el("b", "", "Phone setup (QR code)"));
  const url = pwaSetupUrl(n);
  const missing = [
    !url && "the published page address (https://…, after copying the folder to a static host)",
    !n.config.wsUrl && "the broker WebSocket URL (wss://…)",
    !$("deviceId").value.trim() && "the board's Device ID (Device panel)",
  ].filter(Boolean);
  if (!url) {
    box.append(
      el(
        "p",
        "muted",
        `To get a QR code, set ${missing.join(", ")}. The phone cannot open this PC's test page (Microflow only answers this PC), so the code points to the published copy.`,
      ),
    );
    return box;
  }
  if (typeof qrcode !== "function") {
    box.append(el("p", "muted", "QR code library not loaded."));
    return box;
  }
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const art = el("div", "pwa-qr-code");
  art.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  art.title = url;
  box.append(
    art,
    el(
      "p",
      "muted",
      "Scan with the phone's camera: the page opens and connects to the broker as this board" +
        (missing.length ? `. Still missing: ${missing.join(", ")} (set it on the phone with ⚙).` : ". Then Add to Home screen to install it."),
    ),
  );
  const copy = button("Copy link", async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast(url);
    }
  });
  box.append(copy);
  return box;
}
