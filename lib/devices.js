// Input device and Output device nodes: one box each, with the device chosen in
// Properties (like the Logic node's function).
//
//  Input device:  gyroscope / accelerometer (MPU-6050, I2C), oscilloscope (fast ADC
//                 capture), image sensor (ESP32-CAM camera), voltmeter, temperature
//                 sensor (DS18B20, DHT22/DHT11, NTC thermistor, LM35, TMP36).
//  Output device: servo motor, stepper motor (STEP/DIR driver or ULN2003 + 28BYJ-48).
//
// Each device has the simulator's behaviour (host / simulate) and the firmware's
// (fw); fields show only for their device through `when` (an object, or a list of
// objects of which one must match). Pins come from `pinSpec`, which the IDE also
// reads, so the board checks, the pin guide and the virtual pins agree.

// ── Small helpers (kept here so lib/nodes.js can require this file) ──
const toNumber = (value) => {
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
// A C float literal: 3 → 3.0f.
const fl = (x) => {
  const s = String(Number(x));
  return (/[.e]/i.test(s) ? s : s + ".0") + "f";
};
// Printable ASCII in a C string literal (for Serial messages).
const cText = (s) =>
  '"' +
  String(s)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "'")
    .replace(/\?/g, "_") +
  '"';
// Does a node's config match a field's `when` (one object, or a list = any of them)?
function whenMatches(config, when, fields) {
  if (!when) return true;
  const one = (w) =>
    Object.entries(w).every(([key, values]) =>
      values.includes(
        String(config[key] ?? fields.find((f) => f.key === key)?.default),
      ),
    );
  return Array.isArray(when) ? when.some(one) : one(when);
}
const pinField = (key, label, def, extra = {}) => ({
  key,
  label,
  type: "number",
  default: def,
  min: 0,
  max: 54, // ESP32-P4 has GPIO 0–54; each board's own pins are checked
  integer: true,
  ...extra,
});
const num = (key, label, def, min, max, extra = {}) => ({
  key,
  label,
  type: "number",
  default: def,
  min,
  max,
  ...extra,
});
const select = (key, label, def, options, extra = {}) => ({
  key,
  label,
  type: "select",
  default: def,
  options,
  ...extra,
});
const fixed = (x, d) => Number(x).toFixed(d);

// ═══════════════════════════ Input device ═══════════════════════════
const INPUT_DEVICES = {
  temp: "Temperature sensor",
  volt: "Voltmeter (analog input)",
  gyro: "Gyroscope / accelerometer (MPU-6050)",
  scope: "Oscilloscope (fast analog capture)",
  camera: "Image sensor (ESP32-CAM camera)",
};
const SENSORS = {
  ds18b20: "DS18B20 (1-Wire)",
  dht22: "DHT22 / AM2302",
  dht11: "DHT11",
  ntc: "NTC thermistor",
  lm35: "LM35",
  tmp36: "TMP36",
};
const ANALOG_SENSORS = ["ntc", "lm35", "tmp36"];
const DHT = ["dht22", "dht11"];
const GYRO_OUT = {
  all: "All values (JSON)",
  pitch: "Pitch / forward tilt (°)",
  roll: "Roll / sideways tilt (°)",
  ax: "Acceleration X (g)",
  ay: "Acceleration Y (g)",
  az: "Acceleration Z (g)",
  gx: "Rotation X (°/s)",
  gy: "Rotation Y (°/s)",
  gz: "Rotation Z (°/s)",
};
const inputFields = [
  select("device", "Device", "temp", INPUT_DEVICES),
  select("sensor", "Sensor", "ds18b20", SENSORS, {
    when: { device: ["temp"] },
  }),
  pinField("pin", "Pin", 4, {
    when: { device: ["temp", "volt", "scope"] },
    labelBy: {
      key: "device",
      labels: {
        temp: "Sensor pin (data, or analog for NTC / LM35 / TMP36)",
        volt: "Analog input pin",
        scope: "Analog input pin (probe)",
      },
    },
  }),
  pinField("sda", "SDA pin", 21, { when: { device: ["gyro"] } }),
  pinField("scl", "SCL pin", 22, { when: { device: ["gyro"] } }),
  select(
    "address",
    "I2C address",
    "104",
    { 104: "0x68 (AD0 to GND or open)", 105: "0x69 (AD0 to 3.3 V)" },
    { when: { device: ["gyro"] } },
  ),
  select("gyroOut", "Output", "all", GYRO_OUT, { when: { device: ["gyro"] } }),
  select(
    "gyroRange",
    "Gyro range",
    "1",
    { 0: "±250 °/s", 1: "±500 °/s", 2: "±1000 °/s", 3: "±2000 °/s" },
    { when: { device: ["gyro"] } },
  ),
  select(
    "accelRange",
    "Accelerometer range",
    "0",
    { 0: "±2 g", 1: "±4 g", 2: "±8 g", 3: "±16 g" },
    { when: { device: ["gyro"] } },
  ),
  select(
    "calibrate",
    "Zero the gyro at start",
    "yes",
    { yes: "Yes (keep the sensor still at power-up)", no: "No" },
    { when: { device: ["gyro"] } },
  ),
  num("samples", "Samples per capture", 100, 10, 500, {
    integer: true,
    when: { device: ["scope"] },
  }),
  num("rate", "Sample rate (samples per second)", 2000, 100, 20000, {
    integer: true,
    when: { device: ["scope"] },
  }),
  select(
    "scopeOut",
    "Output",
    "stats",
    {
      stats: "Summary JSON (min, max, avg, Vpp, frequency)",
      samples: "All samples (JSON array, up to 80)",
    },
    { when: { device: ["scope"] } },
  ),
  select(
    "camOut",
    "Output",
    "both",
    {
      both: "Brightness and motion (JSON)",
      brightness: "Brightness (0–255)",
      motion: "Motion (% of the picture changed)",
    },
    { when: { device: ["camera"] } },
  ),
  num(
    "motionLevel",
    "Motion: change of a pixel that counts (1–255)",
    25,
    1,
    255,
    { integer: true, when: { device: ["camera"], camOut: ["both", "motion"] } },
  ),
  num("r1", "Divider: top resistor R1 (kΩ, 0 = no divider)", 0, 0, 100000, {
    when: { device: ["volt"] },
  }),
  num("r2", "Divider: bottom resistor R2 (kΩ)", 10, 0.001, 100000, {
    when: { device: ["volt"] },
  }),
  num("calib", "Calibration factor (×)", 1, 0.1, 10, {
    when: { device: ["volt"] },
  }),
  num("average", "Average of readings", 16, 1, 64, {
    integer: true,
    when: { device: ["volt"] },
  }),
  num(
    "fullScale",
    "ESP8266 A0 full scale (V; NodeMCU / D1 mini 3.2, bare chip 1.0)",
    3.2,
    0.5,
    30,
    {
      when: [
        { device: ["volt"] },
        { device: ["temp"], sensor: ANALOG_SENSORS },
      ],
    },
  ),
  num("beta", "NTC beta (B25/85)", 3950, 1000, 10000, {
    integer: true,
    when: { device: ["temp"], sensor: ["ntc"] },
  }),
  num("r0", "NTC resistance at 25 °C (kΩ)", 10, 0.01, 10000, {
    when: { device: ["temp"], sensor: ["ntc"] },
  }),
  num("series", "Series resistor to 3.3 V (kΩ)", 10, 0.01, 10000, {
    when: { device: ["temp"], sensor: ["ntc"] },
  }),
  select(
    "dhtOut",
    "Output",
    "temp",
    {
      temp: "Temperature",
      humidity: "Humidity (%)",
      both: "Both (JSON)",
    },
    { when: { device: ["temp"], sensor: DHT } },
  ),
  select(
    "unit",
    "Unit",
    "c",
    { c: "°C", f: "°F" },
    { when: { device: ["temp"] } },
  ),
  num("decimals", "Decimals", 2, 0, 4, {
    integer: true,
    when: { device: ["temp", "volt", "gyro"] },
  }),
  num("interval", "Read every (ms)", 1000, 20, 86400000, { integer: true }),
];
// Shortest interval each device can keep up with.
function minInterval(c) {
  if (c.device === "temp")
    return { ds18b20: 800, dht22: 2000, dht11: 1000 }[c.sensor] || 100;
  return { gyro: 20, scope: 100, camera: 200, volt: 50 }[c.device];
}
function validateInput(c) {
  const min = minInterval(c);
  const what =
    c.device === "temp"
      ? SENSORS[c.sensor].split(" ")[0]
      : INPUT_DEVICES[c.device].split(" (")[0];
  if (c.interval < min)
    throw Error(`${what}: Read every must be at least ${min} ms.`);
  if (c.device === "gyro" && c.sda === c.scl)
    throw Error("SDA and SCL must be different pins.");
  if (c.device === "scope") {
    const ms = (c.samples / c.rate) * 1000;
    if (ms > 250)
      throw Error(
        `Oscilloscope: a capture takes ${Math.round(ms)} ms (${c.samples} samples at ${c.rate}/s); keep it at most 250 ms (fewer samples or a higher rate), because the board pauses while it captures.`,
      );
    if (c.scopeOut === "samples" && c.samples > 80)
      throw Error(
        "Oscilloscope: All samples sends at most 80 samples, so the message fits an MQTT packet. Lower Samples per capture or choose Summary.",
      );
    if (ms > c.interval / 2)
      throw Error(
        `Oscilloscope: a capture takes ${Math.round(ms)} ms; Read every must be at least twice that.`,
      );
  }
}
// Pins per device; `use` as in lib/boards.js checkPin. sim: shown as a virtual pin.
const inputPins = [
  {
    key: "pin",
    use: "in",
    sim: false,
    when: { device: ["temp"], sensor: ["ds18b20", ...DHT] },
  },
  {
    key: "pin",
    use: "adc",
    sim: true,
    when: [
      { device: ["volt", "scope"] },
      { device: ["temp"], sensor: ANALOG_SENSORS },
    ],
  },
  // I2C: one bus shared by every sensor on it (not a clash).
  {
    key: "sda",
    use: "out",
    sim: false,
    shared: "i2c",
    when: { device: ["gyro"] },
  },
  {
    key: "scl",
    use: "out",
    sim: false,
    shared: "i2c",
    when: { device: ["gyro"] },
  },
];
const inputSummary = {
  temp: "{sensor} · GPIO {pin}",
  volt: "Voltmeter · ADC {pin}",
  gyro: "MPU-6050 · {gyroOut}",
  scope: "Scope · ADC {pin} · {samples} @ {rate}/s",
  camera: "Camera · {camOut}",
};
const inputHelp = {
  temp: "DS18B20: data to the pin with a 4.7 kΩ resistor to 3.3 V (several on one wire: the first one is read). DHT22 / DHT11: data to the pin with a 10 kΩ pull-up. NTC thermistor: between the analog pin and GND, with the series resistor from the pin to 3.3 V. LM35 / TMP36: output to the analog pin. DS18B20 and DHT use Arduino libraries that Microflow installs on the first compile. In the PC simulator: DS18B20 / DHT give a slowly changing room temperature; analog sensors read the virtual pin's slider.",
  volt: "Measures a voltage on an analog pin and sends it in volts. Up to about 3.1 V directly (ESP32; ESP8266 boards: the A0 full scale). For higher voltages use a divider: R1 from the voltage to the pin, R2 from the pin to GND (e.g. 30 kΩ / 7.5 kΩ for up to about 15 V). Never more than 3.3 V on the pin. ESP32 boards read calibrated millivolts. In the simulator the virtual pin's slider sets the reading.",
  gyro: "MPU-6050 (GY-521 board): VCC to 3.3 V, GND, SDA and SCL to the pins chosen here. Tilt (pitch, roll) comes from the accelerometer, so it is right while the sensor is not being shaken. In the simulator the sensor slowly tilts back and forth.",
  scope:
    "Captures a burst of fast analog samples and sends a summary (lowest, highest and average reading, peak-to-peak, and the frequency of a repeating signal) or all samples. Readings are raw ADC values (ESP32 0–4095, ESP8266 0–1023). The board pauses during a capture (at most 250 ms). ESP8266: keep the rate at 2000/s or lower, or WiFi can drop. In the simulator the virtual pin's slider gives a steady level.",
  camera:
    "Camera boards only: choose AI-Thinker ESP32-CAM or Freenove ESP32-S3 WROOM CAM as the board. Takes a small grey picture (160 × 120) each time and sends its brightness and/or motion: the percentage of the picture that changed since the last one, e.g. to switch on a light or start a recording. The picture itself is not sent. In the simulator the values are made up.",
};

