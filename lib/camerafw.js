// Camera node (Freenove ESP32-S3 WROOM CAM only): each rising edge (off → on) on its
// input takes a still picture. The board keeps the latest one in PSRAM and serves it
// as a PNG file at http://<board IP>/camera/<node id>.png; the PNG is encoded while it
// is sent (stored deflate blocks), so it needs no memory beyond the picture itself.
// The node sends {"image": <that URL>, "width", "height", "shot"}; debug builds also
// report it to the IDE, which saves each picture as a PNG file on the PC and shows
// it in a floating window (public/app.js).
const { on } = require("./logic");
const png = require("./png");

const SENSORS = {
  ov2640: "OV2640 (2 MP, up to 1600 × 1200)",
  ov3660: "OV3660 (3 MP, up to 2048 × 1536)",
  ov5640: "OV5640 (5 MP, up to 2560 × 1920)",
};
// Sensor IDs as esp32-camera reports them (sensor->id.PID).
const PID = { ov2640: "0x26", ov3660: "0x3660", ov5640: "0x5640" };
const SIZES = {
  QVGA: [320, 240],
  VGA: [640, 480],
  SVGA: [800, 600],
  XGA: [1024, 768],
  HD: [1280, 720],
  SXGA: [1280, 1024],
  UXGA: [1600, 1200],
  QXGA: [2048, 1536],
  QSXGA: [2560, 1920],
};
// The largest picture each sensor takes.
const SENSOR_MAX = { ov2640: "UXGA", ov3660: "QXGA", ov5640: "QSXGA" };
// PSRAM the picture may use: the Freenove board's 8 MB (N8R8 and N16R8 alike; the
// first number is flash, which does not hold pictures), less what Wi-Fi, the web
// server and MQTT take from it.
const PSRAM = 8 * 1024 * 1024;
const MARGIN = 512 * 1024;
const bytes = (size, color) =>
  SIZES[size][0] * SIZES[size][1] * (color === "gray" ? 1 : 2);
const ORDER = Object.keys(SIZES).reverse(); // largest first
// Auto: the largest picture the sensor takes that fits in memory.
function autoSize(sensor, color, free = PSRAM - MARGIN) {
  const order = ORDER.filter((k) => k !== "HD"); // 4:3 and 5:4 pictures only
  const max = order.indexOf(SENSOR_MAX[sensor] || "UXGA");
  return order.slice(max).find((k) => bytes(k, color) <= free) || "QVGA";
}
const sizeOf = (c) =>
  c.size === "auto" ? autoSize(c.sensor, c.color) : c.size || "VGA";
