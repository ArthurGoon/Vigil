import { OfflineError, api, panelUrl } from "./api.js";

const POLL_ALARM = "vigil-poll";
const MAX_NOTIFICATIONS = 3;

// Setup

function setup() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "vigil-pen",
      title: "Vigiar um trecho desta página",
      contexts: ["page", "selection", "image", "link"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
  chrome.action.setBadgeBackgroundColor({ color: "#e5372b" });
  poll();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

// Pen

function isWebPage(url) {
  return /^https?:\/\//i.test(url || "");
}

async function startPen(tab) {
  if (!tab?.id || !isWebPage(tab.url)) return { ok: false, error: "Abra um site para usar a caneta" };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "vigil:pen", on: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Não consegui abrir a caneta nesta página" };
  }
}
// Exposed for the end-to-end script, which drives the service worker directly.
self.vigilStartPen = async (tabId) => startPen(await chrome.tabs.get(tabId));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "start-pen") return;
  const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  await startPen(target);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "vigil-pen") startPen(tab);
});

// Notifications

async function updateBadge(unseen) {
  await chrome.action.setBadgeText({ text: unseen > 0 ? String(Math.min(unseen, 99)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#e5372b" });
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Asks the server for changes newer than the last one we notified about.
 * The first run only records where the feed is, so installing the extension
 * does not replay old changes.
 */
async function poll() {
  let feed;
  const { lastChangeId } = await chrome.storage.local.get("lastChangeId");
  try {
    feed = await api(`/changes?after=${lastChangeId ?? 0}&limit=20`, { timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof OfflineError) await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await updateBadge(feed.unseen);
  if (lastChangeId === undefined) {
    await chrome.storage.local.set({ lastChangeId: feed.latestId });
    return;
  }
  const fresh = feed.changes.filter((c) => c.id > lastChangeId).reverse();
  if (!fresh.length) return;
  await chrome.storage.local.set({ lastChangeId: Math.max(...fresh.map((c) => c.id)) });

  if (fresh.length > MAX_NOTIFICATIONS) {
    chrome.notifications.create("vigil-many", {
      type: "basic",
      iconUrl: "icons/128.png",
      title: `${fresh.length} mudanças novas`,
      message: [...new Set(fresh.map((c) => c.watchLabel))].slice(0, 4).join(", "),
      priority: 1,
    });
    return;
  }
  for (const change of fresh) {
    chrome.notifications.create(`vigil-change-${change.watchId}-${change.id}`, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: change.watchLabel,
      message: change.summary,
      contextMessage: host(change.watchUrl),
      priority: 1,
    });
  }
}
self.vigilPoll = poll;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll();
});

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const watchId = /^vigil-change-(\d+)-/.exec(id)?.[1];
  chrome.tabs.create({ url: await panelUrl(watchId) });
});

// Messages from the page card and the popup

const handlers = {
  async "vigil:probe"(msg) {
    return api("/probe", { method: "POST", body: { url: msg.url, selectors: msg.selectors, text: msg.text } });
  },
  async "vigil:save"(msg) {
    const result = await api("/watches", { method: "POST", body: msg.watch, timeoutMs: 45_000 });
    poll();
    return result;
  },
  async "vigil:open-panel"(msg) {
    await chrome.tabs.create({ url: await panelUrl(msg.watchId) });
    return {};
  },
  async "vigil:start-pen"(msg) {
    return startPen(await chrome.tabs.get(msg.tabId));
  },
  async "vigil:poll"() {
    await poll();
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) =>
      sendResponse({ ok: false, offline: err instanceof OfflineError, error: err?.message || "Erro" })
    );
  return true;
});