// ── Input firmware ──
const ADC_VCC = 3.3; // NTC: the series resistor goes to 3.3 V
function voltsExpr(n, i, build, readings) {
  const c = n.config;
  const analog = build?.emulate ? "mfAnalogRead" : "analogRead";
  // ESP32: calibrated millivolts (PC emulation builds read the raw wrapper).
  if (!["esp8266", "ameba", "rp2040"].includes(build?.family))
    return build?.emulate
      ? `mfVolts${i}(${analog}(${c.pin}) * 3300.0f / 4095.0f, ${readings})`
      : `mfVolts${i}(-1, ${readings})`;
  return `mfVolts${i}(-2, ${readings})`;
}
function inputGlobals(n, i, build) {
  const c = n.config;
  const label = cText(n.label || "Input device");
  const err = `unsigned long mfErr${i} = 0;
void mfComplain${i}(const char* what) {
  if (mfErr${i} && millis() - mfErr${i} < 10000UL) return; // once per 10 s
  mfErr${i} = millis() | 1;
  Serial.print(${label}); Serial.print(": "); Serial.println(what);
}`;
  const analog = build?.emulate ? "mfAnalogRead" : "analogRead";
  // Volts on the pin: average of `count` readings.
  const volts = `float mfVolts${i}(float fixed, int count) {
  if (fixed >= 0) return fixed / 1000.0f;
  float sum = 0;
  for (int k = 0; k < count; k++) sum += ${
    build?.family === "esp8266"
      ? `${analog}(${c.pin}) * ${fl(c.fullScale)} / 1023.0f`
      : build?.family === "ameba" || build?.family === "rp2040" // Realtek, Pico: 12-bit reads (set in setup), 0–3.3 V
        ? `${analog}(${c.pin}) * 3.3f / 4095.0f`
        : `analogReadMilliVolts(${c.pin}) / 1000.0f`
  };
  return sum / count;
}`;
  switch (c.device) {
    case "gyro": {
      const a = `0x${Number(c.address).toString(16)}`;
      const alsb = 16384 / (1 << Number(c.accelRange));
      const glsb = 131 / (1 << Number(c.gyroRange));
      return `// ${label}: MPU-6050 at ${a} on I2C (SDA ${c.sda}, SCL ${c.scl}).
${err}
bool mfMpuOk${i} = false;
float mfMpuZero${i}[3] = {0, 0, 0};
bool mfMpuSet${i}(uint8_t reg, uint8_t v) {
  Wire.beginTransmission((uint8_t)${a}); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}
bool mfMpuRead${i}(float* a, float* g) {
  Wire.beginTransmission((uint8_t)${a}); Wire.write((uint8_t)0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)${a}, (int)14) != 14) return false;
  int16_t r[7];
  for (int k = 0; k < 7; k++) { int hi = Wire.read(); int lo = Wire.read(); r[k] = (int16_t)((hi << 8) | lo); }
  for (int k = 0; k < 3; k++) { a[k] = r[k] / ${fl(alsb)}; g[k] = r[k + 4] / ${fl(glsb)} - mfMpuZero${i}[k]; }
  return true;
}
bool mfMpuBegin${i}() {
  if (!mfMpuSet${i}((uint8_t)0x6B, (uint8_t)0x01)) return false; // wake up, gyro clock
  mfMpuSet${i}((uint8_t)0x1A, (uint8_t)0x03); // low-pass filter about 44 Hz
  mfMpuSet${i}((uint8_t)0x1B, (uint8_t)${Number(c.gyroRange) << 3});
  mfMpuSet${i}((uint8_t)0x1C, (uint8_t)${Number(c.accelRange) << 3});${
    c.calibrate === "yes"
      ? `
  delay(30);
  float a[3], g[3], s[3] = {0, 0, 0};
  int got = 0;
  for (int k = 0; k < 50; k++) { if (mfMpuRead${i}(a, g)) { for (int j = 0; j < 3; j++) s[j] += g[j]; got++; } delay(2); }
  if (got) for (int j = 0; j < 3; j++) mfMpuZero${i}[j] = s[j] / got;`
      : ""
  }
  return true;
}`;
    }
    case "scope":
      return `// ${label}: oscilloscope capture on ADC ${c.pin}.
uint16_t mfScope${i}[${c.samples}];`;
    case "camera":
      return `// ${label}: camera (160 x 120 grey picture).
${err}
bool mfCamOk${i} = false, mfCamHave${i} = false;
uint8_t* mfCamPrev${i} = NULL;
size_t mfCamLen${i} = 0;
bool mfCamBegin${i}() {
  camera_config_t c;
  memset(&c, 0, sizeof(c));
  c.ledc_channel = LEDC_CHANNEL_7;
  c.ledc_timer = LEDC_TIMER_3;
${Object.entries(build?.camera || {})
  .map(
    ([k, p]) =>
      `  c.pin_${{ sda: "sccb_sda", scl: "sccb_scl" }[k] || k} = ${p};`,
  )
  .join("\n")}
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_GRAYSCALE;
  c.frame_size = FRAMESIZE_QQVGA;
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  return esp_camera_init(&c) == ESP_OK;
}`;
    case "volt":
      return `// ${label}: voltmeter on ADC ${c.pin}.
${volts}`;
    case "temp":
      if (c.sensor === "ds18b20")
        return `// ${label}: DS18B20 on GPIO ${c.pin}.
${err}
OneWire mfOneWire${i}(${c.pin});
DallasTemperature mfDs${i}(&mfOneWire${i});`;
      if (DHT.includes(c.sensor))
        return `// ${label}: ${c.sensor.toUpperCase()} on GPIO ${c.pin}.
${err}
DHT mfDht${i}(${c.pin}, ${c.sensor.toUpperCase()});`;
      return `// ${label}: ${SENSORS[c.sensor]} on ADC ${c.pin}.
${err}
${volts}`;
  }
  return "";
}
function inputSetup(n, i) {
  const c = n.config;
  if (c.device === "temp" && c.sensor === "ds18b20")
    return `mfDs${i}.begin(); mfDs${i}.setWaitForConversion(false); mfDs${i}.requestTemperatures();`;
  if (c.device === "temp" && DHT.includes(c.sensor))
    return `mfDht${i}.begin();`;
  if (c.device === "camera") return `mfCamOk${i} = mfCamBegin${i}();`;
  return "";
}
// C++ that sends a temperature t (°C, float) in the chosen unit.
const sendTemp = (c, i, t = "t") =>
  `node${i}(String(${c.unit === "f" ? `${t} * 1.8f + 32.0f` : t}, ${c.decimals}));`;
