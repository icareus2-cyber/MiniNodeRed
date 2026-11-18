#!/usr/bin/env node
// Microflow accounts from the command line (on the server, e.g. over SSH):
//   npm run user -- add <name> [--admin]   create an account (asks for the password)
//   npm run user -- passwd <name>          set a new password (logs it out everywhere)
//   npm run user -- admin <name> on|off    give or take admin rights
//   npm run user -- disable <name> | enable <name>
//   npm run user -- delete <name>          delete the account and its flows
//   npm run user -- list [--json]
// Uses the same database as the server (DB_PATH, default data/microflow.sqlite).
// The first account is always an admin and receives the flows made before accounts.
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { openStore } = require("../lib/store");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "microflow.sqlite");
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const store = openStore(dbPath);
const [cmd, name, arg] = process.argv.slice(2);

// Reads a password without showing it.
function ask(question) {
  return new Promise((resolve) => {
    if (process.env.MICROFLOW_PASSWORD) return resolve(process.env.MICROFLOW_PASSWORD);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}
async function newPassword() {
  const a = await ask("Password (at least 8 characters): ");
  const b = process.env.MICROFLOW_PASSWORD ? a : await ask("Same password again: ");
  if (a !== b) throw Error("The passwords differ.");
  return a;
}
const userId = (n) => {
  const u = store.listUsers().find((x) => x.name.toLowerCase() === String(n).toLowerCase());
  if (!u) throw Error(`No user “${n}”.`);
  return u.id;
};
async function main() {
  switch (cmd) {
    case "add": {
      if (!name) throw Error("Usage: npm run user -- add <name> [--admin]");
      const u = store.createUser({ name, password: await newPassword(), admin: process.argv.includes("--admin") });
      console.log(`Created ${u.name}${u.admin ? " (admin)" : ""}.`);
      break;
    }
    case "passwd":
      store.updateUser(userId(name), { password: await newPassword() });
      console.log(`New password set for ${name}; logged out everywhere.`);
      break;
    case "admin":
      if (!["on", "off"].includes(arg)) throw Error("Usage: npm run user -- admin <name> on|off");
      store.updateUser(userId(name), { admin: arg === "on" });
      console.log(`${name}: admin ${arg}.`);
      break;
    case "disable":
    case "enable":
      store.updateUser(userId(name), { disabled: cmd === "disable" });
      console.log(`${name}: ${cmd}d.`);
      break;
    case "delete":
      if (!store.deleteUser(userId(name))) throw Error(`No user “${name}”.`);
      console.log(`${name}: deleted.`);
      break;
    case "list":
      if (process.argv.includes("--json")) {
        console.log(JSON.stringify(store.listUsers()));
        break;
      }
      for (const u of store.listUsers())
        console.log(
          `${u.name.padEnd(20)} ${u.admin ? "admin" : "user "} ${u.disabled ? "disabled" : "active  "} flows ${u.flows}  last login ${u.last_login || "never"}`,
        );
      break;
    default:
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 10).join("\n").replace(/^\/\/ ?/gm, ""));
  }
}
main()
  .catch((e) => {
    console.error("Error: " + e.message);
    process.exitCode = 1;
  })
  .finally(() => store.close());
