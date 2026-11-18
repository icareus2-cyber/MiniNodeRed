// Terminal nodes: like Inject, but fired by typing "<command> <data>" in any terminal:
// USB serial, the IDE's test terminal (USB or MQTT) or the board's web page.
// Debug builds route it through the test terminal (mfCommand); release builds get a
// small USB serial line reader of their own.

// Built-in test terminal commands a Terminal node may not shadow.
const RESERVED = [
  "help",
  "status",
  "wifi",
  "gpio",
  "adc",
  "pwm",
  "nodes",
  "send",
  "pub",
  "echo",
  "reboot",
  "lcd",
  "mf?",
];
const nodesOf = (nodes) => nodes.filter((n) => n.type === "terminal");
const uses = (nodes) => nodesOf(nodes).length > 0;

// mfTerminal(line) fires the Terminal nodes whose command is the first word and
// returns a reply, or "" when no Terminal node has that command.
function globals(nodes, index) {
  const byCommand = new Map();
  for (const n of nodesOf(nodes))
    byCommand.set(n.config.command, [
      ...(byCommand.get(n.config.command) || []),
      index.get(n.id),
    ]);
  const cases = [...byCommand]
    .map(
      ([command, ids]) =>
        `  if (cmd == ${JSON.stringify(command)}) { ${ids.map((i) => `node${i}(data);`).join(" ")} return String("→ ${command}: \\"") + data + "\\""; }`,
    )
    .join("\n");
  return `// Terminal nodes: "<command> <data>" typed in any terminal.
String mfTerminal(String line) {
  line.trim();
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String data = sp < 0 ? String() : line.substring(sp + 1);
  cmd.toLowerCase();
  data.trim();
${cases}
  return "";
}
`;
}

// Release builds have no test terminal, so Terminal nodes read USB serial themselves.
const releasePoll = `void mfTerminalPoll() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 10 || c == 13) {
      if (line.length()) {
        String reply = mfTerminal(line);
        Serial.println(String("» ") + (reply.length() ? reply : String("error: unknown command")));
      }
      line = "";
    } else if (line.length() < 128) line += c;
  }
}
`;

module.exports = { RESERVED, uses, globals, releasePoll };
