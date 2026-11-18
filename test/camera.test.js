// Camera node (lib/camerafw.js): Freenove ESP32-S3 WROOM CAM only; a still picture
// per rising edge, served by the board as a PNG file encoded while it is sent. The
// firmware runs with the host g++ and stand-in headers (test/fixtures/arduino); the
// PNG it sends is decoded with zlib and compared pixel by pixel.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyze, build, validate } = require("../lib/flow");
const { types, catalog } = require("../lib/nodes");
const png = require("../lib/png");
const camerafw = require("../lib/camerafw");

// Push button → Camera → Radio out ("q <json>").
const flowOf = (config = {}) => ({
  name: "t",
  nodes: [
    { id: "go", type: "test-button", name: "GO", config: {} },
    { id: "cam", type: "camera", label: "Cam", config },
    { id: "o", type: "mqtt-out", config: { topic: "q" } },
  ],
  edges: [
    { from: "go", to: "cam" },
    { from: "cam", to: "o" },
  ],
});
const settings = {
  board: "freenove-s3cam",
  ssid: "n",
  host: "h",
  profile: "release",
  ota: false,
};

test("catalog and board checks: Freenove only, one camera, on / off trigger", () => {
  const c = catalog().camera;
  assert.equal(c.needs, "stillcam");
  assert.deepEqual(
    c.fields.map((f) => f.key),
    [
      "sensor",
      "size",
      "color",
      "brightness",
      "contrast",
      "saturation",
      "whiteBalance",
      "mirror",
      "flip",
      "live",
    ],
  );
  assert.match(
    analyze(flowOf(), "esp32").errors.join(),
    /Freenove ESP32-S3 WROOM CAM board only/,
  );
  assert.match(analyze(flowOf(), "esp32cam").errors.join(), /Freenove/);
  assert.deepEqual(analyze(flowOf(), "freenove-s3cam").errors, []);
  const two = flowOf();
  two.nodes.push({ id: "cam2", type: "camera", config: {} });
  two.edges.push({ from: "go", to: "cam2" });
  assert.match(analyze(two, "freenove-s3cam").errors.join(), /one Camera node/);
  const withSensor = flowOf();
  withSensor.nodes.push(
    { id: "s", type: "input-device", config: { device: "camera" } },
    { id: "d", type: "debug", config: {} },
  );
  withSensor.edges.push({ from: "s", to: "d" });
  assert.match(
    analyze(withSensor, "freenove-s3cam").errors.join(),
    /both use the board's camera/,
  );
  const analogTrigger = flowOf();
  analogTrigger.nodes[0] = { id: "go", type: "analog-in", config: { pin: 1 } };
  assert.match(
    analyze(analogTrigger, "freenove-s3cam").errors.join(),
    /analog value is not on \/ off/,
  );
});

