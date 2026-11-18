// ── Upload from the browser: the board on this computer's USB ─────────────
// The server compiles; the browser writes the firmware to the chip over Web Serial
// with Espressif's esptool-js (public/vendor/esptool-js-0.6.1.js, Apache-2.0). So a
// visitor (guest or logged in) uploads to the board on their own desk, not the
// server's. Needs Chrome or Edge on https or localhost. ESP8266 and ESP32 boards;
// Realtek (BW16) boards use Realtek's own tool. After flashing, the console opens on
// the same port, so the board's first messages show.
const ESPTOOL_URL = "./vendor/esptool-js-0.6.1.js";
const FLASH_BAUDS = [460800, 115200]; // fast first; slower if the USB bridge fails

const webFlashSupported = () => window.isSecureContext && !!navigator.serial;

// The chip esptool reports (CHIP_NAME) for the selected board, from its FQBN.
function flashChipName(boardId) {
  const b = boards.find((x) => x.id === boardId);
  if (!b) return null;
  if (b.family === "esp8266") return "ESP8266";
  if (b.family !== "esp32") return null;
  const m = String(b.fqbn).split(":")[2] || "";
  const names = {
    esp32s2: "ESP32-S2",
    esp32s3: "ESP32-S3",
    esp32c2: "ESP32-C2",
    esp32c3: "ESP32-C3",
    esp32c5: "ESP32-C5",
    esp32c6: "ESP32-C6",
    esp32h2: "ESP32-H2",
    esp32p4: "ESP32-P4",
  };
  return names[m] || "ESP32";
}

// The board's port: the one the console already uses (closed for flashing), else
// the browser's port list. Call it first in a click: the list needs the click.
async function pickFlashPort() {
  if (!webFlashSupported())
    throw Error(
      "Uploading from the browser needs Chrome or Edge (Web Serial), on https:// or localhost.",
    );
  if (browserSerial.port) {
    const port = browserSerial.port;
    await browserSerial.disconnect();
    return port;
  }
  try {
    return await navigator.serial.requestPort();
  } catch (e) {
    if (e.name === "NotFoundError")
      throw Error(
        "No port chosen. Plug the board in with a data USB cable, click Upload again and pick its port (e.g. “USB-SERIAL CH340 (COM4)” or “CP2102 … (COM4)”). Nothing listed: install the board's USB driver (CH340 or CP210x).",
      );
    throw e;
  }
}

// Writes firmware ({ base64, address }) to the chip on port. onProgress(pct).
async function webFlash(port, firmware, { board, onProgress, onLine } = {}) {
  const { ESPLoader, Transport } = await import(ESPTOOL_URL);
  const data = Uint8Array.from(atob(firmware.base64), (c) => c.charCodeAt(0));
  const want = flashChipName(board);
  const line = (t) => {
    const s = String(t).trim();
    if (s) onLine?.(s);
  };
  let lastError;
  for (const baudrate of FLASH_BAUDS) {
    const transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate,
      terminal: { clean() {}, writeLine: line, write: line },
      debugLogging: false,
    });
    try {
      try {
        await loader.main();
      } catch (e) {
        throw Object.assign(
          Error(
            `The chip did not answer (${e.message}). Close other programs using the port (Arduino Serial Monitor, PuTTY, another tab). If it still fails: hold the BOOT (or FLASH) button, press and release RESET (EN), release BOOT, then upload again.`,
          ),
          { final: true },
        );
      }
      const got = loader.chip?.CHIP_NAME;
      if (want && got && got !== want)
        throw Object.assign(
          Error(
            `The board on this port is an ${got}, but the flow is for ${want} (${boards.find((b) => b.id === board)?.label || board}). Choose the matching board in the Device panel, then upload again.`,
          ),
          { final: true },
        );
      onProgress?.(0);
      await loader.writeFlash({
        fileArray: [{ data, address: firmware.address || 0 }],
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll: false,
        compress: true,
        reportProgress: (_i, written, total) =>
          onProgress?.(Math.round((written / total) * 100)),
      });
      await loader.after("hard_reset").catch(() => {});
      return { chip: got, baudrate };
    } catch (e) {
      lastError = e;
      if (e.final) throw e;
      line(`Upload at ${baudrate} baud failed: ${e.message}`);
    } finally {
      await transport.disconnect().catch(() => {});
    }
  }
  throw Error(
    `Upload failed: ${lastError?.message || "unknown error"}. Try another USB cable or port, and close other programs using the port.`,
  );
}

