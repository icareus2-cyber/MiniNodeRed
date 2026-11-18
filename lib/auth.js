// Accounts and login (server side). Accounts are created by an admin (Users dialog,
// or `npm run user -- add <name> --admin` on the server); there is no self sign-up.
//
// Without any account, Microflow works as before on this PC (one person, no login)
// but refuses requests that come through a reverse proxy (a deployed server), so a
// server is never open before its admin exists. Once an account exists, a visitor
// who is not logged in is a guest (req.guest): the editor loads, and the API allows
// only what touches nothing on this PC (GUEST_API: design, check, compile and download
// firmware). A guest's flows and settings stay in their browser (public/guest.js).
// Logged-in users save to SQLite and use everything (serial ports, uploads, the
// simulator, tests, devices). The browser keeps a random session token in an
// HttpOnly cookie; the database keeps only its hash (lib/store.js).
const COOKIE = "mf_session";
const GUEST_COOKIE = "mf_guest"; // chose "Continue as a guest" (this browser session)
const LOCK_AFTER = 5; // failed logins per name and address…
const LOCK_MS = 60000; // …lock that pair for a minute

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Behind a reverse proxy (Caddy, nginx) the proxy adds these headers.
const proxied = (req) =>
  !!(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["x-real-ip"]);
const loopback = (req) =>
  /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket?.remoteAddress || "");
const https = (req) =>
  req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
// Pages and files anyone may load (the login page and what it needs; phone pages).
const PUBLIC = [
  /^\/login\.html$/,
  /^\/login\.js$/,
  /^\/style\.css$/,
  /^\/favicon\.(ico|svg)$/,
  /^\/api\/auth\/(login|me)$/,
  /^\/pwa(\/|$)/,
];
// What a guest may call ("METHOD /path"); everything else answers 403 (guest: true).
const GUEST_API = [
  /^GET \/api\/(catalog|boards|version|examples|examples\/[a-z0-9-]+)$/,
  /^POST \/api\/(validate|analyze|firmware|compile)$/,
];
// Server state a guest has none of: empty answers, so the editor loads without errors.
const GUEST_EMPTY = {
  "/api/devices": [],
  "/api/deployments": [],
  "/api/serial/ports": [],
  "/api/serial/status": { connected: false, path: null, baudRate: null },
  "/api/runtime/status": { running: false },
};
const GUEST_DENIED =
  "Log in to use this. As a guest you can design flows, compile them and download the firmware; your flows and settings stay in this browser.";