// C++ String of a gyroscope reading (float a[3], g[3], pitch, roll in scope).
function gyroText(c) {
  const d = c.decimals;
  const pick = {
    pitch: "pitch",
    roll: "roll",
    ax: "a[0]",
    ay: "a[1]",
    az: "a[2]",
    gx: "g[0]",
    gy: "g[1]",
    gz: "g[2]",
  };
  return c.gyroOut === "all"
    ? `String("{\\"ax\\":") + String(a[0], ${d}) + ",\\"ay\\":" + String(a[1], ${d}) + ",\\"az\\":" + String(a[2], ${d}) + ",\\"gx\\":" + String(g[0], ${d}) + ",\\"gy\\":" + String(g[1], ${d}) + ",\\"gz\\":" + String(g[2], ${d}) + ",\\"pitch\\":" + String(pitch, ${d}) + ",\\"roll\\":" + String(roll, ${d}) + "}"`
    : `String(${pick[c.gyroOut]}, ${d})`;
}
function inputRead(n, i, build) {
  const c = n.config;
  const analog = build?.emulate ? "mfAnalogRead" : "analogRead";
  switch (c.device) {
    case "gyro": {
      const out = gyroText(c);
      return `if (!mfMpuOk${i}) mfMpuOk${i} = mfMpuBegin${i}();
      float a[3], g[3];
      if (!mfMpuOk${i} || !mfMpuRead${i}(a, g)) { mfMpuOk${i} = false; mfComplain${i}("no MPU-6050 answers at 0x${Number(c.address).toString(16)}; check SDA, SCL, 3.3 V and GND"); }
      else {
        float pitch = atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2])) * 57.29578f + 0.0f; // + 0: no "-0.00"
        float roll = atan2(a[1], a[2]) * 57.29578f + 0.0f;
        node${i}(${out});
      }`;
    }
    case "scope": {
      const period = Math.round(1e6 / c.rate);
      const capture = `unsigned long t0 = micros();
      for (int k = 0; k < ${c.samples}; k++) {
        while ((long)(micros() - t0) < (long)(k * ${period}UL)) {}
        mfScope${i}[k] = ${analog}(${c.pin});
      }
      unsigned long took = micros() - t0;`;
      if (c.scopeOut === "samples")
        return `${capture}
      (void)took;
      String out = "[";
      for (int k = 0; k < ${c.samples}; k++) { if (k) out += ","; out += String((int)mfScope${i}[k]); }
      node${i}(out + "]");`;
      return `${capture}
      uint16_t lo = 65535, hi = 0;
      uint32_t sum = 0;
      for (int k = 0; k < ${c.samples}; k++) { uint16_t v = mfScope${i}[k]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
      // Frequency: rising crossings of the middle level (with 10 % hysteresis).
      float mid = (lo + hi) / 2.0f, band = (hi - lo) / 10.0f;
      int rises = 0, first = -1, last = -1;
      bool up = mfScope${i}[0] > mid;
      for (int k = 1; k < ${c.samples}; k++) {
        if (!up && mfScope${i}[k] > mid + band) { up = true; rises++; if (first < 0) first = k; last = k; }
        else if (up && mfScope${i}[k] < mid - band) up = false;
      }
      float dt = took / (float)${c.samples}; // microseconds per sample, as captured
      float hz = (rises >= 2 && hi - lo >= 8) ? (rises - 1) * 1000000.0f / ((last - first) * dt) : 0;
      node${i}(String("{\\"min\\":") + String((int)lo) + ",\\"max\\":" + String((int)hi) + ",\\"avg\\":" + String(sum / (float)${c.samples}, 1) + ",\\"vpp\\":" + String((int)(hi - lo)) + ",\\"hz\\":" + String(hz, 1) + "}");`;
    }
    case "camera": {
      const out = {
        brightness: "String(bright)",
        motion: "String(motion, 1)",
        both: `String("{\\"brightness\\":") + String(bright) + ",\\"motion\\":" + String(motion, 1) + "}"`,
      }[c.camOut];
      return `if (!mfCamOk${i}) mfCamOk${i} = mfCamBegin${i}();
      camera_fb_t* fb = mfCamOk${i} ? esp_camera_fb_get() : NULL;
      if (fb) { esp_camera_fb_return(fb); fb = esp_camera_fb_get(); } // a fresh picture
      if (!fb) { mfCamOk${i} = false; mfComplain${i}("the camera does not answer; is the board a camera board (AI-Thinker ESP32-CAM, Freenove ESP32-S3 WROOM CAM)?"); }
      else {
        size_t len = fb->len;
        uint32_t sum = 0, moved = 0, looked = 0;
        for (size_t k = 0; k < len; k++) sum += fb->buf[k];
        if (!mfCamPrev${i}) { mfCamPrev${i} = (uint8_t*)malloc(len); mfCamLen${i} = len; }
        if (mfCamPrev${i} && mfCamLen${i} == len) {
          if (mfCamHave${i})
            for (size_t k = 0; k < len; k += 2) { looked++; int d = (int)fb->buf[k] - (int)mfCamPrev${i}[k]; if (d > ${c.motionLevel} || d < -${c.motionLevel}) moved++; }
          memcpy(mfCamPrev${i}, fb->buf, len);
          mfCamHave${i} = true;
        }
        esp_camera_fb_return(fb);
        int bright = len ? (int)(sum / len) : 0;
        float motion = looked ? moved * 100.0f / looked : 0;
        node${i}(${out});
      }`;
    }
    case "volt": {
      const ratio = c.r1 > 0 ? (c.r1 + c.r2) / c.r2 : 1;
      return `float v = ${voltsExpr(n, i, build, c.average)} * ${fl(ratio * c.calib)};
      node${i}(String(v, ${c.decimals}));`;
    }
    case "temp": {
      if (c.sensor === "ds18b20")
        return `float t = mfDs${i}.getTempCByIndex(0);
      mfDs${i}.requestTemperatures(); // ready for the next reading
      if (t == DEVICE_DISCONNECTED_C) mfComplain${i}("no DS18B20 found; check the data wire and its 4.7 kOhm pull-up");
      else ${sendTemp(c, i)}`;
      if (DHT.includes(c.sensor)) {
        const temp = c.unit === "f" ? "t * 1.8f + 32.0f" : "t";
        const out = {
          temp: `String(${temp}, ${c.decimals})`,
          humidity: `String(h, ${c.decimals})`,
          both: `String("{\\"temperature\\":") + String(${temp}, ${c.decimals}) + ",\\"humidity\\":" + String(h, ${c.decimals}) + "}"`,
        }[c.dhtOut];
        return `float t = mfDht${i}.readTemperature(), h = mfDht${i}.readHumidity();
      if (isnan(t) || isnan(h)) mfComplain${i}("no answer from the ${c.sensor.toUpperCase()}; check the data wire and its pull-up");
      else node${i}(${out});`;
      }
      const v = voltsExpr(n, i, build, 8);
      if (c.sensor === "ntc")
        return `float v = ${v};
      if (v <= 0.01f || v >= ${fl(ADC_VCC - 0.01)}) mfComplain${i}("NTC reading out of range; check the thermistor and the series resistor");
      else {
        float r = ${fl(c.series)} * v / (${fl(ADC_VCC)} - v); // thermistor, kOhm
        float t = 1.0f / (1.0f / 298.15f + log(r / ${fl(c.r0)}) / ${fl(c.beta)}) - 273.15f;
        ${sendTemp(c, i)}
      }`;
      return `float t = (${v}${c.sensor === "tmp36" ? " - 0.5f" : ""}) * 100.0f;
      ${sendTemp(c, i)}`;
    }
  }
  return "";
}
function inputLoop(n, i, build) {
  const read = inputRead(n, i, build);
  // PC input emulation builds: the PC can stand in for the sensor (lib/emufw.js).
  const body = build?.emulate ? require("./emufw").deviceRead(i, read) : read;
  return `{ static unsigned long tick${i} = 0;
    if (millis() - tick${i} >= ${n.config.interval}UL) {
      tick${i} = millis();
      ${body}
    } }`;
}
// ── Input simulation (PC): made-up but plausible readings ──
function simulateInput(n, sim) {
  const c = n.config;
  const t0 = Date.now();
  const secs = () => (Date.now() - t0) / 1000;
  const adcVolts = () => {
    const raw = sim.readPin(c.pin);
    // As the firmware: ESP8266 A0 scaled; ESP32 whole millivolts.
    return c.pin === 17
      ? (raw / 1023) * c.fullScale
      : Math.floor((raw * 3300) / 4095) / 1000;
  };
  const send = (v) => sim.send(String(v));
  const tick = () => {
    const s = secs();
    switch (c.device) {
      case "gyro": {
        const d = c.decimals;
        const rad = Math.PI / 180;
        const pitch = 15 * Math.sin((2 * Math.PI * s) / 8);
        const roll = 10 * Math.sin((2 * Math.PI * s) / 5);
        const a = [
          -Math.sin(pitch * rad),
          Math.sin(roll * rad) * Math.cos(pitch * rad),
          Math.cos(roll * rad) * Math.cos(pitch * rad),
        ];
        const g = [
          10 * ((2 * Math.PI) / 5) * Math.cos((2 * Math.PI * s) / 5),
          15 * ((2 * Math.PI) / 8) * Math.cos((2 * Math.PI * s) / 8),
          0,
        ];
        const v = {
          ax: a[0],
          ay: a[1],
          az: a[2],
          gx: g[0],
          gy: g[1],
          gz: g[2],
          pitch,
          roll,
        };
        return send(
          c.gyroOut === "all"
            ? `{${Object.entries(v)
                .map(([k, x]) => `"${k}":${fixed(x, d)}`)
                .join(",")}}`
            : fixed(v[c.gyroOut], d),
        );
      }
      case "scope": {
        const raw = sim.readPin(c.pin);
        if (c.scopeOut === "samples")
          return send(`[${Array(c.samples).fill(raw).join(",")}]`);
        return send(
          `{"min":${raw},"max":${raw},"avg":${fixed(raw, 1)},"vpp":0,"hz":0.0}`,
        );
      }
      case "camera": {
        const bright = Math.round(120 + 20 * Math.sin(s / 30));
        const motion =
          Math.random() < 0.15 ? 5 + Math.random() * 30 : Math.random() * 2;
        return send(
          {
            brightness: String(bright),
            motion: fixed(motion, 1),
            both: `{"brightness":${bright},"motion":${fixed(motion, 1)}}`,
          }[c.camOut],
        );
      }
      case "volt": {
        const ratio = c.r1 > 0 ? (c.r1 + c.r2) / c.r2 : 1;
        return send(fixed(adcVolts() * ratio * c.calib, c.decimals));
      }
      case "temp": {
        let t;
        if (ANALOG_SENSORS.includes(c.sensor)) {
          const v = adcVolts();
          if (c.sensor === "ntc") {
            if (v <= 0.01 || v >= ADC_VCC - 0.01)
              return sim.warn(
                `${n.label}: NTC reading out of range (move the virtual pin's slider)`,
              );
            const r = (c.series * v) / (ADC_VCC - v);
            t = 1 / (1 / 298.15 + Math.log(r / c.r0) / c.beta) - 273.15;
          } else t = (v - (c.sensor === "tmp36" ? 0.5 : 0)) * 100;
        } else t = 22 + 1.5 * Math.sin(s / 40) + (Math.random() - 0.5) * 0.1;
        const shown = c.unit === "f" ? t * 1.8 + 32 : t;
        if (DHT.includes(c.sensor)) {
          const h = 45 + 5 * Math.sin(s / 55);
          return send(
            {
              temp: fixed(shown, c.decimals),
              humidity: fixed(h, c.decimals),
              both: `{"temperature":${fixed(shown, c.decimals)},"humidity":${fixed(h, c.decimals)}}`,
            }[c.dhtOut],
          );
        }
        return send(fixed(shown, c.decimals));
      }
    }
  };
  sim.every(c.interval, tick);
}

