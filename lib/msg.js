// Node-RED style messages ({"payload":…,"topic":…}) for flows in Node-RED language.
// Mirrors mfMsg in lib/jsonfw.js (the firmware), so the PC simulator and the board
// produce the same text: values are copied as written, never re-formatted.
const WS = new Set([" ", "\t", "\r", "\n"]);
const ws = (s, i) => {
  while (i < s.length && WS.has(s[i])) i++;
  return i;
};
const digit = (c) => c >= "0" && c <= "9";
const hexDigit = (c) => /^[0-9a-fA-F]$/.test(c || "");
// End index of the JSON string at i, or -1.
function str(s, i) {
  if (s[i] !== '"') return -1;
  for (i++; i < s.length && s[i] !== '"'; i++) {
    if (s.charCodeAt(i) < 0x20) return -1;
    if (s[i] === "\\") {
      i++;
      if (s[i] === "u") {
        for (let k = 1; k <= 4; k++) if (!hexDigit(s[i + k])) return -1;
        i += 4;
      } else if (i >= s.length || !'"\\/bfnrt'.includes(s[i])) return -1;
    }
  }
  return i < s.length ? i + 1 : -1;
}
function num(s, i) {
  if (s[i] === "-") i++;
  if (s[i] === "0") i++;
  else if (s[i] >= "1" && s[i] <= "9") while (digit(s[i])) i++;
  else return -1;
  if (s[i] === ".") {
    i++;
    if (!digit(s[i])) return -1;
    while (digit(s[i])) i++;
  }
  if (s[i] === "e" || s[i] === "E") {
    i++;
    if (s[i] === "+" || s[i] === "-") i++;
    if (!digit(s[i])) return -1;
    while (digit(s[i])) i++;
  }
  return i;
}
// End index of the valid JSON value at i, or -1.
function value(s, i, depth) {
  i = ws(s, i);
  if (depth > 16) return -1;
  if (s[i] === "{") {
    i = ws(s, i + 1);
    if (s[i] === "}") return i + 1;
    for (;;) {
      i = str(s, i);
      if (i < 0) return -1;
      i = ws(s, i);
      if (s[i] !== ":") return -1;
      i = value(s, i + 1, depth + 1);
      if (i < 0) return -1;
      i = ws(s, i);
      if (s[i] === ",") {
        i = ws(s, i + 1);
        continue;
      }
      return s[i] === "}" ? i + 1 : -1;
    }
  }
  if (s[i] === "[") {
    i = ws(s, i + 1);
    if (s[i] === "]") return i + 1;
    for (;;) {
      i = value(s, i, depth + 1);
      if (i < 0) return -1;
      i = ws(s, i);
      if (s[i] === ",") {
        i++;
        continue;
      }
      return s[i] === "]" ? i + 1 : -1;
    }
  }
  if (s[i] === '"') return str(s, i);
  if (s.startsWith("true", i) || s.startsWith("null", i)) return i + 4;
  if (s.startsWith("false", i)) return i + 5;
  return num(s, i);
}
const valid = (s) => {
  const e = value(s, 0, 0);
  return e >= 0 && ws(s, e) === s.length;
};
const trimmed = (s, a, b) => {
  a = ws(s, a);
  while (b > a && WS.has(s[b - 1])) b--;
  return s.slice(a, b);
};
// Same escaping as mfJson::jsonQuote.
function quote(text) {
  let out = '"';
  for (const c of text) {
    if (c === '"' || c === "\\") out += "\\" + c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c.charCodeAt(0) < 0x20)
      out += "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    else out += c;
  }
  return out + '"';
}
// A payload as JSON: numbers, true/false/null, objects and arrays as written; any
// other text (strings too) quoted.
const payloadJson = (v) =>
  valid(v) && v[ws(v, 0)] !== '"' ? trimmed(v, 0, v.length) : quote(v);
// Top-level members of an object: [{ key (raw, with quotes), value (raw) }].
function members(s) {
  const out = [];
  let i = ws(s, 0);
  if (s[i] !== "{") return out;
  i = ws(s, i + 1);
  while (s[i] === '"') {
    const ke = str(s, i);
    if (ke < 0) return out;
    let v = ws(s, ke);
    if (s[v] !== ":") return out;
    v = ws(s, v + 1);
    const ve = value(s, v, 1);
    if (ve < 0) return out;
    out.push({ key: s.slice(i, ke), value: trimmed(s, v, ve) });
    i = ws(s, ve);
    if (s[i] !== ",") return out;
    i = ws(s, i + 1);
  }
  return out;
}
const PAYLOAD = '"payload"';
// The message a node receives: a message object as it is; anything else (a raw
// value from an input, the test terminal, …) becomes its payload.
function msgIn(text, raw) {
  text = String(text);
  if (
    !raw &&
    text[ws(text, 0)] === "{" &&
    valid(text) &&
    members(text).some((m) => m.key === PAYLOAD)
  )
    return trimmed(text, 0, text.length);
  return `{"payload":${payloadJson(text)}}`;
}
// msg.payload as text: a string's text, any other value as written.
function payloadOf(msg) {
  const m = members(msg).find((x) => x.key === PAYLOAD);
  if (!m) return "";
  return m.value.startsWith('"') ? JSON.parse(m.value) : m.value;
}
// The message a node sends: the new payload, the node's own fields (its Message box),
// then the other fields of the message it received.
function msgOut(msgInText, payload, fields = "{}") {
  const own = members(fields).filter((m) => m.key !== PAYLOAD);
  const ownKeys = new Set(own.map((m) => m.key));
  const rest = members(msgInText).filter(
    (m) => m.key !== PAYLOAD && !ownKeys.has(m.key),
  );
  return `{"payload":${payloadJson(String(payload))}${[...own, ...rest]
    .map((m) => `,${m.key}:${m.value}`)
    .join("")}}`;
}
// A node's Message box: a JSON object of extra fields (not payload), compact.
function checkFields(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw Error('Message must be valid JSON, e.g. {"topic": "SW1"}.');
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw Error('Message must be a JSON object, e.g. {"topic": "SW1"}.');
  if (Object.hasOwn(obj, "payload"))
    throw Error(
      "Message: payload is set by the node itself; use other fields (topic, room, …).",
    );
  return JSON.stringify(obj);
}
module.exports = {
  valid,
  payloadJson,
  msgIn,
  payloadOf,
  msgOut,
  checkFields,
  quote,
};
