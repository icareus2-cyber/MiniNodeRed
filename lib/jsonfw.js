// C++ JSON helpers for Arduino nodes (no library needed). Emitted once when a flow
// has an Arduino node; each node's namespace imports the public names, so its own
// variables still win.
//
//   jsonText(value, "name")          text of a field ("" if missing; strings unescaped)
//   jsonNumber(value, "sensor.temp") number of a field (0, or a fallback, if missing)
//   jsonBool(value, "on")            true for true, a non-zero number, "true", "on", "1"
//   jsonHas(value, "list[2]")        whether the field exists
//   Json().add("temp", 21.5).add("ok", true)   builds {"temp":21.5,"ok":true}
//
// Paths: "a", "a.b", "list.0" or "list[0]"; "" is the whole value.
const helpers = `
// ── JSON helpers for Arduino nodes ──
namespace mfJson {
namespace detail {
inline const char* ws(const char* p) {
  while (*p == ' ' || *p == '\\t' || *p == '\\r' || *p == '\\n') p++;
  return p;
}
// End of the JSON value starting at p, or NULL when it is malformed.
inline const char* skip(const char* p) {
  p = ws(p);
  if (*p == '"') {
    for (p++; *p && *p != '"'; p++)
      if (*p == '\\\\' && p[1]) p++;
    return *p ? p + 1 : NULL;
  }
  if (*p == '{' || *p == '[') {
    int depth = 0;
    while (*p) {
      if (*p == '"') {
        p = skip(p);
        if (!p) return NULL;
        continue;
      }
      if (*p == '{' || *p == '[') depth++;
      else if (*p == '}' || *p == ']') {
        if (--depth == 0) return p + 1;
      }
      p++;
    }
    return NULL;
  }
  const char* start = p;
  while (*p && !strchr(",}] \\t\\r\\n", *p)) p++;
  return p > start ? p : NULL;
}
// Start of the value at path inside json (end in *end), or NULL when it is missing.
inline const char* find(const char* p, const char* path, const char** end) {
  p = ws(p);
  while (*path) {
    char key[33];
    size_t k = 0;
    while (*path == '.' || *path == '[' || *path == ']') path++;
    if (!*path) break;
    while (*path && *path != '.' && *path != '[' && *path != ']') {
      if (k == 32) return NULL; // longer than any key we look up
      key[k++] = *path++;
    }
    key[k] = 0;
    if (*p == '{') {
      p = ws(p + 1);
      bool found = false;
      while (*p == '"') {
        const char* name = p + 1;
        const char* after = skip(p);
        if (!after) return NULL;
        bool match = (size_t)(after - 1 - name) == k && strncmp(name, key, k) == 0;
        p = ws(after);
        if (*p != ':') return NULL;
        p = ws(p + 1);
        if (match) {
          found = true;
          break;
        }
        p = skip(p);
        if (!p) return NULL;
        p = ws(p);
        if (*p == ',') p = ws(p + 1);
      }
      if (!found) return NULL;
    } else if (*p == '[') {
      char* rest;
      long index = strtol(key, &rest, 10);
      if (*rest || index < 0) return NULL;
      p = ws(p + 1);
      for (long i = 0; i < index; i++) {
        if (*p == ']') return NULL;
        p = skip(p);
        if (!p) return NULL;
        p = ws(p);
        if (*p != ',') return NULL;
        p = ws(p + 1);
      }
      if (*p == ']') return NULL;
    } else
      return NULL;
  }
  const char* e = skip(p);
  if (!e) return NULL;
  *end = e;
  return p;
}
inline void utf8(String& out, unsigned long c) {
  if (c < 0x80) out += (char)c;
  else if (c < 0x800) { out += (char)(0xC0 | (c >> 6)); out += (char)(0x80 | (c & 0x3F)); }
  else if (c < 0x10000) { out += (char)(0xE0 | (c >> 12)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); }
  else { out += (char)(0xF0 | (c >> 18)); out += (char)(0x80 | ((c >> 12) & 0x3F)); out += (char)(0x80 | ((c >> 6) & 0x3F)); out += (char)(0x80 | (c & 0x3F)); }
}
inline unsigned long hex4(const char* p) {
  char digits[5] = {p[0], p[1], p[2], p[3], 0};
  return strtoul(digits, NULL, 16);
}
// A JSON string's text (escapes decoded); any other value as written.
inline String text(const char* p, const char* end) {
  String out;
  if (*p != '"') {
    while (p < end) out += *p++;
    return out;
  }
  for (p++; p < end - 1; p++) {
    if (*p != '\\\\') {
      out += *p;
      continue;
    }
    char c = *++p;
    if (c == 'n') out += '\\n';
    else if (c == 't') out += '\\t';
    else if (c == 'r') out += '\\r';
    else if (c == 'b') out += '\\b';
    else if (c == 'f') out += '\\f';
    else if (c == 'u' && end - p > 4) {
      unsigned long u = hex4(p + 1);
      p += 4;
      if (u >= 0xD800 && u < 0xDC00 && end - p > 6 && p[1] == '\\\\' && p[2] == 'u') {
        unsigned long low = hex4(p + 3);
        if (low >= 0xDC00 && low < 0xE000) {
          u = 0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00);
          p += 6;
        }
      }
      utf8(out, u);
    } else out += c; // \\" \\\\ \\/
  }
  return out;
}
} // namespace detail
// Quotes and escapes text as a JSON string.
inline String jsonQuote(const String& s) {
  String out = "\\"";
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\\\') { out += '\\\\'; out += c; }
    else if (c == '\\n') out += "\\\\n";
    else if (c == '\\r') out += "\\\\r";
    else if (c == '\\t') out += "\\\\t";
    else if ((unsigned char)c < 0x20) { char u[7]; snprintf(u, sizeof u, "\\\\u%04x", c); out += u; }
    else out += c;
  }
  return out + "\\"";
}
inline bool jsonHas(const String& json, const char* path) {
  const char* end;
  return detail::find(json.c_str(), path, &end) != NULL;
}
inline String jsonText(const String& json, const char* path) {
  const char* end;
  const char* p = detail::find(json.c_str(), path, &end);
  return p ? detail::text(p, end) : String("");
}
inline double jsonNumber(const String& json, const char* path, double fallback) {
  const char* end;
  const char* p = detail::find(json.c_str(), path, &end);
  if (!p) return fallback;
  String t = detail::text(p, end);
  const char* s = t.c_str();
  char* rest;
  double x = strtod(s, &rest);
  if (rest == s) return t == "true" ? 1 : t == "false" ? 0 : fallback;
  return x;
}
inline double jsonNumber(const String& json, const char* path) { return jsonNumber(json, path, 0); }
inline bool jsonBool(const String& json, const char* path) {
  String t = jsonText(json, path);
  if (t == "true" || t == "on" || t == "yes") return true;
  const char* s = t.c_str();
  char* rest;
  double x = strtod(s, &rest);
  return rest != s && x != 0;
}
inline bool jsonHas(const String& json, const String& path) { return jsonHas(json, path.c_str()); }
inline String jsonText(const String& json, const String& path) { return jsonText(json, path.c_str()); }
inline double jsonNumber(const String& json, const String& path) { return jsonNumber(json, path.c_str()); }
inline double jsonNumber(const String& json, const String& path, double fallback) { return jsonNumber(json, path.c_str(), fallback); }
inline bool jsonBool(const String& json, const String& path) { return jsonBool(json, path.c_str()); }
// Builds a JSON object: Json().add("temp", 21.5).add("name", "lab").add("on", true)
class Json {
 public:
  Json& add(const char* key, const String& v) { return addJson(key, jsonQuote(v)); }
  Json& add(const char* key, const char* v) { return addJson(key, jsonQuote(String(v))); }
  Json& add(const char* key, bool v) { return addJson(key, v ? "true" : "false"); }
  Json& add(const char* key, int v) { return addJson(key, String(v)); }
  Json& add(const char* key, unsigned int v) { return addJson(key, String(v)); }
  Json& add(const char* key, long v) { return addJson(key, String(v)); }
  Json& add(const char* key, unsigned long v) { return addJson(key, String(v)); }
  Json& add(const char* key, double v) { return addJson(key, number(v, 6)); }
  Json& add(const char* key, double v, unsigned int decimals) { return addJson(key, number(v, decimals)); }
  // A value that is already JSON: a nested Json, an array "[1,2]", null, …
  Json& addJson(const char* key, const String& json) {
    if (body.length()) body += ",";
    body += jsonQuote(String(key));
    body += ":";
    body += json;
    return *this;
  }
  Json& add(const char* key, const Json& v) { return addJson(key, v.text()); }
  String text() const { return "{" + body + "}"; }
  operator String() const { return text(); }
 private:
  String body;
  // Up to \`decimals\` places without trailing zeros; null for NaN and infinity.
  static String number(double v, unsigned int decimals) {
    if (!isfinite(v)) return "null";
    String s(v, decimals);
    if (s.indexOf('.') >= 0) {
      while (s.endsWith("0")) s.remove(s.length() - 1);
      if (s.endsWith(".")) s.remove(s.length() - 1);
    }
    return s == "-0" ? String("0") : s;
  }
};
// Typed values from text (input variables of Arduino nodes, or your own use).
inline bool asBool(const String& v) {
  if (v == "true" || v == "on" || v == "yes") return true;
  const char* s = v.c_str();
  char* rest;
  double x = strtod(s, &rest);
  return rest != s && x != 0;
}
inline double asDouble(const String& v) {
  const char* s = v.c_str();
  char* rest;
  double x = strtod(s, &rest);
  if (rest == s) return asBool(v) ? 1 : 0;
  return x;
}
inline int asInt(const String& v) {
  double x = asDouble(v);
  if (x != x) return 0; // NaN
  if (x >= 2147483647.0) return 2147483647;
  if (x <= -2147483648.0) return -2147483647 - 1;
  return (int)x;
}
// A value as a node's Input / Output type (same rules as convertValue() in
// lib/nodes.js): bool "1" / "0", a whole number, or a decimal number (up to 6 places).
inline String toBool(const String& v) { return asBool(v) ? "1" : "0"; }
inline String toInt(const String& v) {
  double x = asDouble(v);
  if (!isfinite(x)) return "0";
  return String(asInt(v));
}
inline String toFloat(const String& v) {
  double x = asDouble(v);
  if (!isfinite(x)) return "0";
  String s(x, 6);
  if (s.indexOf('.') >= 0) {
    while (s.endsWith("0")) s.remove(s.length() - 1);
    if (s.endsWith(".")) s.remove(s.length() - 1);
  }
  return s == "-0" ? String("0") : s;
}
} // namespace mfJson
`;
// Node-RED style messages ({"payload":…,"topic":…}) on every wire. Mirrors lib/msg.js,
// which the PC simulator uses, so both produce the same text.
const msgHelpers = String.raw`
// ── Node-RED style messages ──
namespace mfMsg {
using mfJson::detail::ws;
inline bool digit(char c) { return c >= '0' && c <= '9'; }
inline bool hexDigit(char c) { return digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
inline const char* str(const char* p) {
  if (*p != '"') return NULL;
  for (p++; *p && *p != '"'; p++) {
    if ((unsigned char)*p < 0x20) return NULL;
    if (*p == '\\') {
      p++;
      if (*p == 'u') {
        for (int i = 1; i <= 4; i++)
          if (!hexDigit(p[i])) return NULL;
        p += 4;
      } else if (!*p || !strchr("\"\\/bfnrt", *p)) return NULL;
    }
  }
  return *p ? p + 1 : NULL;
}
inline const char* num(const char* p) {
  if (*p == '-') p++;
  if (*p == '0') p++;
  else if (*p >= '1' && *p <= '9') while (digit(*p)) p++;
  else return NULL;
  if (*p == '.') {
    p++;
    if (!digit(*p)) return NULL;
    while (digit(*p)) p++;
  }
  if (*p == 'e' || *p == 'E') {
    p++;
    if (*p == '+' || *p == '-') p++;
    if (!digit(*p)) return NULL;
    while (digit(*p)) p++;
  }
  return p;
}
// End of the valid JSON value at p, or NULL.
inline const char* value(const char* p, int depth) {
  p = ws(p);
  if (depth > 16) return NULL;
  if (*p == '{') {
    p = ws(p + 1);
    if (*p == '}') return p + 1;
    for (;;) {
      p = str(p);
      if (!p) return NULL;
      p = ws(p);
      if (*p != ':') return NULL;
      p = value(p + 1, depth + 1);
      if (!p) return NULL;
      p = ws(p);
      if (*p == ',') { p = ws(p + 1); continue; }
      return *p == '}' ? p + 1 : NULL;
    }
  }
  if (*p == '[') {
    p = ws(p + 1);
    if (*p == ']') return p + 1;
    for (;;) {
      p = value(p, depth + 1);
      if (!p) return NULL;
      p = ws(p);
      if (*p == ',') { p++; continue; }
      return *p == ']' ? p + 1 : NULL;
    }
  }
  if (*p == '"') return str(p);
  if (!strncmp(p, "true", 4) || !strncmp(p, "null", 4)) return p + 4;
  if (!strncmp(p, "false", 5)) return p + 5;
  return num(p);
}
inline bool valid(const char* p) {
  const char* e = value(p, 0);
  return e && !*ws(e);
}
// Copies [a, b) without the white space at both ends.
inline String trimmed(const char* a, const char* b) {
  a = ws(a);
  while (b > a && (b[-1] == ' ' || b[-1] == '\t' || b[-1] == '\r' || b[-1] == '\n')) b--;
  String out;
  while (a < b) out += *a++;
  return out;
}
// A payload as JSON: numbers, true/false/null, objects and arrays as they are; any
// other text (strings too) quoted.
inline String payloadJson(const String& v) {
  const char* p = v.c_str();
  if (valid(p) && *ws(p) != '"') return trimmed(p, p + v.length());
  return mfJson::jsonQuote(v);
}
// Whether the top-level object obj has the key spelled [k, ke) (with its quotes).
inline bool hasKey(const char* obj, const char* k, const char* ke) {
  const char* p = ws(obj);
  if (*p != '{') return false;
  p = ws(p + 1);
  while (*p == '"') {
    const char* e = str(p);
    if (!e) return false;
    if (e - p == ke - k && !strncmp(p, k, ke - k)) return true;
    p = ws(e);
    if (*p != ':') return false;
    p = value(p + 1, 1);
    if (!p) return false;
    p = ws(p);
    if (*p != ',') return false;
    p = ws(p + 1);
  }
  return false;
}
// Appends obj's members as ,"key":value, except payload and keys found in except.
inline void members(String& out, const char* obj, const char* except) {
  const char* p = ws(obj);
  if (*p != '{') return;
  p = ws(p + 1);
  while (*p == '"') {
    const char* k = p;
    const char* ke = str(p);
    if (!ke) return;
    const char* v = ws(ke);
    if (*v != ':') return;
    v = ws(v + 1);
    const char* ve = value(v, 1);
    if (!ve) return;
    bool skipIt = (ke - k == 9 && !strncmp(k, "\"payload\"", 9)) || (except && hasKey(except, k, ke));
    if (!skipIt) {
      out += ',';
      while (k < ke) out += *k++;
      out += ':';
      out += trimmed(v, ve);
    }
    p = ws(ve);
    if (*p != ',') return;
    p = ws(p + 1);
  }
}
// The message a node receives: a message object as it is, anything else (a raw value
// from an input, the test terminal, …) as its payload.
inline String in(const String& text, bool raw) {
  const char* p = text.c_str();
  if (!raw && *ws(p) == '{' && valid(p)) {
    const char* k = "\"payload\"";
    if (hasKey(p, k, k + 9)) return trimmed(p, p + text.length());
  }
  return "{\"payload\":" + payloadJson(text) + "}";
}
// msg.payload as text: a string's text, any other value as written.
inline String payload(const String& msg) { return mfJson::jsonText(msg, "payload"); }
// The message a node sends: the new payload, the node's own fields (its Message
// box), then the other fields of the message it received.
inline String out(const String& msgIn, const String& payloadText, const char* fields) {
  String o = "{\"payload\":";
  o += payloadJson(payloadText);
  members(o, fields, NULL);
  members(o, msgIn.c_str(), fields);
  o += '}';
  return o;
}
} // namespace mfMsg
`;
module.exports = { helpers, msgHelpers };