// ═══════════════════════════ Output device ═══════════════════════════
const OUTPUT_DEVICES = {
  servo: "Servo motor",
  stepper: "Stepper motor",
  i2cdisplay: "I2C display (OLED / LCD)",
};
// I2C displays: SSD1306 OLED (Adafruit SSD1306 + GFX) or a character LCD with a
// PCF8574 backpack (LiquidCrystal I2C). Boxes with the same address share one screen,
// so several boxes can each write their own line.
const DISPLAY = { device: ["i2cdisplay"] };
const DISPLAYS = {
  oled64: "OLED 128×64 (SSD1306, 0.96\")",
  oled32: "OLED 128×32 (SSD1306, 0.91\")",
  lcd1602: "LCD 16×2 (I2C backpack PCF8574)",
  lcd2004: "LCD 20×4 (I2C backpack PCF8574)",
};
const DISPLAY_ADDR = {
  auto: "Usual address (OLED 0x3C, LCD 0x27)",
  "0x3C": "0x3C",
  "0x3D": "0x3D",
  "0x27": "0x27",
  "0x3F": "0x3F",
};
const isOled = (c) => String(c.screen).startsWith("oled");
const displayAddr = (c) =>
  c.addr && c.addr !== "auto" ? c.addr : isOled(c) ? "0x3C" : "0x27";
// Lines of the chosen text size, and characters per line.
function displayGrid(c) {
  if (!isOled(c)) return c.screen === "lcd2004" ? [4, 20] : [2, 16];
  const size = Number(c.textSize) || 1;
  const h = c.screen === "oled32" ? 32 : 64;
  return [Math.floor(h / (8 * size)), Math.floor(128 / (6 * size))];
}
const displayText = (c, v) =>
  String(c.text ?? "{{payload}}").replaceAll("{{payload}}", String(v));
const SERVO_IN = {
  angle: "Angle (°)",
  percent: "Position (0–100 %)",
  us: "Pulse width (µs)",
  speed: "Speed, continuous-rotation servo (−100…100 %)",
};
const STEPPER_IN = {
  angle: "Turn by angle (°, + / −)",
  angleTo: "Go to angle (°)",
  distance: "Move by distance (mm, + / −)",
  distanceTo: "Go to distance (mm)",
  steps: "Move by steps (+ / −)",
  position: "Go to step position",
  rpm: "Run at speed (RPM, + / −, 0 = stop)",
};
const STEPPER = { device: ["stepper"] };
const STEPDIR = { device: ["stepper"], driver: ["stepdir"] };
const ULN = { device: ["stepper"], driver: ["uln2003"] };
const outputFields = [
  select("device", "Device", "servo", OUTPUT_DEVICES),
  select(
    "driver",
    "Driver",
    "stepdir",
    {
      stepdir: "STEP / DIR driver (A4988, DRV8825, TMC2208, …)",
      uln2003: "ULN2003 board (28BYJ-48 motor)",
    },
    { when: STEPPER },
  ),
  pinField("pin", "Pin", 13, {
    when: [{ device: ["servo"] }, STEPDIR],
    labelBy: {
      key: "device",
      labels: { servo: "Signal pin", stepper: "STEP pin" },
    },
  }),
  pinField("dirPin", "DIR pin", 14, { when: STEPDIR }),
  pinField("enPin", "ENABLE pin (−1 = not wired)", -1, {
    min: -1,
    when: STEPDIR,
  }),
  pinField("in1", "IN1 pin", 25, { when: ULN }),
  pinField("in2", "IN2 pin", 26, { when: ULN }),
  pinField("in3", "IN3 pin", 27, { when: ULN }),
  pinField("in4", "IN4 pin", 14, { when: ULN }),
  select("servoIn", "Input value", "angle", SERVO_IN, {
    when: { device: ["servo"] },
  }),
  num("range", "Angle range (°)", 180, 90, 360, {
    integer: true,
    when: { device: ["servo"] },
  }),
  num("minUs", "Pulse at 0° (µs)", 500, 300, 1500, {
    integer: true,
    when: { device: ["servo"] },
  }),
  num("maxUs", "Pulse at full range (µs)", 2400, 1500, 3000, {
    integer: true,
    when: { device: ["servo"] },
  }),
  num("start", "Start angle (°, −1 = do not move at power-up)", 90, -1, 360, {
    when: { device: ["servo"], servoIn: ["angle", "percent", "us"] },
  }),
  num("speed", "Turn speed (°/s, 0 = as fast as it can)", 0, 0, 2000, {
    when: { device: ["servo"], servoIn: ["angle", "percent", "us"] },
  }),
  select("input", "Input value", "angle", STEPPER_IN, { when: STEPPER }),
  num("stepsPerRev", "Motor steps per revolution (full steps)", 200, 4, 10000, {
    integer: true,
    when: STEPDIR,
  }),
  select(
    "microsteps",
    "Microstepping (as set on the driver)",
    "1",
    { 1: "Full step", 2: "1/2", 4: "1/4", 8: "1/8", 16: "1/16", 32: "1/32" },
    { when: STEPDIR },
  ),
  num(
    "ulnSteps",
    "Half-steps per revolution (28BYJ-48: 4096)",
    4096,
    8,
    100000,
    {
      integer: true,
      when: ULN,
    },
  ),
  num(
    "mmPerRev",
    "Travel per revolution (mm, e.g. lead screw 8)",
    8,
    0.01,
    10000,
    {
      when: { device: ["stepper"], input: ["distance", "distanceTo"] },
    },
  ),
  num("rpm", "Top speed (RPM)", 60, 0.1, 3000, { when: STEPPER }),
  num(
    "accel",
    "Acceleration (RPM per second, 0 = start at full speed)",
    120,
    0,
    100000,
    {
      when: STEPPER,
    },
  ),
  select(
    "idle",
    "When stopped",
    "hold",
    {
      hold: "Hold position (motor stays powered)",
      release: "Release (turns freely, stays cool)",
    },
    { when: STEPPER },
  ),
  select(
    "reverse",
    "Direction",
    "no",
    { no: "Normal", yes: "Reversed" },
    {
      when: STEPPER,
    },
  ),
  select("screen", "Display", "oled64", DISPLAYS, { when: DISPLAY }),
  pinField("sda", "SDA pin", 21, { when: DISPLAY }),
  pinField("scl", "SCL pin", 22, { when: DISPLAY }),
  select("addr", "I2C address", "auto", DISPLAY_ADDR, { when: DISPLAY }),
  num("line", "Line (0 = top)", 0, 0, 7, { integer: true, when: DISPLAY }),
  {
    key: "text",
    label: "Text ({{payload}} = the value received)",
    type: "text",
    default: "{{payload}}",
    when: DISPLAY,
  },
  select(
    "textSize",
    "Text size (OLED)",
    "1",
    {
      1: "Small (21 characters × 8 lines on 128×64)",
      2: "Medium (10 × 4)",
      3: "Large (7 × 2)",
    },
    { when: { device: ["i2cdisplay"], screen: ["oled64", "oled32"] } },
  ),
  select(
    "clear",
    "Before writing",
    "line",
    { line: "Clear this line only", screen: "Clear the whole screen" },
    { when: DISPLAY },
  ),
];
// Steps per revolution as the driver counts them, and steps per input unit.
const stepsPerRev = (c) =>
  c.driver === "uln2003" ? c.ulnSteps : c.stepsPerRev * Number(c.microsteps);
