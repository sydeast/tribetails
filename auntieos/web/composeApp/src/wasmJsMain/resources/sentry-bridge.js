// AuntieOS web crash/error bridge (0H). Self-hosted (no CDN SDK) so the page CSP only needs
// the Sentry ingest host added to connect-src. POSTs minimal Sentry envelopes to the shared
// auntieos-admin project and auto-captures window.onerror / unhandledrejection. The DSN is a
// public client key (same one the Android APK ships), so embedding it here is safe.
(function () {
  var DSN_KEY = "b219cf4fe0ad95909c3ded27776055aa";
  var DSN = "https://" + DSN_KEY + "@o4511074771533824.ingest.us.sentry.io/4511282806521856";
  var ENVELOPE_URL =
    "https://o4511074771533824.ingest.us.sentry.io/api/4511282806521856/envelope/" +
    "?sentry_key=" + DSN_KEY + "&sentry_version=7";

  function eventId() {
    var s = "";
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function send(message, level) {
    try {
      var header = JSON.stringify({ sent_at: new Date().toISOString(), dsn: DSN });
      var item = JSON.stringify({ type: "event" });
      var payload = JSON.stringify({
        event_id: eventId(),
        timestamp: Date.now() / 1000,
        platform: "javascript",
        level: level || "error",
        environment: "web",
        release: "auntieos-web",
        tags: { client: "auntieos-web" },
        message: { formatted: String(message).slice(0, 8000) }
      });
      fetch(ENVELOPE_URL, {
        method: "POST",
        body: header + "\n" + item + "\n" + payload,
        headers: { "Content-Type": "application/x-sentry-envelope" },
        keepalive: true
      }).catch(function () { /* never let the reporter throw */ });
    } catch (e) { /* swallow: reporting must never break the app */ }
  }

  window.__sentry = {
    init: function () { /* hooks installed at load below; this is a no-op confirmation */ },
    captureMessage: function (message, fatal) { send(message, fatal ? "fatal" : "info"); }
  };

  window.addEventListener("error", function (ev) {
    var m = (ev && ev.message) ? ev.message : "window.onerror";
    var where = (ev && ev.filename) ? (" (" + ev.filename + ":" + ev.lineno + ":" + ev.colno + ")") : "";
    send("[web] " + m + where, "error");
  });

  window.addEventListener("unhandledrejection", function (ev) {
    var m;
    try {
      var r = ev && ev.reason;
      m = (r && r.stack) ? r.stack : String(r);
    } catch (e) { m = "unhandledrejection"; }
    send("[web] unhandledrejection: " + m, "error");
  });
})();
