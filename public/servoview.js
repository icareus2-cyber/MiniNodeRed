// ── Servo boxes: a small robot arm that turns like the servo ──────────
// Output device boxes in servo mode (and Peripheral boxes driving a servo) show a
// servo with an arm on it while the PC simulation (or the real board over USB)
// runs: the arm turns to the angle at the servo's speed, with the angle and the
// pulse width the board would send (µs). Continuous-rotation servos (input "speed")
// spin. The simulator says where the servo goes ("servo" events: angle and travel
// time, or speed); the value the node sends on confirms where it stopped.
const servoState = new Map(); // node id → { angle, speed }
function isServoNode(n) {
  return (
    (n.type === "output-device" && n.config.device === "servo") ||
    (n.type === "peripheral" && n.config.kind === "servo")
  );
}
// The servo's settings as the drawing needs them (Peripheral servos use the
// Output device defaults for range and pulses).
function servoConfig(n) {
  const c = n.config;
  return {
    range: Number(c.range) || 180,
    minUs: Number(c.minUs) || 500,
    maxUs: Number(c.maxUs) || 2400,
    start: c.start === undefined ? 90 : Number(c.start),
    continuous: n.type === "output-device" && c.servoIn === "speed",
  };
}
const SERVO_NS = "http://www.w3.org/2000/svg";
const servoSvgEl = (tag, attrs) => {
  const e = document.createElementNS(SERVO_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
// The drawing: servo body with its horn at the pivot, a dotted arc over the
// angle range, and a two-part arm with a gripper. 0° points right, 90° up.
function servoView(n) {
  const cfg = servoConfig(n);
  const st = servoState.get(n.id) || {};
  const box = el("div", "servo-view");
  box.dataset.node = n.id;
  const svg = servoSvgEl("svg", {
    viewBox: "0 0 120 74",
    width: "120",
    height: "74",
    role: "img",
    "aria-label": `${n.label}: servo arm`,
  });
  const cx = 60,
    cy = 56,
    r = 40;
  // Range arc (0° … range), as a protractor.
  const rad = (deg) => (deg * Math.PI) / 180;
  const pt = (deg, rr) => [cx + rr * Math.cos(rad(deg)), cy - rr * Math.sin(rad(deg))];
  const span = Math.min(cfg.range, 359);
  const [x0, y0] = pt(0, r + 6),
    [x1, y1] = pt(span, r + 6);
  svg.append(
    servoSvgEl("path", {
      d: `M ${x0} ${y0} A ${r + 6} ${r + 6} 0 ${span > 180 ? 1 : 0} 0 ${x1} ${y1}`,
      class: "servo-arc",
    }),
  );
  for (const deg of [0, 90, 180].filter((d) => d <= cfg.range)) {
    const [a, b] = pt(deg, r + 3),
      [c, d] = pt(deg, r + 9);
    svg.append(servoSvgEl("line", { x1: a, y1: b, x2: c, y2: d, class: "servo-tick" }));
  }
  // Servo body (with mounting ears) under the pivot.
  svg.append(
    servoSvgEl("rect", { x: 40, y: 54, width: 40, height: 16, rx: 2, class: "servo-body" }),
    servoSvgEl("rect", { x: 34, y: 58, width: 52, height: 4, rx: 1, class: "servo-body" }),
  );
  // The arm: drawn pointing right, turned by the angle around the pivot.
  const arm = servoSvgEl("g", { class: "servo-arm" });
  arm.append(
    servoSvgEl("rect", { x: -5, y: -4, width: 30, height: 8, rx: 4, class: "servo-link" }),
    servoSvgEl("circle", { cx: 25, cy: 0, r: 3.2, class: "servo-joint" }),
    servoSvgEl("rect", { x: 24, y: -3, width: 14, height: 6, rx: 3, class: "servo-link2" }),
    servoSvgEl("path", { d: "M 38 -5 L 44 -6 M 38 5 L 44 6 M 38 -5 L 38 5", class: "servo-grip" }),
  );
  const holder = servoSvgEl("g", { transform: `translate(${cx} ${cy})` });
  holder.append(arm);
  svg.append(holder, servoSvgEl("circle", { cx, cy, r: 4.5, class: "servo-horn" }));
  const label = el("div", "servo-label");
  box.append(svg, label);
  // Where it is now (or its start angle before the simulation moves it).
  const angle = st.angle ?? (cfg.start >= 0 ? cfg.start : null);
  paintServo(box, n, angle, 0, st.speed);
  return box;
}
// Turns the arm on a box (ms: travel time, so the arm moves at the servo's speed).
function paintServo(box, n, angle, ms = 0, speed) {
  const cfg = servoConfig(n);
  const arm = box.querySelector(".servo-arm");
  const label = box.querySelector(".servo-label");
  if (!arm || !label) return;
  arm.classList.toggle("spinning", !!(cfg.continuous && speed));
  if (cfg.continuous) {
    const s = Number(speed) || 0;
    arm.style.animationDuration = s ? `${(2 * 100) / Math.abs(s)}s` : "";
    arm.style.animationDirection = s < 0 ? "reverse" : "normal";
    const us = Math.round((cfg.minUs + cfg.maxUs) / 2 + (s * (cfg.maxUs - cfg.minUs)) / 200);
    label.textContent = s ? `speed ${s} % · ${us} µs` : "stopped";
    return;
  }
  if (angle === null || angle === undefined || !Number.isFinite(Number(angle))) {
    label.textContent = "angle: —";
    arm.style.transform = "rotate(-90deg)";
    return;
  }
  const a = Math.max(0, Math.min(cfg.range, Number(angle)));
  const us = Math.round(cfg.minUs + (a / cfg.range) * (cfg.maxUs - cfg.minUs));
  arm.style.transition = `transform ${Math.max(0, ms)}ms linear`;
  arm.style.transform = `rotate(${-a}deg)`;
  // While it turns: "→ target"; once there: the angle.
  const done = `${a.toFixed(1)}° · ${us} µs`;
  clearTimeout(box.servoTimer);
  if (ms > 300) {
    label.textContent = `→ ${a.toFixed(1)}° · ${us} µs`;
    box.servoTimer = setTimeout(() => (label.textContent = done), ms);
  } else label.textContent = done;
}
function paintServoNode(id, ms) {
  const n = flow.nodes.find((m) => m.id === id);
  if (!n || !isServoNode(n)) return;
  const st = servoState.get(id) || {};
  for (const box of document.querySelectorAll(
    `.servo-view[data-node="${CSS.escape(id)}"]`,
  ))
    paintServo(box, n, st.angle, ms, st.speed);
}
// Simulator events (called by log() in app.js).
function servoEvent(event) {
  if (event.kind === "servo" && event.node) {
    const st = servoState.get(event.node) || {};
    if (event.speed !== undefined) st.speed = Number(event.speed);
    if (event.angle !== undefined) st.angle = Number(event.angle);
    servoState.set(event.node, st);
    paintServoNode(event.node, Number(event.ms) || 0);
  } else if (event.kind === "trace" && event.payload !== undefined)
    servoValue(String(event.message).split("__")[0], event.payload);
  else if (
    event.kind === "status" &&
    (event.message === "Runtime stopped" || event.message === "Restarting")
  ) {
    servoState.clear();
    for (const box of document.querySelectorAll(".servo-view")) {
      const n = flow.nodes.find((m) => m.id === box.dataset.node);
      if (n) paintServo(box, n, servoConfig(n).start >= 0 ? servoConfig(n).start : null, 300);
    }
  }
}
// A value a servo box sent on (where it stopped), in the simulator or from the real
// board over USB (emulate.js): the arm goes there.
function servoValue(id, value) {
  const n = flow.nodes.find((m) => m.id === id);
  if (!n || !isServoNode(n) || servoConfig(n).continuous) return;
  const a = Number(value);
  if (!Number.isFinite(a)) return;
  const st = servoState.get(id) || {};
  // Already there (or on its way at the servo's speed): nothing to redraw.
  if (st.angle === a) return;
  st.angle = a;
  servoState.set(id, st);
  paintServoNode(id, 250);
}
