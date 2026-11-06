import { DEFAULT_SERVER, OfflineError, api, getServer, panelUrl, setServer } from "./api.js";

const $ = (sel) => document.querySelector(sel);
const app = $("#app");

const MODE = { text_changed: "quando mudar", text_appears: "quando aparecer", text_disappears: "quando sumir" };

const ICON = {
  refresh: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pause: `<svg width="15" height="15" viewBox="0 0 16 16"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>`,
  play: `<svg width="15" height="15" viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  logo: `<svg width="40" height="40" viewBox="0 0 32 32" fill="none"><path d="M5.5 17.5c-1.6-6.3 4-11.6 11.2-11.4 7 .2 11.6 4.6 10.4 10.4-1.2 6-7.6 9.4-13.6 8.6C8 24.4 4.4 20.6 6 15.2" stroke="#e5372b" stroke-width="2.2" stroke-linecap="round"/><circle cx="16.4" cy="15.6" r="3.4" fill="currentColor"/></svg>`,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

function every(min) {
  if (min % 1440 === 0) return min === 1440 ? "1 dia" : `${min / 1440} dias`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toast(text) {
  document.querySelector(".toast")?.remove();
  const t = el("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

let watches = [];
let confirming = null;
const busy = new Set();

function dotClass(w) {
  if (!w.isActive) return "paused";
  if (w.unseenChanges > 0) return "news";
  if (w.lastStatus === "error") return "error";
  if (w.lastStatus === "pending") return "pending";
  return "ok";
}

function metaLine(w) {
  if (!w.isActive) return el("div", { class: "item-meta" }, `Pausado · ${host(w.url)}`);
  if (w.lastStatus === "error") return el("div", { class: "item-meta err", title: w.lastError || "" }, `Erro: ${w.lastError || "falhou"}`);
  const checked = w.checking || busy.has(w.id) ? "checando..." : w.lastCheckedAt ? `checado ${ago(w.lastCheckedAt)}` : "esperando a 1ª leitura";
  return el("div", { class: "item-meta" }, `${host(w.url)} · ${MODE[w.monitorMode]} · ${checked}`);
}

function renderList() {
  if (!watches.length) {
    app.replaceChildren(
      el("div", { class: "empty" },
        el("div", { html: ICON.logo }),
        el("h2", {}, "Nada sendo vigiado ainda"),
        el("p", {}, "Abra um site, clique em Circular e marque o trecho que você quer acompanhar.")));
    return;
  }
  const news = watches.filter((w) => w.unseenChanges > 0).length;
  app.replaceChildren(
    el("div", { class: "section-title" },
      el("span", {}, `${watches.length} ${watches.length === 1 ? "alerta" : "alertas"}`),
      news ? el("span", { style: "color:var(--red-ink)" }, `${news} com novidade`) : null),
    el("ul", { class: "list" }, watches.map(renderItem)));
}

function renderItem(w) {
  const isBusy = busy.has(w.id) || w.checking;
  const actions =
    confirming === w.id
      ? el("div", { class: "confirm" },
          el("span", {}, "Excluir?"),
          el("button", { class: "yes", onclick: (e) => (e.stopPropagation(), remove(w)) }, "Sim"),
          el("button", { class: "no", onclick: (e) => (e.stopPropagation(), (confirming = null), renderList()) }, "Não"))
      : el("div", { class: "actions" },
          el("button", { class: "icon-btn", title: "Checar agora", "aria-label": "Checar agora", disabled: isBusy || !w.isActive, onclick: (e) => (e.stopPropagation(), checkNow(w)), html: ICON.refresh }),
          el("button", { class: "icon-btn", title: w.isActive ? "Pausar" : "Retomar", "aria-label": w.isActive ? "Pausar" : "Retomar", onclick: (e) => (e.stopPropagation(), togglePause(w)), html: w.isActive ? ICON.pause : ICON.play }),
          el("button", { class: "icon-btn danger", title: "Excluir", "aria-label": "Excluir", onclick: (e) => (e.stopPropagation(), (confirming = w.id), renderList()), html: ICON.trash }));
  if (isBusy) actions.querySelector(".icon-btn")?.firstElementChild?.classList.add("spin");

  return el("li", { class: `item${isBusy ? " busy" : ""}`, tabindex: "0", "data-id": String(w.id), onclick: () => openWatch(w), onkeydown: (e) => e.key === "Enter" && openWatch(w) },
    el("span", { class: `dot ${dotClass(w)}` }),
    el("div", { class: "item-main" },
      el("div", { class: "item-title" }, el("span", { title: w.label }, w.label), w.unseenChanges > 0 ? el("em", { class: "pill" }, w.unseenChanges > 1 ? `${w.unseenChanges} mudanças` : "mudou") : null),
      metaLine(w)),
    actions);
}

function renderOffline(server) {
  $("#conn").hidden = false;
  $("#conn").className = "conn off";
  $("#conn").textContent = "desligado";
  app.replaceChildren(
    el("div", { class: "offline" },
      el("h2", {}, "O Vigil não está rodando"),
      el("p", {}, `Não encontrei o servidor em ${server.replace(/^https?:\/\//, "")}. Na pasta do projeto, rode:`),
      el("code", {}, "npm start"),
      el("div", {}, el("button", { class: "btn-soft", onclick: () => load(true) }, "Tentar de novo"))));
}

