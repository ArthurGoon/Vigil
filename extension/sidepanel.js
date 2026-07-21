const DEFAULT_API = "http://localhost:3000";

const els = {
  login: document.getElementById("view-login"),
  app: document.getElementById("view-app"),
  apiBase: document.getElementById("api-base"),
  email: document.getElementById("email"),
  magicToken: document.getElementById("magic-token"),
  btnGoogle: document.getElementById("btn-google"),
  btnMagic: document.getElementById("btn-magic"),
  btnExchange: document.getElementById("btn-exchange"),
  loginMsg: document.getElementById("login-msg"),
  userLabel: document.getElementById("user-label"),
  btnLogout: document.getElementById("btn-logout"),
  btnPen: document.getElementById("btn-pen"),
  penMsg: document.getElementById("pen-msg"),
  confirmCard: document.getElementById("confirm-card"),
  confirmUrl: document.getElementById("confirm-url"),
  confirmText: document.getElementById("confirm-text"),
  monitorMode: document.getElementById("monitor-mode"),
  intervalHours: document.getElementById("interval-hours"),
  notifyEmail: document.getElementById("notify-email"),
  webhookUrl: document.getElementById("webhook-url"),
  btnCreate: document.getElementById("btn-create"),
  btnDiscard: document.getElementById("btn-discard"),
  createMsg: document.getElementById("create-msg"),
  btnRefresh: document.getElementById("btn-refresh"),
  watchList: document.getElementById("watch-list"),
  listEmpty: document.getElementById("list-empty"),
};

let state = {
  apiBase: DEFAULT_API,
  sessionToken: null,
  email: null,
  pending: null,
};

async function loadState() {
  const data = await chrome.storage.local.get(["apiBase", "sessionToken", "email"]);
  state.apiBase = data.apiBase || DEFAULT_API;
  state.sessionToken = data.sessionToken || null;
  state.email = data.email || null;
  els.apiBase.value = state.apiBase;
  els.email.value = state.email || "";
}

async function saveAuth(partial) {
  state = { ...state, ...partial };
  await chrome.storage.local.set({
    apiBase: state.apiBase,
    sessionToken: state.sessionToken,
    email: state.email,
  });
}

function setMsg(el, text, kind = "") {
  el.textContent = text || "";
  el.className = `msg${kind ? ` ${kind}` : ""}`;
}

function showViews() {
  const loggedIn = Boolean(state.sessionToken);
  els.login.classList.toggle("hidden", loggedIn);
  els.app.classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    els.userLabel.textContent = state.email || "Sessão ativa";
  }
}

async function api(path, options = {}) {
  const base = (els.apiBase.value || state.apiBase || DEFAULT_API).replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.sessionToken) {
    headers.Authorization = `Bearer ${state.sessionToken}`;
  }
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

async function refreshPending() {
  const res = await chrome.runtime.sendMessage({ type: "VIGIL_GET_PENDING" });
  state.pending = res?.pending || null;
  renderPending();
}

function renderPending() {
  const p = state.pending;
  els.confirmCard.classList.toggle("hidden", !p);
  if (!p) return;
  els.confirmUrl.textContent = p.url || "";
  const kind = p.kind === "image" ? "[imagem] " : "";
  els.confirmText.textContent = `${kind}${p.label || p.targetText || ""}`;
  setMsg(els.createMsg, "");
}

async function loadWatches() {
  const data = await api("/watches");
  const watches = data.watches || data || [];
  els.watchList.innerHTML = "";
  els.listEmpty.classList.toggle("hidden", watches.length > 0);
  for (const w of watches) {
    const li = document.createElement("li");
    const modeLabel =
      {
        text_changed: "mudou",
        text_appears: "apareceu",
        text_disappears: "sumiu",
      }[w.monitorMode] || w.monitorMode;
    li.innerHTML = `
      <div class="title">${escapeHtml((w.targetText || "").slice(0, 80))}</div>
      <div class="meta">${escapeHtml(modeLabel)} · ${w.intervalMinutes} min · ${w.lastStatus || "—"}</div>
      <div class="meta">${escapeHtml(w.url || "")}</div>
      <div class="actions">
        <button type="button" data-check="${w.id}">Checar agora</button>
        <button type="button" data-del="${w.id}">Remover</button>
      </div>
    `;
    els.watchList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

els.btnGoogle?.addEventListener("click", async () => {
  try {
    await saveAuth({ apiBase: els.apiBase.value.trim() || DEFAULT_API });
    setMsg(els.loginMsg, "Abrindo Google…", "");

    const redirectUri = chrome.identity.getRedirectURL();
    const start = await api(
      `/auth/google?format=json&mode=extension&redirect_uri=${encodeURIComponent(redirectUri)}`
    );
    if (!start.url) throw new Error("Google login não configurado no servidor");

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: start.url,
      interactive: true,
    });
    if (!responseUrl) throw new Error("Login cancelado");

    const redirected = new URL(responseUrl);
    if (redirected.searchParams.get("error")) {
      throw new Error(redirected.searchParams.get("error_description") || "Login Google negado");
    }
    const code = redirected.searchParams.get("code");
    if (!code) throw new Error("Google não devolveu o código de login");

    const data = await api("/auth/google/code", {
      method: "POST",
      body: JSON.stringify({ code, redirectUri }),
    });

    await saveAuth({
      sessionToken: data.sessionToken,
      email: data.email || state.email,
    });
    setMsg(els.loginMsg, "", "");
    showViews();
    await loadWatches();
    await refreshPending();
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/not configured|503|GOOGLE_/i.test(msg)) {
      setMsg(
        els.loginMsg,
        "Configure GOOGLE_CLIENT_ID/SECRET na API e adicione o redirect da extensão no Google Cloud.",
        "err"
      );
    } else {
      setMsg(els.loginMsg, msg, "err");
    }
  }
});

