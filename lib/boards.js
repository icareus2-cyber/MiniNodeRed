// Board registry: FQBN, chip family and pin rules used for validation and codegen.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Realtek RTL8720DN (Ai-Thinker BW16 module): dual-band WiFi (2.4 + 5 GHz), Realtek's
// Arduino core "realtek:AmebaD" (installed by Microflow on first use). Pins are the
// core's Arduino numbers D0–D12 (printed on the BW16 boards), not chip GPIO names.
// D0/D1 are the USB serial (log UART); one analog input (A2 = D6); I2C fixed on
// D8 (SDA) / D7 (SCL). Type-C boards upload by themselves; others need Burn + RST.
const BW16 = {
  family: "ameba",
  gpio: range(0, 12),
  inputOnly: [],
  noPull: [],
  adc: [6],
  pwm: [3, 7, 8, 11, 12],
  strapping: {},
  notes: {
    0: "USB serial TX (log UART)",
    1: "USB serial RX (log UART)",
    2: "SWD data (debugger)",
    6: "SWD clock (debugger)",
    10: "the green LED",
    11: "the blue LED",
    12: "the red LED",
  },
  bluetooth: false, // BLE exists on the chip, but Microflow's BLE nodes use the ESP32 API
};
// Raspberry Pi Pico / Pico W (RP2040) and Pico 2 / Pico 2 W (RP2350), on Earle
// Philhower's Arduino core "rp2040:rp2040" (lib/picofw.js maps the ESP calls).
// Header pins GP0–GP22 and GP26–GP28 (ADC0–2); GP23–25 and GP29 are on the board
// (power, LED, and on the W boards the WiFi chip). Every GPIO has PWM and pull-ups.
// Serial is the chip's own USB, so the baud rate does not matter; uploads reset the
// board into its USB drive (BOOTSEL) and copy the firmware. Updates over USB only.
const PICO = {
  family: "rp2040",
  usbSerial: true,
  gpio: [...range(0, 22), 26, 27, 28],
  inputOnly: [],
  noPull: [],
  adc: [26, 27, 28],
  pwm: [...range(0, 22), 26, 27, 28],
  strapping: {},
  notes: {},
  bluetooth: false, // Microflow's BLE nodes use the ESP32 API
};
const boards = {
  esp8266: {
    label: "ESP8266 · NodeMCU",
    fqbn: "esp8266:esp8266:nodemcuv2",
    family: "esp8266",
    gpio: [...range(0, 5), ...range(12, 16)],
    inputOnly: [],
    adc: [17],
    pwm: [...range(0, 5), ...range(12, 16)],
    strapping: {
      0: "boot mode",
      2: "boot mode",
      15: "boot mode (must be LOW)",
    },
    notes: { 1: "UART TX", 3: "UART RX", 16: "no interrupt/pull-up" },
    noPull: [16],
  },
  d1mini: {
    label: "ESP8266 · Wemos D1 mini",
    fqbn: "esp8266:esp8266:d1_mini",
    family: "esp8266",
    gpio: [...range(0, 5), ...range(12, 16)],
    inputOnly: [],
    adc: [17],
    pwm: [...range(0, 5), ...range(12, 16)],
    strapping: {
      0: "boot mode",
      2: "boot mode",
      15: "boot mode (must be LOW)",
    },
    notes: { 1: "UART TX", 3: "UART RX", 16: "no interrupt/pull-up" },
    noPull: [16],
  },
  esp01: {
    label: "ESP8266 · ESP-01 (1 MB)",
    fqbn: "esp8266:esp8266:generic",
    family: "esp8266",
    gpio: [0, 1, 2, 3],
    inputOnly: [],
    adc: [],
    pwm: [0, 1, 2, 3],
    strapping: { 0: "boot mode", 2: "boot mode" },
    notes: { 1: "UART TX (serial log lost)", 3: "UART RX" },
  },
  esp32: {
    label: "ESP32 · Dev Module (30-pin)",
    fqbn: "esp32:esp32:esp32",
    family: "esp32",
    gpio: [
      ...range(0, 5),
      ...range(12, 19),
      21,
      22,
      23,
      25,
      26,
      27,
      ...range(32, 39),
    ],
    inputOnly: range(34, 39),
    noPull: range(34, 39), // no internal pull-up/down
    // ADC2 is unavailable while WiFi is running, so only ADC1 is offered.
    adc: range(32, 39),
    pwm: [...range(0, 5), ...range(12, 19), 21, 22, 23, 25, 26, 27, 32, 33],
    strapping: {
      0: "boot mode",
      2: "boot mode",
      5: "boot timing",
      12: "flash voltage",
      15: "boot log",
    },
    notes: { 1: "UART TX", 3: "UART RX" },
  },
  // ESP32 DevKitC (38 pins): same chip and pin rules as the 30-pin board above,
  // filled in below; only the header differs.
  "esp32-38": null,
  // LILYGO TTGO T-Display: ESP32 + 1.14" ST7789V IPS LCD (240×135) on SPI.
  // Pins per LILYGO's wiki; the display pins are reserved for the screen.
  "ttgo-t-display": {
    label: "ESP32 · LILYGO TTGO T-Display (1.14″ LCD)",
    fqbn: "esp32:esp32:esp32",
    family: "esp32",
    gpio: [
      0, 2, 12, 13, 15, 17, 21, 22, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39,
    ],
    inputOnly: range(34, 39),
    noPull: range(34, 39), // no internal pull-up/down
    adc: range(32, 39),
    pwm: [2, 12, 13, 15, 17, 21, 22, 25, 26, 27, 32, 33],
    strapping: {
      0: "boot mode",
      2: "boot mode",
      12: "flash voltage",
      15: "boot log",
    },
    notes: {
      0: "button 1 (also BOOT)",
      35: "button 2 (input-only, no internal pull-up)",
    },
    display: {
      driver: "st7789",
      width: 240,
      height: 135,
      pins: { mosi: 19, sclk: 18, cs: 5, dc: 16, rst: 23, backlight: 4 },
    },
  },
  // Heltec WiFi Kit 32 (V2 / V2.1): ESP32 + 0.96" SSD1306 OLED (128×64) on I2C
  // SDA 4, SCL 15, reset 16; Vext (GPIO 21, LOW = on) powers the screen. LED on 25,
  // PRG button on 0. Pins per Heltec's schematic and pins_arduino.h; the screen's pins
  // are not offered. Filled in below from the ESP32 Dev Module.
  "heltec-wifi-kit-32": null,
  // Heltec WiFi Kit 32 V3: ESP32-S3 (8 MB flash) + 0.96" SSD1306 OLED on I2C SDA 17,
  // SCL 18, reset 21; Vext (GPIO 36, LOW = on) powers the screen. LED on 35, PRG
  // button on 0, CP2102 USB-serial on UART0 (43/44).
  "heltec-wifi-kit-32-v3": {
    label: "ESP32-S3 · Heltec WiFi Kit 32 V3 (0.96″ OLED)",
    fqbn: "esp32:esp32:esp32s3",
    family: "esp32",
    gpio: [...range(0, 7), 19, 20, 26, 33, 34, 35, ...range(37, 42), ...range(45, 48)],
    inputOnly: [],
    noPull: [],
    adc: range(1, 7),
    pwm: [...range(0, 7), 19, 20, 26, 33, 34, 35, ...range(37, 42), ...range(45, 48)],
    strapping: { 0: "boot mode (PRG button)", 3: "JTAG select", 45: "flash voltage", 46: "boot mode" },
    notes: {
      0: "the PRG button",
      35: "the onboard LED (on when HIGH)",
      19: "USB D− (native USB)",
      20: "USB D+ (native USB)",
      17: "OLED SDA (not offered)",
      18: "OLED SCL (not offered)",
      21: "OLED reset (not offered)",
      36: "Vext, the screen's power switch (not offered)",
    },
    display: {
      driver: "ssd1306",
      width: 128,
      height: 64,
      pins: { sda: 17, scl: 18, rst: 21, vext: 36 },
    },
  },
  // Wemos Lolin32 OLED (and the many "ESP32 + 0.96″ OLED" copies): SSD1306 OLED on
  // I2C SDA 5, SCL 4, no reset line. Filled in below from the ESP32 Dev Module.
  "lolin32-oled": null,
  // AI-Thinker ESP32-CAM: OV2640 camera (pins below are taken by it), 4 MB PSRAM,
  // flash LED on GPIO 4. ADC2 pins only, which do not work while WiFi runs.
  esp32cam: {
    label: "ESP32 · AI-Thinker ESP32-CAM (camera)",
    fqbn: "esp32:esp32:esp32cam",
    family: "esp32",
    gpio: [2, 4, 12, 13, 14, 15],
    inputOnly: [],
    noPull: [],
    adc: [],
    pwm: [2, 4, 12, 13, 14, 15],
    strapping: { 2: "boot mode", 12: "flash voltage", 15: "boot log" },
    notes: {
      4: "the bright flash LED",
      2: "SD card",
      14: "SD card",
      15: "SD card",
    },
    camera: {
      pwdn: 32,
      reset: -1,
      xclk: 0,
      sda: 26,
      scl: 27,
      d7: 35,
      d6: 34,
      d5: 39,
      d4: 36,
      d3: 21,
      d2: 19,
      d1: 18,
      d0: 5,
      vsync: 25,
      href: 23,
      pclk: 22,
    },
  },
  // Freenove ESP32-S3 WROOM CAM (ESP32-S3, 8 MB octal PSRAM): OV2640 camera on the
  // ESP32-S3-EYE pins below. Not offered: camera pins, PSRAM (35–37), USB (19, 20)
  // and the serial port (43, 44).
  "freenove-s3cam": {
    label: "ESP32-S3 · Freenove ESP32-S3 WROOM CAM (camera)",
    stillCamera: true, // Camera node: still pictures in its 8 MB PSRAM
    fqbn: "esp32:esp32:esp32s3:PSRAM=opi",
    family: "esp32",
    gpio: [0, 1, 2, 3, 14, 21, 38, 39, 40, 41, 42, 45, 46, 47, 48],
    inputOnly: [],
    noPull: [],
    adc: [1, 2, 3], // ADC1 pins the camera leaves free
    pwm: [0, 1, 2, 3, 14, 21, 38, 39, 40, 41, 42, 45, 46, 47, 48],
    strapping: {
      0: "boot mode (BOOT button)",
      3: "JTAG select",
      45: "flash voltage",
      46: "boot mode",
    },
    notes: {
      2: "the onboard LED",
      48: "the onboard RGB LED (WS2812)",
      19: "USB D+ (not offered)",
      20: "USB D- (not offered)",
      35: "PSRAM (not offered)",
      36: "PSRAM (not offered)",
      37: "PSRAM (not offered)",
      43: "serial TX (not offered)",
      44: "serial RX (not offered)",
      38: "SD card",
      39: "SD card",
      40: "SD card",
    },
    camera: {
      pwdn: -1,
      reset: -1,
      xclk: 15,
      sda: 4,
      scl: 5,
      d7: 16,
      d6: 17,
      d5: 18,
      d4: 12,
      d3: 10,
      d2: 8,
      d1: 9,
      d0: 11,
      vsync: 6,
      href: 7,
      pclk: 13,
    },
  },
  // ESP32-C3 SuperMini (16 pins, USB-C at the top), the most common ESP32-C3 board.
  // Its USB-C socket is the chip's own USB (GPIO 18/19), so Serial goes there (USB CDC
  // on boot). Not offered: USB (18, 19) and flash (11–17).
  esp32c3: {
    label: "ESP32-C3 · SuperMini (16 pins)",
    fqbn: "esp32:esp32:esp32c3:CDCOnBoot=cdc",
    family: "esp32",
    usbSerial: true,
    gpio: [...range(0, 10), 20, 21],
    inputOnly: [],
    noPull: [],
    adc: range(0, 4),
    pwm: [...range(0, 10), 20, 21],
    strapping: { 2: "boot mode", 8: "boot mode", 9: "boot mode (BOOT button)" },
    notes: {
      8: "the onboard blue LED (on when LOW)",
      9: "the BOOT button",
      20: "UART RX",
      21: "UART TX",
    },
  },
  // "MINI ESP32C3 Development Board" (ESP32-C3-MINI-1, 4 MB flash, 2 × 15 pins, dual
  // Type-C): one Type-C goes through a USB-serial chip (sold as CH343P; the photo shows
  // a CH340K) to UART0 (TX 21 / RX 20), the other is the chip's own USB (GPIO 18/19).
  // Serial uses UART0, so it comes out of the USB-serial socket, with auto-reset on
  // DTR/RTS (no CDC on boot). 18/19 are on the header and usable when the native USB
  // socket is not used. Not offered: 20/21 (UART0) and the module's flash pins.
  "esp32c3-dual": {
    label: "ESP32-C3 · Mini dev board (30 pins, dual Type-C)",
    fqbn: "esp32:esp32:esp32c3",
    family: "esp32",
    gpio: [...range(0, 10), 18, 19],
    inputOnly: [],
    noPull: [],
    adc: range(0, 4),
    pwm: [...range(0, 10), 18, 19],
    strapping: { 2: "boot mode", 8: "boot mode", 9: "boot mode (BOOT button)" },
    notes: {
      9: "the BOOT button",
      18: "USB D− of the native Type-C: as a GPIO, that socket stops working",
      19: "USB D+ of the native Type-C: as a GPIO, that socket stops working",
      20: "RX: UART0 to the USB-serial chip (not offered)",
      21: "TX: UART0 to the USB-serial chip (not offered)",
    },
  },
  // ESP32-C6 SuperMini (20 header pins, USB-C at the top): RISC-V, Wi-Fi 6, BLE 5.
  // Its USB-C socket is the chip's own USB, so Serial goes there (USB CDC on boot).
  // Not offered: USB (12, 13) and flash (24–30).
  "esp32c6-mini": {
    label: "ESP32-C6 · SuperMini (20 pins)",
    fqbn: "esp32:esp32:esp32c6:CDCOnBoot=cdc",
    family: "esp32",
    usbSerial: true,
    gpio: [...range(0, 9), ...range(14, 23)],
    inputOnly: [],
    noPull: [],
    adc: range(0, 6),
    pwm: [...range(0, 9), ...range(14, 23)],
    strapping: {
      4: "boot (JTAG select)",
      5: "boot",
      8: "boot mode",
      9: "boot mode (BOOT button)",
      15: "boot",
    },
    notes: {
      8: "the onboard RGB LED (WS2812)",
      9: "the BOOT button",
      15: "the onboard LED",
      16: "UART0 TX",
      17: "UART0 RX",
      22: "pad under the board",
      23: "pad under the board",
      21: "pad under the board",
      12: "USB D- (not offered)",
      13: "USB D+ (not offered)",
    },
  },
  // Waveshare ESP32-P4-WIFI6: ESP32-P4 (v3.x, 32 MB PSRAM, 32 MB flash) with an
  // ESP32-C6 for WiFi 6 / BLE 5 over SDIO (ESP-Hosted, GPIO 14–19 + reset 54: the
  // Arduino core's defaults). USB-C through a CH343 USB-serial chip (UART0). The
  // 32 MB partition keeps two 4.5 MB app slots, so remote update (OTA) works.
  // Header: 27 GPIOs on two 20-pin rows (Waveshare's pin definition).
  "esp32p4-wifi6": {
    label: "ESP32-P4 · Waveshare ESP32-P4-WIFI6 (C6 WiFi 6)",
    fqbn: "esp32:esp32:esp32p4:ChipVariant=postv3,PSRAM=enabled,FlashSize=32M,PartitionScheme=app5M_fat24M_32MB",
    family: "esp32",
    chip: "esp32p4",
    gpio: [2, 3, 4, 5, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 46, 47, 48, 49, 50, 51, 52],
    inputOnly: [],
    noPull: [],
    // ADC1 GPIO 20–23 and ADC2 GPIO 49–52 (WiFi is on the C6, so ADC2 stays free).
    adc: [20, 21, 22, 23, 49, 50, 51, 52],
    pwm: [2, 3, 4, 5, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 46, 47, 48, 49, 50, 51, 52],
    strapping: {},
    notes: {
      7: "I2C SDA (also the onboard ES8311 audio codec, address 0x18)",
      8: "I2C SCL (also the onboard ES8311 audio codec)",
      24: "USB D− of the 4-pin USB header",
      25: "USB D+ of the 4-pin USB header",
    },
    // ESP-NOW needs the radio on the chip itself (esp_now_* are not in the P4
    // libraries; compile-tested with arduino-esp32 3.3.11). BLE, Local MQTT, web
    // server, Speak and remote update compile and run through the C6.
    lacks: ["espnow"],
  },
  bw16: {
    ...BW16,
    label: "Realtek RTL8720DN · BW16 module (Type-C)",
    fqbn: "realtek:AmebaD:Ai-Thinker_BW16:AutoUploadMode=Enable",
  },
  "bw16-manual": {
    ...BW16,
    notes: {
      ...BW16.notes,
      4: "the onboard USB serial chip (micro-USB kit)",
      5: "the onboard USB serial chip (micro-USB kit)",
    },
    label: "Realtek RTL8720DN · BW16 module (Burn button)",
    fqbn: "realtek:AmebaD:Ai-Thinker_BW16:AutoUploadMode=Disable",
  },
  esp32s3: {
    label: "ESP32-S3 · Dev Module",
    fqbn: "esp32:esp32:esp32s3",
    family: "esp32",
    gpio: [...range(0, 21), ...range(33, 48)],
    inputOnly: [],
    adc: range(1, 10),
    pwm: [...range(0, 21), ...range(33, 48)],
    strapping: {
      0: "boot mode",
      3: "JTAG select",
      45: "flash voltage",
      46: "boot mode",
    },
    notes: {
      19: "USB D-",
      20: "USB D+",
      43: "UART TX",
      44: "UART RX",
      35: "PSRAM on octal boards",
      36: "PSRAM on octal boards",
      37: "PSRAM on octal boards",
    },
  },
  pico: { ...PICO, label: "Raspberry Pi Pico · RP2040", fqbn: "rp2040:rp2040:rpipico", wifi: false },
  picow: {
    ...PICO,
    label: "Raspberry Pi Pico W · RP2040 + WiFi",
    fqbn: "rp2040:rp2040:rpipicow",
    notes: {}, // the LED is on the WiFi chip (LED_BUILTIN), not a GPIO
  },
  pico2: { ...PICO, label: "Raspberry Pi Pico 2 · RP2350", fqbn: "rp2040:rp2040:rpipico2", wifi: false },
  pico2w: {
    ...PICO,
    label: "Raspberry Pi Pico 2 W · RP2350 + WiFi",
    fqbn: "rp2040:rp2040:rpipico2w",
    notes: {},
  },
};
// How each hardware node uses a pin: "in", "out", "pwm" or "adc".
function checkPin(boardId, pin, use, label) {
  const b = boards[boardId];
  const errors = [],
    warnings = [];
  // Realtek boards use the Arduino pin numbers printed on them (D0–D12).
  const where = `${label}: ${b.family === "ameba" ? "pin" : "GPIO"} ${pin}`;
  const screen = Object.entries(b.display?.pins || {}).find(
    ([, p]) => p === pin,
  );
  if (screen) {
    errors.push(
      `${where} is used by the built-in display (${screen[0].toUpperCase()}). Use a Display node to show values, or pick another pin.`,
    );
    return { errors, warnings };
  }
  if (use === "adc") {
    if (!b.adc.length)
      errors.push(`${label}: ${b.label} has no usable analog input.`);
    else if (!b.adc.includes(pin))
      errors.push(
        `${where} is not an analog input on ${b.label}. Use ${b.family === "esp8266" ? "A0 (enter 17)" : "GPIO " + b.adc.join(", ")}.`,
      );
    return { errors, warnings };
  }
  if (!b.gpio.includes(pin))
    errors.push(
      `${where} is not available on ${b.label} (flash, missing or reserved).`,
    );
  else if ((use === "out" || use === "pwm") && b.inputOnly.includes(pin))
    errors.push(`${where} is input-only on ${b.label}.`);
  else if (use === "pwm" && !b.pwm.includes(pin))
    errors.push(`${where} cannot output PWM on ${b.label}.`);
  if (b.strapping[pin])
    warnings.push(
      `${where} is a strapping pin (${b.strapping[pin]}); it can stop the board from booting.`,
    );
  if (b.notes[pin]) warnings.push(`${where} is shared with ${b.notes[pin]}.`);
  return { errors, warnings };
}
// Parses Arduino CLI output for ESP32 ("Sketch uses …") and ESP8266 (IROM/RAM table) builds.
function parseSize(output) {
  const size = {};
  let m = /Sketch uses (\d+) bytes .*?Maximum is (\d+)/.exec(output);
  if (m) size.flash = { used: +m[1], max: +m[2] };
  m = /Global variables use (\d+) bytes .*?Maximum is (\d+)/.exec(output);
  if (m) size.ram = { used: +m[1], max: +m[2] };
  m = /Code in flash.*?used (\d+) \/ (\d+) bytes/.exec(output);
  if (m && !size.flash) size.flash = { used: +m[1], max: +m[2] };
  m = /Variables and constants in RAM.*?used (\d+) \/ (\d+) bytes/.exec(output);
  if (m && !size.ram) size.ram = { used: +m[1], max: +m[2] };
  return size;
}
// Hardware that some node types need (node definition `needs`), and which boards have it.
const FEATURES = {
  display: {
    has: (b) => !!b.display,
    missing: (b) =>
      `${b.label} has no built-in display. Choose a board with one (LILYGO TTGO T-Display, Heltec WiFi Kit 32, Lolin32 OLED) or remove the Display nodes.`,
  },
  wifi: {
    has: (b) => b.wifi !== false,
    missing: (b) =>
      `${b.label} has no WiFi, so Radio in/out with MQTT cannot run on it. Use the I2C protocol, or GPIO, logic and Debug nodes, and test over USB serial.`,
  },
  // Web in / Web out: the board's web server (the ESP cores' WebServer library).
  webserver: {
    has: (b) => b.wifi !== false && b.family !== "ameba",
    missing: (b) =>
      b.wifi === false
        ? `${b.label} has no WiFi, so it cannot serve Web in / Web out. Choose a board with WiFi (e.g. ${b.family === "rp2040" ? "the W version of this Pico" : "an ESP32"}).`
        : `${b.label} cannot serve Web in / Web out: the board's web server uses the ESP32 / ESP8266 WebServer library. Use Radio in/out (MQTT) or a PWA node instead, or choose an ESP board.`,
  },
  espnow: {
    has: (b) => b.family === "esp32" && b.wifi !== false,
    missing: (b) =>
      `${b.label} cannot use ESP-NOW in Radio in/out here: it needs an ESP32 board with its own radio (ESP32, ESP32-S3, ESP32-C3). Use MQTT or I2C instead.`,
  },
  camera: {
    has: (b) => !!b.camera,
    missing: (b) =>
      `${b.label} has no camera. The Image sensor needs a camera board: choose AI-Thinker ESP32-CAM or Freenove ESP32-S3 WROOM CAM as the board.`,
  },
  localbroker: {
    has: (b) => b.family === "esp32" && b.wifi !== false,
    missing: (b) =>
      `${b.label} cannot run a local MQTT broker: Local MQTT in Radio in/out needs an ESP32 board (ESP32, ESP32-S3, ESP32-C3). Use MQTT with a broker elsewhere instead.`,
  },
  stillcam: {
    has: (b) => !!b.stillCamera,
    missing: (b) =>
      `${b.label} cannot take still pictures: the Camera node works on the Freenove ESP32-S3 WROOM CAM board only. Choose it as the board.`,
  },
  speech: {
    has: (b) => /:esp32s3\b/.test(b.fqbn),
    missing: (b) =>
      `${b.label} cannot run Voice command: offline speech recognition needs an ESP32-S3 board with 16 MB flash and PSRAM (e.g. ESP32-S3 N16R8). Choose an ESP32-S3 board.`,
  },
  i2sout: {
    has: (b) => b.family === "esp32",
    missing: (b) =>
      `${b.label} cannot run Speak: it needs an ESP32 board (I2S amplifier output).`,
  },
  bluetooth: {
    has: (b) => b.family === "esp32" && b.bluetooth !== false,
    missing: (b) =>
      `${b.label} has no Bluetooth. BLE in/out nodes need an ESP32 board (ESP32, ESP32-C3 or ESP32-S3).`,
  },
};
boards["esp32-38"] = {
  ...boards.esp32,
  label: "ESP32 · Dev Module (38-pin DevKitC)",
};
// ESP32 boards with a built-in OLED: the Dev Module's pins without the screen's.
const without = (list, taken) => list.filter((g) => !taken.includes(g));
const oledBoard = (label, taken, display, notes) => ({
  ...boards.esp32,
  label,
  gpio: without(boards.esp32.gpio, taken),
  adc: without(boards.esp32.adc, taken),
  pwm: without(boards.esp32.pwm, taken),
  strapping: Object.fromEntries(
    Object.entries(boards.esp32.strapping).filter(([g]) => !taken.includes(+g)),
  ),
  notes: { ...boards.esp32.notes, ...notes },
  display: { driver: "ssd1306", width: 128, height: 64, ...display },
});
boards["heltec-wifi-kit-32"] = oledBoard(
  "ESP32 · Heltec WiFi Kit 32 V2 (0.96″ OLED)",
  [4, 15, 16, 21],
  { pins: { sda: 4, scl: 15, rst: 16, vext: 21 } },
  {
    0: "the PRG button",
    25: "the onboard LED (on when HIGH)",
    4: "OLED SDA (not offered)",
    15: "OLED SCL (not offered)",
    16: "OLED reset (not offered)",
    21: "Vext, the screen's power switch (not offered)",
  },
);
boards["lolin32-oled"] = oledBoard(
  "ESP32 · Wemos Lolin32 OLED (0.96″ OLED)",
  [4, 5],
  { pins: { sda: 5, scl: 4, rst: -1, vext: -1 } },
  { 0: "the BOOT button", 4: "OLED SCL (not offered)", 5: "OLED SDA (not offered)" },
);
// A board can list features its family has but it does not (board.lacks).
for (const [name, f] of Object.entries(FEATURES)) {
  const has = f.has;
  f.has = (b) => !(b.lacks || []).includes(name) && has(b);
}
const features = (b) => Object.keys(FEATURES).filter((f) => FEATURES[f].has(b));
// Usual I2C pins per board (Radio in/out with I2C starts with these).
const I2C_PINS = {
  esp8266: { sda: 4, scl: 5 }, // D2, D1
  d1mini: { sda: 4, scl: 5 },
  esp01: { sda: 0, scl: 2 },
  esp32: { sda: 21, scl: 22 },
  "esp32-38": { sda: 21, scl: 22 },
  "ttgo-t-display": { sda: 21, scl: 22 },
  // Boards with a built-in OLED: the bus the screen is on (other I2C parts can share it).
  "heltec-wifi-kit-32": { sda: 4, scl: 15 },
  "heltec-wifi-kit-32-v3": { sda: 17, scl: 18 },
  "lolin32-oled": { sda: 5, scl: 4 },
  esp32c3: { sda: 8, scl: 9 },
  "esp32c3-dual": { sda: 8, scl: 9 },
  "esp32c6-mini": { sda: 20, scl: 19 },
  esp32s3: { sda: 8, scl: 9 },
  esp32cam: { sda: 13, scl: 14 },
  "freenove-s3cam": { sda: 41, scl: 42 },
  bw16: { sda: 8, scl: 7 },
  "bw16-manual": { sda: 8, scl: 7 },
  "esp32p4-wifi6": { sda: 7, scl: 8 },
  pico: { sda: 4, scl: 5 },
  picow: { sda: 4, scl: 5 },
  pico2: { sda: 4, scl: 5 },
  pico2w: { sda: 4, scl: 5 },
};
// What each board looks like, for the board drawing and pin map in the IDE
// (public/boardview.js). Header pins top to bottom with the USB socket at the
// bottom, as "LABEL:gpio" (a GPIO), "LABEL" (power or not offered) or a GPIO
// number. layout "physical": the real header order; "schematic": the board's
// GPIOs in number order (check the labels printed on the board).
const LOOKS = {
  esp8266: {
    name: "NodeMCU v2 (ESP-12E)",
    fullLength: true,
    chip: "ESP8266",
    module: "ESP-12E",
    memory: "4 MB flash",
    usb: "micro-USB",
    buttons: ["RST", "FLASH"],
    size: [26, 49],
    layout: "physical",
    left: [
      "A0:17",
      "RSV",
      "RSV",
      "SD3",
      "SD2",
      "SD1",
      "CMD",
      "SD0",
      "CLK",
      "GND",
      "3V3",
      "EN",
      "RST",
      "GND",
      "VIN",
    ],
    right: [
      "D0:16",
      "D1:5",
      "D2:4",
      "D3:0",
      "D4:2",
      "3V3",
      "GND",
      "D5:14",
      "D6:12",
      "D7:13",
      "D8:15",
      "RX:3",
      "TX:1",
      "GND",
      "3V3",
    ],
  },
  d1mini: {
    name: "Wemos D1 mini",
    chip: "ESP8266",
    memory: "4 MB flash",
    usb: "micro-USB",
    buttons: ["RST"],
    size: [26, 35],
    layout: "physical",
    left: ["RST", "A0:17", "D0:16", "D5:14", "D6:12", "D7:13", "D8:15", "3V3"],
    right: ["TX:1", "RX:3", "D1:5", "D2:4", "D3:0", "D4:2", "GND", "5V"],
  },
  esp01: {
    name: "ESP-01",
    chip: "ESP8266",
    memory: "1 MB flash",
    usb: "",
    buttons: [],
    size: [15, 25],
    layout: "physical",
    left: ["GND", "IO2:2", "IO0:0", "RX:3"],
    right: ["TX:1", "EN", "RST", "3V3"],
  },
  esp32: {
    name: "ESP32 DevKit (30-pin)",
    fullLength: true,
    chip: "ESP32",
    module: "ESP32-WROOM-32",
    memory: "4 MB flash",
    usb: "micro-USB",
    buttons: ["EN", "BOOT:0"],
    size: [28, 52],
    layout: "physical",
    note: "30-pin DevKit V1 order. For the 38-pin board choose ESP32 · Dev Module (38-pin DevKitC).",
    left: [
      "EN",
      "VP:36",
      "VN:39",
      "D34:34",
      "D35:35",
      "D32:32",
      "D33:33",
      "D25:25",
      "D26:26",
      "D27:27",
      "D14:14",
      "D12:12",
      "D13:13",
      "GND",
      "VIN",
    ],
    right: [
      "D23:23",
      "D22:22",
      "TX0:1",
      "RX0:3",
      "D21:21",
      "D19:19",
      "D18:18",
      "D5:5",
      "TX2:17",
      "RX2:16",
      "D4:4",
      "D2:2",
      "D15:15",
      "GND",
      "3V3",
    ],
  },
  "esp32-38": {
    name: "ESP32 DevKitC (38-pin)",
    fullLength: true,
    chip: "ESP32",
    module: "ESP32-WROOM-32",
    memory: "4 MB flash",
    usb: "micro-USB",
    buttons: ["EN", "BOOT:0"],
    size: [28, 55],
    layout: "physical",
    note: "Espressif ESP32-DevKitC order; SD0–SD3, CMD and CLK are the flash pins (do not use).",
    left: [
      "3V3",
      "EN",
      "VP:36",
      "VN:39",
      "34:34",
      "35:35",
      "32:32",
      "33:33",
      "25:25",
      "26:26",
      "27:27",
      "14:14",
      "12:12",
      "GND",
      "13:13",
      "SD2",
      "SD3",
      "CMD",
      "5V",
    ],
    right: [
      "GND",
      "23:23",
      "22:22",
      "TX:1",
      "RX:3",
      "21:21",
      "GND",
      "19:19",
      "18:18",
      "5:5",
      "17:17",
      "16:16",
      "4:4",
      "0:0",
      "2:2",
      "15:15",
      "SD1",
      "SD0",
      "CLK",
    ],
  },
  // Per LILYGO's pinmap (TTGO T-Display V1.1): screen in the middle, the GPIO0 and
  // GPIO35 buttons beside the USB-C socket, RST on the right-hand edge.
  "ttgo-t-display": {
    name: "LILYGO TTGO T-Display",
    chip: "ESP32",
    module: "ESP32-D0WDQ6",
    memory: "4 MB flash",
    usb: "USB-C",
    brand: "TTGO",
    lcd: "1.14″ LCD",
    buttons: ["BTN:0", "BTN:35"],
    edgeButton: "RST@right",
    size: [25, 51],
    layout: "physical",
    note: "LILYGO's pin order (T-Display V1.1, screen facing you). The 1.14″ ST7789V screen uses GPIO 4, 5, 16, 18, 19 and 23 behind the board.",
    left: [
      "GND",
      "GND",
      "21:21",
      "22:22",
      "17:17",
      "2:2",
      "15:15",
      "13:13",
      "12:12",
      "GND",
      "GND",
      "3V3",
    ],
    right: [
      "3V3",
      "SVP:36",
      "37:37",
      "38:38",
      "SVN:39",
      "32:32",
      "33:33",
      "25:25",
      "26:26",
      "27:27",
      "GND",
      "5V",
    ],
  },
  esp32cam: {
    name: "AI-Thinker ESP32-CAM",
    chip: "ESP32",
    module: "ESP32-S",
    memory: "4 MB flash · 4 MB PSRAM",
    usb: "",
    buttons: ["RST"],
    camera: true,
    flash: true,
    size: [27, 40],
    layout: "physical",
    note: "Pin order as printed beside the headers; there is no USB socket (use a USB-serial adapter or the ESP32-CAM-MB base).",
    left: [
      "5V",
      "GND",
      "IO12:12",
      "IO13:13",
      "IO15:15",
      "IO14:14",
      "IO2:2",
      "IO4:4",
    ],
    right: ["3V3", "IO16", "IO0:0", "GND", "VCC", "U0R:3", "U0T:1", "GND"],
  },
  // Per Freenove's pinout drawing (ESP32S3_Pinout): the camera socket is on the
  // board, the two USB-C sockets at the bottom.
  "freenove-s3cam": {
    name: "Freenove ESP32-S3 WROOM CAM",
    fullLength: true,
    chip: "ESP32-S3",
    module: "ESP32-S3-WROOM-1",
    memory: "8 or 16 MB flash · 8 MB PSRAM (N8R8 / N16R8)",
    usb: "USB-C ×2",
    ports: [
      {
        label: "UART",
        via: "USB-to-UART bridge (CH343)",
        use: "upload · serial monitor · Web Serial",
        short: "upload · serial · Web Serial",
      },
      {
        label: "USB",
        via: "ESP32-S3 native USB on GPIO 19/20",
        use: "USB OTG · JTAG debugging",
        short: "USB OTG · JTAG",
      },
    ],
    buttons: ["RST", "BOOT:0"],
    camera: true,
    size: [28, 64],
    layout: "physical",
    note: "Freenove's pin order; the numbers are the GPIOs printed beside the pins.",
    left: [
      "3V3",
      "RST",
      "4:4",
      "5:5",
      "6:6",
      "7:7",
      "15:15",
      "16:16",
      "17:17",
      "18:18",
      "8:8",
      "3:3",
      "46:46",
      "9:9",
      "10:10",
      "11:11",
      "12:12",
      "13:13",
      "14:14",
      "5V",
    ],
    right: [
      "TX:43",
      "RX:44",
      "1:1",
      "2:2",
      "42:42",
      "41:41",
      "40:40",
      "39:39",
      "38:38",
      "37:37",
      "36:36",
      "35:35",
      "0:0",
      "45:45",
      "48:48",
      "47:47",
      "21:21",
      "20:20",
      "19:19",
      "GND",
    ],
  },
  // ESP32-C3 SuperMini, drawn as the seller's pin diagram shows it: from the back,
  // where the pin numbers are printed, USB-C at the top.
  esp32c3: {
    name: "ESP32-C3 SuperMini",
    chip: "ESP32-C3",
    module: "",
    memory: "4 MB flash",
    usb: "USB-C",
    usbAt: "top",
    backView: "ESP32 C3",
    ports: [
      {
        label: "USB-C",
        via: "ESP32-C3 native USB (USB-Serial-JTAG on GPIO 18/19)",
        use: "upload · serial monitor · Web Serial",
        short: "upload · serial · Web Serial",
        kind: "uart",
      },
    ],
    buttons: [],
    size: [18, 23],
    layout: "physical",
    note: "Seen from the back, where the numbers are printed (as in the seller's pin diagram). From the chip side, left and right swap. BOOT (GPIO 9) and RST are on the chip side.",
    left: ["5V", "GND", "3V3", "4:4", "3:3", "2:2", "1:1", "0:0"],
    right: ["5:5", "6:6", "7:7", "8:8", "9:9", "10:10", "RX:20", "TX:21"],
  },
  // MINI ESP32C3 dual Type-C board, as printed on it: module at the top, the two Type-C
  // sockets at the bottom (the one beside the USB-serial chip is UART0).
  "esp32c3-dual": {
    name: "ESP32-C3 Mini dev board (dual Type-C)",
    chip: "ESP32-C3",
    module: "ESP32-C3-MINI-1",
    memory: "4 MB flash",
    usb: "USB-C ×2",
    ports: [
      {
        label: "USB",
        via: "ESP32-C3 native USB (USB-Serial-JTAG on GPIO 18/19)",
        use: "upload · JTAG (the flow's Serial is not here)",
        short: "upload · JTAG",
        kind: "uart",
      },
      {
        label: "UART",
        via: "USB-to-UART bridge (CH343P / CH340K) on UART0",
        use: "upload · serial monitor · Web Serial",
        short: "upload · serial · Web Serial",
      },
    ],
    buttons: ["RST", "BOOT:9"],
    size: [26, 40],
    layout: "physical",
    note: "Pin order as printed on the board, module at the top. The Type-C beside the USB-serial chip carries Serial (115200); the other one is the chip's own USB. R is the reset (EN) pin. The RGB LED's GPIO is not printed on the board.",
    left: ["GND", "3V3", "3V3", "2:2", "3:3", "GND", "EN", "GND", "0:0", "1:1", "10:10", "GND", "5V out", "5V in", "GND"],
    right: ["GND", "TX:21", "RX:20", "GND", "9:9", "8:8", "GND", "7:7", "6:6", "5:5", "4:4", "GND", "18:18", "19:19", "GND"],
  },
  // Per the MakerGO ESP32-C6 SuperMini pinout: USB-C at the top, 10 pins a side,
  // five more pads (23, 22, 12, 13, 21) on the bottom edge.
  "esp32c6-mini": {
    name: "ESP32-C6 SuperMini",
    chip: "ESP32-C6",
    module: "",
    memory: "4 MB flash",
    usb: "USB-C",
    usbAt: "top",
    ports: [
      {
        label: "USB-C",
        via: "ESP32-C6 native USB (USB-Serial-JTAG on GPIO 12/13)",
        use: "upload · serial monitor · Web Serial",
        short: "upload · serial · Web Serial",
        kind: "uart",
      },
    ],
    buttons: ["BOOT:9", "RST"],
    size: [18, 23],
    layout: "physical",
    note: "SuperMini pin order with the USB-C socket at the top. The pads 23, 22, 12, 13 and 21 are on the underside edge (12 and 13 are the USB lines).",
    left: [
      "TX:16",
      "RX:17",
      "0:0",
      "1:1",
      "2:2",
      "3:3",
      "4:4",
      "5:5",
      "6:6",
      "7:7",
    ],
    right: [
      "5V",
      "GND",
      "3V3",
      "20:20",
      "19:19",
      "18:18",
      "15:15",
      "14:14",
      "9:9",
      "8:8",
    ],
    pads: ["23:23", "22:22", "12:12", "13:13", "21:21"],
  },
  esp32s3: {
    name: "ESP32-S3-DevKitC-1",
    fullLength: true,
    chip: "ESP32-S3",
    module: "ESP32-S3-WROOM-1",
    memory: "8 MB flash or more",
    usb: "USB-C ×2",
    ports: [
      {
        label: "UART",
        via: "USB-to-UART bridge (CP2102N or CH343)",
        use: "upload · serial monitor · Web Serial",
        short: "upload · serial · Web Serial",
      },
      {
        label: "USB",
        via: "ESP32-S3 native USB on GPIO 19/20",
        use: "USB OTG · JTAG debugging",
        short: "USB OTG · JTAG",
      },
    ],
    buttons: ["RST", "BOOT:0"],
    size: [28, 63],
    layout: "physical",
    note: "ESP32-S3-DevKitC-1 order; other S3 boards differ.",
    left: [
      "3V3",
      "3V3",
      "RST",
      "4:4",
      "5:5",
      "6:6",
      "7:7",
      "15:15",
      "16:16",
      "17:17",
      "18:18",
      "8:8",
      "3:3",
      "46:46",
      "9:9",
      "10:10",
      "11:11",
      "12:12",
      "13:13",
      "14:14",
      "5V",
      "GND",
    ],
    right: [
      "GND",
      "TX:43",
      "RX:44",
      "1:1",
      "2:2",
      "42:42",
      "41:41",
      "40:40",
      "39:39",
      "38:38",
      "37:37",
      "36:36",
      "35:35",
      "0:0",
      "45:45",
      "48:48",
      "47:47",
      "21:21",
      "20:20",
      "19:19",
      "GND",
      "GND",
    ],
  },
};
// Realtek BW16 kits (pin order from Realtek's Ameba pin maps).
LOOKS.bw16 = {
  name: "Ai-Thinker BW16-Kit (Type-C)",
  chip: "RTL8720DN",
  module: "BW16",
  memory: "2 MB flash · WiFi 2.4 + 5 GHz",
  usb: "USB-C",
  buttons: ["RST", "Burn"],
  size: [26, 40],
  layout: "physical",
  note: "Pins are the Arduino numbers printed on the board (3 = PA30). Upload starts by itself on this board.",
  left: [
    "GND",
    "PA30:3",
    "PA27:2",
    "PA25:7",
    "PA26:8",
    "PA8:1",
    "PA7:0",
    "EN",
    "GND",
    "3V3",
    "5V",
  ],
  right: [
    "GND",
    "PA15:9",
    "PA14:10",
    "PA13:11",
    "PA12:12",
    "PB3:6",
    "PB2:5",
    "PB1:4",
    "GND",
    "3V3",
    "5V",
  ],
};
LOOKS["bw16-manual"] = {
  name: "Ai-Thinker BW16-Kit (micro-USB)",
  chip: "RTL8720DN",
  module: "BW16",
  memory: "2 MB flash · WiFi 2.4 + 5 GHz",
  usb: "micro-USB",
  buttons: ["RST", "Burn"],
  size: [26, 40],
  layout: "physical",
  note: "Upload: hold Burn, press and release RST, release Burn, then upload. The onboard USB chip is wired to 4/5 (PB1/PB2): connect a USB-serial adapter to 0/1 (PA7/PA8), or bridge 1–5 and 0–4, as Realtek's guide shows.",
  left: [
    "PA15:9",
    "PA27:2",
    "NC",
    "PA26:8",
    "PA8:1",
    "PA13:11",
    "PA14:10",
    "PA30:3",
    "PA12:12",
    "GND",
    "3V3",
    "EN",
    "NC",
    "GND",
    "VIN",
  ],
  right: [
    "NC",
    "NC",
    "NC",
    "NC",
    "NC",
    "3V3",
    "GND",
    "PB3:6",
    "PA25:7",
    "NC",
    "PA7:0",
    "PB2:5",
    "PB1:4",
    "GND",
    "3V3",
  ],
};
// Waveshare ESP32-P4-WIFI6 (Waveshare's pin definition, turned so the USB-C is at
// the bottom).
LOOKS["esp32p4-wifi6"] = {
  name: "Waveshare ESP32-P4-WIFI6",
  fullLength: true,
  chip: "ESP32-P4",
  module: "ESP32-C6 (WiFi 6 / BLE 5)",
  memory: "32 MB flash · 32 MB PSRAM",
  usb: "USB-C",
  ports: [
    {
      label: "USB-C",
      via: "CH343 USB-to-UART bridge (UART0)",
      use: "upload · serial monitor · Web Serial",
      short: "upload · serial · Web Serial",
    },
    {
      label: "USB",
      via: "4-pin header: the ESP32-P4's USB 2.0 High-Speed OTG",
      use: "USB host / device",
      short: "USB OTG",
    },
  ],
  buttons: ["RESET", "BOOT"],
  size: [21, 64],
  layout: "physical",
  note: "WiFi and Bluetooth are on the ESP32-C6 (SDIO, GPIO 14–19 + 54, not on the header). Display / camera connectors, TF card (GPIO 39–44) and audio (GPIO 9–13, 53) use other pins.",
  left: [
    "48:48",
    "47:47",
    "GND",
    "46:46",
    "33:33",
    "32:32",
    "27:27",
    "GND",
    "26:26",
    "RUN",
    "23:23",
    "22:22",
    "GND",
    "21:21",
    "20:20",
    "3V3",
    "EN",
    "GND",
    "VSYS",
    "VBUS",
  ],
  right: [
    "D+:25",
    "D−:24",
    "GND",
    "SDA:7",
    "SCL:8",
    "2:2",
    "3:3",
    "GND",
    "4:4",
    "5:5",
    "49:49",
    "50:50",
    "GND",
    "28:28",
    "29:29",
    "30:30",
    "31:31",
    "GND",
    "51:51",
    "52:52",
  ],
};
// Raspberry Pi Pico boards, as printed: USB at the top, pin 1 (GP0) top left, pin 40
// (VBUS) top right. All four share the pinout.
const picoLook = (name, chip, memory, wifi) => ({
  name,
  chip,
  module: wifi ? "CYW43439 (WiFi 2.4 GHz)" : "",
  memory,
  usb: "micro-USB",
  usbAt: "top",
  ports: [
    {
      label: "micro-USB",
      via: `${chip} native USB`,
      use: "upload · serial monitor · Web Serial",
      short: "upload · serial · Web Serial",
    },
  ],
  buttons: ["BOOTSEL"],
  size: [21, 51],
  layout: "physical",
  note: `Upload resets the board into its USB drive by itself. A new board, or one that does not answer: hold BOOTSEL while plugging in the USB cable, then upload. ${wifi ? "The LED is on the WiFi chip (LED_BUILTIN)." : "The LED is GP25 (LED_BUILTIN)."}`,
  left: [
    "GP0:0", "GP1:1", "GND", "GP2:2", "GP3:3", "GP4:4", "GP5:5", "GND", "GP6:6", "GP7:7",
    "GP8:8", "GP9:9", "GND", "GP10:10", "GP11:11", "GP12:12", "GP13:13", "GND", "GP14:14", "GP15:15",
  ],
  right: [
    "VBUS", "VSYS", "GND", "3V3_EN", "3V3", "ADC_VREF", "GP28:28", "GND", "GP27:27", "GP26:26",
    "RUN", "GP22:22", "GND", "GP21:21", "GP20:20", "GP19:19", "GP18:18", "GND", "GP17:17", "GP16:16",
  ],
});
LOOKS.pico = picoLook("Raspberry Pi Pico", "RP2040", "2 MB flash · 264 KB RAM", false);
LOOKS.picow = picoLook("Raspberry Pi Pico W", "RP2040", "2 MB flash · 264 KB RAM · WiFi", true);
LOOKS.pico2 = picoLook("Raspberry Pi Pico 2", "RP2350", "4 MB flash · 520 KB RAM", false);
LOOKS.pico2w = picoLook("Raspberry Pi Pico 2 W", "RP2350", "4 MB flash · 520 KB RAM · WiFi", true);
// Default SPI pins per board (Arduino's SCK / MISO / MOSI / SS), for the pin map.
const SPI_PINS = {
  esp8266: { sck: 14, miso: 12, mosi: 13, ss: 15 },
  d1mini: { sck: 14, miso: 12, mosi: 13, ss: 15 },
  esp32: { sck: 18, miso: 19, mosi: 23, ss: 5 },
  "esp32-38": { sck: 18, miso: 19, mosi: 23, ss: 5 },
  esp32cam: {},
  "ttgo-t-display": {},
  esp32c3: { sck: 4, miso: 5, mosi: 6, ss: 7 },
  "esp32c3-dual": { sck: 4, miso: 5, mosi: 6, ss: 7 },
  "esp32c6-mini": { sck: 21, miso: 20, mosi: 19, ss: 18 },
  esp32s3: { sck: 12, miso: 13, mosi: 11, ss: 10 },
  "freenove-s3cam": {},
  bw16: { sck: 10, miso: 11, mosi: 12, ss: 9 },
  "bw16-manual": { sck: 10, miso: 11, mosi: 12, ss: 9 },
  "esp32p4-wifi6": { sck: 36, miso: 33, mosi: 32, ss: 26 },
  pico: { sck: 18, miso: 16, mosi: 19, ss: 17 },
  picow: { sck: 18, miso: 16, mosi: 19, ss: 17 },
  pico2: { sck: 18, miso: 16, mosi: 19, ss: 17 },
  pico2w: { sck: 18, miso: 16, mosi: 19, ss: 17 },
};
const publicBoards = () =>
  Object.entries(boards).map(([id, b]) => ({
    id,
    label: b.label,
    fqbn: b.fqbn,
    family: b.family,
    adc: b.adc,
    gpio: b.gpio,
    // Pin facts for the Node properties pin guide.
    inputOnly: b.inputOnly,
    noPull: b.noPull || [],
    pwm: b.pwm,
    strapping: b.strapping,
    notes: b.notes,
    i2c: I2C_PINS[id] || { sda: 21, scl: 22 },
    spi: SPI_PINS[id] || {},
    reserved: Object.fromEntries(
      Object.entries(b.display?.pins || {}).map(([role, pin]) => [
        pin,
        `display ${role.toUpperCase()}`,
      ]),
    ),
    display: b.display
      ? { width: b.display.width, height: b.display.height }
      : null,
    features: features(b),
    look: LOOKS[id] || null,
    camera: b.camera || null,
    usbSerial: !!b.usbSerial,
  }));
