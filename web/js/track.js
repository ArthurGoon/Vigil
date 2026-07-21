const API = "";
const ANON_KEY = "vigil_anon";
const SESS_KEY = "vigil_sess";

function id(key) {
  let value = localStorage.getItem(key);
  if (key === SESS_KEY) value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    if (key === SESS_KEY) sessionStorage.setItem(key, value);
    else localStorage.setItem(key, value);
  }
  return value;
}

export function trackPage(path) {
  const anon = id(ANON_KEY);
  const session = id(SESS_KEY);
  const started = Date.now();
  const params = new URLSearchParams(location.search);

  send([
    {
      name: "page_view",
      props: {
        path,
        referrer: document.referrer || "",
        utm_source: params.get("utm_source") || undefined,
        utm_medium: params.get("utm_medium") || undefined,
        utm_campaign: params.get("utm_campaign") || undefined,
      },
    },
  ], anon, session);

  window.addEventListener("pagehide", () => {
    send(
      [
        {
          name: "page_leave",
          props: { path, duration_ms: Date.now() - started },
        },
      ],
      anon,
      session
    );
  });
}

function send(events, anonymousId, sessionId) {
  const body = JSON.stringify({ anonymousId, sessionId, events });
  const url = `${API}/ingest/events`;
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
  } else {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "include",
    }).catch(() => {});
  }
}
