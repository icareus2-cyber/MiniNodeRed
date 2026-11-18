// C++ for screens drawn as 7 text rows (each Display node owns one row):
//  • st7789: built-in colour LCD on SPI (LILYGO TTGO T-Display), Adafruit ST7789 + GFX,
//    used in landscape (240×135), rows 19 px high.
//  • ssd1306: 128×64 monochrome OLED on I2C (Heltec WiFi Kit 32, Lolin32 OLED, or an
//    OLED wired to the board), Adafruit SSD1306 + GFX, rows 9 px high, small text only.
//    The OLED is looked for at start-up (I2C address 0x3C, then 0x3D): when nothing
//    answers, every screen call does nothing, so the firmware runs without it.
// Every function takes the board (its .display) or a display description itself.
// Both drivers give the same calls: mfLcd(row, size, color, text), mfLcdClear(),
// mfLcdPower(on) and mfLcdFlush() (call it from loop(); the OLED sends its buffer
// there, at most every 50 ms). mfLcdFound says whether a screen is there.
const { quoted, LCD_COLORS } = require("./nodes");
const ROW_HEIGHT = 19; // ST7789 rows (the OLED's are 9 px)
const OLED_ROW = 9;
const disp = (x) => x?.display || x;
const isOled = (x) => disp(x)?.driver === "ssd1306";
const rowHeight = (x) => (isOled(x) ? OLED_ROW : ROW_HEIGHT);
// Characters on one row at text size 1.
const rowChars = (x) => (isOled(x) ? 21 : 39);
const LIBRARIES = {
  st7789: ["Adafruit ST7735 and ST7789 Library", "Adafruit GFX Library"],
  ssd1306: ["Adafruit SSD1306", "Adafruit GFX Library"],
};
const libraries = (x) => LIBRARIES[disp(x)?.driver] || [];
const ST7789_INCLUDES =
  "#include <SPI.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_ST7789.h>\n";
const includesFor = (x) =>
  isOled(x)
    ? "#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\n"
    : ST7789_INCLUDES;
// The ST77XX colour names the Display node uses: all "lit" on a monochrome OLED.
const OLED_COLORS = `#ifndef ST77XX_BLACK
#define ST77XX_BLACK 0
#endif
${Object.values(LCD_COLORS)
  .map((c) => `#ifndef ${c}\n#define ${c} 1\n#endif`)
  .join("\n")}`;
function oledGlobals(d) {
  const p = d.pins;
  return `// ${d.builtIn === false ? "I2C OLED, if one is connected" : "Built-in 128×64 SSD1306 OLED"} (I2C SDA ${p.sda}, SCL ${p.scl}${p.rst >= 0 ? `, reset ${p.rst}` : ""}${p.vext >= 0 ? `, power switch ${p.vext} (on when LOW)` : ""}; address 0x3C or 0x3D).
${OLED_COLORS}
Adafruit_SSD1306 mfTft(128, 64, &Wire, -1);
bool mfLcdFound = false, mfLcdDirty = false;
// Writes one line of small text on a row (21 characters), clearing that row first.
void mfLcd(uint8_t row, uint8_t size, uint16_t color, const String& text) {
  if (!mfLcdFound || row > 6) return;
  const int16_t y = row * ${OLED_ROW};
  mfTft.fillRect(0, y, mfTft.width(), ${OLED_ROW}, SSD1306_BLACK);
  mfTft.setTextSize(1);
  mfTft.setTextColor(SSD1306_WHITE);
  mfTft.setCursor(1, y + 1);
  mfTft.print(text.substring(0, 21));
  mfLcdDirty = true;
}
void mfLcdClear() {
  if (!mfLcdFound) return;
  mfTft.clearDisplay();
  mfLcdDirty = true;
}
void mfLcdPower(bool on) {
  if (mfLcdFound) mfTft.ssd1306_command(on ? SSD1306_DISPLAYON : SSD1306_DISPLAYOFF);
}
// Sends the drawing to the OLED (from loop(), at most every 50 ms).
void mfLcdFlush() {
  static unsigned long at = 0;
  if (!mfLcdFound || !mfLcdDirty || millis() - at < 50) return;
  at = millis();
  mfLcdDirty = false;
  mfTft.display();
}
// Looks for the OLED; true when one answered.
bool mfLcdBegin() {
${p.vext >= 0 ? `  pinMode(${p.vext}, OUTPUT);\n  digitalWrite(${p.vext}, LOW); // screen power on\n  delay(50);\n` : ""}${p.rst >= 0 ? `  pinMode(${p.rst}, OUTPUT);\n  digitalWrite(${p.rst}, LOW);\n  delay(10);\n  digitalWrite(${p.rst}, HIGH);\n  delay(10);\n` : ""}  Wire.begin(${p.sda}, ${p.scl});
  for (uint8_t addr : { 0x3C, 0x3D }) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;
    if (!mfTft.begin(SSD1306_SWITCHCAPVCC, addr, false, false)) return false;
    mfLcdFound = true;
    mfTft.clearDisplay();
    mfTft.setTextWrap(false);
    mfTft.display();
    Serial.printf("OLED found at I2C 0x%02X\\n", addr);
    return true;
  }
  Serial.println(${quoted(d.builtIn === false ? "No I2C OLED found (it is optional)." : "The built-in OLED did not answer on I2C.")});
  return false;
}
`;
}
function tftGlobals(d) {
  const p = d.pins;
  return `// Built-in ${d.width}×${d.height} ST7789 LCD (SPI: MOSI ${p.mosi}, SCLK ${p.sclk}, CS ${p.cs}, DC ${p.dc}, RST ${p.rst}, backlight ${p.backlight}).
