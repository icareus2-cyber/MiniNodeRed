// Introduction page: shown for 5 s when the app opens, then fades out to the
// editor (which loads behind it meanwhile). Skip, Esc, Enter or a click on the
// background closes it early.
(() => {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const close = () => {
    if (splash.classList.contains("leaving")) return;
    clearTimeout(timer);
    document.removeEventListener("keydown", onKey);
    splash.classList.add("leaving");
    setTimeout(() => splash.remove(), 500);
  };
  const onKey = (e) => {
    if (e.key === "Escape" || e.key === "Enter") close();
  };
  const timer = setTimeout(close, 5000);
  document.getElementById("splashSkip").onclick = close;
  splash.onclick = (e) => e.target === splash && close();
  document.addEventListener("keydown", onKey);
  document.getElementById("splashSkip").focus();
})();
