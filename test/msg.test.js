// Node-RED language: JSON messages on every wire (lib/msg.js for the simulator,
// mfMsg in lib/jsonfw.js for the firmware), variable types and the language setting.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("../lib/msg");
const { helpers, msgHelpers } = require("../lib/jsonfw");
const { validate, build } = require("../lib/flow");
const { varType, payloadType } = require("../lib/nodes");

test("raw values become the payload; message objects pass as they are", () => {
  assert.equal(M.msgIn("1", true), '{"payload":1}');
  assert.equal(M.msgIn("21.50", true), '{"payload":21.50}');
  assert.equal(M.msgIn("on", true), '{"payload":"on"}');
  assert.equal(M.msgIn("", true), '{"payload":""}');
  assert.equal(M.msgIn('"q"', true), '{"payload":"\\"q\\""}');
  assert.equal(M.msgIn(' {"t": 1} ', true), '{"payload":{"t": 1}}');
  assert.equal(M.msgIn("[1,2", true), '{"payload":"[1,2"}');
  // A message object (has payload) is kept when it comes from another node...
  const m = '{"payload":1,"topic":"SW1"}';
  assert.equal(M.msgIn(m, false), m);
  // ...but an input node treats whatever arrives as its payload.
  assert.equal(M.msgIn(m, true), `{"payload":${m}}`);
  // Objects without payload are payloads too.
  assert.equal(M.msgIn('{"t":1}', false), '{"payload":{"t":1}}');
});
test("payloadOf gives text: strings unescaped, other values as written", () => {
  assert.equal(M.payloadOf('{"payload":"a\\"b\\u00e9"}'), 'a"bé');
  assert.equal(M.payloadOf('{"payload":21.50}'), "21.50");
  assert.equal(M.payloadOf('{"payload":{"t": 1}, "x":2}'), '{"t": 1}');
  assert.equal(M.payloadOf('{"topic":"x"}'), "");
});
test("msgOut: new payload, the node's fields, then the received fields", () => {
  assert.equal(
    M.msgOut(
      '{"payload":1,"topic":"SW1","room":"lab"}',
      "0",
      '{"topic":"gate"}',
    ),
    '{"payload":0,"topic":"gate","room":"lab"}',
  );
  assert.equal(M.msgOut('{"payload":1}', "hi", "{}"), '{"payload":"hi"}');
  // A payload in the fields is ignored: the node sets it.
  assert.equal(
    M.msgOut('{"payload":1}', "2", '{"payload":9}'),
    '{"payload":2}',
  );
  assert.equal(M.checkFields(' { "topic" : "SW1" } '), '{"topic":"SW1"}');
  assert.throws(() => M.checkFields("{x}"), /valid JSON/);
  assert.throws(() => M.checkFields("[1]"), /JSON object/);
  assert.throws(
    () => M.checkFields('{"payload":1}'),
    /payload is set by the node/,
  );
});
test("validate: language, default Message boxes, types", () => {
  const nodes = () => [
    { id: "s", type: "test-switch", name: "SW1", config: {} },
    { id: "d", type: "debug", config: {} },
  ];
  const plain = validate({ nodes: nodes(), edges: [] });
  assert.equal(plain.language, "arduino");
  assert.equal(plain.nodes[0].msg, undefined);
  const red = validate({ language: "nodered", nodes: nodes(), edges: [] });
  assert.equal(red.nodes[0].msg, '{"topic":"SW1"}'); // inputs name the source
  assert.equal(red.nodes[1].msg, "{}");
  assert.throws(
    () =>
      validate({
        language: "nodered",
        nodes: [
          {
            id: "a",
            type: "debug",
            label: "Log",
            msg: '{"payload":1}',
            config: {},
          },
        ],
        edges: [],
      }),
    /Log: Message: payload/,
  );
  assert.throws(
    () =>
      validate({
        nodes: [
          { id: "a", type: "debug", label: "Log", vtype: "float", config: {} },
        ],
        edges: [],
      }),
    /Log: variable type/,
  );
  const auto = validate({
    nodes: [{ id: "a", type: "debug", vtype: "auto", config: {} }],
    edges: [],
  });
  assert.equal(auto.nodes[0].vtype, undefined);
});
test("variable types follow the node kind, the inject payload, or the input", () => {
  const flow = validate({
    nodes: [
      { id: "sw", type: "test-switch", config: {} },
      { id: "adc", type: "analog-in", config: { pin: 34 } },
      { id: "map", type: "scale", config: {} },
      { id: "i1", type: "inject", config: { payload: "5" } },
      { id: "i2", type: "inject", config: { payload: "2.5" } },
      { id: "i3", type: "inject", config: { payload: "true" } },
      { id: "i4", type: "inject", config: { payload: "hello" } },
      { id: "cmp", type: "compare", config: { op: "gt", value: "1" } },
      { id: "thr", type: "throttle", config: {} },
      { id: "dbg", type: "debug", vtype: "String", config: {} },
      { id: "mqtt", type: "mqtt-in", config: { topic: "a/b" } },
    ],
    edges: [
      { from: "adc", to: "map" },
      { from: "adc", to: "cmp" },
      { from: "sw", to: "thr" },
      { from: "i4", to: "thr" },
      { from: "sw", to: "dbg" },
    ],
  });
  const ins = (n) =>
    flow.edges
      .filter((e) => e.to === n.id)
      .map((e) => flow.nodes.find((m) => m.id === e.from));
  const t = Object.fromEntries(flow.nodes.map((n) => [n.id, varType(n, ins)]));
  assert.deepEqual(t, {
    sw: "bool",
    adc: "int",
    map: "double",
    i1: "int",
    i2: "double",
    i3: "bool",
    i4: "String",
    cmp: "int", // passes its single input's values on
    thr: "String", // mixed inputs (bool and String)
    dbg: "String", // chosen
    mqtt: "String",
  });
  assert.equal(payloadType("1e3"), "double");
  assert.equal(payloadType("12345678901"), "double"); // too big for int
});