const MAX_STEP_RATE = 10000;
function stepsPerUnit(c) {
  const spr = stepsPerRev(c);
  if (c.input === "angle" || c.input === "angleTo") return spr / 360;
  if (c.input === "distance" || c.input === "distanceTo")
    return spr / c.mmPerRev;
  return 1;
}
function validateOutput(c) {
  if (c.device === "i2cdisplay") {
    const [lines] = displayGrid(c);
    if (c.line >= lines)
      throw Error(
        `I2C display: Line must be 0 to ${lines - 1} on this display${isOled(c) ? " with this text size" : ""}.`,
      );
    if (c.sda === c.scl) throw Error("I2C display: SDA and SCL must be different pins.");
    return;
  }
  if (c.device === "servo") {
    if (c.minUs >= c.maxUs)
      throw Error(
        "Servo: the pulse at 0° must be shorter than the pulse at full range.",
      );
    if (c.start > c.range)
      throw Error(
        `Servo: Start angle must be at most the angle range (${c.range}°).`,
      );
    return;
  }
  const rate = (c.rpm * stepsPerRev(c)) / 60;
  if (rate > MAX_STEP_RATE)
    throw Error(
      `Stepper: ${c.rpm} RPM is ${Math.round(rate)} steps per second; the board makes at most ${MAX_STEP_RATE}. Lower Top speed or the microstepping.`,
    );
  const pins =
    c.driver === "uln2003"
      ? [c.in1, c.in2, c.in3, c.in4]
      : [c.pin, c.dirPin, ...(c.enPin >= 0 ? [c.enPin] : [])];
  if (new Set(pins).size !== pins.length)
    throw Error("Stepper: each pin may be used once.");
  if (c.driver === "stepdir" && c.idle === "release" && c.enPin < 0)
    throw Error(
      "Stepper: Release needs the driver's ENABLE pin wired (set ENABLE pin), or choose Hold position.",
    );
}
const outputPins = [
  // I2C: one bus shared with other I2C devices (not a clash).
  { key: "sda", use: "out", sim: false, shared: "i2c", when: DISPLAY },
  { key: "scl", use: "out", sim: false, shared: "i2c", when: DISPLAY },
  { key: "pin", use: "pwm", sim: false, when: { device: ["servo"] } },
  { key: "pin", use: "out", sim: false, when: STEPDIR },
  { key: "dirPin", use: "out", sim: false, when: STEPDIR },
  { key: "enPin", use: "out", sim: false, when: STEPDIR },
  ...["in1", "in2", "in3", "in4"].map((key) => ({
    key,
    use: "out",
    sim: false,
    when: ULN,
  })),
];
const outputSummary = {
  servo: "Servo · GPIO {pin} · {servoIn}",
  stepper: "Stepper · {input} · {rpm} RPM",
  i2cdisplay: "{screen} · line {line}",
};
const outputHelp = {
  i2cdisplay:
    "I2C display: VCC to 3.3 V (or 5 V for most LCD backpacks), GND, SDA and SCL to the pins set here (the board's usual I2C pins). SSD1306 OLED (128×64 or 128×32, address 0x3C) or a 16×2 / 20×4 character LCD with a PCF8574 backpack (address 0x27, sometimes 0x3F). Each box writes its Text on its Line; boxes with the same address share the screen, so several boxes can show different values. {{payload}} is the value received. The value passes on, so the box can feed more nodes. Libraries (Adafruit SSD1306 + GFX, or LiquidCrystal I2C) are installed on the first build.",
  servo:
    "Hobby servo: signal wire (orange or white) to the pin, red to 5 V (a separate supply for big servos), brown or black to GND shared with the board. Send the angle (or a position, a pulse width, or a speed for a continuous-rotation servo). The node sends the angle on when the servo has got there (with a turn speed set, after the turn). Up to 6 servos on ESP32 boards.",
  stepper:
    "STEP / DIR driver (A4988, DRV8825, TMC2208…): STEP and DIR to the pins, ENABLE optional, motor power to the driver's VMOT. ULN2003 board: IN1–IN4 to four pins, 5 V and GND. Send an angle, a distance, a number of steps or a position; the node sends the position when the move is done. Also: stop (slows down and stops), zero (the present position becomes 0). Moves accelerate and slow down with the acceleration set. At most 10 000 steps per second; WiFi can make fast steps a little uneven.",
};

// ── Output firmware ──
const esp32Ledc3 =
  "defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3";
