// Account menu (the round badge at the bottom of the left rail) and the admin's
// Users dialog. Accounts are made by an admin only; there is no sign-up.
let accountMe = null; // { user, accounts, open } from /api/auth/me
const currentUser = () => accountMe?.user || null;

async function loadAccount() {
  try {
    accountMe = await api("auth/me");
  } catch {
    accountMe = null;
  }
  const badge = document.querySelector(".rail-bottom");
  if (!badge) return;
  const u = currentUser();
  const guest = !!accountMe?.guest;
  badge.textContent = u ? u.name.slice(0, 2).toUpperCase() : guest ? "G" : "MF";
  badge.title = u
    ? `Logged in as ${u.name}${u.admin ? " (admin)" : ""}: click for account`
    : guest
      ? "Guest: your flows are saved in this browser. Click to log in or back them up"
      : "No accounts yet (only this PC can use Microflow): click to create the admin";
  badge.classList.toggle("account-guest", guest);
  badge.classList.toggle("account-admin", !!u?.admin);
  badge.setAttribute("role", "button");
  badge.tabIndex = 0;
  badge.onclick = attempt(openAccount);
  badge.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      badge.click();
    }
  };
}

// A labelled input for the account forms.
function accountField(label, type = "text", auto = "off") {
  const wrap = el("label", "account-field", label);
  const input = el("input");
  input.type = type;
  input.autocomplete = auto;
  wrap.append(input);
  return { wrap, input };
}

// Backup / Restore buttons (guest.js), for guests and logged-in users.
function backupButtons(guest) {
  const save = el("button", "", guest ? "⬇ Backup (flows + settings)" : "⬇ Backup settings");
  save.onclick = attempt(downloadBackup);
  const load = el("button", "", "⬆ Restore backup…");
  load.onclick = pickBackup;
  return [save, load];
}

function openAccount() {
  const u = currentUser();
  const area = el("div", "account");
  if (!u && accountMe?.guest) {
    area.append(
      el(
        "p",
        "",
        "You are using Microflow as a guest. Your flows and settings are saved in this browser only: clearing the browser's data deletes them, so download a backup now and then.",
      ),
      el(
        "p",
        "muted",
        "Guests can design flows, compile them and download the firmware (.bin). Log in to save on the server and to upload, simulate, test and use the serial ports of this server.",
      ),
    );
    const actions = el("div", "actions");
    const login = el("button", "primary", "Log in");
    login.onclick = () => {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
    };
    actions.append(login, ...backupButtons(true));
    area.append(actions);
    return modal("Guest", area);
  }
  if (!u) {
    area.append(
      el(
        "p",
        "",
        "Microflow has no accounts yet, so it works without a login on this PC only. Before you put it on a server, create the admin here (or on the server: npm run user -- add <name> --admin). After that, everyone logs in and keeps their own flows.",
      ),
    );
    area.append(userForm(true));
    return modal("Create the admin", area);
  }
  area.append(
    el("p", "", `Logged in as ${u.name}${u.admin ? " · admin" : ""}.`),
  );
  const actions = el("div", "actions");
  const pw = el("button", "", "Change password");
  pw.onclick = () => modal("Change password", passwordForm());
  actions.append(pw, ...backupButtons(false));
  // Flows made as a guest in this browser: move them into the account.
  const guestFlows = Object.values(guestRead(GUEST_FLOWS, {}));
  if (guestFlows.length) {
    const move = el(
      "button",
      "primary",
      `⇪ Move ${guestFlows.length} guest flow${guestFlows.length > 1 ? "s" : ""} to my account`,
    );
    move.onclick = attempt(async () => {
      for (const f of guestFlows) {
        const copy = { ...f };
        delete copy.id;
        delete copy.updated;
        await api("flows", copy);
      }
      localStorage.removeItem(GUEST_FLOWS);
      $("modal").close();
      toast(`${guestFlows.length} flow${guestFlows.length > 1 ? "s" : ""} moved to your account: see Saved flows.`);
    });
    actions.append(move);
  }
  if (u.admin) {
    const users = el("button", "", "Users…");
    users.onclick = attempt(openUsers);
    actions.append(users);
  }
  const out = el("button", "danger", "Log out");
  out.onclick = attempt(async () => {
    await api("auth/logout", {});
    location.href = "/login.html";
  });
  actions.append(out);
  area.append(actions);
  modal("Account", area);
}

