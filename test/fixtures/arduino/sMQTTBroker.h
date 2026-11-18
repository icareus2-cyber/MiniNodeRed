// Stand-in for tests (sMQTTBroker library): what the board publishes is added to
// `published` as "local <topic> <payload>"; clientPublish() / clientLogin() act as
// an MQTT client of the board's broker.
#pragma once
#include <string>
extern std::string published;
enum sMQTTEventType { NewClient_sMQTTEventType, RemoveClient_sMQTTEventType, Public_sMQTTEventType, LostConnect_sMQTTEventType };
struct sMQTTEvent { sMQTTEventType type; sMQTTEventType Type() { return type; } };
struct sMQTTNewClientEvent : sMQTTEvent { std::string login, pass; std::string Login() { return login; } std::string Password() { return pass; } };
struct sMQTTPublicClientEvent : sMQTTEvent { std::string topic, payload; std::string Topic() { return topic; } std::string Payload() { return payload; } };
struct sMQTTBroker {
  int port = 0;
  virtual ~sMQTTBroker() {}
  virtual bool onEvent(sMQTTEvent*) { return true; }
  bool init(unsigned short p, bool = false) { port = p; return true; }
  void update() {}
  bool publish(const std::string& t, const std::string& p, unsigned char = 0, bool retain = false) {
    published += "local " + t + " " + p + (retain ? " (retained)" : "") + "\n";
    return true;
  }
  bool clientPublish(const char* t, const char* p) { sMQTTPublicClientEvent e; e.type = Public_sMQTTEventType; e.topic = t; e.payload = p; return onEvent(&e); }
  bool clientLogin(const char* u, const char* pw) { sMQTTNewClientEvent e; e.type = NewClient_sMQTTEventType; e.login = u; e.pass = pw; return onEvent(&e); }
};
