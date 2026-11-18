async function api(url, body, method, fetcher = fetch) {
  const path = "/api/" + url;
  const verb = method || (body ? "POST" : "GET");
  // A guest's flows and settings are kept in this browser (guest.js).
  if (typeof guestApi === "function" && !url.startsWith("auth/") && (await isGuest())) {
    const local = await guestApi(url, body, verb);
    if (local !== undefined) return local;
  }
  let response;
  try {
    response = await fetcher(path, {
      method: verb,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Error(
      `Cannot reach the server for ${verb} ${path}. Check that npm start is running and open http://127.0.0.1:3000.`,
    );
  }
  const type = response.headers.get("content-type") || "";
  if (!/(?:\/|\+)json\b/i.test(type)) {
    throw Error(
      `${verb} ${path} returned ${type.includes("html") ? "an HTML page" : "a non-JSON response"} (HTTP ${response.status}). ${response.status === 404 ? "This API endpoint is missing. Restart the backend with npm start." : "Make sure this page is served by the Microflow backend, not a static preview server."}`,
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      `${verb} ${path} returned invalid JSON (HTTP ${response.status}). Check the backend output and restart it if needed.`,
    );
  }
  // Logged out (session ended or expired): go to the login page and come back here.
  if (response.status === 401 && data?.login && typeof location !== "undefined") {
    location.href =
      "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
  }
  if (!response.ok) {
    const message =
      typeof data?.error === "string" ? data.error : "Request failed";
    // stage (e.g. "upload") tells callers which step of a multi-step request failed.
    throw Object.assign(
      Error(`${message} (${verb} ${path}, HTTP ${response.status})`),
      {
        stage: data?.stage,
        status: response.status,
        detail: message,
        lan: data?.lan,
        chip: data?.chip, // upload check: the chip found on the port
        fits: data?.fits, // …and the boards built for it
      },
    );
  }
  return data;
}
if (typeof module !== "undefined") module.exports = { api };
