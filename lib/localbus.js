// Built-in MQTT for the multi-chip PC simulation: an in-memory broker with the
// parts of an mqtt.js client the runtime uses (connect, subscribe, publish with
// retain, end, "connect" / "message" events). No network, no broker to install:
// every simulated chip gets a client, and what one publishes reaches the others
// (and itself, like a real broker) with + and # wildcards.
const { EventEmitter } = require("node:events");

function matches(filter, topic) {
  const f = filter.split("/"),
    t = topic.split("/");
  if (topic.startsWith("$") && !filter.startsWith("$")) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (t[i] === undefined || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

function createBus() {
  const clients = new Set();
  const retained = new Map(); // topic → payload (last retained message)
  // Subscriptions count as they are when the message is published.
  const deliver = (client, topic, payload, retain) => {
    if (![...client.filters].some((f) => matches(f, topic))) return;
    setImmediate(
      () =>
        client.connected &&
        client.emit("message", topic, Buffer.from(payload), { retain }),
    );
  };
  const publish = (topic, payload, retain) => {
    payload = String(payload ?? "");
    if (retain) {
      if (payload === "") retained.delete(topic);
      else retained.set(topic, payload);
    }
    for (const c of clients) deliver(c, topic, payload, false);
  };
  function connect(url, options = {}) {
    const client = new EventEmitter();
    client.filters = new Set();
    client.connected = false;
    client.options = options;
    client.subscribe = (topics, cb) => {
      const list = [].concat(topics);
      for (const f of list) {
        client.filters.add(f);
        for (const [topic, payload] of retained)
          if (matches(f, topic))
            setImmediate(
              () =>
                client.connected &&
                client.emit("message", topic, Buffer.from(payload), {
                  retain: true,
                }),
            );
      }
      setImmediate(() => cb?.(null, list.map((topic) => ({ topic, qos: 0 }))));
      return client;
    };
    client.unsubscribe = (topics, cb) => {
      for (const f of [].concat(topics)) client.filters.delete(f);
      setImmediate(() => cb?.(null));
      return client;
    };
    client.publish = (topic, payload, opts, cb) => {
      if (typeof opts === "function") [cb, opts] = [opts, {}];
      if (!client.connected) {
        setImmediate(() => cb?.(Error("Built-in MQTT: client is closed")));
        return client;
      }
      publish(topic, payload, !!opts?.retain);
      setImmediate(() => cb?.(null));
      return client;
    };
    client.end = (force, opts, cb) => {
      if (typeof force === "function") cb = force;
      else if (typeof opts === "function") cb = opts;
      // A forced end is like a dropped connection: the last will goes out.
      const will = force === true && client.connected && options.will;
      client.connected = false;
      clients.delete(client);
      if (will) publish(will.topic, will.payload, !!will.retain);
      setImmediate(() => {
        client.emit("close");
        cb?.();
      });
      return client;
    };
    clients.add(client);
    setImmediate(() => {
      if (!clients.has(client)) return;
      client.connected = true;
      client.emit("connect", { sessionPresent: false });
    });
    return client;
  }
  return { connect, publish, retained, clients };
}

module.exports = { createBus };
