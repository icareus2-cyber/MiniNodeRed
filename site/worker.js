// Cloudflare Worker in front of the MiniNodeRed server.
// micrologiclink.com: "/" shows the introduction page to visitors who are not logged
// in (and /welcome to everyone); everything else goes to the server through the
// tunnel. When the server or this PC is off, pages show "under maintenance" and the
// API answers 503 JSON, instead of Cloudflare's error 502 / 530.
// *.workers.dev: redirects to micrologiclink.com when the app answers, otherwise the
// same maintenance page (it reloads itself and moves on once the app is back).
const APP = "https://micrologiclink.com";
// What Cloudflare answers when the tunnel or the server behind it is down.
const DOWN = new Set([502, 504, 521, 522, 523, 524, 530]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".workers.dev"))
      return (await appUp())
        ? Response.redirect(APP + url.pathname + url.search, 302)
        : maintenance(url);
    const loggedIn = /(?:^|;\s*)mf_session=/.test(request.headers.get("Cookie") || "");
    if (url.pathname === "/welcome" || (url.pathname === "/" && !url.search && !loggedIn))
      return html(intro(await appUp()));
    try {
      const res = await fetch(request);
      if (!DOWN.has(res.status)) return res;
    } catch {}
    return maintenance(url);
  },
};

// The login page is public, so it answers whenever the server runs.
async function appUp() {
  try {
    const res = await fetch(APP + "/login.html", {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return !DOWN.has(res.status) && res.status < 500;
  } catch {
    return false;
  }
}

const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

function maintenance(url) {
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/sim/"))
    return new Response(
      JSON.stringify({ error: "Microflow is under maintenance. Please try again in a few minutes." }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
    );
  return html(
    page(
      "Under maintenance",
      `<meta http-equiv="refresh" content="30" />`,
      `<main class="card center">
        <div class="logo">&mu;</div>
        <h1>Under maintenance</h1>
        <p class="lead">Microflow is offline for a short while. This page checks again every 30 seconds and opens the app as soon as it is back.</p>
        <p class="status down"><span></span>Offline</p>
        <p><a class="button ghost" href="${APP}/welcome">About Microflow</a></p>
      </main>`,
    ),
    503,
    { "Retry-After": "30" },
  );
}

function intro(up) {
  return page(
    "Microflow",
    "",
    `<header class="hero">
      <div class="logo">&mu;</div>
      <h1>Microflow</h1>
      <p class="lead">Design ESP8266 and ESP32 programs as a visual flow. Microflow turns them into native Arduino C++, uploads them, and helps you debug them live.</p>
      <p class="status ${up ? "up" : "down"}"><span></span>${up ? "Online" : "Under maintenance: back soon"}</p>
      <p class="actions">
        ${
          up
            ? `<a class="button" href="/?guest">Try it as a guest</a> <a class="button ghost light" href="/login.html?next=%2F">Log in</a>`
            : `<span class="button off">Try it as a guest</span>`
        }
      </p>
      <p class="note">No account needed: guests design, compile and download firmware, and keep their flows in their own browser. Log in to save on the server and upload to the boards here.</p>
    </header>
    <section class="steps">
      <article><b>1</b><h2>Design</h2><p>Drag nodes for pins, timers, logic, displays, sensors and MQTT, and wire them into a flow.</p></article>
      <article><b>2</b><h2>Compile &amp; upload</h2><p>The flow becomes a lean Arduino sketch, uploaded over USB, Web Serial or remote update.</p></article>
      <article><b>3</b><h2>Debug</h2><p>Watch values live over MQTT, drive inputs from the PC, or simulate the whole board on screen.</p></article>
    </section>
    <section class="boards">
      <h2>Boards</h2>
      <p>ESP8266 (NodeMCU, D1 mini, ESP-01) · ESP32, S3, C3, C6, P4 · ESP32-CAM · TTGO T-Display · Heltec · Realtek BW16</p>
      <p class="muted">Each board comes with ready-made input, output and analog tests in the Examples tab.</p>
    </section>
    <footer>Microflow · Small chip. Big ideas.</footer>`,
  );
}

function page(title, head, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
${head}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23193d32'/%3E%3Ctext x='16' y='23' font-size='20' text-anchor='middle' fill='%23c3e7aa'%3E%CE%BC%3C/text%3E%3C/svg%3E" />
<style>
:root {
  --bg: #f4f7f2; --card: #ffffff; --ink: #172f27; --muted: #52665b;
  --accent: #236c55; --hero: #193d32; --hero-ink: #eaf5e3; --lime: #c3e7aa;
  --line: #d5e0d7; --up: #2f9e5b; --down: #c77a1c;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1d18; --card: #16271f; --ink: #e3eee6; --muted: #9db3a6; --line: #26392f; --accent: #7cc69d; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 "DM Sans", system-ui, sans-serif; }
h1, h2 { font-family: "Space Grotesk", system-ui, sans-serif; line-height: 1.2; }
.hero { background: radial-gradient(circle at 50% 30%, #24584a, var(--hero) 70%); color: var(--hero-ink); text-align: center; padding: 72px 16px 64px; }
.hero h1 { font-size: clamp(36px, 7vw, 56px); margin: 0; }
.lead { max-width: 620px; margin: 14px auto 0; font-size: 18px; color: inherit; opacity: 0.9; }
.logo { width: 76px; height: 76px; margin: 0 auto 18px; border-radius: 18px; display: grid; place-items: center; background: #122e26; color: var(--lime); font-size: 46px; box-shadow: 0 6px 24px #0005; }
.status { display: inline-flex; align-items: center; gap: 8px; margin: 22px 0 0; padding: 4px 14px; border-radius: 99px; background: #ffffff1a; font-size: 14px; font-weight: 500; }
.status span { width: 9px; height: 9px; border-radius: 50%; background: var(--up); box-shadow: 0 0 0 3px #2f9e5b40; }
.status.down span { background: var(--down); box-shadow: 0 0 0 3px #c77a1c40; }
.actions { margin: 26px 0 0; }
.button { display: inline-block; padding: 12px 26px; border-radius: 10px; background: var(--lime); color: #12301f; font-weight: 700; text-decoration: none; }
.button:hover { filter: brightness(1.06); }
.button.off { opacity: 0.45; cursor: not-allowed; }
.button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
.button.ghost.light { color: var(--hero-ink); border-color: #ffffff55; margin-left: 8px; }
.note { max-width: 520px; margin: 16px auto 0; font-size: 14px; opacity: 0.75; }
.steps { max-width: 1000px; margin: -32px auto 0; padding: 0 16px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.steps article, .boards, .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
.steps b { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--card); font-size: 14px; }
.steps h2 { margin: 12px 0 6px; font-size: 20px; }
.steps p, .boards p { margin: 0; color: var(--muted); }
.boards { max-width: 1000px; margin: 16px auto 0; }
.boards h2 { margin: 0 0 8px; font-size: 20px; }
.boards .muted { margin-top: 8px; font-size: 14px; }
footer { text-align: center; color: var(--muted); font-size: 13px; padding: 40px 16px; }
.center { max-width: 520px; margin: 12vh auto; text-align: center; }
.card .lead { color: var(--muted); font-size: 16px; }
.card .status { background: var(--bg); }
.card .logo { color: var(--lime); }
@media (max-width: 640px) { .boards { margin: 16px 16px 0; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
