chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_) {
    /* already open */
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "VIGIL_SELECTION") {
    chrome.storage.session.set({ pendingSelection: message.payload }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "VIGIL_GET_PENDING") {
    chrome.storage.session.get(["pendingSelection"]).then((data) => {
      sendResponse({ ok: true, pending: data.pendingSelection || null });
    });
    return true;
  }

  if (message?.type === "VIGIL_CLEAR_PENDING") {
    chrome.storage.session.remove("pendingSelection").then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
