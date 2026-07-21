/**
 * Drop-in browser snippet for later front (page_view / page_leave).
 * Not wired in MVP — keep for Fase F.
 */
export const browserTrackingSnippet = `
(function () {
  var API = window.VIGIL_API || "http://localhost:3000";
  var anon = localStorage.getItem("vigil_anon") || (crypto.randomUUID && crypto.randomUUID());
  localStorage.setItem("vigil_anon", anon);
  var session = sessionStorage.getItem("vigil_sess") || (crypto.randomUUID && crypto.randomUUID());
  sessionStorage.setItem("vigil_sess", session);
  var started = Date.now();
  function send(events) {
    var body = JSON.stringify({ anonymousId: anon, sessionId: session, events: events });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API + "/ingest/events", new Blob([body], { type: "application/json" }));
    } else {
      fetch(API + "/ingest/events", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
    }
  }
  send([{ name: "page_view", props: { path: location.pathname, referrer: document.referrer } }]);
  window.addEventListener("pagehide", function () {
    send([{ name: "page_leave", props: { path: location.pathname, duration_ms: Date.now() - started } }]);
  });
})();
`;