els.btnMagic.addEventListener("click", async () => {
  try {
    await saveAuth({ apiBase: els.apiBase.value.trim() || DEFAULT_API, email: els.email.value.trim() });
    const data = await api("/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email: els.email.value.trim() }),
    });
    if (data.devLink) {
      try {
        const token = new URL(data.devLink).searchParams.get("token");
        if (token) els.magicToken.value = token;
      } catch (_) {
        /* ignore */
      }
      setMsg(els.loginMsg, "Dev: token preenchido — clique em Entrar com token.", "ok");
    } else {
      setMsg(els.loginMsg, "Link enviado por e-mail. Cole o token do link abaixo.", "ok");
    }
  } catch (err) {
    setMsg(els.loginMsg, err.message, "err");
  }
});

els.btnExchange.addEventListener("click", async () => {
  try {
    await saveAuth({ apiBase: els.apiBase.value.trim() || DEFAULT_API, email: els.email.value.trim() });
    const data = await api("/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ token: els.magicToken.value.trim() }),
    });
    await saveAuth({
      sessionToken: data.sessionToken,
      email: els.email.value.trim() || state.email,
    });
    setMsg(els.loginMsg, "", "");
    showViews();
    await loadWatches();
    await refreshPending();
  } catch (err) {
    setMsg(els.loginMsg, err.message, "err");
  }
});

els.btnLogout.addEventListener("click", async () => {
  await saveAuth({ sessionToken: null });
  showViews();
});

els.btnPen.addEventListener("click", async () => {
  try {
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error("Nenhuma aba ativa");
    if (!isInjectableUrl(tab.url)) {
      throw new Error("Abra uma página http(s) normal (não chrome://) e tente de novo");
    }

    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "VIGIL_TOGGLE_PEN", active: true });
    setMsg(els.penMsg, "Caneta ligada — circule o alvo em vermelho na página.", "ok");
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      setMsg(
        els.penMsg,
        "Recarregue a página (F5), depois clique de novo em Ativar caneta.",
        "err"
      );
    } else {
      setMsg(els.penMsg, msg || "Não deu para ligar a caneta.", "err");
    }
  }
});

async function getTargetTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const httpTab = tabs.find((t) => isInjectableUrl(t.url));
  if (httpTab) return httpTab;
  const all = await chrome.tabs.query({ lastFocusedWindow: true });
  return all.find((t) => t.active && isInjectableUrl(t.url)) || tabs[0] || null;
}

function isInjectableUrl(url) {
  if (!url) return false;
  return /^https?:/i.test(url);
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "VIGIL_PEN_STATUS" });
    if (ping?.ok) return;
  } catch (_) {
    /* not injected yet */
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  // small wait so listener is registered
  await new Promise((r) => setTimeout(r, 50));
}

els.btnDiscard.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "VIGIL_CLEAR_PENDING" });
  state.pending = null;
  renderPending();
  await clearHighlightOnTab();
});

els.btnCreate.addEventListener("click", async () => {
  if (!state.pending) return;
  try {
    const hours = Number(els.intervalHours.value || 6);
    const intervalMinutes = Math.max(6, hours) * 60;
    const webhook = els.webhookUrl.value.trim();
    await api("/watches", {
      method: "POST",
      body: JSON.stringify({
        url: state.pending.url,
        targetText: state.pending.targetText,
        cssSelector: state.pending.cssSelector || null,
        monitorMode: els.monitorMode.value,
        intervalMinutes,
        notifyEmail: els.notifyEmail.checked,
        webhookUrl: webhook || null,
      }),
    });
    await chrome.runtime.sendMessage({ type: "VIGIL_CLEAR_PENDING" });
    state.pending = null;
    renderPending();
    await clearHighlightOnTab();
    setMsg(els.createMsg, "Alerta criado.", "ok");
    await loadWatches();
  } catch (err) {
    setMsg(els.createMsg, err.message, "err");
  }
});

async function clearHighlightOnTab() {
  try {
    const tab = await getTargetTab();
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { type: "VIGIL_CLEAR_HIGHLIGHT" });
  } catch (_) {
    /* tab may have changed */
  }
}

els.btnRefresh.addEventListener("click", () => {
  loadWatches().catch((err) => setMsg(els.createMsg, err.message, "err"));
});

els.watchList.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const checkId = t.getAttribute("data-check");
  const delId = t.getAttribute("data-del");
  try {
    if (checkId) {
      await api(`/watches/${checkId}/check`, { method: "POST" });
      await loadWatches();
    }
    if (delId) {
      await api(`/watches/${delId}`, { method: "DELETE" });
      await loadWatches();
    }
  } catch (err) {
    setMsg(els.createMsg, err.message, "err");
  }
});

setInterval(() => {
  if (state.sessionToken) refreshPending().catch(() => {});
}, 1500);

(async () => {
  await loadState();
  showViews();
  if (state.sessionToken) {
    try {
      await loadWatches();
      await refreshPending();
    } catch (err) {
      if (String(err.message).includes("401") || String(err.message).includes("Unauthorized")) {
        await saveAuth({ sessionToken: null });
        showViews();
      }
    }
  }
})();