// One screen object per I2C address (a guard keeps it to one in the sketch).
function displayGlobals(n) {
  const c = n.config;
  const a = displayAddr(c).slice(2);
  const [rows, cols] = displayGrid(c);
  return isOled(c)
    ? `#ifndef MF_OLED_${a}
#define MF_OLED_${a}
Adafruit_SSD1306 mfOled${a}(128, ${c.screen === "oled32" ? 32 : 64}, &Wire, -1); // ${DISPLAYS[c.screen].replace(/"/g, "in")} at ${displayAddr(c)}
bool mfOledOk${a} = false;
#endif`
    : `#ifndef MF_LCD_${a}
#define MF_LCD_${a}
LiquidCrystal_I2C mfLcd${a}(${displayAddr(c)}, ${cols}, ${rows < 4 ? 2 : 4}); // ${cols}×${rows} LCD at ${displayAddr(c)}
#endif`;
}
function outputGlobals(n, i, build) {
  const c = n.config;
  const label = cText(n.label || "Output device");
  if (c.device === "i2cdisplay") return displayGlobals(n);
  if (c.device === "servo") {
    // ESP8266 / Pico Servo and Realtek AmebaServo share attach() / writeMicroseconds().
    const esp8266 = ["esp8266", "ameba", "rp2040"].includes(build?.family);
    const servoClass = build?.family === "ameba" ? "AmebaServo" : "Servo";
    const ch = build?.servoChannel?.get?.(n.id) ?? 0;
    const write = esp8266
      ? `  if (!mfServoOn${i}) { mfServo${i}.attach(${c.pin}, ${c.minUs}, ${c.maxUs}); mfServoOn${i} = true; }
  mfServo${i}.writeMicroseconds((int)(us + 0.5f));`
      : `  if (!mfServoOn${i}) {
#if ${esp32Ledc3}
    ledcAttach(${c.pin}, 50, 14);
#else
    ledcSetup(${ch}, 50, 14); ledcAttachPin(${c.pin}, ${ch});
#endif
    mfServoOn${i} = true;
  }
  uint32_t duty = (uint32_t)(us * 0.8192f); // 20 ms period, 14-bit
#if ${esp32Ledc3}
  ledcWrite(${c.pin}, duty);
#else
  ledcWrite(${ch}, duty);
#endif`;
    return `// ${label}: servo on GPIO ${c.pin}.
${esp8266 ? `${servoClass} mfServo${i};\n` : ""}bool mfServoOn${i} = false, mfServoMoving${i} = false;
float mfServoNow${i} = -1, mfServoTo${i} = -1;
unsigned long mfServoAt${i} = 0;
void mfServoUs${i}(float us) {
  if (us < ${c.minUs}) us = ${c.minUs};
  if (us > ${c.maxUs}) us = ${c.maxUs};
${write}
}
void mfServoAngle${i}(float a) { mfServoUs${i}(${fl(c.minUs)} + ${fl(c.maxUs - c.minUs)} * a / ${fl(c.range)}); }`;
  }
  // Stepper
  const spr = stepsPerRev(c);
  const vmax = (c.rpm * spr) / 60;
  const acc = (c.accel * spr) / 60;
  const rev = c.reverse === "yes";
  const uln = c.driver === "uln2003";
  const release = c.idle === "release";
  const pulse = uln
    ? `  static const uint8_t seq[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9}; // half steps
  mfStepPhase${i} = (mfStepPhase${i} + (dir > 0 ? ${rev ? 7 : 1} : ${rev ? 1 : 7})) & 7;
  mfStepCoils${i}(seq[mfStepPhase${i}]);`
    : `  if (dir != mfStepDirSet${i}) { digitalWrite(${c.dirPin}, dir > 0 ? ${rev ? "LOW" : "HIGH"} : ${rev ? "HIGH" : "LOW"}); mfStepDirSet${i} = dir; delayMicroseconds(2); }
  digitalWrite(${c.pin}, HIGH); delayMicroseconds(3); digitalWrite(${c.pin}, LOW);`;
  const power = uln
    ? `  static const uint8_t seq[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9};
  mfStepCoils${i}(on ? seq[mfStepPhase${i}] : 0);`
    : c.enPin >= 0
      ? `  digitalWrite(${c.enPin}, on ? LOW : HIGH); // ENABLE is active LOW`
      : "  (void)on;";
  const unit =
    c.input === "rpm"
      ? ""
      : `const float mfStepUnit${i} = ${fl(stepsPerUnit(c))}; // steps per input unit\n`;
  return `// ${label}: stepper motor (${uln ? `ULN2003 on GPIO ${c.in1}, ${c.in2}, ${c.in3}, ${c.in4}` : `STEP ${c.pin}, DIR ${c.dirPin}${c.enPin >= 0 ? `, ENABLE ${c.enPin}` : ""}`}).
${unit}long mfStepPos${i} = 0, mfStepTo${i} = 0;      // steps
float mfStepV${i} = 0, mfStepRunV${i} = 0;       // speed now (steps/s), Run at speed target (signed)
bool mfStepRunning${i} = false, mfStepBusy${i} = false, mfStepOn${i} = true;
int mfStepDir${i} = 1, mfStepDirSet${i} = 0;
uint8_t mfStepPhase${i} = 0;
unsigned long mfStepLast${i} = 0, mfStepGap${i} = 0;
${
  uln
    ? `void mfStepCoils${i}(uint8_t bits) {
  digitalWrite(${c.in1}, bits & 1 ? HIGH : LOW); digitalWrite(${c.in2}, bits & 2 ? HIGH : LOW);
  digitalWrite(${c.in3}, bits & 4 ? HIGH : LOW); digitalWrite(${c.in4}, bits & 8 ? HIGH : LOW);
}
`
    : ""
}void mfStepPower${i}(bool on) { // motor current on / off
  if (on == mfStepOn${i}) return;
  mfStepOn${i} = on;
${power}
}
void mfStepPulse${i}(int dir) {
${pulse}
}
// One step when it is due. Speed changes by the acceleration each step (v² ± 2a),
// so a move starts slowly, runs at top speed and slows down to stop on target.
// Returns true when a move (not Run at speed) has just ended.
bool mfStepRun${i}() {
  const float vmax = ${c.vmaxExpr || fl(vmax)}, acc = ${fl(acc)};
  const float vmin = acc > 0 ? sqrt(2 * acc) : vmax;
  long togo = mfStepTo${i} - mfStepPos${i};
  int want;
  float cap = vmax;
  if (mfStepRunning${i}) { want = mfStepRunV${i} > 0 ? 1 : mfStepRunV${i} < 0 ? -1 : 0; cap = fabs(mfStepRunV${i}); }
  else want = togo > 0 ? 1 : togo < 0 ? -1 : 0;
  unsigned long now = micros();
  if (mfStepV${i} == 0) {
    if (want == 0) { // at rest
      bool ended = mfStepBusy${i};
      mfStepBusy${i} = false;${
        release
          ? `
      mfStepPower${i}(false);`
          : ""
      }
      return ended;
    }
    mfStepDir${i} = want;
    mfStepV${i} = vmin < cap ? vmin : cap;
    mfStepPower${i}(true);
    mfStepLast${i} = now;
  } else {
    if (now - mfStepLast${i} < mfStepGap${i}) return false;
    mfStepLast${i} += mfStepGap${i};
    if (now - mfStepLast${i} > mfStepGap${i}) mfStepLast${i} = now; // fell behind: do not rush
    bool stopping = want != mfStepDir${i};
    if (acc <= 0) {
      if (stopping) { mfStepV${i} = 0; return false; }
      mfStepV${i} = cap;
    } else {
      float slower = mfStepV${i} * mfStepV${i} - 2 * acc;
      bool brake = !mfStepRunning${i} && labs(togo) <= (long)(mfStepV${i} * mfStepV${i} / (2 * acc));
      if (stopping) {
        if (slower < vmin * vmin) { mfStepV${i} = 0; return false; } // stopped: turn round, or rest
        mfStepV${i} = sqrt(slower);
      } else if (brake || mfStepV${i} > cap) {
        float v = sqrt(slower > vmin * vmin ? slower : vmin * vmin);
        mfStepV${i} = mfStepV${i} > cap && v < cap ? cap : v;
      } else {
        float v = sqrt(mfStepV${i} * mfStepV${i} + 2 * acc);
        mfStepV${i} = v < cap ? v : cap;
      }
    }
  }
  mfStepPulse${i}(mfStepDir${i});
  mfStepPos${i} += mfStepDir${i};
  mfStepGap${i} = (unsigned long)(1000000.0f / mfStepV${i});
  if (!mfStepRunning${i} && mfStepPos${i} == mfStepTo${i}) {
    mfStepV${i} = 0;
    mfStepBusy${i} = false;${release ? `\n    mfStepPower${i}(false);` : ""}
    return true;
  }
  return false;
}`;
}
function outputSetup(n, i) {
  const c = n.config;
  // The same text for every box on one screen: setup() keeps one copy.
  if (c.device === "i2cdisplay") {
    const a = displayAddr(c).slice(2);
    return isOled(c)
      ? `mfOledOk${a} = mfOled${a}.begin(SSD1306_SWITCHCAPVCC, ${displayAddr(c)}); if (mfOledOk${a}) { mfOled${a}.clearDisplay(); mfOled${a}.setTextColor(SSD1306_WHITE); mfOled${a}.display(); } else Serial.println("I2C display: no OLED at ${displayAddr(c)} (check wiring and address)");`
      : `mfLcd${a}.init(); mfLcd${a}.backlight(); mfLcd${a}.clear();`;
  }
  if (c.device === "servo")
    return c.servoIn !== "speed" && c.start >= 0
      ? `mfServoNow${i} = mfServoTo${i} = ${fl(c.start)}; mfServoAngle${i}(mfServoNow${i});`
      : "";
  const hold = c.idle === "hold";
  if (c.driver === "uln2003")
    return `${[c.in1, c.in2, c.in3, c.in4].map((p) => `pinMode(${p}, OUTPUT);`).join(" ")} mfStepPower${i}(${hold});`;
  return `pinMode(${c.pin}, OUTPUT); digitalWrite(${c.pin}, LOW); pinMode(${c.dirPin}, OUTPUT);${c.enPin >= 0 ? ` pinMode(${c.enPin}, OUTPUT); mfStepPower${i}(${hold});` : ""}`;
}
// The private "done" signal from loop() to the node function (as the Pulse node).
const DONE = "value.length() == 1 && value[0] == 31";
function outputBody(n, i) {
  const c = n.config;
  if (c.device === "i2cdisplay") {
    const a = displayAddr(c).slice(2);
    const [, cols] = displayGrid(c);
    const t = String(c.text ?? "{{payload}}");
    const text = t.includes("{{payload}}")
      ? `String t(${cText(t)}); t.replace("{{payload}}", value);`
      : `String t(${cText(t)});`;
    const fit = `if (t.length() > ${cols}) t = t.substring(0, ${cols});`;
    if (isOled(c)) {
      const size = Number(c.textSize) || 1;
      const y = c.line * 8 * size;
      return `{ if (!mfOledOk${a}) return; ${text} ${fit}
  ${c.clear === "screen" ? `mfOled${a}.clearDisplay();` : `mfOled${a}.fillRect(0, ${y}, 128, ${8 * size}, SSD1306_BLACK);`}
  mfOled${a}.setTextSize(${size}); mfOled${a}.setTextColor(SSD1306_WHITE); mfOled${a}.setCursor(0, ${y}); mfOled${a}.print(t); mfOled${a}.display(); }`;
    }
    return `{ ${text} ${fit} while (t.length() < ${cols}) t += ' ';
  ${c.clear === "screen" ? `mfLcd${a}.clear(); ` : ""}mfLcd${a}.setCursor(0, ${c.line}); mfLcd${a}.print(t); }`;
  }
  if (c.device === "servo") {
    if (c.servoIn === "speed")
      return `double x; if (!mfNumber(value, x)) return; if (x < -100) x = -100; if (x > 100) x = 100;
  mfServoUs${i}(${fl((c.minUs + c.maxUs) / 2)} + (float)x * ${fl((c.maxUs - c.minUs) / 200)});`;
    const toAngle = {
      angle: "x",
      percent: `x * ${fl(c.range / 100)}`,
      us: `(x - ${c.minUs}) * ${fl(c.range / (c.maxUs - c.minUs))}`,
    }[c.servoIn];
    return `if (${DONE}) { value = String(mfServoNow${i}, 1); } else {
  double x; if (!mfNumber(value, x)) return;
  float a = ${toAngle};
  if (a < 0) a = 0;
  if (a > ${c.range}) a = ${c.range};
  ${
    c.speed > 0
      ? `if (mfServoNow${i} >= 0) { mfServoTo${i} = a; mfServoMoving${i} = true; mfServoAt${i} = millis(); return; } // sent when it gets there
  `
      : ""
  }mfServoNow${i} = mfServoTo${i} = a; mfServoAngle${i}(a);
  value = String(a, 1); }`;
  }
  // Stepper
  const decimals = c.input.startsWith("distance")
    ? 2
    : c.input.startsWith("angle")
      ? 1
      : 0;
  const here =
    c.input === "rpm"
      ? "String(mfStepPos" + i + ")"
      : decimals
        ? `String(mfStepPos${i} / mfStepUnit${i}, ${decimals})`
        : `String(mfStepPos${i})`;
  const spr = stepsPerRev(c);
  const vmax = (c.rpm * spr) / 60;
  const acc = (c.accel * spr) / 60;
  const move = {
    angle: `mfStepTo${i} += lround(x * mfStepUnit${i});`,
    distance: `mfStepTo${i} += lround(x * mfStepUnit${i});`,
    steps: `mfStepTo${i} += lround(x);`,
    angleTo: `mfStepTo${i} = lround(x * mfStepUnit${i});`,
    distanceTo: `mfStepTo${i} = lround(x * mfStepUnit${i});`,
    position: `mfStepTo${i} = lround(x);`,
  }[c.input];
  const zero = `if (value == "zero") { mfStepTo${i} -= mfStepPos${i}; mfStepPos${i} = 0; value = "0"; }`;
  const stop = `if (value == "stop") {
    if (mfStepRunning${i}) mfStepRunV${i} = 0;
    else ${
      acc > 0
        ? `mfStepTo${i} = mfStepPos${i} + (mfStepV${i} > 0 ? mfStepDir${i} * (long)(mfStepV${i} * mfStepV${i} / ${fl(2 * acc)}) : 0);`
        : `mfStepTo${i} = mfStepPos${i};`
    }
    return;
  }`;
  if (c.input === "rpm")
    return `${zero} else {
  ${stop}
  double x; if (!mfNumber(value, x)) return;
  float v = (float)x * ${fl(spr / 60)};
  if (v > ${fl(vmax)}) v = ${fl(vmax)};
  if (v < ${fl(-vmax)}) v = ${fl(-vmax)};
  if (!mfStepRunning${i}) { mfStepRunning${i} = true; mfStepTo${i} = mfStepPos${i}; mfStepBusy${i} = false; }
  mfStepRunV${i} = v; }`;
  return `if (${DONE}) { value = ${here}; } else ${zero} else {
  ${stop}
  double x; if (!mfNumber(value, x)) return;
  if (mfStepRunning${i}) { mfStepRunning${i} = false; mfStepTo${i} = mfStepPos${i}; }
  ${move}
  mfStepBusy${i} = true;
  return; } // sent when the move is done`;
}
function outputLoop(n, i) {
  const c = n.config;
  if (c.device === "i2cdisplay") return "";
  if (c.device === "servo")
    return c.speed > 0 && c.servoIn !== "speed"
      ? `if (mfServoMoving${i} && millis() - mfServoAt${i} >= 20UL) {
    float step = ${fl(c.speed)} * (millis() - mfServoAt${i}) / 1000.0f;
    mfServoAt${i} = millis();
    float d = mfServoTo${i} - mfServoNow${i};
    if (fabs(d) <= step) { mfServoNow${i} = mfServoTo${i}; mfServoMoving${i} = false; }
    else mfServoNow${i} += d > 0 ? step : -step;
    mfServoAngle${i}(mfServoNow${i});
    if (!mfServoMoving${i}) node${i}(String((char)31));
  }`
      : "";
  return `if (mfStepRun${i}()) node${i}(String((char)31));`;
}
// ── Output simulation (PC): timing as on the board, values logged ──
// Seconds for a move of d steps from rest to rest (v max, a; a = 0: no ramps).
function moveTime(d, vmax, a) {
  if (d <= 0) return 0;
  if (!(a > 0)) return d / vmax;
  const ramp = (vmax * vmax) / (2 * a);
  return d >= 2 * ramp
    ? 2 * (vmax / a) + (d - 2 * ramp) / vmax
    : 2 * Math.sqrt(d / a);
}
function outputHost(v, n, ctx) {
  const c = n.config;
  const st = ctx.state;
  if (c.device === "i2cdisplay") {
    const [, cols] = displayGrid(c);
    const shown = displayText(c, v).slice(0, cols);
    ctx.log?.(`${n.label}: ${isOled(c) ? "OLED" : "LCD"} ${displayAddr(c)} line ${c.line}: ${shown}`);
    return v;
  }
  const text = String(v).trim();
  const x = toNumber(text);
  if (c.device === "servo") {
    if (x === null) return undefined;
    if (c.servoIn === "speed") {
      const s = Math.max(-100, Math.min(100, x));
      ctx.log?.(`${n.label}: servo speed ${s} %`);
      ctx.motion?.({ speed: s });
      return v;
    }
    const a = Math.max(
      0,
      Math.min(
        c.range,
        {
          angle: x,
          percent: (x * c.range) / 100,
          us: ((x - c.minUs) * c.range) / (c.maxUs - c.minUs),
        }[c.servoIn],
      ),
    );
    st.now ??= c.start >= 0 ? c.start : -1;
    ctx.cancel(st.timer);
    const ms =
      c.speed > 0 && st.now >= 0 ? (Math.abs(a - st.now) / c.speed) * 1000 : 0;
    ctx.log?.(
      `${n.label}: servo → ${fixed(a, 1)}°${ms ? ` (${Math.round(ms)} ms)` : ""}`,
    );
    ctx.motion?.({ angle: a, ms: Math.round(ms) });
    if (!ms) {
      st.now = a;
      return fixed(a, 1);
    }
    st.timer = ctx.later(ms, () => {
      st.now = a;
      ctx.forward(fixed(a, 1));
    });
    return undefined;
  }
  // Stepper
  const spr = stepsPerRev(c);
  const vmax = (c.rpm * spr) / 60;
  const acc = (c.accel * spr) / 60;
  const per = stepsPerUnit(c);
  const decimals = c.input.startsWith("distance")
    ? 2
    : c.input.startsWith("angle")
      ? 1
      : 0;
  const show = (steps) =>
    c.input === "rpm" ? String(steps) : fixed(steps / per, decimals);
  st.pos ??= 0;
  st.to ??= 0;
  // Where a move under way has got to (straight line in time; good enough here).
  const where = () =>
    st.moving
      ? Math.round(
          st.from +
            (st.to - st.from) * Math.min(1, (Date.now() - st.started) / st.ms),
        )
      : st.pos;
  if (text === "zero") {
    // Like the board: a move under way goes on, counted from the new zero.
    const p = where();
    st.from -= p;
    st.to -= p;
    st.pos -= p;
    ctx.log?.(`${n.label}: position set to 0`);
    return "0";
  }
  if (text === "stop") {
    ctx.cancel(st.timer);
    if (st.moving) {
      st.pos = st.to = where();
      st.moving = false;
      ctx.log?.(`${n.label}: stopped at ${show(st.pos)}`);
      ctx.forward(show(st.pos));
    }
    return undefined;
  }
  if (x === null) return undefined;
  if (c.input === "rpm") {
    const r = Math.max(-c.rpm, Math.min(c.rpm, x));
    ctx.log?.(`${n.label}: stepper running at ${r} RPM`);
    return v;
  }
  st.pos = where();
  ctx.cancel(st.timer);
  // Relative moves add to the target of a move under way, as on the board.
  const relative = ["angle", "distance", "steps"].includes(c.input);
  const amount = Math.round(
    c.input === "steps" || c.input === "position" ? x : x * per,
  );
  st.to = relative ? st.to + amount : amount;
  const ms = moveTime(Math.abs(st.to - st.pos), vmax, acc) * 1000;
  Object.assign(st, {
    from: st.pos,
    started: Date.now(),
    ms: ms || 1,
    moving: true,
  });
  ctx.log?.(
    `${n.label}: stepper ${st.to - st.pos >= 0 ? "+" : ""}${st.to - st.pos} steps → ${show(st.to)} (${Math.round(ms)} ms)`,
  );
  st.timer = ctx.later(ms, () => {
    st.pos = st.to;
    st.moving = false;
    ctx.forward(show(st.pos));
  });
  return undefined;
}

