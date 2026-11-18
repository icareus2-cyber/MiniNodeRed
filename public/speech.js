// ── Speech in the PC simulation ─────────────────────────────────────
// Voice command boxes get a text field and 🎤 (the browser's speech recognition,
// e.g. Chrome or Edge): what you say or type is matched against the box's commands
// and sent into the running simulation like the board would. Speak boxes talk
// through this PC's speakers (the browser's speech synthesis). Same command rules
// as lib/speechfw.js.
function voiceCommands(config) {
  return String(config.commands || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("|")
        .map((p) => p.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    )
    .filter((phrases) => phrases.length)
    .map((phrases, id) => ({ id, text: phrases[0], phrases }));
}
const speechWords = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .split(" ")
    .filter(Boolean);
// The command a heard sentence means: an exact phrase, a phrase inside it, or the
// phrase sharing most of its words (at least 2 of 3); null if none.
function matchCommand(config, heard) {
  const said = speechWords(heard).join(" ");
  if (!said) return null;
  let best = null,
    score = 0;
  for (const c of voiceCommands(config))
    for (const p of c.phrases) {
      const words = speechWords(p);
      const phrase = words.join(" ");
      if (said === phrase) return c;
      if (` ${said} `.includes(` ${phrase} `) && 0.99 > score) {
        best = c;
        score = 0.99;
      }
      const hit = words.filter((w) => said.split(" ").includes(w)).length;
      const s = hit / Math.max(words.length, 1);
      if (s >= 0.67 && s > score) {
        best = c;
        score = s;
      }
    }
  return best;
}
function sendVoice(n, heard) {
  const c = matchCommand(n.config, heard);
  if (!c) {
    toast(
      `"${heard}" is not one of the commands: ${voiceCommands(n.config)
        .map((x) => x.text)
        .join(", ")}.`,
    );
    return;
  }
  const value = n.config.output === "number" ? String(c.id + 1) : c.text;
  attempt(() => triggerNode(n.id, value))();
}
const Recognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);
// The controls on a Voice command box (testDevice() in app.js).
function voiceControl(n) {
  const box = el("div", "voice-ctl");
  const field = Object.assign(el("input"), {
    placeholder: "type a command, Enter",
    title: "Type what you would say, then Enter (start ▶ Simulate first)",
  });
  field.onpointerdown = (e) => e.stopPropagation(); // typing, not dragging the box
  field.onkeydown = (e) => {
    e.stopPropagation(); // Delete / Ctrl+C stay in the field
    if (e.key === "Enter" && field.value.trim()) {
      sendVoice(n, field.value.trim());
      field.value = "";
    }
  };
  box.append(field);
  if (Recognition) {
    const mic = el("button", "voice-mic", "🎤");
    mic.title = "Say a command (uses the browser's speech recognition)";
    mic.onpointerdown = (e) => e.stopPropagation();
    mic.onclick = (e) => {
      e.stopPropagation();
      const rec = new Recognition();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      mic.classList.add("listening");
      rec.onresult = (ev) => {
        const alts = [...ev.results[0]].map((a) => a.transcript);
        const said =
          alts.find((a) => matchCommand(n.config, a)) || alts[0] || "";
        field.value = said;
        sendVoice(n, said);
      };
      rec.onerror = (ev) =>
        toast(
          ev.error === "not-allowed"
            ? "The microphone is blocked for this page: allow it in the browser, or type the command."
            : `Speech recognition: ${ev.error}. Type the command instead.`,
        );
      rec.onend = () => mic.classList.remove("listening");
      rec.start();
    };
    box.append(mic);
  }
  return box;
}
// "speak" events from the simulator (called by log() in app.js).
const SPEAK_VOICE = {
  sam: [1, 1],
  elf: [1.1, 1.5],
  robot: [1.2, 0.5],
  stuffy: [1, 0.9],
  oldlady: [0.9, 0.6],
  et: [1.3, 1.2],
};
function speechEvent(event) {
  if (event.kind !== "speak" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(String(event.payload ?? ""));
  u.lang = "en-US";
  const [rate, pitch] = SPEAK_VOICE[event.voice] || [1, 1];
  u.rate = rate;
  u.pitch = pitch;
  speechSynthesis.speak(u);
}
