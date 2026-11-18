// Web nodes: the board serves a JSON API and a small page on port 80.
//   GET  /api          → {"<Web out name>": value, …}  (null until set)
//   GET  /api/<name>   → {"<name>": value}
//   POST /api/<name>   → the request body (JSON) goes to the Web in node(s) named
//                        <name>; the flow runs, then the reply is GET /api, so one
//                        request carries input and output.
//   POST /terminal     → one terminal line (Terminal nodes, and the test terminal in
//                        debug builds); the reply is plain text.
//   GET  /camera/<node id>.png → the Camera node's latest picture (lib/camerafw.js).
//   GET  /             → page with the values, an input box per Web in and a terminal.
// CORS is open so other pages on the LAN can call the API. There is no login: anyone
// on the same network can read and post.
const camerafw = require("./camerafw");
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const outs = (nodes) => [
  ...new Set(
    nodes.filter((n) => n.type === "web-out").map((n) => n.config.name),
  ),
];
const ins = (nodes) => [
  ...new Set(
    nodes.filter((n) => n.type === "web-in").map((n) => n.config.name),
  ),
];
// Camera nodes need the web server too: their pictures are served at /camera/….
const uses = (nodes) =>
  nodes.some(
    (n) => n.type === "web-in" || n.type === "web-out" || n.type === "camera",
  );
const outIndex = (nodes, name) => outs(nodes).indexOf(name);

// Same rule as the firmware's mfWebJson(), for the simulator.
function toJson(value) {
  const v = String(value).trim();
  if (["true", "false", "null"].includes(v)) return v;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return v;
  const [a, b] = [v[0], v[v.length - 1]];
  if (
    v.length > 1 &&
    ((a === "{" && b === "}") ||
      (a === "[" && b === "]") ||
      (a === '"' && b === '"'))
  )
    return v;
  return JSON.stringify(String(value).trim());
}
const includes = (family) =>
  family === "esp8266"
    ? "#include <ESP8266WebServer.h>\n"
    : "#include <WebServer.h>\n";