// Settings that cannot work: a size the sensor does not take, or too large for PSRAM.
function problems(n) {
  const c = n.config || {};
  const label = n.label || "Camera";
  const size = c.size || "auto";
  if (size === "auto" || !SIZES[size]) return [];
  const sensor = c.sensor || "ov2640";
  const out = [];
  if (ORDER.indexOf(size) < ORDER.indexOf(SENSOR_MAX[sensor]))
    out.push(
      `${label}: the ${sensor.toUpperCase()} takes pictures up to ${SENSOR_MAX[sensor]}; choose a smaller resolution or Auto.`,
    );
  else if (bytes(size, c.color) > PSRAM - MARGIN)
    out.push(
      `${label}: a ${size} colour picture needs ${(bytes(size, c.color) / 1048576).toFixed(1)} MB, more than the board's 8 MB PSRAM leaves free; choose Grey, a smaller resolution or Auto.`,
    );
  return out;
}
const level = (key, label) => ({
  key,
  label,
  type: "number",
  default: 0,
  min: -2,
  max: 2,
  integer: true,
});
const fields = [
  {
    key: "sensor",
    label: "Image sensor",
    type: "select",
    default: "ov2640",
    options: SENSORS,
  },
  {
    key: "size",
    label: "Resolution",
    type: "select",
    default: "auto",
    options: {
      auto: "Auto (largest the sensor and memory allow)",
      ...Object.fromEntries(
        Object.entries(SIZES).map(([k, [w, h]]) => [k, `${k} · ${w} × ${h}`]),
      ),
    },
  },
  {
    key: "color",
    label: "Colour",
    type: "select",
    default: "color",
    options: {
      color: "Colour (24-bit RGB)",
      gray: "Grey (8-bit, smaller file)",
    },
  },
  level("brightness", "Brightness (−2 … 2)"),
  level("contrast", "Contrast (−2 … 2)"),
  level("saturation", "Saturation (−2 … 2)"),
  {
    key: "whiteBalance",
    label: "White balance",
    type: "select",
    default: "auto",
    options: {
      auto: "Auto",
      sunny: "Sunny",
      cloudy: "Cloudy",
      office: "Office (fluorescent)",
      home: "Home (incandescent)",
    },
  },
  {
    key: "mirror",
    label: "Mirror (left ↔ right)",
    type: "select",
    default: "no",
    options: { no: "No", yes: "Yes" },
  },
  {
    key: "flip",
    label: "Flip (upside down)",
    type: "select",
    default: "no",
    options: { no: "No", yes: "Yes" },
  },
  {
    key: "live",
    label: "Live video page (for focusing)",
    type: "select",
    default: "VGA",
    options: {
      off: "Off",
      QVGA: "QVGA · 320 × 240 (smoothest)",
      VGA: "VGA · 640 × 480",
      SVGA: "SVGA · 800 × 600 (most detail)",
    },
  },
];
const LIVE_MINUTES = 5; // the live video stops by itself after this
const help =
  'Takes a still picture on each rising edge (off → on) of its input, e.g. from a push button, a Logic or a Timer node. The board keeps the latest picture and serves it as a PNG file at http://<board IP>/camera/<node id>.png; the node sends {"image": that address, "width", "height", "shot"}. With a debug build (or the PC simulator) Microflow saves each picture as a PNG file in its captures folder; 🖼 on the box opens it in a floating window that stays on top, on any monitor. For focusing, open http://<board IP>/camera/live: live video with a sharpness number (set its size in Live video page; the flow pauses while it is open). Freenove ESP32-S3 WROOM CAM only. Sending a large picture takes a few seconds, during which the flow waits.';
const ESP_WB = { auto: 0, sunny: 1, cloudy: 2, office: 3, home: 4 };

// ── Simulator ──
// A test picture: colour bars, a grey ramp and a white block that moves each shot.
function testPicture(c, shot) {
  const [w, h] = SIZES[sizeOf(c)];
  const ch = c.color === "gray" ? 1 : 3;
  const px = Buffer.alloc(w * h * ch);
  const bars = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 0],
  ];
  const block = Math.floor(h / 6);
  const bx = ((shot * 97) % Math.max(1, w - block)) | 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let rgb;
      if (y >= h - block * 2 && y < h - block && x >= bx && x < bx + block)
        rgb = [255, 255, 255];
      else if (y < (h * 2) / 3) rgb = bars[Math.floor((x * 8) / w)];
      else {
        const g = Math.round((x * 255) / (w - 1));
        rgb = [g, g, g];
      }
      const k = (y * w + x) * ch;
      if (ch === 1)
        px[k] = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
      else [px[k], px[k + 1], px[k + 2]] = rgb;
    }
  return png.encode(w, h, ch, px);
}
function host(v, n, ctx) {
  const st = ctx.state;
  const now = on(v);
  const rise = now && !st.level;
  st.level = now;
  if (!rise) return undefined;
  st.shot = (st.shot || 0) + 1;
  const [width, height] = SIZES[sizeOf(n.config)];
  const url = ctx.still?.(testPicture(n.config, st.shot), st.shot);
  const out = JSON.stringify({ image: url, width, height, shot: st.shot });
  ctx.camera?.(out);
  return out;
}

