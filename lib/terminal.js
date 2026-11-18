// Test terminal over MQTT: publishes one command line to microflow/<id>/cmd and
// waits for the reply on microflow/<id>/cmd/reply (see lib/shellfw.js).
const mqtt = require("mqtt");
const { randomBytes } = require("node:crypto");
const { checkBroker, brokerHint } = require("./runtime");
function checkLine(line) {
  if (
    typeof line !== "string" ||
    !line.trim() ||
    line.length > 200 ||
    /[\r\n]/.test(line)
  )
    throw Error("Enter one command (up to 200 characters).");
  return line.trim();
}
async function mqttCommand({
  broker,
  deviceId,
  line,
  connect = mqtt.connect,
  timeout = 8000,
}) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(deviceId || ""))
    throw Error("Enter the board's Device ID.");
  const command = checkLine(line);
  const options = checkBroker(broker);
  const base = `microflow/${deviceId}`;
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-term-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", (e) => reject(Error(brokerHint(e, options.url))));
    });
    await new Promise((resolve, reject) =>
      client.subscribe(`${base}/cmd/reply`, (e) => (e ? reject(e) : resolve())),
    );
    const started = Date.now();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Error(
              `${deviceId} did not answer within ${timeout / 1000} s. Is it online on this broker and running a Debug build that includes the test terminal?`,
            ),
          ),
        timeout,
      );
      client.on("message", (topic, payload, packet) => {
        if (packet.retain) return;
        clearTimeout(timer);
        resolve(payload.toString());
      });
    });
    client.publish(`${base}/cmd`, command);
    return { reply: await reply, ms: Date.now() - started };
  } finally {
    client.end(true);
  }
}
module.exports = { mqttCommand, checkLine };