Adafruit_ST7789 mfTft(&SPI, ${p.cs}, ${p.dc}, ${p.rst});
const bool mfLcdFound = true;
// Writes one line of text on a row, clearing that row first; long text is cut off.
void mfLcd(uint8_t row, uint8_t size, uint16_t color, const String& text) {
  const int16_t y = 2 + row * ${ROW_HEIGHT};
  mfTft.fillRect(0, y, mfTft.width(), 8 * size + 2, ST77XX_BLACK);
  mfTft.setTextSize(size);
  mfTft.setTextColor(color, ST77XX_BLACK);
  mfTft.setCursor(4, y + 1);
  mfTft.print(text.substring(0, (mfTft.width() - 8) / (6 * size)));
}
void mfLcdClear() { mfTft.fillScreen(ST77XX_BLACK); }
void mfLcdPower(bool on) { digitalWrite(${p.backlight}, on ? HIGH : LOW); } // backlight
void mfLcdFlush() {} // drawn at once
`;
}
const globals = (x) => (isOled(x) ? oledGlobals(disp(x)) : tftGlobals(disp(x)));
// Start-up: the screen, then the boot text of Display nodes.
function setup(x, flow = { nodes: [] }) {
  const d = disp(x);
  const boot = flow.nodes
    .filter((n) => n.type === "display" && n.config.initial)
    .map(
      (n) =>
        `  mfLcd(${n.config.row}, ${n.config.size}, ${LCD_COLORS[n.config.color]}, ${quoted(n.config.initial)});`,
    );
  if (isOled(d)) return `  mfLcdBegin();\n${boot.join("\n")}`;
  const p = d.pins;
  return `  SPI.begin(${p.sclk}, -1, ${p.mosi}, ${p.cs});
  mfTft.init(${d.height}, ${d.width}); // panel is ${d.height}×${d.width} in portrait
  mfTft.setRotation(1); // landscape 240×135
  mfTft.setTextWrap(false);
  mfTft.fillScreen(ST77XX_BLACK);
  pinMode(${p.backlight}, OUTPUT);
  digitalWrite(${p.backlight}, HIGH); // backlight on
${boot.join("\n")}`;
}
const loop = () => "mfLcdFlush();";
// Test-terminal commands for the screen (debug builds).
const shell = `  if (cmd == "lcd") {
    String a = mfWord(rest);
    if (a == "clear") { mfLcdClear(); return "display cleared"; }
    long row;
    if (!mfInt(a, row) || row < 0 || row > 6) return "error: lcd <row 0-6> <text> | lcd clear";
    mfLcd(row, 2, ST77XX_WHITE, rest);
    return String("row ") + row + " = " + rest;
  }
`;
// Kept for older callers: the ST7789 includes.
const includes = ST7789_INCLUDES;
module.exports = {
  includes,
  includesFor,
  globals,
  setup,
  loop,
  shell,
  libraries,
  isOled,
  rowHeight,
  rowChars,
  ROW_HEIGHT,
};
