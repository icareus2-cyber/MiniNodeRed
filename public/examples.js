// Examples tab (beside Node Library): board tests made for the selected board from
// its own pin list, and the shared example flows (examples/*.json).
// Board tests: Input test (ground a pin, the console shows it), Output test (a switch
// per pin over USB, measure with a voltmeter) and Analog test (the console shows the
// ADC value). Pins the USB serial port or the board itself uses are left out, and
// unless "boot and shared pins" is ticked, so are strapping pins (grounded at reset
// the board does not start), pins without a pull-up and pins shared with an LED or
// another part: on an ESP8266 that leaves D1, D2, D5, D6 and D7.
const BOARD_TEST_MAX = 32; // two nodes per pin, a flow has at most 64 nodes
let boardTestAll = false; // the "boot and shared pins" box
let boardTestOpen = null; // { test, nodes } while a board test is open unedited

// Why a pin is risky for a test ("" = safe).
function pinRisk(b, pin, use) {
  if (b.strapping?.[pin]) return `strapping pin: ${b.strapping[pin]}`;
  if (use === "in" && b.noPull.includes(pin)) return "no internal pull-up";
  return b.notes?.[pin] ? `shared with ${b.notes[pin]}` : "";
}

// The pins a test uses: { pins, left } (left = risky pins left out, with why).
function boardTestSet(b, use) {
  const all = boardTestPins(b, use);
  if (boardTestAll || use === "adc") return { pins: all, left: [] };
  const left = all
    .map((p) => ({ ...p, why: pinRisk(b, p.pin, use) }))
    .filter((p) => p.why);
  return { pins: all.filter((p) => !pinRisk(b, p.pin, use)), left };
}

// The board's usable pins for a test, with the name printed on the board.
function boardTestPins(b, use) {
  const silk = new Map();
  for (const entry of [...(b.look?.left || []), ...(b.look?.right || [])]) {
    const p = headerPin(entry);
    if (p.gpio !== null && !silk.has(p.gpio)) silk.set(p.gpio, p.label);
  }
  const reserved = boardReserved(b);
  const list = use === "adc" ? b.adc : b.gpio;
  return list
    .filter((pin) => !reserved.has(pin))
    .filter((pin) => !/UART|USB|flash|PSRAM/i.test(b.notes?.[pin] || ""))
    .filter((pin) => use !== "out" || !b.inputOnly.includes(pin))
    .map((pin) => {
      const name = silk.get(pin);
      const gpio = b.family === "ameba" ? `D${pin}` : `GPIO ${pin}`;
      const printed = name && name !== String(pin) && name !== gpio;
      return { pin, name: printed ? `${name} (${gpio})` : gpio, short: printed ? name : gpio };
    });
}

// Pairs of nodes (source → sink) in two columns of pairs.
function testPairs(pins, make) {
  const nodes = [],
    edges = [];
  pins.forEach((p, i) => {
    const x = i % 2 ? 440 : 40,
      y = 40 + Math.floor(i / 2) * 80;
    const [from, to] = make(p, i);
    nodes.push({ ...from, x, y }, { ...to, x: x + 190, y });
    edges.push({ from: from.id, to: to.id });
  });
  return { nodes, edges };
}

const BOARD_TESTS = [
  {
    id: "input",
    title: "Input test · ground a pin",
    mode: "device",
    use: "in",
    how: "Upload over USB in Real board mode and open the console. Touch any pin to GND with a wire: the console prints the pin's name and 0, then 1 when you let go.",
    flow: (pins, b) =>
      testPairs(pins, (p, i) => [
        {
          id: `in${i}`,
          type: "gpio-watch",
          label: p.name,
          config: {
            pin: p.pin,
            // Pins without an internal pull-up float: they need a resistor to 3.3 V.
            pull: b.noPull.includes(p.pin) ? "none" : "pullup",
            debounce: 50,
            startup: "level",
          },
        },
        { id: `log${i}`, type: "debug", label: `${p.short} level`, config: { show: "payload" } },
      ]),
  },
  {
    id: "output",
    title: "Output test · switch a pin",
    mode: "emulate",
    use: "out",
    how: "Upload over USB in Real board + PC inputs mode, then press ▶ Start. Click a pin's switch ON or OFF on the screen and measure that pin against GND with a voltmeter: about 3.3 V when ON, 0 V when OFF.",
    flow: (pins) =>
      testPairs(pins, (p, i) => [
        { id: `sw${i}`, type: "test-switch", label: `${p.short} switch`, config: {} },
        { id: `out${i}`, type: "digital-write", label: p.name, config: { pin: p.pin } },
      ]),
  },
  {
    id: "analog",
    title: "Analog test · read the ADC",
    mode: "device",
    use: "adc",
    how: "Upload over USB in Real board mode and open the console. Connect an analog pin to a voltage between 0 and 3.3 V (a potentiometer, or GND and 3.3 V): the console prints its value every second.",
    flow: (pins) =>
      testPairs(pins, (p, i) => [
        {
          id: `adc${i}`,
          type: "analog-in",
          label: p.name,
          config: { pin: p.pin, interval: 1000, bits: "native" },
        },
        { id: `log${i}`, type: "debug", label: `${p.short} value`, config: { show: "payload" } },
      ]),
  },
];

