// Talks to the local Vigil server. Used by the popup and the service worker.

export const DEFAULT_SERVER = "http://localhost:3000";

export async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

export async function setServer(url) {
  await chrome.storage.local.set({ server: url.replace(/\/+$/, "") });
}

export class OfflineError extends Error {
  constructor() {
    super("O Vigil não está rodando");
    this.name = "OfflineError";
  }
}

export async function api(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const server = await getServer();
  let res;
  try {
    res = await fetch(`${server}/api${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new OfflineError();
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export async function panelUrl(watchId) {
  const server = await getServer();
  return watchId ? `${server}/#/w/${watchId}` : `${server}/`;
}