// Compile on the server, then flash the board on this computer's USB. The port is
// chosen first (the browser allows its list only right after a click). stage(text)
// reports the step, progress(pct) the flashing. Returns the compile result.
async function uploadInBrowser({ flow, settings, stage, progress }) {
  const board = settings.board;
  if (!flashChipName(board))
    throw Error(
      "This board is flashed with its maker's own tool (Realtek): use ✓ Compile, download the firmware and flash it with Realtek's image tool.",
    );
  const port = await pickFlashPort();
  const note = (message) =>
    log({ kind: "serial", message, time: new Date().toISOString() });
  try {
    stage?.("Compiling on the server…");
    const r = await api("compile", { flow, settings, download: true });
    if (!r.firmware) throw Error("The server returned no firmware image to upload.");
    stage?.("Uploading to the board…");
    note(`Browser upload: build ${r.build} (${Math.round(r.firmware.base64.length * 0.75 / 1024)} KB) to the board on USB`);
    const done = await webFlash(port, r.firmware, {
      board,
      onProgress: progress,
      onLine: note,
    });
    note(`Browser upload done: ${done.chip} at ${done.baudrate} baud. The board restarts.`);
    return { ...r, chip: done.chip };
  } finally {
    // Watch it start: the console on the same port (Web Serial).
    if (!browserSerial.port) {
      if ($("serialTransport").value !== "browser") {
        $("serialTransport").value = "browser";
        $("serialTransport").onchange?.();
      }
      await browserSerial
        .connect(Number($("baudRate").value) || 115200, port)
        .catch((e) => note(`Console not reopened: ${e.message}. Click Connect serial.`));
    }
  }
}

// Runs uploadInBrowser inside a window: go = its button, progress = a bar
// (.ota-progress), result = where the outcome shows. For guests and logged-in users.
async function browserUploadInto({ go, progress, result }) {
  if (boards.find((b) => b.id === settings().board)?.family === "rp2040")
    return picoUploadInto({ go, progress, result });
  showConsole("upload"); // the console follows the upload
  const text = go.textContent;
  const bar = (pct) => progress.style.setProperty("--pct", pct + "%");
  go.disabled = true;
  $("upload").disabled = true;
  progress.hidden = false;
  bar(0);
  result.replaceChildren();
  try {
    const r = await uploadInBrowser({
      flow: structuredClone(chipFlow()),
      settings: settings(),
      stage: (t) => (go.textContent = t),
      progress: (pct) => {
        bar(pct);
        go.textContent = `Uploading to the board… ${pct} %`;
      },
    });
    lastUploadedBuild = r.build;
    markUploaded(); // the board now runs this flow (runcheck.js)
    toast(`Firmware ${r.build} uploaded`);
    result.replaceChildren(
      el(
        "p",
        "result-head pass",
        `✓ Build ${r.build} uploaded to the ${r.chip}. The board restarted; its messages show in the console (Web Serial).`,
      ),
      sizeReport(r.size),
    );
  } catch (e) {
    result.replaceChildren(el("p", "result-head fail", "✗ " + e.message));
    throw e;
  } finally {
    go.disabled = false;
    $("upload").disabled = false;
    go.textContent = text;
  }
}

// ── Raspberry Pi Pico (UF2) ──
// A Pico is flashed by copying a .uf2 file onto the USB drive it shows in BOOTSEL mode
// (RPI-RP2 on a Pico, RP2350 on a Pico 2). Opening its serial port at 1200 baud and
// closing it restarts a Pico running Arduino firmware into that mode, so the steps
// are: compile, ① restart into the drive, ② save the file onto the drive. Each step
// is its own click (the browser allows its port list and save dialog only then).