function setupAuth(app, store, { route }) {
  const fails = new Map(); // "name|address" → { n, until }
  const setCookie = (req, res, token, maxAgeS) =>
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${https(req) ? "; Secure" : ""}`,
    );
  // Who is asking: req.user = { id, name, admin }, or undefined in open mode.
  app.use((req, res, next) => {
    const accounts = store.userCount() > 0;
    if (!accounts) {
      req.openMode = true;
      if (!proxied(req) && loopback(req)) return next();
      // A deployed server without accounts: closed until the admin is created.
      const text =
        "Microflow has no accounts yet. On the server, create the admin first: npm run user -- add <name> --admin";
      if (PUBLIC.some((p) => p.test(req.path)) && req.path !== "/api/auth/login") return next();
      return req.path.startsWith("/api/")
        ? res.status(503).json({ error: text })
        : res.status(503).type("text").send(text);
    }
    req.user = store.sessionUser(cookies(req)[COOKIE]) || undefined;
    req.guest = !req.user;
    if (req.user || PUBLIC.some((p) => p.test(req.path))) return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/sim/")) {
      if (GUEST_API.some((r) => r.test(`${req.method} ${req.path}`))) return next();
      if (req.method === "GET" && req.path in GUEST_EMPTY)
        return res.json(GUEST_EMPTY[req.path]);
      // The console stream carries this PC's serial output and builds: not for guests
      // (204 also stops the browser's EventSource from reconnecting).
      if (req.path === "/api/events") return res.status(204).end();
      return res.status(403).json({ error: GUEST_DENIED, guest: true });
    }
    // The editor page asks first: log in, or continue as a guest (login page). Choosing
    // guest (/?guest) sets a cookie that lasts until the browser closes.
    if (req.method === "GET" && /^\/(index\.html)?$/.test(req.path)) {
      if ("guest" in (req.query || {}))
        res.setHeader("Set-Cookie", `${GUEST_COOKIE}=1; Path=/; SameSite=Lax${https(req) ? "; Secure" : ""}`);
      else if (!cookies(req)[GUEST_COOKIE])
        return res.redirect(302, "/login.html?next=" + encodeURIComponent(req.originalUrl));
    }
    next(); // the editor page and its files
  });
  const needUser = (req) => {
    if (!req.user)
      throw Object.assign(Error("Please log in."), { status: 401 });
    return req.user;
  };
  const needAdmin = (req) => {
    // Open mode (this PC, no accounts yet) may create the first admin.
    if (req.openMode && !proxied(req) && loopback(req)) return;
    if (!needUser(req).admin)
      throw Object.assign(Error("Only an admin can manage users."), { status: 403 });
  };
  app.get("/api/auth/me", (req, res) =>
    res.json({
      user: req.user || null,
      accounts: store.userCount() > 0,
      open: !!req.openMode,
      guest: !!req.guest,
    }),
  );
  app.post(
    "/api/auth/login",
    route((req, res) => {
      const name = String(req.body?.name || "").trim();
      const password = String(req.body?.password || "");
      const key = `${name.toLowerCase()}|${req.headers["x-forwarded-for"] || req.socket?.remoteAddress}`;
      const f = fails.get(key);
      if (f && f.until > Date.now())
        throw Object.assign(
          Error(`Too many tries: wait ${Math.ceil((f.until - Date.now()) / 1000)} s.`),
          { status: 429 },
        );
      const user = store.checkLogin(name, password);
      if (!user) {
        const n = (f?.n || 0) + 1;
        fails.set(key, { n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
        throw Object.assign(Error("Wrong user name or password."), { status: 401 });
      }
      fails.delete(key);
      const { token, expires } = store.createSession(user.id);
      setCookie(req, res, token, Math.round((Date.parse(expires) - Date.now()) / 1000));
      return { user };
    }),
  );
  app.post(
    "/api/auth/logout",
    route((req, res) => {
      const token = cookies(req)[COOKIE];
      if (token) store.deleteSession(token);
      setCookie(req, res, "", 0);
      // Logged out: the next visit asks again (log in or guest).
      res.append("Set-Cookie", `${GUEST_COOKIE}=; Path=/; Max-Age=0`);
      return { ok: true };
    }),
  );
  // Change your own password (the current one is asked again).
  app.post(
    "/api/auth/password",
    route((req) => {
      const user = needUser(req);
      if (!store.checkPassword(user.id, String(req.body?.current || "")))
        throw Object.assign(Error("The current password is wrong."), { status: 403 });
      store.updateUser(user.id, { password: String(req.body?.password || "") });
      return { ok: true, relogin: true };
    }),
  );
  // ── Users (admin) ──
  app.get(
    "/api/users",
    route((req) => {
      needAdmin(req);
      return store.listUsers();
    }),
  );
  app.post(
    "/api/users",
    route((req) => {
      needAdmin(req);
      const { name, password, admin } = req.body || {};
      return store.createUser({ name, password, admin: admin === true });
    }),
  );
  app.put(
    "/api/users/:id",
    route((req) => {
      needAdmin(req);
      const id = Number(req.params.id);
      const { password, admin, disabled } = req.body || {};
      if (req.user && id === req.user.id && (admin === false || disabled === true))
        throw Error("You cannot remove your own admin rights or disable yourself.");
      store.updateUser(id, {
        password: password === undefined ? undefined : String(password),
        admin: typeof admin === "boolean" ? admin : undefined,
        disabled: typeof disabled === "boolean" ? disabled : undefined,
      });
      return { ok: true };
    }),
  );
  app.delete(
    "/api/users/:id",
    route((req) => {
      needAdmin(req);
      const id = Number(req.params.id);
      if (req.user && id === req.user.id) throw Error("You cannot delete yourself.");
      return { ok: store.deleteUser(id) };
    }),
  );
  return { needUser, needAdmin };
}
module.exports = { setupAuth, cookies, COOKIE };