test("firmware: camera settings, web server route", () => {
  const { source, fqbn } = build(
    flowOf({
      sensor: "ov5640",
      size: "UXGA",
      color: "gray",
      brightness: 1,
      contrast: -2,
      whiteBalance: "home",
      mirror: "yes",
    }),
    settings,
  );
  assert.equal(fqbn, "esp32:esp32:esp32s3:PSRAM=opi");
  assert.match(source, /#include <WebServer\.h>/);
  assert.match(source, /#include "esp_camera\.h"/);
  assert.match(source, /c\.pixel_format = PIXFORMAT_GRAYSCALE;/);
  assert.match(source, /c\.frame_size = FRAMESIZE_UXGA;/);
  assert.match(source, /c\.fb_location = CAMERA_FB_IN_PSRAM;/);
  assert.match(source, /c\.pin_xclk = 15;/);
  assert.match(source, /if \(s->id\.PID != 0x5640\)/);
  assert.match(source, /s->set_vflip\(s, 1\);/); // OV5640 modules are upside down
  assert.match(source, /s->set_hmirror\(s, 1\);/);
  assert.match(source, /s->set_wb_mode\(s, 4\);/);
  assert.match(
    source,
    /uri\.startsWith\("\/camera\/"\) && mfCameraRoute\(uri\)/,
  );
  assert.match(source, /if \(uri == "\/camera\/cam\.png"\)/);
});

test("simulator: a test picture per rising edge", () => {
  const [, n] = validate(flowOf({ size: "QVGA" })).nodes;
  const pictures = [];
  const events = [];
  const ctx = {
    state: {},
    still: (buf, shot) => (
      pictures.push(buf),
      `/api/camera/sim/cam.png?shot=${shot}`
    ),
    camera: (json) => events.push(json),
  };
  assert.equal(
    types.camera.host("1", n, ctx),
    '{"image":"/api/camera/sim/cam.png?shot=1","width":320,"height":240,"shot":1}',
  );
  assert.equal(types.camera.host("1", n, ctx), undefined); // no new edge
  types.camera.host("0", n, ctx);
  assert.match(types.camera.host("on", n, ctx), /"shot":2/);
  assert.equal(events.length, 2);
  const pic = png.decode(pictures[0]);
  assert.deepEqual([pic.width, pic.height, pic.channels], [320, 240, 3]);
  assert.deepEqual([...pic.pixels.subarray(0, 3)], [255, 255, 255]); // first colour bar
  const grey = png.decode(
    camerafw.testPicture({ size: "QVGA", color: "gray" }, 1),
  );
  assert.equal(grey.channels, 1);
});

const gxx = spawnSync("g++", ["--version"]).status === 0;
test(
  "firmware: the PNG the board sends decodes to the picture",
  { skip: !gxx && "g++ not found" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-camera-"));
    const sketch = (config) =>
      build(flowOf(config), settings).source.replace(/^#include .*$/gm, "");
    // A 7 × 5 RGB565 picture (high byte first), and a 6 × 3 grey one.
    const W = 7,
      H = 5;
    const rgb565 = [];
    for (let k = 0; k < W * H; k++) rgb565.push((k * 2654435761) & 0xffff);
    const grey = Array.from({ length: 18 }, (_, k) => (k * 37) & 255);
    fs.writeFileSync(
      path.join(dir, "t.cpp"),
      `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "WebServer.h"
#include "esp_camera.h"
namespace colour {
${sketch({ size: "VGA" })}
}
namespace grey {
${sketch({ color: "gray", size: "VGA" })}
}
uint8_t rgb[${W * H * 2}] = {${rgb565.flatMap((p) => [p >> 8, p & 255]).join(",")}};
uint8_t g8[18] = {${grey.join(",")}};
void save(const char* name, const std::string& body) { FILE* f = fopen(name, "wb"); fwrite(body.data(), 1, body.size(), f); fclose(f); }
int main(int, char** argv) {
  std::string out = argv[1];
  colour::setup();
  colour::mfWeb.request("/camera/cam.png");
  printf("before: %d %s\\n", colour::mfWeb.code, colour::mfWeb.sent.c_str());
  mfCamFb = camera_fb_t{rgb, sizeof rgb, ${W}, ${H}, PIXFORMAT_RGB565};
  colour::node0(String("1"));
  colour::node0(String("1")); // no new edge: no new picture
  colour::mfWeb.request("/camera/cam.png");
  printf("code %d type %s length %zu sent %zu taken %d\\n", colour::mfWeb.code, colour::mfWeb.type.c_str(), colour::mfWeb.length, colour::mfWeb.sent.size(), mfCamTaken);
  save((out + "/colour.png").c_str(), colour::mfWeb.sent);
  printf("settings %d %d %d\\n", mfCamConfig.pixel_format, mfCamConfig.frame_size, mfCamConfig.fb_location);
  grey::setup();
  mfCamFb = camera_fb_t{g8, sizeof g8, 6, 3, PIXFORMAT_GRAYSCALE};
  grey::node0(String("0")); grey::node0(String("1"));
  grey::mfWeb.request("/camera/cam.png");
  save((out + "/grey.png").c_str(), grey::mfWeb.sent);
  printf("%s", published.c_str());
}
`,
    );
    const exe = path.join(dir, "t");
    const cc = spawnSync(
      "g++",
      [
        "-std=gnu++17",
        "-I",
        path.join(__dirname, "fixtures/arduino"),
        "-Wall",
        "-Wno-unused-function",
        "-Wno-unused-variable",
        "-Wno-unused-but-set-variable",
        "-o",
        exe,
        path.join(dir, "t.cpp"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 40).join("\n"));
    const run = spawnSync(exe, [dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(
      lines[0],
      "before: 404 no picture yet: trigger the camera first",
    );
    const colourFile = fs.readFileSync(path.join(dir, "colour.png"));
    assert.equal(
      lines[1],
      `code 200 type image/png length ${colourFile.length} sent ${colourFile.length} taken 1`,
    );
    assert.equal(lines[2], "settings 0 8 0"); // RGB565, VGA, PSRAM
    assert.equal(
      lines[3],
      'q {"image":"http://1.2.3.4/camera/cam.png","width":7,"height":5,"shot":1}',
    );
    assert.equal(
      lines[4],
      'q {"image":"http://1.2.3.4/camera/cam.png","width":6,"height":3,"shot":1}',
    );
    // Pixel by pixel: RGB565 → 8 bits per colour, low bits repeated (as esp32-camera).
    const colour = png.decode(colourFile);
    assert.deepEqual([colour.width, colour.height, colour.channels], [W, H, 3]);
    const want = Buffer.from(
      rgb565.flatMap((p) => {
        const r = p >> 11,
          g = (p >> 5) & 63,
          b = p & 31;
        return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
      }),
    );
    assert.ok(colour.pixels.equals(want));
    const g = png.decode(fs.readFileSync(path.join(dir, "grey.png")));
    assert.deepEqual([g.width, g.height, g.channels], [6, 3, 1]);
    assert.deepEqual([...g.pixels], grey);
  },
);

test("Auto resolution: the largest the sensor takes that fits in 8 MB PSRAM", () => {
  assert.equal(
    catalog().camera.fields.find((f) => f.key === "size").default,
    "auto",
  );
  assert.equal(camerafw.autoSize("ov2640", "color"), "UXGA");
  assert.equal(camerafw.autoSize("ov3660", "color"), "QXGA");
  assert.equal(camerafw.autoSize("ov5640", "color"), "QXGA"); // 2560 × 1920 colour is 9.8 MB
  assert.equal(camerafw.autoSize("ov5640", "gray"), "QSXGA");
  assert.equal(camerafw.autoSize("ov5640", "color", 2e6), "XGA");
  assert.match(
    analyze(
      flowOf({ sensor: "ov2640", size: "QXGA" }),
      "freenove-s3cam",
    ).errors.join(),
    /OV2640 takes pictures up to UXGA/,
  );
  assert.match(
    analyze(
      flowOf({ sensor: "ov5640", size: "QSXGA" }),
      "freenove-s3cam",
    ).errors.join(),
    /needs 9\.4 MB/,
  );
  assert.deepEqual(
    analyze(
      flowOf({ sensor: "ov5640", size: "QSXGA", color: "gray" }),
      "freenove-s3cam",
    ).errors,
    [],
  );
  const [, n] = validate(flowOf({ sensor: "ov3660" })).nodes;
  const out = types.camera.host("1", n, { state: {} });
  assert.match(out, /"width":2048,"height":1536/);
});

test(
  "firmware: Auto measures PSRAM, asks the sensor, steps down when a size fails",
  { skip: !gxx && "g++ not found" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-camauto-"));
    const { source } = build(flowOf({ sensor: "ov5640" }), settings);
    assert.match(source, /#include "esp_flash\.h"/);
    // esp32-camera wants a framesize_t, not an int (a compile error on the real core).
    assert.match(
      source,
      /const framesize_t mfStillSize1\[\] = \{FRAMESIZE_QSXGA,/,
    );
    const run = (body) => {
      fs.writeFileSync(
        path.join(dir, "t.cpp"),
        `#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "WebServer.h"
#include "esp_camera.h"
${source.replace(/^#include .*$/gm, "")}
int main() { ${body} printf("%s\\n%s", mfStillInfo1.c_str(), published.c_str()); }
`,
      );
      const cc = spawnSync(
        "g++",
        [
          "-std=gnu++17",
          "-I",
          path.join(__dirname, "fixtures/arduino"),
          "-w",
          "-o",
          path.join(dir, "t"),
          path.join(dir, "t.cpp"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 30).join("\n"));
      return spawnSync(path.join(dir, "t"), { encoding: "utf8" }).stdout;
    };
    // An OV2640 is fitted (the node says OV5640): UXGA, its largest.
    let out = run(
      `setup(); node0(String("1")); printf("size %d\\n", mfCamConfig.frame_size);`,
    );
    assert.match(out, /size 13/);
    assert.match(
      out,
      /auto: UXGA 1600 x 1200 colour · module N16R8 · PSRAM 8\.0 MB \(7\.7 MB free\) · sensor 0x26/,
    );
    assert.match(source, /not the OV5640 set in the Camera node/);
    // An OV5640 on an N8R8 board: QXGA in colour.
    out = run(
      `mfSensor.id.PID = 0x5640; mfFlashSize = 8388608; setup(); node0(String("1")); printf("size %d\\n", mfCamConfig.frame_size);`,
    );
    assert.match(out, /size 17/);
    assert.match(out, /auto: QXGA 2048 x 1536 colour · module N8R8/);
    // Little PSRAM free: a smaller size. A size that does not start: the next one.
    out = run(
      `mfSensor.id.PID = 0x5640; mfPsramFree = 3000000; mfCamLargest = 9; setup(); node0(String("1")); printf("size %d\\n", mfCamConfig.frame_size);`,
    );
    assert.match(out, /auto: SVGA 800 x 600/);
    // No picture at the chosen size: the next press steps down and still takes one.
    out = run(
      `setup(); mfCamLargest = 12; node0(String("1")); printf("size %d\\n", mfCamConfig.frame_size);`,
    );
    assert.match(out, /auto: SXGA 1280 x 1024/);
    assert.match(out, /"shot":1/);
  },
);

test("debug builds: the camera command takes a picture whatever the input", () => {
  const { source } = build(flowOf({ size: "VGA" }), {
    ...settings,
    profile: "debug",
  });
  assert.match(source, /\| camera"/);
  assert.match(
    source,
    /if \(cmd == "camera"\) \{\n    uint32_t before = mfStillShot1;\n    node1\(String\("0"\)\); node1\(String\("1"\)\); node1\(String\("0"\)\);/,
  );
  assert.match(
    source,
    /Cam: input still on: a picture needs off \(0\) then on \(1\)/,
  );
  // A line sent without Enter still runs.
  assert.match(source, /millis\(\) - last > 300 && last - first < 50/);
});

test(
  "firmware: live video page for focusing, then back to still pictures",
  { skip: !gxx && "g++ not found" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-camlive-"));
    const { source } = build(flowOf({ size: "VGA", live: "QVGA" }), settings);
    assert.match(
      source,
      /c\.pixel_format = PIXFORMAT_JPEG;\n  c\.frame_size = FRAMESIZE_QVGA;/,
    );
    assert.doesNotMatch(
      build(flowOf({ live: "off" }), settings).source,
      /camera\/live/,
    );
    fs.writeFileSync(
      path.join(dir, "t.cpp"),
      `#include <algorithm>
#include "Arduino.h"
#include "WiFi.h"
std::string published;
#include "PubSubClient.h"
#include "WebServer.h"
#include "esp_camera.h"
${source.replace(/^#include .*$/gm, "")}
int main() {
  setup(); node0(String("1"));
  mfWeb.request("/camera/live"); printf("page %d %s\\n", mfWeb.code, mfWeb.type.c_str());
  int inits = mfCamInits;
  mfWeb.request("/camera/live.mjpg");
  printf("inits %d frames %d\\n", mfCamInits - inits, (int)std::count(mfClientOut.begin(), mfClientOut.end(), '@'));
  printf("back %d %d %d\\n", mfCamConfig.pixel_format, mfCamConfig.frame_size, mfCamConfig.fb_count);
  mfWeb.request("/camera/cam.png"); printf("old picture %d\\n", mfWeb.code);
  node0(String("0")); node0(String("1")); mfWeb.request("/camera/cam.png"); printf("new picture %d\\n", mfWeb.code);
}
`.replace("int main() {", "int main() { mfCamFrame[0] = '@';"),
    );
    const cc = spawnSync(
      "g++",
      [
        "-std=gnu++17",
        "-I",
        path.join(__dirname, "fixtures/arduino"),
        "-w",
        "-o",
        path.join(dir, "t"),
        path.join(dir, "t.cpp"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 30).join("\n"));
    const out = spawnSync(path.join(dir, "t"), { encoding: "utf8" }).stdout;
    assert.match(out, /page 200 text\/html/);
    assert.match(out, /inits 2 frames 3/); // live, then stills again; 3 frames sent
    assert.match(out, /back 0 8 1/); // RGB565, VGA, one buffer
    assert.match(out, /old picture 404/);
    assert.match(out, /new picture 200/);
  },
);

// Regression: the web server's JSON function used to be called mfJson, like the
// JSON helpers' namespace, so Web in/out with Logic (or C/C++) did not compile.
test(
  "Web out together with Logic compiles",
  { skip: !gxx && "g++ not found" },
  () => {
    const flow = {
      name: "t",
      nodes: [
        { id: "a", type: "test-switch", config: {} },
        { id: "l", type: "logic", config: { fn: "not" } },
        { id: "w", type: "web-out", config: { name: "state" } },
      ],
      edges: [
        { from: "a", to: "l" },
        { from: "l", to: "w" },
      ],
    };
    const { source } = build(flow, { ...settings, board: "esp32" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-web-"));
    fs.writeFileSync(
      path.join(dir, "t.cpp"),
      `#include "Arduino.h"\n#include "WiFi.h"\nstd::string published;\n#include "PubSubClient.h"\n#include "WebServer.h"\n${source.replace(/^#include .*$/gm, "")}\nint main() { setup(); node0(String("0")); mfWeb.request("/api"); printf("%s", mfWeb.sent.c_str()); }\n`,
    );
    const cc = spawnSync(
      "g++",
      [
        "-std=gnu++17",
        "-I",
        path.join(__dirname, "fixtures/arduino"),
        "-w",
        "-o",
        path.join(dir, "t"),
        path.join(dir, "t.cpp"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(cc.status, 0, cc.stderr.split("\n").slice(0, 20).join("\n"));
    assert.equal(
      spawnSync(path.join(dir, "t"), { encoding: "utf8" }).stdout,
      '{"state":1}',
    );
  },
);