// ── Firmware ──
function globals(n, i, build) {
  const c = n.config;
  const auto = c.size === "auto";
  const pins = build?.camera || {};
  const label = (n.label || "Camera")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "'");
  const report =
    build?.debug && build?.net
      ? `\n  if (mfTelemetry && mqtt.connected()) mqtt.publish((mfBase + "/debug/${n.id}").c_str(), what.c_str());`
      : "";
  const gray = c.color === "gray";
  const config = `  camera_config_t c;
  memset(&c, 0, sizeof(c));
  c.ledc_channel = LEDC_CHANNEL_7;
  c.ledc_timer = LEDC_TIMER_3;
${Object.entries(pins)
  .map(
    ([k, p]) =>
      `  c.pin_${{ sda: "sccb_sda", scl: "sccb_scl" }[k] || k} = ${p};`,
  )
  .join("\n")}
  c.xclk_freq_hz = 20000000;
  c.pixel_format = ${gray ? "PIXFORMAT_GRAYSCALE" : "PIXFORMAT_RGB565"};
  c.frame_size = ${auto ? `mfStillSize${i}[k]` : `FRAMESIZE_${c.size}`};
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;`;
  const settings = `  s->set_brightness(s, ${c.brightness});
  s->set_contrast(s, ${c.contrast});
  s->set_saturation(s, ${c.saturation});
  s->set_whitebal(s, 1);
  s->set_awb_gain(s, ${c.whiteBalance === "auto" ? 1 : 0});
  s->set_wb_mode(s, ${ESP_WB[c.whiteBalance]});
  // OV3660 and OV5640 modules are mounted the other way up.
  s->set_vflip(s, ${auto ? `(s->id.PID != 0x26) != ${c.flip === "yes"}` : (c.flip === "yes") !== (c.sensor !== "ov2640") ? 1 : 0});
  s->set_hmirror(s, ${c.mirror === "yes" ? 1 : 0});`;
  const mismatch = `if (s->id.PID != ${PID[c.sensor]}) mfStillSay${i}(String("the image sensor is not the ${c.sensor.toUpperCase()} set in the Camera node (sensor id 0x") + String((unsigned long)s->id.PID, HEX) + ")");`;
  const head = `// Camera "${label}": ${SENSORS[c.sensor]}, ${auto ? "Auto resolution" : c.size}, ${gray ? "grey" : "colour"}; the latest picture stays in PSRAM.
camera_fb_t* mfStill${i} = NULL;
bool mfStillOk${i} = false, mfStillLevel${i} = false;
uint32_t mfStillShot${i} = 0;
void mfStillSay${i}(const String& what) {
  Serial.print("${label}: "); Serial.println(what);${report}
}`;
  // Live video (focusing): JPEG frames at a low resolution, two buffers so the next
  // frame is taken while one is sent. Opened by the live page, closed after it.
  const live =
    c.live && c.live !== "off"
      ? `
bool mfLiveBegin${i}() {
${config
  .replace(/c\.pixel_format = .*;/, "c.pixel_format = PIXFORMAT_JPEG;")
  .replace(/c\.frame_size = .*;/, `c.frame_size = FRAMESIZE_${c.live};`)
  .replace("c.fb_count = 1;", "c.fb_count = 2;")
  .replace("CAMERA_GRAB_WHEN_EMPTY", "CAMERA_GRAB_LATEST")}
  if (esp_camera_init(&c) != ESP_OK) return false;
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return false;
${settings}
  return true;
}`
      : "";
  if (!auto)
    return `${head}${live}
bool mfStillBegin${i}() {
${config}
  if (esp_camera_init(&c) != ESP_OK) { mfStillSay${i}("the camera does not start; check the ribbon cable"); return false; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return false;
  ${mismatch}
${settings}
  return true;
}`;
  // Auto: at power-up the board measures its PSRAM and asks the sensor what it is,
  // then takes the largest picture that both allow; a size that does not start (or
  // later gives no picture) steps down to the next one.
  const list = ORDER.filter((k) => k !== "HD"); // 4:3 / 5:4 sizes only
  const max = (s) => list.indexOf(SENSOR_MAX[s]);
  return `${head}${live}
const framesize_t mfStillSize${i}[] = {${list.map((k) => `FRAMESIZE_${k}`).join(", ")}};
const uint16_t mfStillW${i}[] = {${list.map((k) => SIZES[k][0]).join(", ")}};
const uint16_t mfStillH${i}[] = {${list.map((k) => SIZES[k][1]).join(", ")}};
const char* const mfStillName${i}[] = {${list.map((k) => `"${k}"`).join(", ")}};
const int mfStillCount${i} = ${list.length};
int mfStillPick${i} = -1; // the size in use (index in the lists above)
String mfStillInfo${i}; // what Auto chose, and why
int mfStillShown${i} = -1; // the size last reported
int mfStillMax${i}(uint16_t pid) { return pid == 0x5640 ? ${max("ov5640")} : pid == 0x3660 ? ${max("ov3660")} : ${max("ov2640")}; }
String mfStillMB${i}(uint32_t b) { return String(b / 1048576.0, 1) + " MB"; }
bool mfStillTry${i}(int k) {
${config}
  return esp_camera_init(&c) == ESP_OK;
}
bool mfStillBegin${i}(int from = 0) {
  uint32_t psram = ESP.getPsramSize(), free = ESP.getFreePsram();
  uint32_t flash = ESP.getFlashChipSize();
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  { uint32_t real = 0; if (esp_flash_get_physical_size(NULL, &real) == ESP_OK && real) flash = real; }
#endif
  uint32_t room = free > ${MARGIN} ? free - ${MARGIN} : 0; // keep some PSRAM for Wi-Fi and the web server
  for (int k = from; k < mfStillCount${i}; k++) {
    if ((uint32_t)mfStillW${i}[k] * mfStillH${i}[k] * ${gray ? 1 : 2} > room) continue;
    if (!mfStillTry${i}(k)) { esp_camera_deinit(); continue; }
    sensor_t* s = esp_camera_sensor_get();
    if (!s) { esp_camera_deinit(); return false; }
    int top = mfStillMax${i}(s->id.PID);
    if (k < top) { esp_camera_deinit(); k = top - 1; continue; } // larger than this sensor takes
    ${mismatch}
${settings.replace(/^/gm, "  ")}
    mfStillPick${i} = k;
    mfStillInfo${i} = String("auto: ") + mfStillName${i}[k] + " " + String(mfStillW${i}[k]) + " x " + String(mfStillH${i}[k]) + "${gray ? " grey" : " colour"} · module N" + String(flash / 1048576) + "R" + String(psram / 1048576) + " · PSRAM " + mfStillMB${i}(psram) + " (" + mfStillMB${i}(free) + " free) · sensor 0x" + String((unsigned long)s->id.PID, HEX);
    mfStillSay${i}(mfStillInfo${i}); // on the serial monitor now; to the IDE with the first picture
    return true;
  }
  mfStillSay${i}(psram ? "the camera does not start; check the ribbon cable" : "no PSRAM found: choose the board's OPI PSRAM setting");
  return false;
}`;
}
const setup = (n, i) => `mfStillOk${i} = mfStillBegin${i}();`;
function body(n, i, build) {
  return `bool level = mfJson::asBool(value);
  bool rise = level && !mfStillLevel${i};
  if (level && mfStillLevel${i}) Serial.println("${(n.label || "Camera").replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "'")}: input still on: a picture needs off (0) then on (1); or type camera");
  mfStillLevel${i} = level;
  if (!rise) return;
  if (!mfStillOk${i}) mfStillOk${i} = mfStillBegin${i}();
  if (mfStill${i}) { esp_camera_fb_return(mfStill${i}); mfStill${i} = NULL; } // the camera takes a new picture
  camera_fb_t* fb = mfStillOk${i} ? esp_camera_fb_get() : NULL;${
    n.config.size === "auto"
      ? `
  while (!fb && mfStillOk${i} && mfStillPick${i} + 1 < mfStillCount${i}) { // too large to take: one size smaller
    mfStillSay${i}(String("no picture at ") + mfStillName${i}[mfStillPick${i}] + "; trying a smaller size");
    esp_camera_deinit();
    mfStillOk${i} = mfStillBegin${i}(mfStillPick${i} + 1);
    fb = mfStillOk${i} ? esp_camera_fb_get() : NULL;
  }`
      : ""
  }
  if (!fb) { mfStillSay${i}("no picture (camera not ready)"); return; }
  mfStill${i} = fb;
  mfStillShot${i}++;${
    n.config.size === "auto"
      ? `
  // Tell the IDE which size Auto chose (again after stepping down).
  if (mfStillPick${i} != mfStillShown${i}) { mfStillSay${i}(mfStillInfo${i}); mfStillShown${i} = mfStillPick${i}; }`
      : ""
  }
  value = String("{\\"image\\":\\"http://") + ${build?.net ? "WiFi.localIP().toString()" : 'String("0.0.0.0")'} + "/camera/${n.id}.png\\",\\"width\\":" + String((int)fb->width) + ",\\"height\\":" + String((int)fb->height) + ",\\"shot\\":" + String((unsigned long)mfStillShot${i}) + "}";
  mfStillSay${i}(value);`;
}
// The live video page: the picture, and a sharpness number to turn the lens by (the
// variation between neighbouring pixels in the middle of the picture: highest when
// the picture is in focus).
const LIVE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camera live view</title>
<style>body{margin:0;background:#101511;color:#e8efe9;font:14px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px}
img{max-width:100%;background:#000;border:1px solid #2f4a37}#bar{width:min(640px,100%);height:14px;background:#1d2a21;border-radius:7px;overflow:hidden}
#fill{height:100%;width:0;background:#6fbf73}#best{color:#a9bcae}p{color:#a9bcae;max-width:640px;text-align:center;margin:0}button{font:inherit;padding:4px 12px}</style></head>
<body><b>Camera live view · focusing</b><img id="v" alt="Live video from the camera"><div id="bar"><div id="fill"></div></div>
<div>Sharpness <b id="now">-</b> <span id="best"></span> <button id="reset">Reset best</button></div>
<p>Turn the lens slowly until sharpness is highest (point the camera at something with fine detail, e.g. printed text). The board's flow pauses while this page is open; the video stops after ${LIVE_MINUTES} minutes or when you close the page, and the camera goes back to still pictures.</p>
<p id="state"></p><script>
const v=document.getElementById("v"),now=document.getElementById("now"),best=document.getElementById("best"),fill=document.getElementById("fill"),state=document.getElementById("state");
let peak=0;document.getElementById("reset").onclick=()=>{peak=0};
function start(){state.textContent="";v.src="/camera/live.mjpg?"+Date.now()}
v.onerror=()=>{state.innerHTML='The video stopped. <button onclick="start()">Start again</button>'};
const c=document.createElement("canvas"),g=c.getContext("2d",{willReadFrequently:true});
setInterval(()=>{if(!v.naturalWidth)return;const w=Math.floor(v.naturalWidth/3),h=Math.floor(v.naturalHeight/3);c.width=w;c.height=h;
try{g.drawImage(v,w,h,w,h,0,0,w,h)}catch(e){return}const d=g.getImageData(0,0,w,h).data;let sum=0,n=0;
for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const k=(y*w+x)*4,l=d[k]+d[k+1]+d[k+2];const lx=d[k+4]+d[k+5]+d[k+6]-(d[k-4]+d[k-3]+d[k-2]),ly=d[k+w*4]+d[k+w*4+1]+d[k+w*4+2]-(d[k-w*4]+d[k-w*4+1]+d[k-w*4+2]);sum+=lx*lx+ly*ly;n++}
const s=Math.round(Math.sqrt(sum/n));peak=Math.max(peak,s);now.textContent=s;best.textContent="(best "+peak+")";fill.style.width=(peak?100*s/peak:0)+"%"},300);
start();</script></body></html>`;
function liveWeb(n, i) {
  const page = LIVE_PAGE.replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `// Live video for focusing: /camera/live (page) and /camera/live.mjpg (MJPEG).
const char MF_LIVE_PAGE[] PROGMEM = "${page}";
void mfLiveSend${i}() {
  if (mfStill${i}) { esp_camera_fb_return(mfStill${i}); mfStill${i} = NULL; } // the last still picture is dropped
  esp_camera_deinit();
  if (!mfLiveBegin${i}()) {
    esp_camera_deinit();
    mfStillOk${i} = mfStillBegin${i}();
    mfWebSend(503, "text/plain", "the camera did not start live video");
    return;
  }
  mfStillSay${i}("live video on: the flow pauses until the page is closed");
  WiFiClient client = mfWeb.client();
  client.print("HTTP/1.1 200 OK\\r\\nContent-Type: multipart/x-mixed-replace; boundary=mfframe\\r\\nCache-Control: no-store\\r\\nAccess-Control-Allow-Origin: *\\r\\nConnection: close\\r\\n\\r\\n");
  unsigned long start = millis();
  uint32_t frames = 0;
  while (client.connected() && millis() - start < ${LIVE_MINUTES * 60000}UL) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { delay(5); continue; }
    char head[96];
    snprintf(head, sizeof head, "--mfframe\\r\\nContent-Type: image/jpeg\\r\\nContent-Length: %u\\r\\n\\r\\n", (unsigned)fb->len);
    bool sent = client.print(head) > 0 && client.write(fb->buf, fb->len) == fb->len && client.print("\\r\\n") > 0;
    esp_camera_fb_return(fb);
    if (!sent) break;
    frames++;
    if (mqtt.connected()) mqtt.loop(); // stay connected to the broker
    delay(1);
  }
  client.stop();
  esp_camera_deinit();
  mfStillOk${i} = mfStillBegin${i}();
  mfStillSay${i}(String("live video off after ") + String((unsigned long)frames) + " frames (" + String((millis() - start) / 1000) + " s); back to still pictures");
}`;
}
// The web server's PNG streaming and its /camera/<id>.png routes (lib/webfw.js).
function webGlobals(nodes, index) {
  const cams = nodes.filter((n) => n.type === "camera");
  if (!cams.length) return "";
  return `// Camera pictures as PNG files, encoded while they are sent: 8-bit grey or RGB,
