const Database = require("better-sqlite3");
const {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} = require("node:crypto");
// Ordered migrations (SQL, or a function for data changes); PRAGMA user_version
// records how many have run.
const migrations = [
  `CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL, updated TEXT NOT NULL);`,
  `CREATE TABLE flow_revisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
     name TEXT NOT NULL, document TEXT NOT NULL, created TEXT NOT NULL);
   CREATE INDEX flow_revisions_flow ON flow_revisions(flow_id, id);
   INSERT INTO flow_revisions (flow_id, name, document, created) SELECT id, name, document, updated FROM flows;
   CREATE TABLE tests (
     id TEXT PRIMARY KEY,
     flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
     name TEXT NOT NULL, document TEXT NOT NULL, updated TEXT NOT NULL);
   CREATE INDEX tests_flow ON tests(flow_id);
   CREATE TABLE test_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
     device TEXT NOT NULL, passed INTEGER NOT NULL, result TEXT NOT NULL,
     started TEXT NOT NULL, duration_ms INTEGER NOT NULL);
   CREATE INDEX test_runs_test ON test_runs(test_id, id);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY, status TEXT, telemetry TEXT,
     first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
   CREATE TABLE deployments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     flow_id TEXT, flow_name TEXT NOT NULL, action TEXT NOT NULL, board TEXT NOT NULL,
     port TEXT, build TEXT NOT NULL, ok INTEGER NOT NULL, size TEXT, message TEXT, created TEXT NOT NULL);
   CREATE INDEX deployments_build ON deployments(build);`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // MQTT in/out became Radio in/out (protocol MQTT): rename boxes that still have
  // the old default name and record the protocol. Custom names stay as they are.
  (db) => {
    const rename = { "MQTT in": "Radio in", "MQTT out": "Radio out" };
    const update = db.prepare("UPDATE flows SET document = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, document FROM flows").all()) {
      const flow = JSON.parse(row.document);
      let changed = false;
      for (const n of flow.nodes || [])
        if (n.type === "mqtt-in" || n.type === "mqtt-out") {
          if (rename[n.label]) ((n.label = rename[n.label]), (changed = true));
          n.config ||= {};
          if (!n.config.protocol)
            ((n.config.protocol = "mqtt"), (changed = true));
        }
      if (changed) update.run(JSON.stringify(flow), row.id);
    }
  },
  // User accounts (admin-created), login sessions, settings per user, and who owns
  // each flow. Flows with no owner (made before accounts) go to the first admin.
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     hash TEXT NOT NULL,
     admin INTEGER NOT NULL DEFAULT 0,
     disabled INTEGER NOT NULL DEFAULT 0,
     created TEXT NOT NULL,
     last_login TEXT);
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created TEXT NOT NULL,
     expires TEXT NOT NULL);
   CREATE TABLE user_settings (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (user_id, key));
   ALTER TABLE flows ADD COLUMN owner INTEGER REFERENCES users(id) ON DELETE CASCADE;
   ALTER TABLE flows ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE deployments ADD COLUMN owner INTEGER;
   CREATE INDEX flows_owner ON flows(owner);`,
];
// Passwords: scrypt with a random salt ("scrypt$<salt hex>$<hash hex>").
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(String(password), Buffer.from(salt, "hex"), want.length, SCRYPT);
  return want.length === got.length && timingSafeEqual(want, got);
}
// Rules for names and passwords of accounts.
function checkAccount(name, password) {
  if (name !== undefined && !/^[A-Za-z0-9._-]{2,32}$/.test(String(name)))
    throw Error("User name: 2–32 letters, digits, . _ or -.");
  if (password !== undefined && String(password).length < 8)
    throw Error("Password: at least 8 characters.");
  if (password !== undefined && String(password).length > 200)
    throw Error("Password: at most 200 characters.");
}
const SESSION_DAYS = 14;
const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");
const KEEP_REVISIONS = 50,
  KEEP_RUNS = 20;
const now = () => new Date().toISOString();
const json = (text) => (text ? JSON.parse(text) : null);
function openStore(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true });
  db.transaction(() => {
    for (let v = version; v < migrations.length; v++)
      typeof migrations[v] === "function"
        ? migrations[v](db)
        : db.exec(migrations[v]);
    db.pragma(`user_version = ${migrations.length}`);
  })();
  const q = (sql) => db.prepare(sql);
  const stmt = {
    listFlows: q(
      `SELECT f.id, f.name, f.updated, f.owner, f.shared, u.name AS owner_name,
         (SELECT COUNT(*) FROM tests t WHERE t.flow_id = f.id) AS tests
       FROM flows f LEFT JOIN users u ON u.id = f.owner ORDER BY f.updated DESC`,
    ),
    getFlow: q("SELECT document FROM flows WHERE id = ?"),
    getFlowRow: q("SELECT id, owner, shared FROM flows WHERE id = ?"),
    upsertFlow: q(
      "INSERT INTO flows (id, name, document, updated, owner) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, document=excluded.document, updated=excluded.updated",
    ),
    shareFlow: q("UPDATE flows SET shared = ? WHERE id = ?"),
    // Users and sessions
    countUsers: q("SELECT COUNT(*) AS n FROM users"),
    countAdmins: q("SELECT COUNT(*) AS n FROM users WHERE admin = 1 AND disabled = 0"),
    listUsers: q(
      `SELECT u.id, u.name, u.admin, u.disabled, u.created, u.last_login,
         (SELECT COUNT(*) FROM flows f WHERE f.owner = u.id) AS flows
       FROM users u ORDER BY u.name`,
    ),
    getUser: q("SELECT * FROM users WHERE id = ?"),
    userByName: q("SELECT * FROM users WHERE name = ?"),
    addUser: q("INSERT INTO users (name, hash, admin, created) VALUES (?,?,?,?)"),
    setHash: q("UPDATE users SET hash = ? WHERE id = ?"),
    setAdmin: q("UPDATE users SET admin = ? WHERE id = ?"),
    setDisabled: q("UPDATE users SET disabled = ? WHERE id = ?"),
    deleteUser: q("DELETE FROM users WHERE id = ?"),
    loggedIn: q("UPDATE users SET last_login = ? WHERE id = ?"),
    claimFlows: q("UPDATE flows SET owner = ? WHERE owner IS NULL"),
    claimDeployments: q("UPDATE deployments SET owner = ? WHERE owner IS NULL"),
    addSession: q("INSERT INTO sessions VALUES (?,?,?,?)"),
    getSession: q(
      `SELECT u.id, u.name, u.admin, u.disabled, s.expires FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    ),
    deleteSession: q("DELETE FROM sessions WHERE token = ?"),
    deleteUserSessions: q("DELETE FROM sessions WHERE user_id = ?"),
    pruneSessions: q("DELETE FROM sessions WHERE expires < ?"),
    getUserSettings: q("SELECT key, value FROM user_settings WHERE user_id = ?"),
    putUserSetting: q(
      "INSERT INTO user_settings VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
    ),
    deleteUserSetting: q("DELETE FROM user_settings WHERE user_id = ? AND key = ?"),
    lastRevision: q(
      "SELECT document FROM flow_revisions WHERE flow_id = ? ORDER BY id DESC LIMIT 1",
    ),
    addRevision: q(
      "INSERT INTO flow_revisions (flow_id, name, document, created) VALUES (?,?,?,?)",
    ),
    pruneRevisions: q(
      "DELETE FROM flow_revisions WHERE flow_id = ? AND id NOT IN (SELECT id FROM flow_revisions WHERE flow_id = ? ORDER BY id DESC LIMIT ?)",
    ),
    listRevisions: q(
      "SELECT id, name, created, json_array_length(document, '$.nodes') AS nodes, json_array_length(document, '$.edges') AS edges FROM flow_revisions WHERE flow_id = ? ORDER BY id DESC",
    ),
    getRevision: q(
      "SELECT document FROM flow_revisions WHERE flow_id = ? AND id = ?",
    ),
    deleteFlow: q("DELETE FROM flows WHERE id = ?"),
    listTests: q(
      `SELECT t.id, t.document, r.passed, r.started, r.device FROM tests t
       LEFT JOIN test_runs r ON r.id = (SELECT MAX(id) FROM test_runs WHERE test_id = t.id)
       WHERE t.flow_id = ? ORDER BY t.name`,
    ),
    getTest: q("SELECT flow_id, document FROM tests WHERE id = ?"),
    upsertTest: q(
      "INSERT INTO tests VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, document=excluded.document, updated=excluded.updated WHERE tests.flow_id = excluded.flow_id",
    ),
    deleteTest: q("DELETE FROM tests WHERE id = ?"),
    addRun: q(
      "INSERT INTO test_runs (test_id, device, passed, result, started, duration_ms) VALUES (?,?,?,?,?,?)",
    ),
    pruneRuns: q(
      "DELETE FROM test_runs WHERE test_id = ? AND id NOT IN (SELECT id FROM test_runs WHERE test_id = ? ORDER BY id DESC LIMIT ?)",
    ),
    listRuns: q(
      "SELECT id, device, passed, result, started, duration_ms FROM test_runs WHERE test_id = ? ORDER BY id DESC",
    ),
    getDevice: q("SELECT * FROM devices WHERE id = ?"),
    upsertDevice: q(
      `INSERT INTO devices (id, status, telemetry, first_seen, last_seen) VALUES (@id, @status, @telemetry, @time, @time)
       ON CONFLICT(id) DO UPDATE SET status = COALESCE(@status, status), telemetry = COALESCE(@telemetry, telemetry), last_seen = @time`,
    ),
    listDevices: q(
      `SELECT d.*, (SELECT json_object('flow_name', flow_name, 'created', created, 'board', board) FROM deployments
        WHERE build = json_extract(d.telemetry, '$.build') AND ok = 1 AND action = 'upload' ORDER BY id DESC LIMIT 1) AS deployment
       FROM devices d ORDER BY last_seen DESC`,
    ),
    deleteDevice: q("DELETE FROM devices WHERE id = ?"),
    addDeployment: q(
      `INSERT INTO deployments (flow_id, flow_name, action, board, port, build, ok, size, message, created, owner)
       VALUES (@flowId, @flowName, @action, @board, @port, @build, @ok, @size, @message, @created, @owner)`,
    ),
    listDeployments: q("SELECT * FROM deployments ORDER BY id DESC LIMIT ?"),
    listOwnDeployments: q(
      "SELECT * FROM deployments WHERE owner = ? ORDER BY id DESC LIMIT ?",
    ),
    getSettings: q("SELECT key, value FROM settings"),
    putSetting: q(
      "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    deleteSetting: q("DELETE FROM settings WHERE key = ?"),
  };
  // Who may do what with a flow. user: { id, admin } of the logged-in account, or
  // undefined without accounts (one person on this PC: everything allowed).
  const canRead = (row, user) =>
    !!row && (!user || user.admin || row.owner === user.id || !!row.shared);
  const canWrite = (row, user) =>
    !!row && (!user || user.admin || row.owner === user.id);
  const flowRow = (id) => stmt.getFlowRow.get(id);
  return {
    db,
    close: () => db.close(),
    // Own flows and shared examples (an admin sees everyone's).
    listFlows: (user) =>
      stmt.listFlows
        .all()
        .filter((r) => canRead(r, user))
        .map((r) => ({
          id: r.id,
          name: r.name,
          updated: r.updated,
          tests: r.tests,
          shared: !!r.shared,
          owner: r.owner_name || null,
          mine: !user || r.owner === user.id,
        })),
    getFlow: (id, user) =>
      canRead(flowRow(id), user) ? json(stmt.getFlow.get(id)?.document) : null,
    canReadFlow: (id, user) => canRead(flowRow(id), user),
    canWriteFlow: (id, user) => canWrite(flowRow(id), user),
    // Saves the flow and records a revision when the graph actually changed. A
    // flow the user may not change (a shared example) is saved as their own copy.
    saveFlow: db.transaction((flow, user) => {
      let id = flow.id || randomUUID();
      const row = flowRow(id);
      if (row && !canWrite(row, user)) id = randomUUID();
      const doc = {
        ...flow,
        id,
        name: String(flow.name || "Untitled flow").slice(0, 100),
      };
      const text = JSON.stringify(doc),
        time = now();
      stmt.upsertFlow.run(id, doc.name, text, time, user ? user.id : null);
      if (stmt.lastRevision.get(id)?.document !== text) {
        stmt.addRevision.run(id, doc.name, text, time);
        stmt.pruneRevisions.run(id, id, KEEP_REVISIONS);
      }
      return doc;
    }),
    deleteFlow: (id, user) =>
      canWrite(flowRow(id), user) && stmt.deleteFlow.run(id).changes > 0,
    // All-or-nothing bulk delete; returns how many flows existed and were removed.
    deleteFlows: db.transaction((ids, user) => {
      if (ids.some((id) => flowRow(id) && !canWrite(flowRow(id), user)))
        throw Object.assign(Error("You can only delete your own flows."), {
          status: 403,
        });
      return ids.reduce((count, id) => count + stmt.deleteFlow.run(id).changes, 0);
    }),
    // Shared examples: every user sees them (and saves changes as a copy).
    shareFlow: (id, shared) => stmt.shareFlow.run(shared ? 1 : 0, id).changes > 0,
    listRevisions: (flowId) => stmt.listRevisions.all(flowId),
    getRevision: (flowId, id) =>
      json(stmt.getRevision.get(flowId, id)?.document),
    listTests: (flowId) =>
      stmt.listTests.all(flowId).map((r) => ({
        ...json(r.document),
        last: r.started
          ? { passed: !!r.passed, started: r.started, device: r.device }
          : null,
      })),
    getTest: (id) => {
      const r = stmt.getTest.get(id);
      return r && { ...json(r.document), flowId: r.flow_id };
    },
    saveTest(flowId, test) {
      if (!stmt.getFlow.get(flowId))
        throw Object.assign(Error("Save the flow before adding tests."), {
          status: 404,
        });
      const doc = { ...test, id: test.id || randomUUID() };
      const r = stmt.upsertTest.run(
        doc.id,
        flowId,
        doc.name,
        JSON.stringify(doc),
        now(),
      );
      if (!r.changes) throw Error("That test belongs to another flow.");
      return doc;
    },
    deleteTest: (id) => stmt.deleteTest.run(id).changes > 0,
    recordRun: db.transaction((testId, result) => {
      stmt.addRun.run(
        testId,
        result.device,
        result.passed ? 1 : 0,
        JSON.stringify(result),
        now(),
        result.durationMs,
      );
      stmt.pruneRuns.run(testId, testId, KEEP_RUNS);
    }),
    listRuns: (testId) =>
      stmt.listRuns
        .all(testId)
        .map((r) => ({ ...r, passed: !!r.passed, result: json(r.result) })),
    touchDevice(id, { status, telemetry }) {
      stmt.upsertDevice.run({
        id,
        status: status === undefined ? null : String(status).slice(0, 32),
        telemetry:
          telemetry === undefined
            ? null
            : JSON.stringify(telemetry).slice(0, 2048),
        time: now(),
      });
    },
    listDevices: () =>
      stmt.listDevices.all().map((d) => ({
        ...d,
        telemetry: json(d.telemetry),
        deployment: json(d.deployment),
      })),
    deleteDevice: (id) => stmt.deleteDevice.run(id).changes > 0,
    addDeployment: (d) =>
      stmt.addDeployment.run({
        port: null,
        message: null,
        flowId: null,
        owner: null,
        ...d,
        ok: d.ok ? 1 : 0,
        size: d.size ? JSON.stringify(d.size) : null,
        created: now(),
      }),
    // A user sees their own build and upload history (an admin sees all).
    listDeployments: (limit = 30, user) =>
      (user && !user.admin
        ? stmt.listOwnDeployments.all(user.id, limit)
        : stmt.listDeployments.all(limit)
      ).map((d) => ({ ...d, ok: !!d.ok, size: json(d.size) })),
    // Secrets live in the same table but are never returned by getSettings().
    getSecret: (key) =>
      stmt.getSettings.all().find((r) => r.key === "secret:" + key)?.value ??
      null,
    setSecret: (key, value) => stmt.putSetting.run("secret:" + key, value),
    getSettings: () =>
      Object.fromEntries(
        stmt.getSettings
          .all()
          .filter((r) => !r.key.startsWith("secret:"))
          .map((r) => [r.key, r.value]),
      ),
    // Empty values are removed so "forget" leaves nothing behind.
    saveSettings: db.transaction((values) => {
      for (const [key, value] of Object.entries(values))
        value === ""
          ? stmt.deleteSetting.run(key)
          : stmt.putSetting.run(key, value);
    }),
    // ── Accounts ──
    userCount: () => stmt.countUsers.get().n,
    listUsers: () =>
      stmt.listUsers.all().map((u) => ({
        ...u,
        admin: !!u.admin,
        disabled: !!u.disabled,
      })),
    // The first admin also gets the flows, history and settings made before accounts.
    createUser: db.transaction(({ name, password, admin = false }) => {
      checkAccount(name, password);
      if (stmt.userByName.get(name))
        throw Object.assign(Error(`User “${name}” already exists.`), { status: 409 });
      const first = stmt.countUsers.get().n === 0;
      const id = Number(
        stmt.addUser.run(String(name), hashPassword(password), admin || first ? 1 : 0, now())
          .lastInsertRowid,
      );
      if (first) {
        stmt.claimFlows.run(id);
        stmt.claimDeployments.run(id);
        for (const r of stmt.getSettings.all())
          if (!r.key.startsWith("secret:")) stmt.putUserSetting.run(id, r.key, r.value);
      }
      return { id, name: String(name), admin: !!(admin || first) };
    }),
    updateUser: db.transaction((id, { password, admin, disabled }) => {
      const u = stmt.getUser.get(id);
      if (!u) throw Object.assign(Error("User not found"), { status: 404 });
      checkAccount(undefined, password);
      // There must always be an admin who can log in.
      const losesAdmin =
        (admin === false && u.admin) || (disabled === true && u.admin && !u.disabled);
      if (losesAdmin && stmt.countAdmins.get().n <= 1)
        throw Error("Keep at least one admin who can log in.");
      if (password !== undefined) {
        stmt.setHash.run(hashPassword(password), id);
        stmt.deleteUserSessions.run(id); // logged out everywhere
      }
      if (admin !== undefined) stmt.setAdmin.run(admin ? 1 : 0, id);
      if (disabled !== undefined) {
        stmt.setDisabled.run(disabled ? 1 : 0, id);
        if (disabled) stmt.deleteUserSessions.run(id);
      }
      return true;
    }),
    // Deletes the account and its flows (shared examples it owned too).
    deleteUser: db.transaction((id) => {
      const u = stmt.getUser.get(id);
      if (!u) return false;
      if (u.admin && !u.disabled && stmt.countAdmins.get().n <= 1)
        throw Error("Keep at least one admin who can log in.");
      return stmt.deleteUser.run(id).changes > 0;
    }),
    // Checks a login; returns { id, name, admin } or null.
    checkLogin(name, password) {
      const u = stmt.userByName.get(String(name || ""));
      // Hash anyway so unknown names take as long as wrong passwords.
      const ok = checkPassword(password, u ? u.hash : hashPassword("x"));
      if (!u || !ok || u.disabled) return null;
      stmt.loggedIn.run(now(), u.id);
      return { id: u.id, name: u.name, admin: !!u.admin };
    },
    checkPassword: (id, password) =>
      checkPassword(password, stmt.getUser.get(id)?.hash),
    // Sessions: the browser keeps a random token; the database keeps its hash.
    createSession(userId) {
      const token = randomBytes(32).toString("base64url");
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      stmt.pruneSessions.run(now());
      stmt.addSession.run(tokenHash(token), userId, now(), expires);
      return { token, expires };
    },
    sessionUser(token) {
      if (!token) return null;
      const r = stmt.getSession.get(tokenHash(token));
      if (!r || r.disabled || r.expires < now()) return null;
      return { id: r.id, name: r.name, admin: !!r.admin };
    },
    deleteSession: (token) => stmt.deleteSession.run(tokenHash(token)),
    // Settings of one user (WiFi, language, Custom node library…).
    getUserSettings: (userId) =>
      Object.fromEntries(stmt.getUserSettings.all(userId).map((r) => [r.key, r.value])),
    saveUserSettings: db.transaction((userId, values) => {
      for (const [key, value] of Object.entries(values))
        value === ""
          ? stmt.deleteUserSetting.run(userId, key)
          : stmt.putUserSetting.run(userId, key, value);
    }),
  };
}
module.exports = { openStore, migrations, hashPassword, checkPassword, checkAccount, SESSION_DAYS };
