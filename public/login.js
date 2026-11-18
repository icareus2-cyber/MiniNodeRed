// Login page: sends the name and password, then goes back to the page that asked.
const form = document.getElementById("login");
const error = document.getElementById("error");
const go = document.getElementById("go");
// Only paths on this server (never another site).
const next = (() => {
  const n = new URLSearchParams(location.search).get("next") || "/";
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
})();
// "Continue as a guest" opens the same page, as a guest.
document.getElementById("guest").href = next + (next.includes("?") ? "&" : "?") + "guest";
fetch("/api/auth/me", { cache: "no-store" })
  .then((r) => r.json())
  .then((me) => {
    if (me.open) return location.replace(next); // no accounts yet: nothing to choose
    if (!me.user) return;
    // Already logged in: say so (continue, or log out to switch account or be a guest).
    document.getElementById("who").textContent = me.user.name;
    document.getElementById("continue").href = next;
    document.getElementById("already").hidden = false;
    for (const e of document.querySelectorAll("#login, .or, #guest, .hint")) e.hidden = true;
  })
  .catch(() => {});
document.getElementById("logout").onclick = async () => {
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  }).catch(() => {});
  location.reload();
};
form.onsubmit = async (event) => {
  event.preventDefault();
  error.textContent = "";
  go.disabled = true;
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: document.getElementById("name").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.error || `Login failed (HTTP ${r.status})`);
    location.replace(next);
  } catch (e) {
    error.textContent = e.message;
    document.getElementById("password").select();
  } finally {
    go.disabled = false;
  }
};