const gxx = spawnSync("g++", ["--version"]).status === 0;
// Arduino String stand-in for host g++ runs.
const STUB = `#include <string>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <iostream>
using std::isfinite;
struct String {
  std::string s;
  String() {}
  String(const char* c) : s(c) {}
  String(const std::string& c) : s(c) {}
  explicit String(char c) : s(1, c) {}
  explicit String(int v) : s(std::to_string(v)) {}
  explicit String(unsigned int v) : s(std::to_string(v)) {}
  explicit String(long v) : s(std::to_string(v)) {}
  explicit String(unsigned long v) : s(std::to_string(v)) {}
  explicit String(double v, unsigned int d = 2) { char b[64]; snprintf(b, 64, "%.*f", (int)d, v); s = b; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* o) { s += o; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  bool operator==(const char* o) const { return s == o; }
  bool operator==(const String& o) const { return s == o.s; }
  char operator[](unsigned int i) const { return s[i]; }
  int indexOf(char c) const { auto p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  bool endsWith(const char* x) const { size_t n = strlen(x); return s.size() >= n && s.compare(s.size() - n, n, x) == 0; }
  void remove(unsigned int i) { s.erase(i); }
  void reserve(unsigned int n) { s.reserve(n); }
  unsigned int length() const { return s.size(); }
  const char* c_str() const { return s.c_str(); }
};
inline String operator+(const String& a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const char* a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, const char* b) { String r(a); r += b; return r; }
`;
function compileAndRun(code, input = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-msg-"));
  fs.writeFileSync(path.join(dir, "t.cpp"), code);
  const exe = path.join(dir, "t");
  const cc = spawnSync(
    "g++",
    [
      "-std=gnu++17",
      "-O1",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      exe,
      path.join(dir, "t.cpp"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(cc.status, 0, cc.stderr);
  const run = spawnSync(exe, { input, encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
test(
  "firmware and simulator build the same messages",
  { skip: !gxx && "g++ not found" },
  () => {
    const hex = (s) => Buffer.from(s, "utf8").toString("hex") || "_";
    const program = `${STUB}${helpers}${msgHelpers}
std::string unhex(const std::string& h) { std::string s; for (size_t i = 0; i + 1 < h.size(); i += 2) s += (char)strtol(h.substr(i, 2).c_str(), 0, 16); return s; }
std::string hex(const std::string& s) { static const char* d = "0123456789abcdef"; std::string o; for (unsigned char c : s) { o += d[c >> 4]; o += d[c & 15]; } return o.empty() ? "_" : o; }
int main() {
  std::string a, b, c;
  while (std::cin >> a >> b >> c) {
    String m = mfMsg::in(String(unhex(a)), c == "1");
    String o = mfMsg::out(m, String(unhex(a)), unhex(b).c_str());
    std::cout << hex(m.s) << " " << hex(mfMsg::payload(m).s) << " " << hex(o.s) << "\\n";
  }
}`;
    const seeds = [
      '{"payload":1,"topic":"SW1"}',
      '{"payload":{"t":21.50},"room":"lab"}',
      "21.50",
      "on",
      "",
      ' { "a" : [1, 2, {"b": "x\\"y"}] } ',
      '"quoted"',
      "-0.5e+3",
      '{"payload":"\\u00e9\\n"}',
      "[1,2",
      "héllo ✓",
      '{"a":"\\ud83d\\ude00","payload":[]}',
    ];
    const fields = ['{"topic":"GPIO4"}', "{}", '{"room":"lab","topic":"T"}'];
    const alphabet = '{}[]":,\\u0123abcdefnrt.-+E 9';
    let seed = 7;
    const r = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const cases = [];
    for (let k = 0; k < 4000; k++) {
      let s = seeds[r(seeds.length)];
      for (let e = r(3); e > 0; e--) {
        const at = r(s.length + 1);
        s =
          r(2) && s.length
            ? s.slice(0, at) + s.slice(at + 1)
            : s.slice(0, at) + alphabet[r(alphabet.length)] + s.slice(at);
      }
      cases.push([s, fields[r(fields.length)], r(2)]);
    }
    const lines = compileAndRun(
      program,
      cases.map(([s, f, raw]) => `${hex(s)} ${hex(f)} ${raw}`).join("\n"),
    )
      .trim()
      .split("\n");
    cases.forEach(([s, f, raw], k) => {
      const m = M.msgIn(s, raw === 1);
      assert.equal(
        lines[k],
        `${hex(m)} ${hex(M.payloadOf(m))} ${hex(M.msgOut(m, s, f))}`,
        JSON.stringify([s, f, raw]),
      );
    });
  },
);
test(
  "Node-RED language firmware: messages through nodes and an Arduino node",
  { skip: !gxx && "g++ not found" },
  () => {
    const flow = {
      name: "t",
      language: "nodered",
      nodes: [
        { id: "a", type: "test-switch", name: "SW_A", config: {} },
        {
          id: "lv",
          type: "inject",
          name: "LEVEL",
          config: { payload: "21.5", interval: 0 },
        },
        { id: "th", type: "threshold", config: { value: 20 } },
        {
          id: "tpl",
          type: "template",
          msg: '{"room":"lab"}',
          config: { template: '{"t":{{payload}}}' },
        },
        {
          id: "g",
          type: "arduino",
          label: "Gate",
          msg: '{"topic":"gate"}',
          config: {
            pins: "",
            vars: "",
            message:
              'if (from == "SW_A") send(SW_A && THRESH1 > 20 ? 1 : 0);\nelse sendMsg(Json().add("payload", THRESH1, 1).add("from", jsonText(msg, "topic")));',
          },
        },
        { id: "d", type: "debug", config: { show: "msg" } },
      ],
      edges: [
        { from: "a", to: "g" },
        { from: "lv", to: "th" },
        { from: "th", to: "g" },
        { from: "lv", to: "tpl" },
        { from: "tpl", to: "d" },
        { from: "g", to: "d" },
      ],
    };
    const { source } = build(structuredClone(flow), {
      board: "esp32",
      profile: "release",
      ota: false,
    });
    const from = source.indexOf("// ── JSON helpers");
    const to = source.indexOf("void setup()");
    const code = source
      .slice(from, to)
      // The Debug node (release build: no output) logs what it receives.
      .replace(
        /(\/\/ Debug \(debug\)\nvoid node(\d+)\(String value\) \{\n)/,
        '$1  std::cout << value.s << "\\n";\n',
      );
    const out = compileAndRun(`${STUB}
bool mfNumber(const String& s, double& o) { const char* a = s.c_str(); char* e; o = strtod(a, &e); return e != a && !*e; }
${flow.nodes.map((n, i) => `void node${i}(String value);`).join("\n")}
${code}
int main() { node1(String("21.5")); node0(String("1")); node0(String("0")); node1(String("5")); }`);
    assert.deepEqual(out.trim().split("\n"), [
      // LEVEL 21.5 passes Threshold into the gate, which sends a message of its own...
      '{"payload":21.5,"from":"LEVEL"}',
      // ...and goes through Template, which keeps topic and adds its room field.
      '{"payload":{"t":21.5},"room":"lab","topic":"LEVEL"}',
      // SW_A on: bool SW_A and double THRESH1 → 1, with the gate's topic.
      '{"payload":1,"topic":"gate"}',
      '{"payload":0,"topic":"gate"}',
      '{"payload":{"t":5},"room":"lab","topic":"LEVEL"}',
    ]);
  },
);