// Detects a failed serial upload from esptool's output. Needed because the ESP8266
// core's upload.py swallows esptool exceptions and still exits with code 0.
function uploadFailure(output, port, family) {
  // Realtek's upload tool prints "Upload Image done." even when it failed; only this
  // line means the board was written.
  if (family === "ameba") {
    if (/All images are sent successfully/i.test(output)) return null;
    if (/Cannot access|Open serial port/i.test(output))
      return `${port} could not be opened: is the BW16 plugged in with a data cable, and is no other program (serial monitor, Arduino IDE) using it? The board was not changed.`;
    if (/Handshake fail|Device not supports Auto Upload Mode|enter the upload mode manually/i.test(output))
      return `The BW16 on ${port} did not enter upload mode. Hold Burn, press and release RST, release Burn, then upload again (micro-USB kits: choose the "Burn button" board and wire the USB-serial adapter to pins 0/1). The board was not changed.`;
    const line = /((?:Erase flash|Flashloader download|Images download|Download) fail[^\n]*|Err:[^\n]*)/i.exec(output)?.[1];
    return `Upload failed${line ? `: ${line.trim()}` : " (Realtek upload tool)"}. The board was not changed.`;
  }
  // Raspberry Pi Pico: the core's uf2conv resets the board into its USB drive (1200
  // baud) and copies the UF2 onto it.
  if (family === "rp2040") {
    if (/No drive to deploy|Unable to find|no.*drive.*found/i.test(output))
      return `The Pico did not appear as a USB drive. Hold BOOTSEL while plugging in the USB cable (a drive named RPI-RP2 or RP2350 opens), then upload again. The board was not changed.`;
    if (/Access is denied|PermissionError|could not open port|busy/i.test(output))
      return `${port} is in use by another program (a serial monitor, Arduino IDE, or a browser tab with Web Serial). Disconnect it and upload again. The board was not changed.`;
    return null;
  }
  if (
    !/A fatal esptool\.py error occurred|A fatal error occurred|could not open port|Failed to connect to ESP/i.test(
      output,
    )
  )
    return null;
  if (
    /FileNotFoundError|cannot find the file|No such file|does not exist/i.test(
      output,
    )
  )
    return `${port} was not found. Is the board plugged in with a data cable? Refresh the port list (↻). The board was not changed.`;
  if (/Access is denied|PermissionError|could not open port|busy/i.test(output))
    return `${port} is in use by another program (a serial monitor, Arduino IDE, or another Microflow window). Disconnect it and upload again. The board was not changed.`;
  if (
    /Failed to connect|Timed out waiting for packet header|No serial data received/i.test(
      output,
    )
  )
    return `The board on ${port} did not enter upload mode. Hold its FLASH/BOOT button while uploading, or try another USB cable. The board was not changed.`;
  const line = /A fatal (?:esptool\.py )?error occurred:?\s*([^\n]*)/i.exec(
    output,
  )?.[1];
  return `Upload failed: ${line || "esptool reported an error"}. The board was not changed.`;
}
// The board's usual I2C pins.
const i2cPins = (id) => I2C_PINS[id] || { sda: 21, scl: 22 };
module.exports = {
  boards,
  i2cPins,
  checkPin,
  parseSize,
  publicBoards,
  uploadFailure,
  FEATURES,
  features,
};
