// Board drawing and pin map (Device tab): the card under Board shows a small drawing
// of the selected board; clicking or right-clicking the card or the Board box opens a
// large one with every pin labelled and the pins the flow uses highlighted. Board
// looks come from lib/boards.js (LOOKS).
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
const selectedBoard = () => boards.find((b) => b.id === $("board").value);
// A header entry: "D1:5" → { label: "D1", gpio: 5 }; 5 → { label: "GPIO 5", gpio: 5 };
// "GND" → { label: "GND", gpio: null }.
function headerPin(entry) {
  if (typeof entry === "number") return { label: String(entry), gpio: entry };
  const [label, gpio] = String(entry).split(":");
  return { label, gpio: gpio === undefined ? null : Number(gpio) };
}
// Which pins the board itself uses (camera, display), as gpio → what.
function boardReserved(b) {
  const out = new Map();
  for (const [pin, what] of Object.entries(b.reserved || {}))
    out.set(Number(pin), what);
  for (const [role, pin] of Object.entries(b.camera || {}))
    if (pin >= 0) out.set(pin, `camera ${role.toUpperCase()}`);
  return out;
}
// The flow's pins: gpio → [{ role: "input" | "output", who }].
function flowPinUse() {
  const use = new Map();
  for (const n of chipFlow().nodes)
    for (const p of nodePins(n)) {
      const list = use.get(p.pin) || [];
      list.push({ role: pinRole(p.use), who: n.name || n.label });
      use.set(p.pin, list);
    }
  return use;
}
// How a pin is drawn: its class and a sentence for its tooltip.
function pinState(b, gpio, use, reserved) {
  if (gpio === null) return { cls: "power", text: "" };
  const users = use.get(gpio) || [];
  const facts = [];
  if (b.adc.includes(gpio)) facts.push("analog input (ADC)");
  if (b.inputOnly?.includes(gpio)) facts.push("input only");
  if (b.strapping?.[gpio]) facts.push(`boot pin: ${b.strapping[gpio]}`);
  if (b.notes?.[gpio]) facts.push(b.notes[gpio]);
  if (b.i2c?.sda === gpio) facts.push("usual I2C SDA");
  if (b.i2c?.scl === gpio) facts.push("usual I2C SCL");
  const roles = new Set(users.map((u) => u.role));
  const cls = reserved.has(gpio)
    ? "reserved"
    : roles.size > 1 || users.filter((u) => u.role === "output").length > 1
      ? "clash"
      : roles.has("input")
        ? "in"
        : roles.has("output")
          ? "out"
          : b.gpio.includes(gpio) || b.adc.includes(gpio)
            ? "free"
            : "power";
  const who = users.map((u) => `${u.role} for ${u.who}`).join("; ");
  const text = [
    reserved.has(gpio) ? `used by the board (${reserved.get(gpio)})` : who,
    ...facts,
  ]
    .filter(Boolean)
    .join(" · ");
  return { cls, text, users, strap: !!b.strapping?.[gpio] };
}
// Short function tags for a GPIO: PWM output, analog input, the usual I2C pins.
function pinTags(b, gpio) {
  if (gpio === null || gpio === undefined) return [];
  const tags = [];
  if (b.pwm?.includes(gpio)) tags.push("PWM");
  if (b.adc?.includes(gpio)) tags.push("ADC");
  if (b.i2c?.sda === gpio) tags.push("SDA");
  if (b.i2c?.scl === gpio) tags.push("SCL");
  for (const [role, pin] of Object.entries(b.spi || {}))
    if (pin === gpio) tags.push(role.toUpperCase());
  return tags;
}
// Names beside a pin are cut to fit the drawing (the tooltip has them all).
const short = (text, max = 12) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;
// The board's USB sockets, left to right: [{ label, via, use, kind, rec }]. Boards
// with one socket use it for everything (through a USB-to-UART bridge or the chip's
// own USB). rec marks the socket to program through: the one that also carries the
// serial monitor, since Microflow uploads and debugs over the same port.
function usbPorts(look) {
  const ports = look.ports
    ? look.ports.map((p) => ({
        ...p,
        kind: p.kind || (p.label === "UART" ? "uart" : "otg"),
      }))
    : look.usb
      ? [
          {
            label: look.usb,
            use: "upload · serial monitor · Web Serial",
            kind: "uart",
          },
        ]
      : [];
  const rec =
    ports.find((p) => p.use.includes("serial monitor")) ||
    ports.find((p) => p.kind === "uart") ||
    ports[0];
  if (rec) rec.rec = true;
  return ports;
}
// The pins down each side: the real header, or the board's GPIOs in two columns.
function boardColumns(b) {
  const look = b.look || {};
  if (look.layout === "physical" && look.left)
    return [look.left.map(headerPin), look.right.map(headerPin)];
  const pins = [...new Set([...b.gpio, ...b.adc])]
    .sort((x, y) => x - y)
    .map((g) => ({ label: `GPIO ${g}`, gpio: g }));
  const half = Math.ceil(pins.length / 2);
  return [pins.slice(0, half), pins.slice(half)];
}
// The drawing. mini: the small one on the card (no labels).
function boardSvg(b, { mini = false } = {}) {
  const look = b.look || { size: [26, 50] };
  const [left, right] = boardColumns(b);
  const rows = Math.max(left.length, right.length, 6);
  const pitch = 20,
    usbTop = look.usbAt === "top", // e.g. SuperMini boards: USB-C at the top
    // Dev boards whose headers run the whole length: the module and the USB socket
    // sit between the two pin rows, and the board keeps its real proportions.
    full = !!look.fullLength,
    top = full
      ? 18
      : look.lcd
        ? 70
        : usbTop
          ? look.buttons?.length
            ? 100
            : 64
          : 96,
    bottom = full ? 18 : look.backView ? 24 : 70;
  const bodyH = top + rows * pitch + bottom;
  const [sw, sh] = look.size || [26, 50];
  const bodyW = full ? Math.max(170, Math.round((bodyH * sw) / sh)) : 170;
  const labelW = 215;
  const W = bodyW + labelW * 2,
    x0 = labelW;
  const svg = svgEl("svg", {
    viewBox: mini
      ? `${x0 - 6} 0 ${bodyW + 12} ${bodyH + 6}`
      : `0 0 ${W} ${bodyH + (look.pads ? 40 : usbPorts(look).length && !usbTop ? 32 : 10)}`,
    class: mini ? "board-svg mini" : "board-svg",
    role: "img",
    preserveAspectRatio: "xMidYMin meet",
    "aria-label": `Drawing of the ${look.name || b.label}`,
  });
  const g = (attrs) => svg.appendChild(svgEl("g", attrs));
  // Circuit board
  svg.append(
    svgEl("rect", {
      x: x0,
      y: 3,
      width: bodyW,
      height: bodyH,
      rx: 10,
      class: "pcb",
    }),
  );
  // Module with its antenna at the top (between the pin rows on full-length boards).
  const mw = full ? Math.round(bodyW * 0.62) : bodyW - 56,
    mx = x0 + (bodyW - mw) / 2,
    my = full ? 8 : 12,
    mh = full ? Math.round(bodyH * (look.moduleHeight || 0.36)) : 74,
    ant = full ? Math.round(mh * 0.24) : 24;
  const shieldY = my + ant + 4,
    shieldH = mh - ant - 10;
  const mod = svgEl("g");
  const zig = Math.max(4, Math.floor((mw - 24) / 12 / 2) * 2);
  mod.append(
    svgEl("rect", {
      x: mx,
      y: my,
      width: mw,
      height: mh,
      rx: 3,
      class: "module",
    }),
    svgEl("path", {
      d:
        `M${mx + 10} ${my + ant - 6}` +
        " h12 v-8 h12 v8".repeat(zig / 2) +
        " h12",
      class: "antenna",
    }),
    svgEl("rect", {
      x: mx + 10,
      y: shieldY,
      width: mw - 20,
      height: shieldH,
      rx: 2,
      class: "shield",
    }),
  );
  if (!mini)
    mod.append(
      svgEl(
        "text",
        {
          x: x0 + bodyW / 2,
          y: shieldY + shieldH / 2 + (look.module ? -2 : 5),
          class: "chip-text",
        },
        look.chip || b.family.toUpperCase(),
      ),
      svgEl(
        "text",
        {
          x: x0 + bodyW / 2,
          y: shieldY + shieldH / 2 + 13,
          class: "chip-sub",
          ...((look.module || "").length * 5.2 > mw - 30
            ? { textLength: mw - 30, lengthAdjust: "spacingAndGlyphs" }
            : {}),
        },
        look.module || "",
      ),
    );
  if (look.lcd) {
    // Display boards: the screen is on the front, the module behind it.
    if (!mini)
      svg.append(
        svgEl(
          "text",
          { x: x0 + bodyW / 2, y: 44, class: "brand-text" },
          look.brand || "",
        ),
      );
  } else if (look.backView) {
    // Drawn from the back: the board's printed name instead of the chip.
    if (!mini)
      svg.append(
        svgEl(
          "text",
          {
            x: x0 + bodyW / 2,
            y: top + (rows * pitch) / 2 + 6,
            class: "back-text",
          },
          look.backView,
        ),
      );
  } else if (usbTop) {
    // The chip sits below the pins; the USB socket and buttons are at the top.
    const cy = top + rows * pitch + 4;
    svg.append(
      svgEl("rect", {
        x: x0 + bodyW / 2 - 20,
        y: cy,
        width: 40,
        height: 34,
        rx: 3,
        class: "module",
      }),
    );
    if (!mini)
      svg.append(
        svgEl(
          "text",
          { x: x0 + bodyW / 2, y: cy + 21, class: "part-text" },
          look.chip || "",
        ),
      );
  } else svg.append(mod);
  // Camera lens or LCD
  if (look.camera) {
    const cy = full
      ? Math.round((my + mh + (bodyH - 60)) / 2)
      : top + (rows * pitch) / 2 - 10;
    svg.append(
      svgEl("rect", {
        x: x0 + bodyW / 2 - 30,
        y: cy - 30,
        width: 60,
        height: 60,
        rx: 6,
        class: "cam-box",
      }),
      svgEl("circle", { cx: x0 + bodyW / 2, cy, r: 20, class: "lens" }),
      svgEl("circle", { cx: x0 + bodyW / 2, cy, r: 9, class: "lens-in" }),
    );
    if (!mini)
      svg.append(
        svgEl(
          "text",
          { x: x0 + bodyW / 2, y: cy + 44, class: "part-text" },
          "camera",
        ),
      );
  }
  if (look.lcd) {
    // The screen fills the middle, between the two pin rows.
    const ly = top - 6,
      lh = rows * pitch + 12;
    svg.append(
      svgEl("rect", {
        x: x0 + 26,
        y: ly,
        width: bodyW - 52,
        height: lh,
        rx: 4,
        class: "lcd-frame",
      }),
      svgEl("rect", {
        x: x0 + 34,
        y: ly + 10,
        width: bodyW - 68,
        height: lh - 20,
        rx: 2,
        class: "lcd",
      }),
    );
    if (!mini)
      svg.append(
        svgEl(
          "text",
          { x: x0 + bodyW / 2, y: ly + lh / 2 + 4, class: "lcd-text" },
          look.lcd,
        ),
      );
  }
  if (look.flash && !mini) {
    svg.append(
      svgEl("circle", { cx: x0 + bodyW - 34, cy: top + 8, r: 7, class: "led" }),
      svgEl(
        "text",
        { x: x0 + bodyW - 34, y: top + 26, class: "part-text" },
        "flash LED",
      ),
    );
  }
  // USB sockets at the bottom: one, or two side by side (UART bridge and native USB).
  const ports = usbPorts(look);
  ports.forEach((port, k) => {
    const cx = x0 + (bodyW * (k + 1)) / (ports.length + 1);
    const sy = usbTop ? 3 : bodyH - 14;
    // The recommended socket gets a green ring and a "PROGRAM" tag.
    if (port.rec)
      svg.append(
        svgEl("rect", {
          x: cx - 26,
          y: sy - 4,
          width: 52,
          height: 28,
          rx: 6,
          class: "usb-rec",
        }),
      );
    svg.append(
      svgEl("rect", {
        x: cx - 22,
        y: sy,
        width: 44,
        height: 20,
        rx: 4,
        class: `usb ${port.kind}`,
      }),
    );
    if (mini) return;
    if (port.rec) {
      svg.append(
        svgEl(
          "text",
          { x: cx, y: sy + 14, class: "usb-rec-tag" },
          "PROGRAM",
        ),
      );
      svg.lastChild.append(
        svgEl("title", {}, "Recommended: connect this socket to upload and debug"),
      );
    }
    svg.append(
      svgEl(
        "text",
        { x: cx, y: usbTop ? 36 : bodyH - 22, class: "part-text usb-name" },
        port.label,
      ),
    );
    const two = ports.length > 1;
    svg.append(
      svgEl(
        "text",
        {
          x: two ? cx + (k ? -20 : 20) : cx,
          y: usbTop ? 49 : bodyH + 22,
          class: `usb-use ${two ? (k ? "start" : "end") : ""}${usbTop ? " inside" : ""}`,
        },
        port.short || port.use,
      ),
    );
    svg.lastChild.append(
      svgEl(
        "title",
        {},
        `${port.label}: ${port.via || ""} · ${port.use}${port.rec ? " (recommended for programming)" : ""}`,
      ),
    );
  });
  // A button on the board's side edge (e.g. RST on the TTGO T-Display).
  if (look.edgeButton) {
    const [label, at] = look.edgeButton.split("@");
    const ey = top + rows * pitch + 4;
    const ex = at === "left" ? x0 - 6 : x0 + bodyW - 4;
    svg.append(
      svgEl("rect", {
        x: ex,
        y: ey,
        width: 10,
        height: 22,
        rx: 2,
        class: "button",
      }),
    );
    if (!mini)
      svg.append(
        svgEl(
          "text",
          {
            x: at === "left" ? ex - 4 : ex + 14,
            y: ey + 15,
            class: `part-text edge ${at || "right"}`,
          },
          label,
        ),
      );
  }
  (look.buttons || []).forEach((name, k, all) => {
    const inner = full ? 34 : 22; // full-length boards: between the pin rows
    const bx =
      x0 +
      inner +
      k * ((bodyW - 2 * inner - 26) / Math.max(1, all.length - 1 || 1));
    const by = usbTop ? 70 : bodyH - 50;
    svg.append(
      svgEl("rect", {
        x: bx,
        y: by,
        width: 26,
        height: 16,
        rx: 3,
        class: "button",
      }),
      svgEl("circle", { cx: bx + 13, cy: by + 8, r: 5, class: "button-in" }),
    );
    if (!mini) {
      const [label, gpio] = name.split(":");
      svg.append(
        svgEl(
          "text",
          { x: bx + 13, y: by - 4, class: "part-text" },
          gpio ? `${label} (${gpio})` : label,
        ),
      );
    }
  });
  // Header pins
  const use = flowPinUse();
  const reserved = boardReserved(b);
  const column = (pins, side) =>
    pins.forEach((p, k) => {
      const y = top + k * pitch + pitch / 2;
      const x = side === "left" ? x0 + 9 : x0 + bodyW - 9;
      const st = pinState(b, p.gpio, use, reserved);
      const pin = g({ class: `pin ${st.cls}${st.strap ? " strap" : ""}` });
      pin.append(
        svgEl("rect", {
          x: x - 6,
          y: y - 6,
          width: 12,
          height: 12,
          rx: 2,
          class: "pad",
        }),
      );
      pin.append(svgEl("circle", { cx: x, cy: y, r: 3.2, class: "hole" }));
      if (mini) return;
      const name =
        p.gpio === null ||
        String(p.gpio) === p.label ||
        p.label === `GPIO ${p.gpio}`
          ? p.label
          : `${p.label} · ${p.gpio === 17 && b.family === "esp8266" ? "ADC" : p.gpio}`;
      const role = reserved.get(p.gpio);
      const who = role
        ? role
        : st.users?.length
          ? short(st.users.map((u) => u.who).join(", "))
          : "";
      const tx = side === "left" ? x0 - 8 : x0 + bodyW + 8;
      const text = svgEl("text", {
        x: tx,
        y: y + 4,
        class: `pin-text ${side}`,
      });
      // Functions the pin offers (free GPIOs only): PWM, ADC, default I2C.
      const tags = role || st.cls === "power" ? [] : pinTags(b, p.gpio);
      const add = (t, cls) =>
        text.append(svgEl("tspan", cls ? { class: cls } : {}, t));
      if (side === "right") {
        add(name);
        for (const t of tags) add(" " + t, `tag ${t.toLowerCase()}`);
        if (who) add(role ? ` · ${who}` : ` ← ${who}`, role ? "" : "who");
      } else {
        if (who) add(role ? `${who} · ` : `${who} → `, role ? "" : "who");
        for (const t of tags) add(t + " ", `tag ${t.toLowerCase()}`);
        add(name);
      }
      pin.append(text);
      const tip = svgEl(
        "title",
        {},
        [p.gpio === null ? p.label : `GPIO ${p.gpio} (${p.label})`, st.text]
          .filter(Boolean)
          .join(": "),
      );
      pin.append(tip);
    });
  column(left, "left");
  column(right, "right");
  // Pads along the bottom edge (e.g. the SuperMini's extra GPIOs underneath).
  (look.pads || []).map(headerPin).forEach((p, k, all) => {
    const x = x0 + (bodyW * (k + 1)) / (all.length + 1);
    const y = bodyH - 8;
    const st = pinState(b, p.gpio, use, reserved);
    const pad = g({ class: `pin ${st.cls}${st.strap ? " strap" : ""}` });
    pad.append(
      svgEl("rect", {
        x: x - 6,
        y: y - 6,
        width: 12,
        height: 12,
        rx: 2,
        class: "pad",
      }),
      svgEl("circle", { cx: x, cy: y, r: 3.2, class: "hole" }),
    );
    if (mini) return;
    const who = st.users?.length
      ? short(st.users.map((u) => u.who).join(", "), 8)
      : "";
    pad.append(
      svgEl("text", { x, y: y + 22, class: "pin-text pad-text" }, p.label),
      svgEl(
        "title",
        {},
        [`GPIO ${p.gpio} (pad)`, st.text].filter(Boolean).join(": "),
      ),
    );
    if (who)
      pad.append(
        svgEl("text", { x, y: y + 34, class: "pin-text pad-text" }, who),
      );
  });
  return svg;
}
// The card under Board: small drawing, board name, chip and memory.
function showBoardCard() {
  const b = selectedBoard();
  if (!b) return;
  const look = b.look || {};
  const card = document.querySelector(".chip-card");
  card.querySelector(".chip").replaceChildren(boardSvg(b, { mini: true }));
  $("chipName").textContent = look.name || b.label.replace(/^[^·]*·\s*/, "");
  $("chipFqbn").textContent = [look.chip || b.family.toUpperCase(), look.memory]
    .filter(Boolean)
    .join(" · ");
  $("chipSpec").textContent = "Pins ▸";
  card.title = `${b.fqbn}\nClick or right-click for the board drawing and pin map.`;
}
// The large drawing with the legend and the flow's pins.
function openBoardView() {
  const b = selectedBoard();
  if (!b) return;
  const look = b.look || {};
  const box = el("div", "board-view");
  const facts = [
    look.chip || b.family.toUpperCase(),
    look.module,
    look.memory,
    look.ports?.length > 1 ? `${look.ports.length} USB ports` : look.usb,
    ...(b.features || []).map(
      (f) =>
        ({
          wifi: "Wi-Fi",
          bluetooth: "Bluetooth",
          display: "LCD",
          stillcam: "camera",
          espnow: "ESP-NOW",
          localbroker: "own MQTT broker",
          webserver: "web server",
          i2sout: "I2S audio out",
          speech: "speech recognition",
        })[f] || f,
    ),
  ].filter(Boolean);
  box.append(el("p", "board-facts", [...new Set(facts)].join(" · ")));
  box.append(el("p", "muted", b.fqbn));
  const drawing = el("div", "board-drawing");
  drawing.append(boardSvg(b));
  box.append(drawing);
  const legend = el("div", "board-legend");
  for (const [cls, text] of [
    ["in", "input in this flow"],
    ["out", "output in this flow"],
    ["clash", "input and output (clash)"],
    ["free", "free GPIO"],
    ["reserved", "used by the board"],
    ["power", "power / not offered"],
    ["free strap", "boot pin (careful)"],
  ]) {
    const item = el("span", `legend-item ${cls}`);
    item.append(el("i"), document.createTextNode(text));
    legend.append(item);
  }
  box.append(legend);
  const tagLegend = el("div", "board-legend tags");
  for (const [t, text] of [
    ["PWM", "PWM output (analogWrite / ledc)"],
    ["ADC", "analog input"],
    ["SDA", "default I2C data"],
    ["SCL", "default I2C clock"],
    ["SCK", "default SPI (SCK / MISO / MOSI / SS)"],
  ]) {
    const item = el("span", "legend-item");
    item.append(
      el("b", `tag-chip ${t.toLowerCase()}`, t),
      document.createTextNode(" " + text),
    );
    tagLegend.append(item);
  }
  box.append(tagLegend);
  // Which USB socket is for what (boards with two: the UART one uploads).
  const ports = usbPorts(look);
  if (ports.length > 1) {
    const list = el("div", "usb-ports");
    list.append(el("b", "", "USB ports (left to right, USB at the bottom):"));
    for (const port of ports) {
      const row = el("div", `usb-port ${port.kind}`);
      row.append(
        el("strong", "", port.label),
        document.createTextNode(` · ${port.use} — ${port.via}`),
      );
      if (port.rec) row.append(el("span", "usb-rec-badge", "★ program here"));
      list.append(row);
    }
    list.append(
      el(
        "p",
        "muted",
        "Microflow uploads and reads the serial monitor through the UART port (its COM port, or Web Serial). The firmware prints to that port, so the native USB port shows no serial output. Check the labels printed beside the sockets on your board.",
      ),
    );
    box.append(list);
  }
  box.append(
    el(
      "p",
      "muted",
      look.layout === "physical"
        ? `Pins in header order, USB socket at the ${look.usbAt === "top" ? "top" : "bottom"}. ${look.note || ""} Hover a pin for details.`
        : "Schematic: the board's GPIOs in number order, not their places on the headers. Check the labels printed on your board. Hover a pin for details.",
    ),
  );
  const reserved = boardReserved(b);
  if (reserved.size)
    box.append(
      el(
        "p",
        "muted",
        `Used by the board (not offered): ${[...reserved]
          .sort((x, y) => x[0] - y[0])
          .map(([pin, what]) => `GPIO ${pin} ${what}`)
          .join(", ")}.`,
      ),
    );
  const used = [...flowPinUse()].sort((x, y) => x[0] - y[0]);
  box.append(
    el(
      "p",
      "",
      used.length
        ? `This flow uses: ${used
            .map(
              ([pin, list]) =>
                `GPIO ${pin} (${list.map((u) => `${u.role} for ${u.who}`).join("; ")})`,
            )
            .join(", ")}.`
        : "This flow uses no GPIO pins yet.",
    ),
  );
  modal(`Board · ${look.name || b.label}`, box);
}
for (const target of [document.querySelector(".chip-card"), $("board")]) {
  target.addEventListener("contextmenu", (event) => {
    if (event.shiftKey) return; // Shift: the browser's own menu
    event.preventDefault();
    openBoardView();
  });
}
document.querySelector(".chip-card").addEventListener("click", openBoardView);
if (boards.length) showBoardCard(); // app.js calls it on each board change