// The page lists the Web in names; Web out names come from GET /api.
const page = (inputs) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Microflow</title>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:16px;background:#f4f6f2;color:#1f2a22}
h1{font-size:18px;margin:0 0 12px}h2{font-size:13px;text-transform:uppercase;color:#5d6e62;margin:18px 0 6px}
.card{background:#fff;border:1px solid #d5ded6;border-radius:8px;padding:10px;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px}.v{font-family:ui-monospace,monospace;word-break:break-all}
textarea,input{width:100%;box-sizing:border-box;font:13px ui-monospace,monospace;padding:6px;border:1px solid #b9c7bd;border-radius:6px}
button{margin-top:6px;padding:6px 14px;border:1px solid #5d8a6a;background:#e9f2ea;border-radius:6px;cursor:pointer}
pre{margin:6px 0 0;white-space:pre-wrap;font:12px ui-monospace,monospace;color:#3d5145}</style></head><body>
<h1>Microflow device</h1><h2>Values · GET /api</h2><div id="out" class="card">loading…</div>
<div id="in"></div><h2>Terminal · POST /terminal</h2><div class="card">
<input id="cmd" placeholder="command data (e.g. help)"><pre id="log"></pre></div>
<script>const IN=${JSON.stringify(inputs)};const $=(i)=>document.getElementById(i);
const esc=(s)=>String(s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
function show(o){$("out").innerHTML=Object.keys(o).length?Object.entries(o).map(([k,v])=>'<div class="row"><b>'+esc(k)+'</b><span class="v">'+esc(JSON.stringify(v))+'</span></div>').join(""):"no Web out nodes";}
async function poll(){try{show(await (await fetch("api")).json());}catch(e){}}
for(const n of IN){const d=document.createElement("div");d.innerHTML='<h2>'+n+' · POST /api/'+n+'</h2><div class="card"><textarea rows="2">{"value": 1}</textarea><button>Send</button><pre></pre></div>';
d.querySelector("button").onclick=async()=>{const r=await fetch("api/"+n,{method:"POST",headers:{"Content-Type":"application/json"},body:d.querySelector("textarea").value});const t=await r.text();d.querySelector("pre").textContent=r.status+" "+t;try{show(JSON.parse(t));}catch(e){}};$("in").append(d);}
$("cmd").onkeydown=async(e)=>{if(e.key!=="Enter")return;const line=e.target.value;e.target.value="";const r=await fetch("terminal",{method:"POST",headers:{"Content-Type":"text/plain"},body:line});$("log").textContent="> "+line+"\\n"+await r.text()+"\\n"+$("log").textContent;poll();};
poll();setInterval(poll,1000);</script></body></html>`;

// terminal: C++ expression that answers one terminal line.
function globals(nodes, index, family, terminal) {
  const o = outs(nodes);
  const server = family === "esp8266" ? "ESP8266WebServer" : "WebServer";
  const dispatch = ins(nodes)
    .map(
      (name) =>
        `      if (name == ${JSON.stringify(name)}) { hit = true; ${nodes
          .filter((n) => n.type === "web-in" && n.config.name === name)
          .map((n) => `node${index.get(n.id)}(body);`)
          .join(" ")} }`,
    )
    .join("\n");
  const html = page(ins(nodes));
  if (html.includes(')MF"')) throw Error("Web page delimiter clash.");
  return `// Web nodes: JSON API and page on port 80
${server} mfWeb(80);
const char* const MF_WEB_OUT[] = { ${o.length ? o.map((n) => JSON.stringify(n)).join(", ") : "nullptr"} };
const size_t MF_WEB_OUT_COUNT = ${o.length};
String mfWebVal[${Math.max(o.length, 1)}];
static const char MF_PAGE[] PROGMEM = R"MF(${html})MF";
// Values that already are JSON (number, true/false/null, object, array, string)
// pass unchanged; any other text becomes a JSON string.
String mfWebJson(String v) { // not mfJson: that is the JSON helpers' namespace
  v.trim();
  if (v == "true" || v == "false" || v == "null") return v;
  // JSON number: starts with a digit (or - and a digit), ends with a digit.
  bool num = v.length() > 0 && isdigit((unsigned char)v[v.length() - 1]) &&
    (isdigit((unsigned char)v[0]) || (v[0] == '-' && v.length() > 1 && isdigit((unsigned char)v[1])));
  for (unsigned i = 0; num && i < v.length(); i++) num = strchr("0123456789.eE+-", v[i]) != nullptr;
  double x;
  if (num && mfNumber(v, x)) return v;
  char a = v.length() ? v[0] : 0, b = v.length() ? v[v.length() - 1] : 0;
  if (v.length() > 1 && ((a == '{' && b == '}') || (a == '[' && b == ']') || (a == '"' && b == '"'))) return v;
  String out = "\\"";
  for (unsigned i = 0; i < v.length(); i++) {
    char c = v[i];
    if (c == '"' || c == '\\\\') { out += '\\\\'; out += c; }
    else if ((unsigned char)c < 0x20) { char e[7]; snprintf(e, sizeof e, "\\\\u%04x", c); out += e; }
    else out += c;
  }
  return out + "\\"";
}
void mfWebSet(size_t k, const String& v) { mfWebVal[k] = mfWebJson(v); }
String mfWebAll() {
  String o = "{";
  for (size_t k = 0; k < MF_WEB_OUT_COUNT; k++) {
    if (k) o += ",";
    o += String("\\"") + MF_WEB_OUT[k] + "\\":" + (mfWebVal[k].length() ? mfWebVal[k] : String("null"));
  }
  return o + "}";
}
void mfWebSend(int code, const char* type, const String& body) {
  mfWeb.sendHeader("Access-Control-Allow-Origin", "*");
  mfWeb.sendHeader("Cache-Control", "no-store");
  mfWeb.send(code, type, body);
}
${camerafw.webGlobals(nodes, index)}
void mfWebHandle() {
  String uri = mfWeb.uri();
  HTTPMethod method = mfWeb.method();
  if (method == HTTP_OPTIONS) {
    mfWeb.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    mfWeb.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    return mfWebSend(204, "text/plain", "");
  }
  if ((uri == "/api" || uri == "/api/") && method == HTTP_GET) return mfWebSend(200, "application/json", mfWebAll());
  if (uri.startsWith("/api/")) {
    String name = uri.substring(5);
    if (method == HTTP_GET) {
      for (size_t k = 0; k < MF_WEB_OUT_COUNT; k++)
        if (name == MF_WEB_OUT[k]) return mfWebSend(200, "application/json", String("{\\"") + name + "\\":" + (mfWebVal[k].length() ? mfWebVal[k] : String("null")) + "}");
    } else if (method == HTTP_POST) {
      String body = mfWeb.arg("plain");
      body.trim();
      bool hit = false;
${dispatch}
      if (hit) return mfWebSend(200, "application/json", mfWebAll());
    }
    return mfWebSend(404, "application/json", String("{\\"error\\":\\"no Web ") + (method == HTTP_GET ? "out" : "in") + " node named '" + name + "'\\"}");
  }
${nodes.some((n) => n.type === "camera") ? '  if (method == HTTP_GET && uri.startsWith("/camera/") && mfCameraRoute(uri)) return;\n' : ""}  if (uri == "/terminal" && method == HTTP_POST) {
    String line = mfWeb.arg("plain");
    return mfWebSend(200, "text/plain; charset=utf-8", ${terminal});
  }
  mfWebSend(404, "application/json", "{\\"error\\":\\"not found\\"}");
}
`;
}

const setup = [
  `mfWeb.on("/", HTTP_GET, []() { mfWeb.send_P(200, "text/html", MF_PAGE); });`,
  "mfWeb.onNotFound(mfWebHandle);",
  "mfWeb.begin();",
];
const loop = "mfWeb.handleClient();";

module.exports = {
  toJson,
  NAME,
  outs,
  ins,
  uses,
  outIndex,
  includes,
  globals,
  setup,
  loop,
  page,
};
