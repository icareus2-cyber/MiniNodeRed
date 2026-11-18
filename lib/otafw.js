// C++ for remote updates, embedded in generated firmware when "Remote update" is on.
//
// Over MQTT (no open ports): the IDE publishes to microflow/<id>/ota/{begin,data,end}
// and the board answers on microflow/<id>/ota-ack. The image is ChaCha20-encrypted
// and authenticated with HMAC-SHA256 over (board challenge || nonce || ciphertext),
// so a public broker can neither read it (it contains WiFi credentials) nor push one.
// The last chunk is held back until the signature verifies, so a bad image is never
// committed. Over the LAN: ArduinoOTA (espota) with a per-project password.
const OTA_CHUNK = 768; // multiple of 64 so each chunk starts on a ChaCha20 block
const cBytes = (buf) =>
  Array.from(buf, (b) => "0x" + b.toString(16).padStart(2, "0")).join(", ");
const family = {
  esp8266: {
    includes:
      "#include <ArduinoOTA.h>\n#include <Updater.h>\n#include <bearssl/bearssl.h>",
    mac: `static br_hmac_key_context mfMacKey;
static br_hmac_context mfMac;
void mfMacStart() { br_hmac_key_init(&mfMacKey, &br_sha256_vtable, MF_KEY_MAC, 32); br_hmac_init(&mfMac, &mfMacKey, 0); }
void mfMacUpdate(const uint8_t* d, size_t n) { br_hmac_update(&mfMac, d, n); }
void mfMacEnd(uint8_t* out) { br_hmac_out(&mfMac, out); }
uint32_t mfRandom() { return ESP.random(); }
void mfUpdateAbort() { Update.end(false); } // not finished yet, so this discards
String mfUpdateError() { return Update.getErrorString(); }`,
  },
  esp32: {
    includes:
      '#include <ArduinoOTA.h>\n#include <Update.h>\n#include "mbedtls/md.h"\n#include "esp_random.h"',
    mac: `static mbedtls_md_context_t mfMac;
void mfMacStart() { mbedtls_md_init(&mfMac); mbedtls_md_setup(&mfMac, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1); mbedtls_md_hmac_starts(&mfMac, MF_KEY_MAC, 32); }
void mfMacUpdate(const uint8_t* d, size_t n) { mbedtls_md_hmac_update(&mfMac, d, n); }
void mfMacEnd(uint8_t* out) { mbedtls_md_hmac_finish(&mfMac, out); mbedtls_md_free(&mfMac); }
uint32_t mfRandom() { return esp_random(); }
void mfUpdateAbort() { Update.abort(); }
String mfUpdateError() { return String(Update.errorString()); }`,
  },
};
const globals = (fam, keys) => `${family[fam].includes}
// Project OTA keys (from this PC's Microflow database). Anyone with these can update the board.
static const uint8_t MF_KEY_ENC[32] = { ${cBytes(keys.enc)} };
static const uint8_t MF_KEY_MAC[32] = { ${cBytes(keys.mac)} };
const char* MF_OTA_PASS = "${keys.lan}";
#define MF_OTA_CHUNK ${OTA_CHUNK}
${family[fam].mac}
#define MF_ROTL(a, b) (((a) << (b)) | ((a) >> (32 - (b))))
#define MF_QR(a, b, c, d) (a += b, d ^= a, d = MF_ROTL(d, 16), c += d, b ^= c, b = MF_ROTL(b, 12), a += b, d ^= a, d = MF_ROTL(d, 8), c += d, b ^= c, b = MF_ROTL(b, 7))
static uint32_t mfLe32(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
// ChaCha20 (RFC 8439) keystream block.
static void mfChacha(uint32_t counter, const uint8_t* nonce, uint8_t* out) {
  uint32_t s[16] = { 0x61707865, 0x3320646e, 0x79622d32, 0x6b206574 };
  for (int i = 0; i < 8; i++) s[4 + i] = mfLe32(MF_KEY_ENC + 4 * i);
  s[12] = counter; s[13] = mfLe32(nonce); s[14] = mfLe32(nonce + 4); s[15] = mfLe32(nonce + 8);
  uint32_t x[16];
  memcpy(x, s, sizeof x);
  for (int i = 0; i < 10; i++) {
    MF_QR(x[0], x[4], x[8], x[12]); MF_QR(x[1], x[5], x[9], x[13]); MF_QR(x[2], x[6], x[10], x[14]); MF_QR(x[3], x[7], x[11], x[15]);
    MF_QR(x[0], x[5], x[10], x[15]); MF_QR(x[1], x[6], x[11], x[12]); MF_QR(x[2], x[7], x[8], x[13]); MF_QR(x[3], x[4], x[9], x[14]);
  }
  for (int i = 0; i < 16; i++) { uint32_t v = x[i] + s[i]; out[4 * i] = v; out[4 * i + 1] = v >> 8; out[4 * i + 2] = v >> 16; out[4 * i + 3] = v >> 24; }
}
struct { bool active; uint32_t size, next; uint8_t nonce[12]; unsigned long last; uint8_t held[MF_OTA_CHUNK]; uint16_t heldLen; } mfOta;
unsigned long mfRestartAt = 0;
void mfOtaReply(const String& msg) { mqtt.publish((mfBase + "/ota-ack").c_str(), msg.c_str()); }
static int mfHex(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
static bool mfUnhex(const char* s, uint8_t* out, int n) {
  for (int i = 0; i < n; i++) { int a = mfHex(s[2 * i]), b = mfHex(s[2 * i + 1]); if (a < 0 || b < 0) return false; out[i] = (a << 4) | b; }
  return true;
}
void mfOtaFail(const String& why) {
  if (mfOta.active) { mfOta.active = false; mfUpdateAbort(); }
  mfOtaReply(String("error ") + why);
}
static bool mfDecryptWrite(uint8_t* data, uint32_t offset, uint16_t len) {
  uint8_t ks[64];
  for (uint16_t i = 0; i < len; i += 64) {
    mfChacha((offset + i) / 64, mfOta.nonce, ks);
    for (uint16_t j = 0; j < 64 && i + j < len; j++) data[i + j] ^= ks[j];
  }
  return Update.write(data, len) == len;
}
// begin: "<size> <24 hex nonce>"  data: 4-byte LE offset + ciphertext  end: "<64 hex HMAC>"
void mfOtaMessage(const String& kind, byte* payload, unsigned int length) {
  if (kind == "begin") {
    char text[64];
    unsigned int n = length < sizeof text - 1 ? length : sizeof text - 1;
    memcpy(text, payload, n);
    text[n] = 0;
    char* rest;
    uint32_t size = strtoul(text, &rest, 10);
    while (*rest == ' ') rest++;
    if (mfOta.active) { mfOta.active = false; mfUpdateAbort(); }
    if (!size || strlen(rest) < 24 || !mfUnhex(rest, mfOta.nonce, 12)) return mfOtaFail("bad begin");
    if (!Update.begin(size)) return mfOtaFail(String("cannot start: ") + mfUpdateError());
    char challenge[33];
    for (int i = 0; i < 4; i++) snprintf(challenge + 8 * i, 9, "%08lx", (unsigned long)mfRandom());
    mfMacStart();
    mfMacUpdate((const uint8_t*)challenge, 32);
    mfMacUpdate(mfOta.nonce, 12);
    mfOta.active = true; mfOta.size = size; mfOta.next = 0; mfOta.heldLen = 0; mfOta.last = millis();
    mfOtaReply(String("ready ") + challenge);
  } else if (kind == "data") {
    if (!mfOta.active || length < 5) return;
    uint32_t offset = mfLe32(payload);
    uint8_t* data = payload + 4;
    uint16_t n = length - 4;
    if (offset != mfOta.next || n > MF_OTA_CHUNK || offset + n > mfOta.size) { mfOtaReply(String("next ") + mfOta.next); return; }
    mfMacUpdate(data, n);
    if (offset + n == mfOta.size) { memcpy(mfOta.held, data, n); mfOta.heldLen = n; } // committed only after the signature checks out
    else if (!mfDecryptWrite(data, offset, n)) return mfOtaFail(String("flash write: ") + mfUpdateError());
    mfOta.next += n;
    mfOta.last = millis();
    mfOtaReply(String("next ") + mfOta.next);
  } else if (kind == "end") {
    if (!mfOta.active || mfOta.next != mfOta.size) return mfOtaFail("incomplete image");
    uint8_t want[32], got[32], diff = 0;
    if (length < 64 || !mfUnhex((const char*)payload, want, 32)) return mfOtaFail("bad signature");
    mfMacEnd(got);
    for (int i = 0; i < 32; i++) diff |= want[i] ^ got[i];
    if (diff) return mfOtaFail("signature mismatch (built with another project key?)");
    if (!mfDecryptWrite(mfOta.held, mfOta.size - mfOta.heldLen, mfOta.heldLen)) return mfOtaFail(String("flash write: ") + mfUpdateError());
    mfOta.active = false;
    if (!Update.end(true)) return mfOtaFail(String("finish: ") + mfUpdateError());
    mfOtaReply("done");
    mfRestartAt = millis() + 500;
  }
}`;
const subscribe = `      mqtt.subscribe((mfBase + "/ota/+").c_str());`;
const dispatch = `  if (topicCopy.startsWith(mfBase + "/ota/")) { mfOtaMessage(topicCopy.substring(mfBase.length() + 5), payload, length); return; }`;
const loop = `  if (mfOta.active && millis() - mfOta.last > 20000UL) mfOtaFail("timeout");
  if (mfRestartAt && (long)(millis() - mfRestartAt) >= 0) { mqtt.disconnect(); delay(100); ESP.restart(); }
  { static bool lanReady = false;
    if (!lanReady && WiFi.status() == WL_CONNECTED) { ArduinoOTA.setHostname(mfId.c_str()); ArduinoOTA.setPassword(MF_OTA_PASS); ArduinoOTA.begin(); lanReady = true; }
    if (lanReady) ArduinoOTA.handle(); }`;
module.exports = { OTA_CHUNK, globals, subscribe, dispatch, loop };
