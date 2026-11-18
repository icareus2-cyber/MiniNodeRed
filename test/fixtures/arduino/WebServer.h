// Stand-in for tests: requests are made by calling request(); what the sketch sends
// is collected in `sent` (headers aside), with the status and Content-Length.
#pragma once
#include <functional>
#define PROGMEM
enum HTTPMethod { HTTP_ANY, HTTP_GET, HTTP_POST, HTTP_OPTIONS };
struct WebServer {
  explicit WebServer(int) {}
  std::function<void()> notFound;
  String path;
  HTTPMethod how = HTTP_GET;
  std::string sent, type;
  int code = 0;
  size_t length = (size_t)-1;
  void on(const char*, HTTPMethod, std::function<void()>) {}
  void onNotFound(std::function<void()> f) { notFound = f; }
  void begin() {}
  WiFiClient client() { return WiFiClient(); }
  void handleClient() {}
  String uri() { return path; }
  HTTPMethod method() { return how; }
  String arg(const char*) { return String(""); }
  void sendHeader(const char*, const char*) {}
  void setContentLength(size_t n) { length = n; }
  void send(int c, const char* t, const String& body) { code = c; type = t; sent += body.s; }
  void send_P(int c, const char* t, const char* body) { code = c; type = t; sent += body; }
  void sendContent(const char* p, size_t n) { sent.append(p, n); }
  void request(const char* uri) { path = String(uri); how = HTTP_GET; sent.clear(); type.clear(); code = 0; length = (size_t)-1; notFound(); }
};
