// The browser scripts share globals (broker(), settings(), api(), flow, …). A local
// variable with the same name hides the global inside that function: e.g. taking
// `broker` out of an API reply made broker() "not a function" on upload.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const SHARED = [
  "broker",
  "settings",
  "api",
  "flow",
  "catalog",
  "boards",
  "el",
  "modal",
  "toast",
  "attempt",
  "button",
  "render",
  "showNode",
  "saveSettings",
];
// Names bound by `const|let|var { … } =` destructuring (`a: b` binds b).
function destructured(source) {
  const names = [];
  const re = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g;
  let m;
  while ((m = re.exec(source))) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/=.*$/, "").trim();
      if (!p || p.startsWith("...")) continue;
      const bound = p.includes(":") ? p.split(":")[1].trim() : p;
      const line = source.slice(0, m.index).split("\n").length;
      names.push([bound, line]);
    }
  }
  return names;
}
test("browser scripts do not hide shared globals with local variables", () => {
  const dir = path.join(__dirname, "../public");
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const [name, line] of destructured(source))
      if (SHARED.includes(name))
        problems.push(`${file}:${line} binds "${name}"`);
    // Plain local declarations inside functions (indented), e.g. "  const broker =".
    source.split("\n").forEach((text, i) => {
      const m = /^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text);
      if (m && SHARED.includes(m[1]))
        problems.push(`${file}:${i + 1} declares "${m[1]}"`);
    });
  }
  assert.deepEqual(problems, []);
});

// Two classic scripts declaring the same top-level name stop the later one from
// loading ("Identifier … has already been declared"), e.g. a helper named like one
// in boardview.js.
test("browser scripts do not declare the same top-level name twice", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !src.startsWith("vendor/") && !/^https?:/.test(src));
  const seen = new Map();
  const clashes = [];
  for (const src of scripts) {
    const text = fs.readFileSync(path.join(__dirname, "../public", src), "utf8");
    const re = /^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1] || m[2];
      if (seen.has(name) && seen.get(name) !== src)
        clashes.push(`${name}: ${seen.get(name)} and ${src}`);
      else seen.set(name, src);
    }
  }
  assert.deepEqual(clashes, []);
});