function passwordForm() {
  const area = el("form", "account");
  const now = accountField("Current password", "password", "current-password");
  const next = accountField("New password (at least 8 characters)", "password", "new-password");
  const again = accountField("New password again", "password", "new-password");
  const save = el("button", "", "Change password");
  save.type = "submit";
  area.append(now.wrap, next.wrap, again.wrap, save);
  area.onsubmit = (e) => {
    e.preventDefault();
    attempt(async () => {
      if (next.input.value !== again.input.value) throw Error("The new passwords differ.");
      await api("auth/password", { current: now.input.value, password: next.input.value });
      // A new password logs out every session, this one too.
      location.href = "/login.html";
    })();
  };
  return area;
}

// New user form. first = the admin made from open mode (then log in as them).
function userForm(first, after) {
  const area = el("form", "account");
  const name = accountField("User name (letters, digits, . _ -)", "text", "off");
  const pw = accountField("Password (at least 8 characters)", "password", "new-password");
  const again = accountField("Password again", "password", "new-password");
  area.append(name.wrap, pw.wrap, again.wrap);
  let admin = null;
  if (!first) {
    const row = el("label", "account-check");
    admin = el("input");
    admin.type = "checkbox";
    row.append(admin, " Admin (can manage users and share examples)");
    area.append(row);
  }
  const add = el("button", "", first ? "Create admin" : "Add user");
  add.type = "submit";
  area.append(add);
  area.onsubmit = (e) => {
    e.preventDefault();
    attempt(async () => {
      if (pw.input.value !== again.input.value) throw Error("The passwords differ.");
      const made = await api("users", {
        name: name.input.value.trim(),
        password: pw.input.value,
        admin: first || !!admin?.checked,
      });
      if (first) {
        toast(`Admin ${made.name} created: log in to continue`);
        location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      } else {
        toast(`User ${made.name} added`);
        after?.();
      }
    })();
  };
  return area;
}

async function openUsers() {
  const users = await api("users");
  const me = currentUser();
  const area = el("div", "account");
  const table = el("table", "users-table");
  const head = el("tr");
  for (const h of ["User", "Role", "Flows", "Last login", ""]) head.append(el("th", "", h));
  table.append(head);
  for (const u of users) {
    const tr = el("tr", u.disabled ? "user-off" : "");
    tr.append(
      el("td", "", u.name + (u.id === me?.id ? " (you)" : "")),
      el("td", "", (u.admin ? "admin" : "user") + (u.disabled ? " · disabled" : "")),
      el("td", "", String(u.flows ?? 0)),
      el("td", "muted", u.last_login ? new Date(u.last_login).toLocaleString() : "never"),
    );
    const cell = el("td", "user-actions");
    const btn = (text, fn, cls = "") => {
      const b = el("button", cls, text);
      b.onclick = attempt(async () => {
        await fn();
        openUsers();
      });
      cell.append(b);
      return b;
    };
    btn("Set password", async () => {
      const pw = prompt(`New password for ${u.name} (at least 8 characters). They are logged out everywhere.`);
      if (pw === null) return;
      await api(`users/${u.id}`, { password: pw }, "PUT");
      toast(`New password set for ${u.name}`);
    });
    if (u.id !== me?.id) {
      btn(u.admin ? "Remove admin" : "Make admin", () =>
        api(`users/${u.id}`, { admin: !u.admin }, "PUT"),
      );
      btn(u.disabled ? "Enable" : "Disable", () =>
        api(`users/${u.id}`, { disabled: !u.disabled }, "PUT"),
      );
      btn(
        "Delete",
        async () => {
          if (!confirm(`Delete ${u.name}? Their ${u.flows || 0} saved flow(s), tests and settings are deleted too. This cannot be undone.`))
            return;
          await api(`users/${u.id}`, null, "DELETE");
          toast(`${u.name} deleted`);
        },
        "danger",
      );
    }
    tr.append(cell);
    table.append(tr);
  }
  area.append(table, el("h4", "", "Add a user"), userForm(false, openUsers));
  modal("Users", area);
}

loadAccount();
