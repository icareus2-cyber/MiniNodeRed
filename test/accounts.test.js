// Accounts: users, passwords, sessions, per-user flows and shared examples.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { openStore, hashPassword, checkPassword, checkAccount } = require("../lib/store");
const { cookies } = require("../lib/auth");

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-acct-"));
  return openStore(path.join(dir, "t.sqlite"));
}
const doc = (id, name) => ({ id, name, nodes: [], links: [] });

test("passwords are salted scrypt hashes and check in constant time", () => {
  const a = hashPassword("correct horse");
  const b = hashPassword("correct horse");
  assert.match(a, /^scrypt\$/);
  assert.notEqual(a, b); // different salt
  assert.equal(checkPassword("correct horse", a), true);
  assert.equal(checkPassword("wrong horse", a), false);
  assert.throws(() => checkAccount("x", "longenough"), /name/i);
  assert.throws(() => checkAccount("bob", "short"), /8/);
});

test("the first user is admin and receives the flows made before accounts", () => {
  const s = fresh();
  s.saveFlow(doc("old", "Before accounts"));
  assert.equal(s.userCount(), 0);
  const max = s.createUser({ name: "max", password: "secret123" });
  assert.equal(max.admin, true);
  const bob = s.createUser({ name: "bob", password: "bobpass12" });
  assert.equal(bob.admin, false);
  const maxUser = { id: max.id, name: "max", admin: true };
  const bobUser = { id: bob.id, name: "bob", admin: false };
  assert.deepEqual(s.listFlows(maxUser).map((f) => f.id), ["old"]);
  // Admins see everything; bob sees only his own and shared flows.
  assert.deepEqual(s.listFlows(bobUser), []);
  s.close();
});

test("login, sessions and logout", () => {
  const s = fresh();
  const max = s.createUser({ name: "max", password: "secret123" });
  assert.equal(s.checkLogin("max", "nope-nope"), null);
  assert.equal(s.checkLogin("nobody", "secret123"), null);
  const u = s.checkLogin("MAX", "secret123"); // names ignore case
  assert.equal(u.id, max.id);
  const { token } = s.createSession(u.id);
  assert.equal(s.sessionUser(token).name, "max");
  assert.equal(s.sessionUser("made-up"), null);
  // A new password ends every session.
  s.updateUser(max.id, { password: "another123" });
  assert.equal(s.sessionUser(token), null);
  const again = s.createSession(max.id);
  s.deleteSession(again.token);
  assert.equal(s.sessionUser(again.token), null);
  s.close();
});

test("disabled users cannot log in and the last admin stays", () => {
  const s = fresh();
  const max = s.createUser({ name: "max", password: "secret123" });
  const bob = s.createUser({ name: "bob", password: "bobpass12" });
  assert.throws(() => s.updateUser(max.id, { admin: false }), /admin/i);
  assert.throws(() => s.deleteUser(max.id), /admin/i);
  s.updateUser(bob.id, { disabled: true });
  assert.equal(s.checkLogin("bob", "bobpass12"), null);
  assert.throws(() => s.createUser({ name: "BOB", password: "whatever1" }));
  s.close();
});

test("own flows, shared examples and saving a copy", () => {
  const s = fresh();
  const max = s.createUser({ name: "max", password: "secret123" });
  const bob = s.createUser({ name: "bob", password: "bobpass12" });
  const M = { id: max.id, name: "max", admin: true };
  const B = { id: bob.id, name: "bob", admin: false };
  s.saveFlow(doc("blink", "Blink"), M);
  assert.equal(s.getFlow("blink", B), null);
  assert.equal(s.canReadFlow("blink", B), false);
  s.shareFlow("blink", true);
  const seen = s.listFlows(B);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].shared, true);
  assert.equal(seen[0].mine, false);
  assert.equal(seen[0].owner, "max");
  assert.equal(s.canReadFlow("blink", B), true);
  assert.equal(s.canWriteFlow("blink", B), false);
  // Bob saving the shared example makes his own copy; the example is unchanged.
  const copy = s.saveFlow({ ...s.getFlow("blink", B), name: "Bob blink" }, B);
  assert.notEqual(copy.id, "blink");
  assert.equal(s.getFlow("blink", M).name, "Blink");
  assert.equal(s.canWriteFlow(copy.id, B), true);
  assert.throws(() => s.deleteFlows(["blink"], B), (e) => e.status === 403);
  // Deleting a user deletes their flows.
  s.deleteUser(bob.id);
  assert.equal(s.getFlow(copy.id, M), null);
  s.close();
});

test("settings are kept per user", () => {
  const s = fresh();
  const max = s.createUser({ name: "max", password: "secret123" });
  const bob = s.createUser({ name: "bob", password: "bobpass12" });
  s.saveUserSettings(max.id, { aiModel: "a" });
  s.saveUserSettings(bob.id, { aiModel: "b" });
  assert.equal(s.getUserSettings(max.id).aiModel, "a");
  assert.equal(s.getUserSettings(bob.id).aiModel, "b");
  s.close();
});

test("session cookie parsing", () => {
  assert.deepEqual(cookies({ headers: { cookie: "a=1; mf_session=abc%3D; b=2" } }), {
    a: "1",
    mf_session: "abc=",
    b: "2",
  });
  assert.deepEqual(cookies({ headers: {} }), {});
});

test("api() sends a logged-out page to the login page", async () => {
  const { api } = require("../public/api");
  global.location = { pathname: "/", search: "?flow=x", href: "/" };
  await assert.rejects(
    api("flows", undefined, undefined, async () =>
      new Response('{"error":"Please log in.","login":true}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    (e) => e.status === 401,
  );
  assert.equal(global.location.href, "/login.html?next=%2F%3Fflow%3Dx");
  delete global.location;
});
