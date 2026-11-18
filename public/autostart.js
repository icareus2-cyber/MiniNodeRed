// Auto-start: open /?flow=<id>&autostart (or &autostart=<seconds>) and the
// page counts down (5 s by default), then presses Start. Cancel stops it.
// Without the autostart parameter nothing happens, so a normal visit never
// starts a run by itself.
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has("autostart")) return;
  const given = Number(params.get("autostart"));
  let left = Number.isFinite(given) && given > 0 ? Math.ceil(given) : 5;

  const bar = document.createElement("div");
  bar.setAttribute("role", "status");
  bar.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;" +
    "background:#1f2937;color:#fff;padding:8px 14px;border-radius:8px;" +
    "box-shadow:0 2px 8px #0006;display:flex;gap:12px;align-items:center";
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  bar.append(text, cancel);
  document.body.append(bar);

  const stop = () => {
    clearInterval(timer);
    bar.remove();
  };
  const tick = () => {
    if (left <= 0) {
      stop();
      const start = document.getElementById("start");
      if (start && !start.disabled) start.click();
      return;
    }
    text.textContent = `Starting in ${left} s…`;
    left -= 1;
  };
  cancel.onclick = stop;
  const timer = setInterval(tick, 1000);
  tick();
})();
