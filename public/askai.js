// ── Ask AI ───────────────────────────────────────────────────────
// Right-click a node in the palette (left) for ready-made questions about it,
// copied to the clipboard; the "Ask AI" tab
// opens Copilot or Gemini docked at the right of the screen to paste them into.
// Those sites refuse to be embedded in other pages, so they open in their own
// window. Shift + right-click keeps the browser's own menu; text fields keep it too.
const AI_SITES = {
  copilot: ["Copilot", "https://copilot.microsoft.com/"],
  gemini: ["Gemini", "https://gemini.google.com/app"],
};
// What Node-RED calls the same idea, where its name differs from ours.
const NODE_RED_NAME = {
  inject: "inject node",
  debug: "debug node",
  "mqtt-in": "mqtt in node",
  "mqtt-out": "mqtt out node",
  threshold: "switch node (with a ≥ rule)",
  compare: "switch node",
  scale: "range node",
  throttle: "delay node in rate-limit mode",
  template: "template node",
  "link-in": "link in node",
  "link-out": "link out node",
  arduino: "function node (but written in C/C++)",
  logic: "boolean logic gate, latch or timer (like a PLC function block)",
  "digital-read": "rpi-gpio in node (read a pin)",
  "gpio-watch": "rpi-gpio in node",
  "digital-write": "rpi-gpio out node",
  "pwm-write": "rpi-gpio out node in PWM mode",
  pulse: "trigger node (send, wait, send again)",
  "pulse-train": "inject node repeating with a trigger node",
  "web-in": "http in node",
  "web-out": "http response node",
  display: "dashboard text node",
  terminal: "serial in node",
  "test-switch": "dashboard switch node",
  "test-button": "dashboard button node",
  "func-gen": "function node with a timer generating a waveform (signal generator)",
  "test-scope": "dashboard chart node",
};
const PROTOCOL_TOPIC = {
  mqtt: "MQTT (topics, a broker, QoS and retained messages)",
  espnow: "ESP-NOW between ESP32 boards (no router)",
  i2c: "I2C between two ESP32 boards (controller and peripheral)",
};
const AI_CONTEXT =
  "Context: I use Microflow, a Node-RED-like flow editor that generates Arduino firmware for ESP32/ESP8266 boards.";