// Restarts the Pico on a port into its USB drive (the 1200-baud "touch").
async function picoTouch() {
  let port;
  if (browserSerial.port) {
    port = browserSerial.port;
    await browserSerial.disconnect();
  } else port = await navigator.serial.requestPort();
  await port.open({ baudRate: 1200 });
  await port.setSignals?.({ dataTerminalReady: false }).catch(() => {});
  await port.close();
}

// Saves the UF2 onto the Pico's drive (Chrome / Edge save dialog), else downloads it.
async function picoSave(firmware) {
  const data = Uint8Array.from(atob(firmware.base64), (c) => c.charCodeAt(0));
  if (!window.showSaveFilePicker) {
    saveFirmware(firmware); // guest.js: a normal download
    return "downloaded";
  }
  const handle = await window.showSaveFilePicker({
    suggestedName: firmware.name,
    types: [{ description: "Pico firmware (UF2)", accept: { "application/octet-stream": [".uf2"] } }],
  });
  const out = await handle.createWritable();
  await out.write(data);
  // The Pico flashes as the blocks arrive and restarts after the last one, so the
  // drive can vanish before the browser finishes: an error here is expected.
  await out.close().catch(() => {});
  return "saved";
}

async function picoUploadInto({ go, progress, result }) {
  showConsole("upload");
  const text = go.textContent;
  go.disabled = true;
  $("upload").disabled = true;
  progress.hidden = true;
  result.replaceChildren();
  let r;
  try {
    go.textContent = "Compiling on the server…";
    r = await api("compile", { flow: structuredClone(chipFlow()), settings: settings(), download: true });
    if (!r.firmware) throw Error("The server returned no firmware file to upload.");
  } catch (e) {
    result.replaceChildren(el("p", "result-head fail", "✗ " + e.message));
    throw e;
  } finally {
    go.disabled = false;
    $("upload").disabled = false;
    go.textContent = text;
  }
  const touch = el("button", "", "① Restart the Pico as a USB drive");
  touch.title = "Pick the Pico's port (e.g. COM5) in the browser's list: it restarts as a drive named RPI-RP2 (Pico) or RP2350 (Pico 2).";
  touch.disabled = !webFlashSupported();
  touch.onclick = attempt(async () => {
    await picoTouch();
    toast("The Pico restarts as a USB drive (RPI-RP2 or RP2350). Now click ② and choose that drive.");
  });
  const save = el("button", "primary", "② Save the firmware onto the Pico drive");
  const done = el("div");
  save.onclick = attempt(async () => {
    const how = await picoSave(r.firmware);
    lastUploadedBuild = r.build;
    markUploaded();
    done.replaceChildren(
      el(
        "p",
        "result-head pass",
        how === "saved"
          ? `✓ Build ${r.build} copied onto the Pico. It restarts with the new program: click Connect serial (Web Serial) to see its messages.`
          : `Build ${r.build} downloaded (${r.firmware.name}): drag it onto the RPI-RP2 / RP2350 drive. The Pico restarts with the new program.`,
      ),
    );
  });
  const steps = el("div", "step-row");
  steps.append(touch, save);
  result.replaceChildren(
    el("p", "result-head pass", `✓ Build ${r.build} compiled. Copy it onto the Pico:`),
    sizeReport(r.size),
    el(
      "p",
      "",
      "① puts the Pico into its USB-drive mode (it must be running a Microflow or Arduino program). A new Pico, or one that does not react: hold BOOTSEL while plugging in the USB cable instead.",
    ),
    el(
      "p",
      "",
      "② opens a save window: choose the drive named RPI-RP2 (Pico) or RP2350 (Pico 2) and click Save. If the browser then reports an error, that is normal: the Pico restarted as soon as the file arrived.",
    ),
    steps,
    done,
  );
}
