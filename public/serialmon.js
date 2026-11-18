// Serial monitor: a strip at the top of Console → Simulation, shown while the run mode
// is a real board. Start opens the serial port chosen in the Device panel at this baud
// rate (default 115200), Stop closes it. The text the board prints appears below;
// the line box sends text to the board. It shares the connection and the baud rate
// with the Device panel (Connect serial / Baud rate).
const monBaud = $("monBaud");
const monShown = () =>
  $("runtimeMode").value !== "host" &&
  document.querySelector('.console-modes [data-mode="sim"]').getAttribute("aria-pressed") === "true";
// True while the monitor shows the board's text itself (the console log skips it then).
function serialMonRunning() {
  return !$("serialMon").hidden && serialConnected();
}
function serialMonSync() {
  $("serialMon").hidden = !monShown();
  const on = serialConnected();
  $("monStart").disabled = on || serialBusy;
  $("monStop").disabled = !on || serialBusy;
  $("monLine").disabled = $("monSend").disabled = !on || serialBusy;
  if ($("baudRate").value !== monBaud.value) monBaud.value = $("baudRate").value;
  monBaud.disabled = $("baudRate").disabled && !serialBusy ? true : serialBusy;
  monBaud.title = $("baudRate").title;
  $("monState").textContent = on
    ? `● ${$("serialStatus").textContent.replace(/^Serial connected: /, "")}`
    : "○ stopped";
  $("monState").classList.toggle("on", on);
}
function serialMonAppend(text, cls = "") {
  const out = $("monOut");
  const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    if (!line) continue;
    out.append(el("div", "term-line " + cls, line));
  }
  while (out.children.length > 1000) out.firstChild.remove();
  if (stick) out.scrollTop = out.scrollHeight;
}
// Board text arrives in pieces: join them into lines.
let monPartial = "";
function serialMonText(text) {
  monPartial += String(text).replace(/\r/g, "");
  const cut = monPartial.lastIndexOf("\n");
  if (cut < 0) {
    if (monPartial.length > 2000) {
      serialMonAppend(monPartial);
      monPartial = "";
    }
    return;
  }
  serialMonAppend(monPartial.slice(0, cut));
  monPartial = monPartial.slice(cut + 1);
}
$("monStart").onclick = attempt(async () => {
  if (serialConnected()) return;
  $("baudRate").value = monBaud.value;
  saveSettings();
  monPartial = "";
  serialMonAppend(`Starting serial at ${monBaud.value} baud…`, "note");
  await $("serialConnect").onclick();
  if (!serialConnected()) serialMonAppend($("serialStatus").textContent, "error");
  serialMonSync();
});
$("monStop").onclick = attempt(async () => {
  if (!serialConnected()) return;
  await $("serialConnect").onclick();
  if (monPartial) serialMonAppend(monPartial);
  monPartial = "";
  serialMonAppend("Serial stopped.", "note");
  serialMonSync();
});
monBaud.onchange = attempt(async () => {
  if (serialConnected()) await applyBaud(Number(monBaud.value)); // panels.js
  else {
    $("baudRate").value = monBaud.value;
    saveSettings();
  }
  serialMonSync();
});
$("baudRate").addEventListener("change", serialMonSync);
$("monClear").onclick = () => {
  $("monOut").replaceChildren();
  monPartial = "";
};
$("monForm").onsubmit = (event) => {
  event.preventDefault();
  attempt(async () => {
    const text = $("monLine").value;
    await chipSend(text + "\n"); // panels.js
    serialMonAppend("→ " + text, "cmd");
    $("monLine").value = "";
  })();
};
// Shown or hidden with the console mode and the run mode.
for (const b of document.querySelectorAll(".console-modes button"))
  b.addEventListener("click", () => setTimeout(serialMonSync));
$("runtimeMode").addEventListener("change", serialMonSync);
$("consoleTab").addEventListener("click", () => setTimeout(serialMonSync));
serialMonSync();