let aiLast = ""; // the question shown in the Ask AI tab
// Questions for one kind of box (palette entry or a box on the canvas).
function nodeQuestions(type, n) {
  const c = catalog[type];
  if (!c) return [];
  const name = c.label;
  const red = NODE_RED_NAME[type];
  const protocol =
    (type === "mqtt-in" || type === "mqtt-out") &&
    (n?.config?.protocol || "mqtt");
  const radio = `How do I send and receive values between boards with ${PROTOCOL_TOPIC[protocol]}? Show an Arduino example for ESP32.`;
  const qs = [];
  // ESP-NOW and I2C have no Node-RED node: ask about the protocol first.
  if (protocol && protocol !== "mqtt") qs.push(radio);
  else
    qs.push(
      `How do I use the ${name.toLowerCase()} in Node-RED${red && !red.startsWith(name.toLowerCase()) ? ` (the ${red})` : ""}? Show a simple example flow.`,
    );
  if (protocol === "mqtt") qs.push(radio);
  else if (!protocol && (c.group === "HARDWARE" || c.pin))
    qs.push(
      `How do I do what a Node-RED ${name.toLowerCase()} does in Arduino code on an ESP32? Include wiring tips.`,
    );
  qs.push(
    `${AI_CONTEXT} Its "${name}" box: ${c.help} When would I use it, and what are common mistakes?`,
  );
  return qs;
}
// What the right-clicked element is, and the questions to offer for it.
function aiTopic(target) {
  const palette = target.closest(".palette-node");
  if (palette?.dataset.type)
    return {
      title: catalog[palette.dataset.type]?.label,
      questions: nodeQuestions(palette.dataset.type),
    };
  const box = target.closest(".flow-node");
  if (box) {
    const n = flow.nodes.find((n) => "node-" + n.id === box.id);
    if (n)
      return {
        title: `${n.label} (${catalog[n.type]?.label})`,
        questions: nodeQuestions(n.type, n),
      };
  }
  // A setting in Node properties: ask about that setting of the selected box.
  const setting = target.closest("#properties label");
  const n = flow.nodes.find((n) => n.id === selected);
  if (setting && n) {
    const field =
      setting.firstChild?.textContent?.trim() || setting.textContent.trim();
    const kind = catalog[n.type]?.label || n.type;
    return {
      title: `${kind} · ${field}`,
      questions: [
        `In Node-RED's ${kind.toLowerCase()} node, what does the "${field}" setting do, and what value should I choose?`,
        `${AI_CONTEXT} In its "${kind}" box, what does "${field}" mean? ${catalog[n.type]?.help || ""}`,
        ...nodeQuestions(n.type, n).slice(0, 1),
      ],
    };
  }
  // Buttons, tabs, headings and other text on screen.
  const item =
    target.closest(
      "button, a, label, th, h1, h2, h3, b, strong, .section-title, [title]",
    ) || target;
  const text = (item.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const hint = item.getAttribute?.("title") || "";
  const what = text || hint;
  if (!what) return null;
  return {
    title: what,
    questions: [
      `${AI_CONTEXT} What does "${what}"${hint && hint !== what ? ` (${hint})` : ""} do, and how do I use it?`,
      `How is "${what}" done in Node-RED or in Arduino for ESP32? Explain step by step.`,
    ],
  };
}
// shown: what stays in the question box and Recent (default: the copied text).
async function aiCopy(text, shown = text) {
  aiLast = shown;
  if ($("aiQuestion")) $("aiQuestion").value = shown;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers without clipboard permission.
    const t = Object.assign(document.createElement("textarea"), {
      value: text,
    });
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  aiRemember(shown);
  toast("Question copied. Paste it into the AI with Ctrl+V.");
}
// Opens the AI in its own window docked at the right edge of the screen.
function aiOpen(site) {
  const [, url] = AI_SITES[site];
  const width = Math.min(520, Math.round(screen.availWidth * 0.35));
  const left = (screen.availLeft || 0) + screen.availWidth - width;
  const win = window.open(
    url,
    "microflow-ai",
    `popup,width=${width},height=${screen.availHeight},left=${left},top=${screen.availTop || 0}`,
  );
  if (!win) toast("The AI window was blocked: allow pop-ups for this page.");
  try {
    localStorage.setItem("microflow.aiSite", site);
  } catch {}
}
// ── Right-click menu ────────────────────────────────────────────
function aiCloseMenu() {
  document.querySelector(".ai-menu")?.remove();
}
document.addEventListener("contextmenu", (event) => {
  if (event.shiftKey) return; // Shift: the browser's own menu
  // Only the node palette on the left asks AI; the canvas has its own menu
  // (copy / paste, app.js) and the rest keeps the browser's menu.
  if (!event.target.closest(".palette")) return;
  if (event.target.closest("input, textarea, select, [contenteditable], pre"))
    return; // text fields keep copy/paste
  const topic = aiTopic(event.target);
  if (!topic?.questions.length) return;
  event.preventDefault();
  aiCloseMenu();
  const menu = el("div", "ai-menu");
  menu.setAttribute("role", "menu");
  menu.append(el("div", "ai-menu-title", `Ask AI about “${topic.title}”`));
  for (const q of topic.questions) {
    const b = el("button", "", q.replace(AI_CONTEXT + " ", ""));
    b.setAttribute("role", "menuitem");
    b.title = "Copy this question";
    b.onclick = () => {
      aiCopy(q);
      aiCloseMenu();
    };
    menu.append(b);
  }
  const open = el("div", "ai-menu-open");
  for (const site of Object.keys(AI_SITES)) {
    const b = el("button", "", `Copy first + open ${AI_SITES[site][0]}`);
    b.onclick = () => {
      aiOpen(site); // first, inside the click, so pop-up blockers allow it
      aiCopy(topic.questions[0]);
      aiCloseMenu();
    };
    open.append(b);
  }
  menu.append(
    open,
    el("div", "ai-menu-hint", "Shift + right-click: browser menu"),
  );
  document.body.append(menu);
  // Keep the menu on screen.
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.min(event.clientX, innerWidth - box.width - 8) + "px";
  menu.style.top = Math.min(event.clientY, innerHeight - box.height - 8) + "px";
  menu.querySelector("button")?.focus();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ai-menu")) aiCloseMenu();
});
document.addEventListener(
  "keydown",
  (e) => e.key === "Escape" && aiCloseMenu(),
);
window.addEventListener("blur", aiCloseMenu);
document.addEventListener("scroll", aiCloseMenu, true);
// ── Ask AI tab (right-hand panel) ───────────────────────────────
function aiRecent() {
  try {
    return JSON.parse(localStorage.getItem("microflow.aiRecent") || "[]");
  } catch {
    return [];
  }
}
function aiRemember(q) {
  try {
    const list = [q, ...aiRecent().filter((x) => x !== q)].slice(0, 8);
    localStorage.setItem("microflow.aiRecent", JSON.stringify(list));
  } catch {}
  if (!$("aiPanel").hidden) showAi();
}
// One paragraph about the setup for a typed question: the board, the language and
// the selected node with its settings (never passwords, keys or WiFi details).
function aiSetup() {
  const board = boards.find((b) => b.id === $("board").value);
  const parts = [AI_CONTEXT];
  if (board) parts.push(`Board: ${board.label} (${board.fqbn}).`);
  parts.push(
    languageOf() === "nodered"
      ? "Flow language: Node-RED messages."
      : "Flow language: Arduino values.",
  );
  const n = flow.nodes.find((m) => m.id === selected);
  if (n) {
    const c = catalog[n.type];
    const secret = new Set(
      (c?.fields || []).filter((f) => f.type === "secret").map((f) => f.key),
    );
    const values = Object.entries(n.config || {})
      .filter(
        ([k, v]) =>
          !secret.has(k) &&
          !/pass|key|token|secret/i.test(k) &&
          String(v).length <= 80,
      )
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    parts.push(
      `Selected node: ${c?.label || n.type}${NODE_RED_NAME[n.type] ? ` (like Node-RED's ${NODE_RED_NAME[n.type]})` : ""}${values ? `, settings: ${values}` : ""}.`,
    );
  }
  return parts.join(" ");
}
// Questions made from the selected node and its place in the flow: what it is, what
// feeds it, where its value goes, its pin, type conversions and the checks' warnings.
function aiSuggestions(n) {
  const c = catalog[n.type];
  if (!c) return [];
  const kind = c.label;
  const name = n.label && n.label !== kind ? `"${n.label}" (${kind})` : kind;
  const label = (id) => {
    const m = flow.nodes.find((x) => x.id === id);
    return m ? m.label || catalog[m.type]?.label || m.type : null;
  };
  const from = flow.edges.filter((e) => e.to === n.id).map((e) => label(e.from)).filter(Boolean);
  const to = flow.edges.filter((e) => e.from === n.id).map((e) => label(e.to)).filter(Boolean);
  const qs = nodeQuestions(n.type, n).map((q) => q.replace(AI_CONTEXT + " Its", "Microflow's"));
  if (from.length)
    qs.push(`My ${name} box gets its value from ${from.join(", ")}. What value arrives, and how should I set the ${kind.toLowerCase()} up for it?`);
  if (to.length)
    qs.push(`My ${name} box sends its value to ${to.join(", ")}. Is that a good way to connect them, and what should I check?`);
  if (!from.length && !to.length && c.inType !== null)
    qs.push(`My ${name} box is not connected yet. Which boxes usually go before and after a ${kind.toLowerCase()}?`);
  if (n.config?.pin !== undefined && n.config.pin !== "")
    qs.push(`On my ${boards.find((b) => b.id === $("board").value)?.label || "ESP32"} board, is GPIO ${n.config.pin} a good pin for a ${kind.toLowerCase()}? How do I wire it?`);
  if (n.itype || n.vtype) {
    const ups = [...new Set(upstreamOf(n).map((m) => varTypeOf(m)))];
    const note = n.itype && ups.length === 1 ? conversionNote(ups[0], n.itype) : "";
    const parts = [
      n.itype && `its input to ${TYPE_LABEL[n.itype] || n.itype}`,
      n.vtype && `its output to ${TYPE_LABEL[n.vtype] || n.vtype}`,
    ].filter(Boolean);
    qs.push(`My ${name} box converts ${parts.join(" and ")}${note ? ` (${note})` : ""}. When is that conversion useful, and what can go wrong?`);
  }
  return qs;
}
// The checks' warnings about one node, as questions (added when they arrive).
async function aiWarningQuestions(n) {
  try {
    const { errors, warnings } = await api("analyze", { flow: chipFlow(), board: $("board").value });
    const kind = catalog[n.type]?.label || n.type;
    const names = [n.label, n.id].filter(Boolean);
    return [...errors, ...warnings]
      .filter((w) => names.some((x) => w.includes(x)))
      .slice(0, 3)
      .map((w) => `Microflow warns about my ${kind} box: "${w}". What does it mean and how do I fix it?`);
  } catch {
    return [];
  }
}
function showAi() {
  $("devicePanel").hidden = $("nodePanel").hidden = true;
  $("consolePanel").hidden = true;
  $("aiPanel").hidden = false;
  for (const id of ["deviceTab", "nodeTab", "consoleTab"])
    $(id).classList.remove("selected");
  $("aiTab").classList.add("selected");
  const area = $("aiArea");
  const question = Object.assign(el("textarea"), {
    id: "aiQuestion",
    rows: 5,
    value: aiLast,
    placeholder:
      "Type your question here, e.g. “How do I debounce a button?”, then Copy question (Ctrl+Enter).",
  });
  question.oninput = () => (aiLast = question.value);
  // Context added in front of a typed question, so the AI knows the setup.
  const withContext = Object.assign(el("input"), { type: "checkbox" });
  try {
    withContext.checked = localStorage.getItem("microflow.aiContext") !== "off";
  } catch {
    withContext.checked = true;
  }
  withContext.onchange = () => {
    try {
      localStorage.setItem(
        "microflow.aiContext",
        withContext.checked ? "on" : "off",
      );
    } catch {}
  };
  const contextLabel = el("label", "check-row");
  contextLabel.append(
    withContext,
    document.createTextNode(
      " Add context: Microflow, my board and the selected node",
    ),
  );
  const copyNow = async () => {
    const text = question.value.trim();
    if (!text) {
      question.focus();
      return toast("Type a question first.");
    }
    const full =
      withContext.checked && !text.startsWith(AI_CONTEXT)
        ? `${aiSetup()}\n\n${text}`
        : text;
    await aiCopy(full, text);
    copy.textContent = "Copied ✓";
    setTimeout(() => (copy.textContent = "Copy question"), 2000);
  };
  const copy = button("Copy question", copyNow, "primary");
  copy.title = "Copy to the clipboard, ready to paste into the AI (Ctrl+Enter)";
  question.onkeydown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      copyNow();
    }
  };
  const sites = el("div", "step-row");
  for (const site of Object.keys(AI_SITES))
    sites.append(
      button(
        `Open ${AI_SITES[site][0]}`,
        () => {
          aiOpen(site);
          if (question.value.trim()) copyNow();
        },
        "",
      ),
    );
  // Suggested questions for the selected node: click one to put it in the box.
  const node = flow.nodes.find((m) => m.id === selected);
  const suggested = el("div", "ai-recent ai-suggested");
  const offer = (q) => {
    const b = el("button", "", q);
    b.title = "Put this question in the box and copy it (edit it if you like)";
    b.onclick = () => {
      question.value = aiLast = q;
      copyNow();
    };
    suggested.append(b);
  };
  if (node) {
    aiSuggestions(node).forEach(offer);
    aiWarningQuestions(node).then((qs) => qs.forEach(offer));
  }
  const recent = aiRecent();
  const list = el("div", "ai-recent");
  for (const q of recent) {
    const b = el("button", "", q.replace(AI_CONTEXT + " ", ""));
    b.title = "Use this question again";
    b.onclick = () => {
      question.value = aiLast = q;
      aiCopy(q);
    };
    list.append(b);
  }
  area.replaceChildren(
    el(
      "p",
      "muted",
      "Pick a suggested question, or type your own below and copy it. Then paste it into the AI. Most boxes work like Node-RED's, so the AI's Node-RED answers apply.",
    ),
    ...(node
      ? [el("b", "", `Suggested for ${node.label || catalog[node.type]?.label || node.type}`), suggested]
      : [el("p", "muted", "Select a node on the canvas, then open this tab, for questions made from it.")]),
    question,
    contextLabel,
    copy,
    sites,
    el(
      "p",
      "muted",
      "Copilot and Gemini open in their own window at the right of the screen (they cannot be shown inside this page). Paste with Ctrl+V. Do not paste passwords or WiFi keys.",
    ),
    ...(recent.length ? [el("b", "", "Recent questions"), list] : []),
  );
}
$("aiTab").onclick = showAi;