// rows in stored (uncompressed) deflate blocks, so the size is known up front.
uint32_t mfCrcTable[256];
uint32_t mfCrc(uint32_t c, const uint8_t* p, size_t n) {
  if (!mfCrcTable[1]) for (uint32_t k = 0; k < 256; k++) { uint32_t x = k; for (int j = 0; j < 8; j++) x = x & 1 ? 0xEDB88320UL ^ (x >> 1) : x >> 1; mfCrcTable[k] = x; }
  for (size_t k = 0; k < n; k++) c = mfCrcTable[(c ^ p[k]) & 0xFF] ^ (c >> 8);
  return c;
}
static void mfBe32(uint8_t* p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
void mfPngSend(camera_fb_t* fb) {
  bool grey = fb->format == PIXFORMAT_GRAYSCALE;
  uint32_t w = fb->width, h = fb->height, row = 1 + w * (grey ? 1 : 3);
  uint32_t idat = 2 + h * (5 + row) + 4;
  uint8_t* line = (uint8_t*)malloc(row + 5);
  if (!line) return mfWebSend(500, "text/plain", "out of memory");
  mfWeb.sendHeader("Access-Control-Allow-Origin", "*");
  mfWeb.sendHeader("Cache-Control", "no-store");
  mfWeb.setContentLength(8 + 25 + 12 + idat + 12);
  mfWeb.send(200, "image/png", "");
  uint8_t head[8 + 25 + 8 + 2] = {137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 'I', 'H', 'D', 'R'};
  mfBe32(head + 16, w); mfBe32(head + 20, h);
  head[24] = 8; head[25] = grey ? 0 : 2; head[26] = head[27] = head[28] = 0;
  mfBe32(head + 29, mfCrc(0xFFFFFFFFUL, head + 12, 17) ^ 0xFFFFFFFFUL);
  mfBe32(head + 33, idat); memcpy(head + 37, "IDAT", 4);
  head[41] = 0x78; head[42] = 0x01; // zlib header
  uint32_t crc = mfCrc(0xFFFFFFFFUL, head + 37, 6), a = 1, b = 0;
  mfWeb.sendContent((const char*)head, sizeof head);
  const uint8_t* px = fb->buf;
  for (uint32_t y = 0; y < h; y++) {
    line[0] = y == h - 1; // last block
    line[1] = row & 0xFF; line[2] = row >> 8; line[3] = ~row & 0xFF; line[4] = (~row >> 8) & 0xFF;
    uint8_t* o = line + 5;
    *o++ = 0; // filter: none
    if (grey) { memcpy(o, px, w); px += w; }
    else for (uint32_t x = 0; x < w; x++, px += 2) { // RGB565, high byte first
      uint8_t hb = px[0], lb = px[1];
      *o++ = (hb & 0xF8) | (hb >> 5);
      *o++ = ((hb & 0x07) << 5) | ((lb & 0xE0) >> 3) | ((hb & 0x07) >> 1);
      *o++ = ((lb & 0x1F) << 3) | ((lb & 0x1F) >> 2);
    }
    for (uint32_t k = 5; k < row + 5; k++) { a += line[k]; b += a; }
    a %= 65521; b %= 65521;
    crc = mfCrc(crc, line, row + 5);
    mfWeb.sendContent((const char*)line, row + 5);
    if ((y & 15) == 15) delay(0); // let WiFi run
  }
  free(line);
  uint8_t tail[4 + 4 + 12] = {0};
  mfBe32(tail, (b << 16) | a);
  crc = mfCrc(crc, tail, 4);
  mfBe32(tail + 4, crc ^ 0xFFFFFFFFUL);
  memcpy(tail + 8, "\\0\\0\\0\\0IEND\\xAE\\x42\\x60\\x82", 12);
  mfWeb.sendContent((const char*)tail, sizeof tail);
}
${cams
  .filter((n) => n.config.live && n.config.live !== "off")
  .map((n) => liveWeb(n, index.get(n.id)))
  .join("\n")}
bool mfCameraRoute(const String& uri) {
${cams
  .filter((n) => n.config.live && n.config.live !== "off")
  .map(
    (
      n,
    ) => `  if (uri == "/camera/live") { mfWebSend(200, "text/html", MF_LIVE_PAGE); return true; }
  if (uri == "/camera/live.mjpg") { mfLiveSend${index.get(n.id)}(); return true; }`,
  )
  .join("\n")}
${cams
  .map(
    (n) => `  if (uri == "/camera/${n.id}.png") {
    if (!mfStill${index.get(n.id)}) mfWebSend(404, "text/plain", "no picture yet: trigger the camera first");
    else mfPngSend(mfStill${index.get(n.id)});
    return true;
  }`,
  )
  .join("\n")}
  return false;
}`;
}
module.exports = {
  SENSORS,
  SIZES,
  SENSOR_MAX,
  autoSize,
  problems,
  fields,
  help,
  host,
  globals,
  setup,
  body,
  webGlobals,
  testPicture,
};
