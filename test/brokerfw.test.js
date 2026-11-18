// MQTT broker board firmware (lib/brokerfw.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generate, checkBroker } = require("../lib/brokerfw");
const base = { board: "esp32", ssid: "home", password: "wifi-pw" };
test("broker firmware runs sMQTTBroker on the chosen port and reports status", () => {
  const fw = generate({ ...base, port: 1884 });
  assert.equal(fw.fqbn, "esp32:esp32:esp32");
  assert.match(fw.source, /#include <sMQTTBroker\.h>/);
  assert.match(fw.source, /const uint16_t MF_PORT = 1884;/);
  assert.match(fw.source, /broker\.init\(MF_PORT\);/);
  assert.match(fw.source, /broker\.update\(\);/);
  assert.match(fw.source, /const char\* MF_SSID = "home";/);
  // Same status line as flow firmware, so the board check can read it.
  assert.ok(fw.source.includes('if (line == "mf?") mfReport();'));
  assert.ok(fw.source.includes("broker"), "status marks a broker");
  assert.doesNotMatch(fw.source, /MF_USER/, "no login without a username");
  assert.doesNotMatch(fw.source, /WiFi\.config/, "DHCP without a fixed IP");
});
test("a username makes clients log in; a fixed IP is configured", () => {
  const fw = generate({
    ...base,
    board: "esp32s3",
    username: "boards",
    brokerPassword: "s3cret",
    staticIp: "192.168.1.50",
    gateway: "192.168.1.1",
  });
  assert.equal(fw.fqbn, "esp32:esp32:esp32s3");
  assert.match(fw.source, /const char\* MF_USER = "boards";/);
  assert.match(
    fw.source,
    /e->Login\(\) != MF_USER \|\| e->Password\(\) != MF_USER_PASS\) return false;/,
  );
  assert.match(
    fw.source,
    /WiFi\.config\(IPAddress\(192, 168, 1, 50\), IPAddress\(192, 168, 1, 1\), IPAddress\(255, 255, 255, 0\), IPAddress\(192, 168, 1, 1\)\);/,
  );
  // Passwords are not part of the build ID.
  const other = generate({
    ...base,
    board: "esp32s3",
    username: "boards",
    brokerPassword: "different",
    staticIp: "192.168.1.50",
    gateway: "192.168.1.1",
  });
  assert.equal(other.build, fw.build);
});
test("broker settings are validated", () => {
  assert.throws(
    () => checkBroker({ ...base, board: "esp8266" }),
    /ESP32-family/,
  );
  assert.throws(() => checkBroker({ ...base, ssid: "" }), /WiFi SSID/);
  assert.throws(() => checkBroker({ ...base, port: 70000 }), /from 1 to 65535/);
  assert.throws(
    () => checkBroker({ ...base, brokerPassword: "x" }),
    /needs a username/,
  );
  assert.throws(
    () =>
      checkBroker({
        ...base,
        staticIp: "192.168.1.300",
        gateway: "192.168.1.1",
      }),
    /Fixed IP must be an IPv4/,
  );
  assert.throws(
    () => checkBroker({ ...base, staticIp: "192.168.1.50" }),
    /Gateway must be an IPv4/,
  );
  // Quotes in WiFi names are escaped for C++.
  assert.match(
    generate({ ...base, ssid: 'my "net"' }).source,
    /MF_SSID = "my \\"net\\"";/,
  );
  assert.throws(
    () => checkBroker({ ...base, heartbeat: 2 }),
    /Heartbeat interval \(s\) must be a whole number from 5 to 3600/,
  );
  assert.throws(
    () => checkBroker({ ...base, screenSeconds: -1 }),
    /Screen on time/,
  );
});
test("the broker sends a heartbeat, answers ping and marks dropped boards offline", () => {
  const { source } = generate({ ...base, heartbeat: 20 });
  // Announces itself like a Microflow board, retained so late subscribers see it.
  assert.ok(
    source.includes(
      'broker.publish((mfBase + "/status").c_str(), "online", 0, true);',
    ),
  );
  assert.ok(
    source.includes(
      'broker.publish((mfBase + "/telemetry").c_str(), t.c_str());',
    ),
  );
  assert.ok(
    source.includes("millis() - beat >= 20000UL"),
    "heartbeat interval",
  );
  assert.ok(
    source.includes('\\"flow\\":\\"MQTT broker\\"'),
    "telemetry names it",
  );
  // Ping on microflow/<id>/ping is answered on /pong with the build.
  assert.ok(source.includes('payload + " " + MF_BUILD + " no-ota"'));
  // Boards announce "online"; when their connection ends the broker publishes
  // their retained "offline" (sMQTTBroker has no Last Will).
  assert.ok(
    source.includes(
      'if (payload == "online") mfStatus[e->Client()->getClientId()] = topic;',
    ),
  );
  assert.ok(source.includes('mfOut.push_back({it->second, "offline", true});'));
  // Publishes from events are sent from loop(), outside the broker's client loop.
  assert.ok(
    source.includes(
      "for (auto& m : mfOut) broker.publish(m.topic, m.payload, 0, m.retain);",
    ),
  );
});
test("on a TTGO T-Display the screen shows the broker at reset and on button press", () => {
  const ttgo = generate({
    ...base,
    board: "ttgo-t-display",
    screenSeconds: 45,
  });
  const src = ttgo.source;
  assert.ok(src.includes("#include <Adafruit_ST7789.h>"));
  assert.ok(src.includes("const uint8_t MF_BUTTONS[] = { 0, 35 };"));
  assert.ok(
    src.includes("if (down && !was[i]) mfScreenWake();"),
    "button wakes it",
  );
  assert.ok(src.includes('mfRow(0, 2, ST77XX_CYAN, "MQTT BROKER");'));
  // The broker's URL (large text when it fits) and its mDNS address.
  assert.ok(
    src.includes(
      'String url = String("mqtt://") + WiFi.localIP().toString() + ":" + MF_PORT;',
    ),
  );
  assert.ok(src.includes("mfRow(1, mfFit(url), ST77XX_GREEN, url);"));
  assert.ok(
    src.includes(
      'mfRow(2, 1, ST77XX_GREEN, String("mqtt://microflow-broker.local:") + MF_PORT);',
    ),
  );
  assert.ok(src.includes('String("Clients ") + broker.clients'));
  assert.ok(
    src.includes("millis() - mfScreenSince >= 45000UL"),
    "screen timeout",
  );
  assert.ok(src.includes("mfLcdPower(false); return; } // screen off"));
  assert.ok(src.includes("void mfLcdPower(bool on) { digitalWrite(4, on ? HIGH : LOW); }"));
  assert.ok(src.includes("mfScreenWake();\n"), "shown at reset");
  // Always on: no timeout.
  assert.ok(
    !generate({
      ...base,
      board: "ttgo-t-display",
      screenSeconds: 0,
    }).source.includes("mfScreenSince >="),
  );
  // Boards without a screen and the OLED option off get none of it.
  assert.ok(!generate({ ...base, oled: false }).source.includes("mfScreen"));
});
test("boards without a screen look for an I2C OLED at start-up", () => {
  const fw = generate(base); // on by default
  const src = fw.source;
  assert.ok(src.includes("#include <Adafruit_SSD1306.h>"));
  assert.ok(src.includes("Wire.begin(21, 22);"), "the board's usual I2C pins");
  assert.ok(src.includes("for (uint8_t addr : { 0x3C, 0x3D })"));
  assert.ok(src.includes("if (Wire.endTransmission() != 0) continue;"), "probe before use");
  assert.ok(src.includes("if (!mfLcdFound) return; // no screen"), "runs without one");
  assert.ok(src.includes("const uint8_t MF_BUTTONS[] = { 0 };"), "BOOT wakes it");
  assert.ok(src.includes("mfLcdFlush();"));
  // Short rows for 21 characters: IP:port and the mDNS name.
  assert.ok(src.includes('mfRow(1, 1, ST77XX_GREEN, WiFi.localIP().toString() + ":" + MF_PORT);'));
  assert.ok(src.includes('mfRow(2, 1, ST77XX_GREEN, "microflow-broker.local");'));
  assert.deepEqual(fw.libraries, ["sMQTTBroker", "Adafruit SSD1306", "Adafruit GFX Library"]);
  // The C3's BOOT button is GPIO 9, and its I2C pins 8 / 9.
  const c3 = generate({ ...base, board: "esp32c3" }).source;
  assert.ok(c3.includes("const uint8_t MF_BUTTONS[] = { 9 };"));
  assert.ok(c3.includes("Wire.begin(8, 9);"));
  // Turning it off changes the build ID; older IDs (TTGO) stay the same.
  assert.notEqual(generate({ ...base, oled: false }).build, fw.build);
  assert.deepEqual(generate({ ...base, oled: false }).libraries, ["sMQTTBroker"]);
});
test("boards with a built-in OLED use it, powered and reset first", () => {
  const v3 = generate({ ...base, board: "heltec-wifi-kit-32-v3" }).source;
  assert.ok(v3.includes("digitalWrite(36, LOW); // screen power on"));
  assert.ok(v3.includes("digitalWrite(21, LOW);"), "reset pulse");
  assert.ok(v3.includes("Wire.begin(17, 18);"));
  const v2 = generate({ ...base, board: "heltec-wifi-kit-32" }).source;
  assert.ok(v2.includes("Wire.begin(4, 15);"));
  assert.ok(v2.includes("digitalWrite(21, LOW); // screen power on"));
  const lolin = generate({ ...base, board: "lolin32-oled" }).source;
  assert.ok(lolin.includes("Wire.begin(5, 4);"));
  assert.ok(!lolin.includes("screen power on"));
});