async function load(showSkeleton = false) {
  if (showSkeleton) app.replaceChildren(el("div", { class: "skeleton" }, el("div"), el("div"), el("div")));
  try {
    const data = await api("/watches", { timeoutMs: 5000 });
    watches = data.watches;
    $("#conn").hidden = false;
    $("#conn").className = "conn";
    $("#conn").textContent = "rodando";
    renderList();
  } catch (err) {
    if (err instanceof OfflineError) renderOffline(await getServer());
    else app.replaceChildren(el("div", { class: "offline" }, el("p", {}, err.message)));
  }
}

async function checkNow(w) {
  busy.add(w.id);
  renderList();
  try {
    const { check } = await api(`/watches/${w.id}/check`, { method: "POST", timeoutMs: 45_000 });
    if (check.status === "error") toast(`Falhou: ${check.error}`);
    else if (check.change) toast(`Mudou: ${check.change.summary}`);
    else toast("Checado. Nada mudou.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy.delete(w.id);
    await load();
  }
}

async function togglePause(w) {
  try {
    await api(`/watches/${w.id}`, { method: "PATCH", body: { isActive: !w.isActive } });
    toast(w.isActive ? "Pausado" : "Retomado. Checando agora.");
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function remove(w) {
  confirming = null;
  try {
    await api(`/watches/${w.id}`, { method: "DELETE" });
    toast("Alerta excluído");
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function openWatch(w) {
  chrome.tabs.create({ url: await panelUrl(w.id) });
  window.close();
}

// Pen button: only on regular web pages.
async function setupPen() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const btn = $("#pen");
  const usable = tab && /^https?:\/\//.test(tab.url || "") && !tab.url.startsWith(await getServer());
  if (!usable) {
    btn.disabled = true;
    $("#pen-note").textContent = "Abra um site para usar a caneta";
    return;
  }
  btn.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "vigil:start-pen", tabId: tab.id });
    if (res?.ok && res.data?.ok) window.close();
    else toast(res?.data?.error || res?.error || "Não deu para abrir a caneta aqui");
  });
}

async function setupServer() {
  const btn = $("#server");
  const show = async () => (btn.textContent = (await getServer()).replace(/^https?:\/\//, ""));
  await show();
  btn.addEventListener("click", async () => {
    const input = el("input", { value: await getServer(), "aria-label": "Endereço do servidor" });
    btn.replaceWith(input);
    input.focus();
    input.select();
    const done = async (commit) => {
      if (commit) await setServer(input.value.trim() || DEFAULT_SERVER);
      input.replaceWith(btn);
      await show();
      if (commit) load(true);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
  });
}

$("#open-panel").addEventListener("click", async () => {
  chrome.tabs.create({ url: await panelUrl() });
  window.close();
});

setupPen();
setupServer();
load(true);
chrome.runtime.sendMessage({ type: "vigil:poll" }).catch(() => {});
setInterval(() => {
  if (!busy.size && confirming === null) load();
}, 5000);