// ═══════════════════════════ Node definitions ═══════════════════════════
const inputDevice = {
  label: "Input device",
  icon: "◫",
  color: "#4f8f8b",
  tint: "#e3f2f0",
  group: "INPUT",
  source: true,
  needs: (c) => (c.device === "camera" ? "camera" : null),
  help: "A sensor read at a set interval: temperature, voltmeter, gyroscope / accelerometer, oscilloscope capture or camera. Choose the device in Properties; wiring help for it appears there.",
  helpBy: { key: "device", texts: inputHelp },
  fields: inputFields,
  pinSpec: inputPins,
  validate: validateInput,
  summary: inputSummary,
  summaryBy: "device",
  simulate: simulateInput,
  fw: { globals: inputGlobals, setup: inputSetup, loop: inputLoop },
};
const outputDevice = {
  label: "Output device",
  icon: "⚙",
  color: "#8a6fb0",
  tint: "#efe9f7",
  group: "OUTPUT",
  quietOutput: true, // a motor is an end point; its output is optional
  help: "Moves a servo motor or a stepper motor from the numbers it receives (angle, position, distance, steps or speed), or shows values on an I2C display (OLED or character LCD). Choose the device in Properties; wiring help for it appears there.",
  helpBy: { key: "device", texts: outputHelp },
  fields: outputFields,
  pinSpec: outputPins,
  validate: validateOutput,
  summary: outputSummary,
  summaryBy: "device",
  host: outputHost,
  fw: {
    globals: outputGlobals,
    setup: outputSetup,
    body: outputBody,
    loop: outputLoop,
  },
};
// C++ variable names and types in C/C++ nodes, per device (first match wins).
const varNames = {
  "input-device": [
    { when: { device: ["temp"] }, name: "TEMP" },
    { when: { device: ["volt"] }, name: "VOLT" },
    { when: { device: ["gyro"] }, name: "GYRO" },
    { when: { device: ["scope"] }, name: "SCOPE_IN" },
    { when: { device: ["camera"] }, name: "CAM" },
  ],
  "output-device": [
    { when: { device: ["servo"] }, name: "SERVO" },
    { when: { device: ["stepper"] }, name: "STEPPER" },
    { when: { device: ["i2cdisplay"] }, name: "SCREEN" },
  ],
  peripheral: [
    { when: { kind: ["servo"] }, name: "SERVO" },
    { when: { kind: ["stepper"] }, name: "STEPPER" },
    { when: { kind: ["gyro"] }, name: "GYRO" },
  ],
};
const varTypes = {
  "input-device": [
    { when: { device: ["gyro"], gyroOut: ["all"] }, type: "String" },
    { when: { device: ["scope"] }, type: "String" },
    { when: { device: ["camera"], camOut: ["both"] }, type: "String" },
    { when: { device: ["camera"], camOut: ["brightness"] }, type: "int" },
    {
      when: { device: ["temp"], sensor: DHT, dhtOut: ["both"] },
      type: "String",
    },
    { when: {}, type: "double" },
  ],
  "output-device": [
    { when: { device: ["i2cdisplay"] }, type: "String" },
    { when: {}, type: "double" },
  ],
  peripheral: [
    { when: { kind: ["gyro"], gyroOut: ["all"] }, type: "String" },
    { when: {}, type: "double" },
  ],
};

// ═══════════════════════════ Flow-wide parts ═══════════════════════════
// A Peripheral node counts as the device it drives (pins, I2C bus, libraries), and
// a Status node (lib/statusfw.js) as an I2C display.
const asDevice = (n) =>
  n.type === "status"
    ? {
        ...n,
        type: "output-device",
        config: { ...n.config, device: "i2cdisplay" },
      }
    : n.type !== "peripheral"
    ? n
    : {
        ...n,
        type: n.config.kind === "gyro" ? "input-device" : "output-device",
        config: { ...n.config, device: n.config.kind, input: "angle" },
      };
const devicesOf = (nodes, type, device) =>
  nodes
    .map(asDevice)
    .filter((n) => n.type === type && (!device || n.config.device === device));