// Opens a board test as a new, unsaved flow on the selected board. again: the board
// changed under an unedited board test, which is made again for the new board.
async function openBoardTest(test, again = false) {
  const b = selectedBoard();
  const { pins: all, left } = boardTestSet(b, test.use);
  if (!all.length)
    throw Error(`${shortBoard(b.id)} has no safe pins for this test: tick “Include boot and shared pins”.`);
  const pins = all.slice(0, BOARD_TEST_MAX);
  const made = {
    name: `${shortBoard(b.id)} · ${test.title}`,
    board: b.id,
    ...test.flow(pins, b),
  };
  const normalized = await api("validate", made);
  if (!again && dirty && !unchangedBoardTest() && !confirm("Replace current flow and discard unsaved changes?"))
    return;
  delete normalized.id;
  flow = normalized;
  currentTab = null;
  showFlowInUrl();
  $("flowName").value = flow.name;
  selected = null;
  selectedLink = null;
  pending = null;
  changed();
  boardTestOpen = { test, nodes: JSON.stringify(flow.nodes) };
  if (!again) await openedFlow();
  else render();
  // Input and analog tests print over USB serial; the output test needs PC inputs.
  if ($("runtimeMode").value !== test.mode) {
    $("runtimeMode").value = test.mode;
    $("runtimeMode").dispatchEvent(new Event("change"));
  }
  if ($("buildProfile").value === "release") {
    $("buildProfile").value = "debug";
    $("buildProfile").dispatchEvent(new Event("change"));
  }
  const skipped = left.length
    ? ` Left out: ${left.map((p) => p.short).join(", ")} (boot or shared pins).`
    : "";
  toast(
    again
      ? `${test.title} made again for ${shortBoard(b.id)}: ${pins.length} pins.${skipped}`
      : all.length > pins.length
        ? `${test.title}: the first ${pins.length} of ${all.length} pins (a flow holds ${BOARD_TEST_MAX}). ${test.how}`
        : `${test.how}${skipped}`,
  );
}
// A board test still as it was opened (same flow, nodes not edited).
const unchangedBoardTest = () =>
  !!boardTestOpen && JSON.stringify(flow.nodes) === boardTestOpen.nodes;

let testsBoard = null; // the board the list (and an open board test) was made for
function renderBoardTests() {
  const box = $("boardTests");
  const b = selectedBoard();
  if (!box || !b) return;
  // The board changed under an unedited board test: make it for the new board.
  if (testsBoard && testsBoard !== b.id && unchangedBoardTest())
    openBoardTest(boardTestOpen.test, true).catch((e) => toast(e.message));
  if (testsBoard !== b.id && $("exampleFlows")?.childElementCount)
    renderExampleFlows().catch((e) => toast(e.message));
  testsBoard = b.id;
  box.replaceChildren(el("div", "group-label", `TESTS · ${shortBoard(b.id).toUpperCase()}`));
  for (const test of BOARD_TESTS) {
    const { pins, left } = boardTestSet(b, test.use);
    const item = el("button", "example-item");
    item.disabled = !pins.length;
    item.title =
      test.how + (left.length ? `\nLeft out: ${left.map((p) => `${p.name} (${p.why})`).join("; ")}` : "");
    item.append(
      el("b", "", test.title),
      el(
        "span",
        "muted",
        pins.length
          ? `${pins.map((p) => p.short).join(", ")} · ${test.mode === "emulate" ? "Real board + PC inputs" : "Real board"}`
          : left.length
            ? "no safe pins: tick the box below"
            : "no usable pins on this board",
      ),
    );
    item.onclick = attempt(() => openBoardTest(test));
    box.append(item);
  }
  const all = el("label", "example-check");
  const tick = Object.assign(el("input"), { type: "checkbox", checked: boardTestAll });
  tick.onchange = () => {
    boardTestAll = tick.checked;
    boardTestOpen = null; // list again, without remaking an open test
    renderBoardTests();
  };
  all.title =
    "Strapping pins stop the board from starting if held at GND during reset; pins shared with an LED or a part, or without a pull-up, read or drive unexpectedly.";
  all.append(tick, " Include boot and shared pins");
  box.append(all);
}

async function renderExampleFlows() {
  const box = $("exampleFlows");
  const board = selectedBoard()?.id || "";
  const list = await api("examples?board=" + encodeURIComponent(board));
  box.replaceChildren(el("div", "group-label", `EXAMPLE FLOWS · ${shortBoard(board).toUpperCase()}`));
  // The ones that run on the selected board first; the others open on a board they fit.
  list.sort((a, b) => !!a.problem - !!b.problem);
  for (const e of list) {
    const item = el("button", `example-item${e.problem ? " other-board" : ""}`);
    item.title = e.problem ? `${e.problem}\n\n${e.description}` : e.description;
    item.append(
      el("b", "", e.title),
      el(
        "span",
        "muted",
        e.problem
          ? "not for this board: opens on one it fits"
          : e.tests
            ? `${e.tests} test${e.tests > 1 ? "s" : ""}`
            : "example",
      ),
    );
    item.onclick = attempt(async () => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      dirty = false;
      const saved = await api("examples/" + encodeURIComponent(e.name), {});
      await loadFlow(saved.id);
      toast(`Added "${e.title}" to Saved flows.`);
    });
    box.append(item);
  }
}

// The two tabs at the top of the left column.
function showPaletteTab(name) {
  for (const t of document.querySelectorAll(".palette-tab"))
    t.setAttribute("aria-selected", String(t.dataset.tab === name));
  $("libraryPane").hidden = name !== "library";
  $("examplesPane").hidden = name !== "examples";
  if (name === "examples") {
    renderBoardTests();
    if (!$("exampleFlows").childElementCount)
      renderExampleFlows().catch((e) => toast(e.message));
  }
}
for (const t of document.querySelectorAll(".palette-tab"))
  t.onclick = () => showPaletteTab(t.dataset.tab);
$("board").addEventListener("change", renderBoardTests);
