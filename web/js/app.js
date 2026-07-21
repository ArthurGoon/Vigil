import { api, getMe } from "./api.js";
import { trackPage } from "./track.js";

trackPage("/app.html");

const userEmail = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");
const createForm = document.getElementById("create-form");
const createStatus = document.getElementById("create-status");
const watchesList = document.getElementById("watches-list");
const refreshBtn = document.getElementById("refresh-btn");
const detailPanel = document.getElementById("detail-panel");
const detailUrl = document.getElementById("detail-url");
const checkBtn = document.getElementById("check-btn");
const deleteBtn = document.getElementById("delete-btn");
const closeDetail = document.getElementById("close-detail");
const checkResult = document.getElementById("check-result");
const changesList = document.getElementById("changes-list");

let selectedId = null;
let watches = [];

init();

async function init() {
  try {
    const me = await getMe();
    userEmail.textContent = me.user.email;
  } catch {
    location.href = "/login.html";
    return;
  }

  await loadWatches();
}

logoutBtn.addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  location.href = "/";
});

refreshBtn.addEventListener("click", () => loadWatches());

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createStatus.className = "form-status";
  createStatus.textContent = "Criando…";

  const fd = new FormData(createForm);
  const webhook = String(fd.get("webhookUrl") || "").trim();
  const payload = {
    url: String(fd.get("url")),
    targetText: String(fd.get("targetText") || "").trim(),
    monitorMode: String(fd.get("monitorMode") || "text_changed"),
    intervalMinutes: Number(fd.get("intervalMinutes") || 360),
    notifyEmail: document.getElementById("notifyEmail").checked,
    webhookUrl: webhook || null,
  };
  const selector = String(fd.get("cssSelector") || "").trim();
  if (selector) payload.cssSelector = selector;

  try {
    await api("/watches", { method: "POST", body: JSON.stringify(payload) });
    createStatus.className = "form-status ok";
    createStatus.textContent = "Alerta criado.";
    createForm.reset();
    document.getElementById("intervalMinutes").value = "360";
    document.getElementById("notifyEmail").checked = true;
    await loadWatches();
  } catch (err) {
    createStatus.className = "form-status error";
    createStatus.textContent =
      typeof err.data?.error === "string" ? err.data.error : err.message;
  }
});

closeDetail.addEventListener("click", () => {
  detailPanel.classList.add("hidden");
  selectedId = null;
});

checkBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  checkResult.textContent = "Rodando check…";
  try {
    const data = await api(`/watches/${selectedId}/check`, { method: "POST" });
    checkResult.textContent = JSON.stringify(data, null, 2);
    await loadWatches();
    await loadChanges(selectedId);
  } catch (err) {
    checkResult.textContent = err.message;
  }
});

deleteBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  if (!confirm("Remover este watch?")) return;
  await api(`/watches/${selectedId}`, { method: "DELETE" });
  detailPanel.classList.add("hidden");
  selectedId = null;
  await loadWatches();
});

async function loadWatches() {
  try {
    const data = await api("/watches");
    watches = data.watches || [];
    renderWatches();
  } catch (err) {
    watchesList.innerHTML = `<p class="empty-hint error">${err.message}</p>`;
  }
}

function renderWatches() {
  if (!watches.length) {
    watchesList.innerHTML = `<p class="empty-hint">Nenhum watch ainda. Crie o primeiro acima.</p>`;
    return;
  }

  watchesList.innerHTML = watches
    .map((w) => {
      const host = safeHost(w.url);
      return `
        <button class="watch-row" type="button" data-id="${w.id}">
          <div>
            <div class="watch-url">${escapeHtml(host)}</div>
            <div class="watch-meta">${escapeHtml(modeLabel(w.monitorMode))} · “${escapeHtml((w.targetText || "").slice(0, 48))}” · a cada ${w.intervalMinutes} min</div>
          </div>
          <span class="status-pill ${escapeHtml(w.lastStatus || "ok")}">${escapeHtml(w.lastStatus || "ok")}</span>
          <span class="watch-meta">${w.lastCheckedAt ? formatDate(w.lastCheckedAt) : "nunca checado"}</span>
        </button>
      `;
    })
    .join("");

  watchesList.querySelectorAll(".watch-row").forEach((btn) => {
    btn.addEventListener("click", () => openDetail(btn.dataset.id));
  });
}

async function openDetail(id) {
  selectedId = id;
  const watch = watches.find((w) => w.id === id);
  if (!watch) return;

  detailPanel.classList.remove("hidden");
  detailUrl.textContent = watch.url;
  checkResult.textContent = watch.lastError
    ? `Último erro: ${watch.lastError}`
    : "Clique em “Testar agora” para ver o preview.";
  await loadChanges(id);
  detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadChanges(id) {
  try {
    const data = await api(`/watches/${id}/changes`);
    const rows = data.changes || [];
    if (!rows.length) {
      changesList.innerHTML = `<li class="empty-hint">Nenhuma mudança registrada ainda.</li>`;
      return;
    }
    changesList.innerHTML = rows
      .map(
        (c) => `
        <li>
          <time>${formatDate(c.createdAt)}</time>
          <pre>${escapeHtml((c.diffSummary || "").slice(0, 800))}</pre>
        </li>
      `
      )
      .join("");
  } catch (err) {
    changesList.innerHTML = `<li class="empty-hint">${escapeHtml(err.message)}</li>`;
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname + new URL(url).pathname;
  } catch {
    return url;
  }
}

function modeLabel(mode) {
  return (
    {
      text_changed: "mudou",
      text_appears: "apareceu",
      text_disappears: "sumiu",
    }[mode] || mode || "mudou"
  );
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("pt-BR");
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