const temps = (nodes, sensors) =>
  devicesOf(nodes, "input-device", "temp").filter((n) =>
    sensors.includes(n.config.sensor),
  );
// Arduino libraries the flow needs (installed with arduino-cli before compiling).
function libraries(nodes) {
  const libs = [];
  if (temps(nodes, ["ds18b20"]).length)
    libs.push("OneWire", "DallasTemperature");
  if (temps(nodes, DHT).length)
    libs.push("DHT sensor library", "Adafruit Unified Sensor");
  const screens = devicesOf(nodes, "output-device", "i2cdisplay");
  if (screens.some((n) => isOled(n.config)))
    libs.push("Adafruit SSD1306", "Adafruit GFX Library");
  if (screens.some((n) => !isOled(n.config))) libs.push("LiquidCrystal I2C");
  return libs;
}
function includes(nodes, family, i2cAlready) {
  const out = [];
  const screens = devicesOf(nodes, "output-device", "i2cdisplay");
  if (
    (devicesOf(nodes, "input-device", "gyro").length || screens.length) &&
    !i2cAlready
  )
    out.push("#include <Wire.h>");
  if (screens.some((n) => isOled(n.config)))
    out.push("#include <Adafruit_GFX.h>", "#include <Adafruit_SSD1306.h>");
  if (screens.some((n) => !isOled(n.config)))
    out.push("#include <LiquidCrystal_I2C.h>");
  // The Image sensor and the Camera node (lib/camerafw.js) use the camera driver.
  if (
    devicesOf(nodes, "input-device", "camera").length ||
    nodes.some((n) => n.type === "camera")
  )
    out.push('#include "esp_camera.h"');
  // Auto resolution reads the real flash size (lib/camerafw.js).
  if (nodes.some((n) => n.type === "camera" && n.config?.size === "auto"))
    out.push('#include "esp_flash.h"');
  if (temps(nodes, ["ds18b20"]).length)
    out.push("#include <OneWire.h>", "#include <DallasTemperature.h>");
  if (temps(nodes, DHT).length) out.push("#include <DHT.h>");
  if ((family === "esp8266" || family === "rp2040") && devicesOf(nodes, "output-device", "servo").length)
    out.push("#include <Servo.h>");
  if (family === "ameba" && devicesOf(nodes, "output-device", "servo").length)
    out.push("#include <AmebaServo.h>");
  return out.length ? out.join("\n") + "\n" : "";
}
// setup(): one Wire.begin for the gyroscopes, unless Radio I2C already starts the bus.
function setup(nodes, i2cAlready) {
  const gyro = devicesOf(nodes, "input-device", "gyro")[0];
  const screen = devicesOf(nodes, "output-device", "i2cdisplay")[0];
  const bus = gyro || screen;
  return bus && !i2cAlready
    ? [
        `Wire.begin(${bus.config.sda}, ${bus.config.scl}); // I2C for the ${gyro ? "MPU-6050" : "display"}${gyro && screen ? " and the display" : ""}`,
      ]
    : [];
}
// ESP32 core 2.x LEDC channel of each servo (0–5: the first timers, apart from the
// channels analogWrite takes from the top and the camera's channel 7).
const servoChannels = (nodes) =>
  new Map(devicesOf(nodes, "output-device", "servo").map((n, k) => [n.id, k]));
// Board checks for the whole flow (lib/flow.js analyze()).
function check(flow, board) {
  const errors = [],
    warnings = [];
  // The OneWire library (DS18B20) does not support the ESP32-P4's GPIO registers.
  if (board.chip === "esp32p4")
    for (const n of temps(flow.nodes, ["ds18b20"]))
      errors.push(
        `${n.label}: the DS18B20 needs the OneWire library, which does not build for the ESP32-P4. Use a DHT22 / DHT11, an NTC or an LM35 / TMP36 on this board.`,
      );
  const gyros = devicesOf(flow.nodes, "input-device", "gyro");
  const radioI2c = flow.nodes.filter(
    (n) =>
      (n.type === "mqtt-in" || n.type === "mqtt-out") &&
      n.config.protocol === "i2c",
  );
  if (gyros.length) {
    const [g] = gyros;
    if (
      gyros.some(
        (n) => n.config.sda !== g.config.sda || n.config.scl !== g.config.scl,
      )
    )
      errors.push(
        "Gyroscopes share one I2C bus: give them all the same SDA and SCL pins.",
      );
    const addresses = gyros.map((n) => n.config.address);
    if (new Set(addresses).size !== addresses.length)
      errors.push(
        "Two gyroscopes have the same I2C address: set AD0 on one of them to 3.3 V and choose 0x69 for it.",
      );
    if (gyros.length > 2)
      errors.push(
        "At most two MPU-6050 gyroscopes fit on one I2C bus (0x68 and 0x69).",
      );
    if (radioI2c.some((n) => n.config.i2cRole === "peripheral"))
      errors.push(
        `${g.label}: this board is an I2C peripheral (Radio in/out), so it cannot also read an MPU-6050. Use the I2C controller role, or another board for the sensor.`,
      );
    else if (
      radioI2c.some(
        (n) => n.config.sda !== g.config.sda || n.config.scl !== g.config.scl,
      )
    )
      errors.push(
        `${g.label}: the MPU-6050 shares the I2C bus with Radio in/out: use the same SDA and SCL pins (${radioI2c[0].config.sda}, ${radioI2c[0].config.scl}).`,
      );
  }
  // I2C displays share the bus with gyroscopes and Radio I2C (one SDA / SCL pair).
  const screens = devicesOf(flow.nodes, "output-device", "i2cdisplay");
  if (screens.length) {
    const bus = [...gyros, ...screens, ...radioI2c];
    const [b] = bus;
    if (
      bus.some((n) => n.config.sda !== b.config.sda || n.config.scl !== b.config.scl)
    )
      errors.push(
        `I2C devices share one bus: give every I2C display${gyros.length ? ", gyroscope" : ""}${radioI2c.length ? " and Radio I2C box" : ""} the same SDA and SCL pins (${b.config.sda}, ${b.config.scl}).`,
      );
    if (radioI2c.some((n) => n.config.i2cRole === "peripheral"))
      errors.push(
        `${screens[0].label}: this board is an I2C peripheral (Radio in/out), so it cannot also drive an I2C display. Use the I2C controller role, or another board for the display.`,
      );
    const byAddr = new Map();
    for (const n of screens) {
      const a = displayAddr(n.config);
      const other = byAddr.get(a);
      if (other && other.config.screen !== n.config.screen)
        errors.push(
          `${n.label} and ${other.label} use the same I2C address ${a} but different displays: one address is one screen.`,
        );
      byAddr.set(a, n);
      if (
        other &&
        other.config.line === n.config.line &&
        (Number(other.config.textSize) || 1) === (Number(n.config.textSize) || 1)
      )
        warnings.push(
          `${n.label} and ${other.label} write the same line ${n.config.line} of the display at ${a}: the last value wins. Choose different lines to show both.`,
        );
    }
    if (gyros.some((g) => ["0x68", "0x69"].includes(displayAddr(screens[0].config))))
      errors.push("An I2C display cannot use a gyroscope's address.");
  }
  const cams = devicesOf(flow.nodes, "input-device", "camera");
  if (cams.length > 1)
    errors.push("A board has one camera: use one Image sensor node.");
  for (const n of devicesOf(flow.nodes, "input-device", "scope"))
    if (board.family === "esp8266" && n.config.rate > 2000)
      warnings.push(
        `${n.label}: on ESP8266 boards, sampling faster than 2000/s can drop WiFi. Lower the sample rate.`,
      );
  for (const n of temps(flow.nodes, ANALOG_SENSORS).concat(
    devicesOf(flow.nodes, "input-device", "volt"),
  ))
    if (
      board.family === "esp8266" &&
      n.config.fullScale > 3.3 &&
      n.config.fullScale !== 3.2
    )
      warnings.push(
        `${n.label}: check the A0 full scale (${n.config.fullScale} V); NodeMCU and D1 mini boards read 0–3.2 V.`,
      );
  const servos = devicesOf(flow.nodes, "output-device", "servo");
  if (board.family === "esp32" && servos.length > 6)
    errors.push(
      `At most 6 servos on ${board.label} (it has ${servos.length}).`,
    );
  for (const n of devicesOf(flow.nodes, "output-device", "stepper")) {
    const rate = (n.config.rpm * stepsPerRev(n.config)) / 60;
    if (board.family === "esp8266" && rate > 3000)
      warnings.push(
        `${n.label}: ${Math.round(rate)} steps per second is a lot for an ESP8266 with WiFi on; steps may be uneven. Lower Top speed or the microstepping.`,
      );
    if (n.config.driver === "uln2003" && n.config.rpm > 15)
      warnings.push(
        `${n.label}: a 28BYJ-48 usually stalls above about 15 RPM.`,
      );
  }
  return { errors, warnings };
}
module.exports = {
  displayGrid,
  displayAddr,
  // For the Status node (lib/statusfw.js), which is an I2C display too.
  DISPLAYS,
  DISPLAY_ADDR,
  isOled,
  displayGlobals,
  // For the Peripheral node (lib/peripheral.js), which drives the same devices.
  inputFields,
  outputFields,
  inputPins,
  outputPins,
  inputGlobals,
  outputGlobals,
  outputSetup,
  outputLoop,
  validateOutput,
  simulateInput,
  gyroText,
  stepsPerUnit,
  asDevice,
  fl,
  MAX_STEP_RATE,
  inputDevice,
  outputDevice,
  whenMatches,
  varNames,
  varTypes,
  libraries,
  includes,
  setup,
  check,
  servoChannels,
  stepsPerRev,
  moveTime,
  INPUT_DEVICES,
  OUTPUT_DEVICES,
};
