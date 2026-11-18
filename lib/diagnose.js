// Explains why a board did not answer a remote (over-MQTT) update request:
// 1) ping through the broker, 2) the status the broker stored for it,
// 3) a quick USB look if its serial port is given and free.
const mqtt = require("mqtt");
const { randomBytes } = require("node:crypto");
const { verifyBoard } = require("./verify");
const { checkBroker } = require("./runtime");
// Reads the retained microflow/<id>/status ("online"/"offline"), or null if none.
async function storedStatus(
  broker,
  deviceId,
  { connect = mqtt.connect, wait = 2000 } = {},
) {
  const options = checkBroker(broker);
  const client = connect(options.url, {
    username: options.username,
    password: options.password,
    clientId: "microflow-diag-" + randomBytes(4).toString("hex"),
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  client.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), wait);
      client.on("message", (topic, payload) => {
        clearTimeout(timer);
        resolve(payload.toString());
      });
      client.subscribe(`microflow/${deviceId}/status`);
    });
  } catch {
    return null;
  } finally {
    client.end(true);
  }
}
async function diagnoseRemote({
  broker,
  deviceId,
  serialPort,
  family,
  usb = verifyBoard,
  status = storedStatus,
  ping = verifyBoard,
}) {
  const host = checkBroker(broker)
    .url.replace(/^\w+:\/\//, "")
    .replace(/\/$/, "");
  const reach = await ping({ deviceId, broker, limits: { ping: 5000 } });
  if (reach.steps[0]?.ok) {
    const { build, ota } = reach.device;
    if (ota === false)
      return `${deviceId} is online on ${host} (build ${build}) but its firmware was built with Remote update off. Upload once over USB with Remote update ticked.`;
    if (ota === null || ota === undefined)
      return `${deviceId} is online on ${host} (build ${build}) but did not take the update: its firmware was probably built with Remote update off or by an older Microflow. Upload once over USB with Remote update ticked.`;
    return `${deviceId} is online on ${host} (build ${build}) and supports remote update, but did not answer in time. It may have been busy; try again.`;
  }
  const last = await status(broker, deviceId);
  const parts = [
    last === "offline"
      ? `${deviceId} is not connected to ${host} (the broker's last status for it: offline).`
      : last
        ? `${deviceId} did not answer on ${host} (last status: ${last}).`
        : `${deviceId} has never reported to ${host}: check the Device ID, and that the board was built for this broker (Firmware broker host).`,
  ];
  if (serialPort) {
    try {
      const r = await usb({
        serialPort,
        family,
        limits: { quick: 3000, respond: 8000, wifi: 10000, mqtt: 10000 },
      });
      const bad = r.steps.find((s) => s.ok === false);
      const other = r.device?.id && r.device.id !== deviceId;
      parts.push(
        other && !bad
          ? `The board on ${serialPort} is ${r.device.id} (build ${r.device.build}), not ${deviceId}: use Device ID ${r.device.id}.`
          : bad
            ? `USB check on ${serialPort}: ${bad.name.toLowerCase()} failed: ${bad.detail}`
            : `USB check on ${serialPort}: the board runs build ${r.device.build}${/crash loop|reset over USB/.test(r.steps[0].detail) ? " after being reset (it was stuck)" : ""}, with WiFi and MQTT connected now. Try the remote update again.`,
      );
    } catch (e) {
      parts.push(`USB check skipped: ${e.message}`);
    }
  } else parts.push("Connect it over USB and use Verify board to see why.");
  return parts.join(" ");
}
module.exports = { diagnoseRemote, storedStatus };
