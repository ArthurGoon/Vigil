// Vigil panel: plain JS over the local API. Hash routes: #/ and #/w/:id.

const $ = (sel, root = document) => root.querySelector(sel);

const MODE = {
  text_changed: { short: "mudar", chip: "Avisa quando mudar" },
  text_appears: { short: "aparecer", chip: "Avisa quando aparecer" },
  text_disappears: { short: "sumir", chip: "Avisa quando sumir" },
};

const ICON = {
  refresh: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pause: `<svg width="14" height="14" viewBox="0 0 16 16"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 13l.6-2.6 7.5-7.5a1.4 1.4 0 0 1 2 2l-7.5 7.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  out: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  yes: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.2 3L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  no: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5.5 10h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  minus: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  logo: `<svg width="34" height="34" viewBox="0 0 32 32" fill="none"><path d="M5.5 17.5c-1.6-6.3 4-11.6 11.2-11.4 7 .2 11.6 4.6 10.4 10.4-1.2 6-7.6 9.4-13.6 8.6C8 24.4 4.4 20.6 6 15.2" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round"/><circle cx="16.4" cy="15.6" r="3.4" fill="currentColor"/></svg>`,
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

// API

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setOnline(false);
    throw new Error("Sem conexão com o servidor");
  }
  setOnline(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// Formatting

function ago(iso) {
  if (!iso) return "nunca";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return inFuture(iso);
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

function inFuture(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 30) return "em instantes";
  if (s < 3600) return `em ${Math.round(s / 60)} min`;
  if (s < 86400) return `em ${Math.round(s / 3600)} h`;
  return `em ${Math.round(s / 86400)} dias`;
}

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });

function when(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const day =
    d.toDateString() === today.toDateString()
      ? "hoje"
      : d.toDateString() === yesterday.toDateString()
        ? "ontem"
        : dateFmt.format(d).replace(".", "");
  return `${day}, ${timeFmt.format(d)}`;
}

function every(min) {
  if (min % 1440 === 0) return min === 1440 ? "1 dia" : `${min / 1440} dias`;
  if (min % 60 === 0) return min === 60 ? "1 hora" : `${min / 60} horas`;
  return `${min} min`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return url;
  }
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toast(text) {
  const t = el("div", { class: "toast", role: "status" }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 3200);
}

// State

let watches = [];
let online = true;
let loaded = false;
const busy = new Set();
let detailKey = "";

function setOnline(value) {
  if (online === value) return;
  online = value;
  $("#offline").hidden = value;
  renderConn();
}

function renderConn() {
  const conn = $("#conn");
  conn.hidden = !loaded && online;
  conn.className = online ? "conn" : "conn off";
  conn.textContent = online
    ? `rodando · ${watches.length} ${watches.length === 1 ? "alerta" : "alertas"}`
    : "desconectado";
}

function route() {
  const m = /^#\/w\/(\d+)/.exec(location.hash);
  return m ? Number(m[1]) : null;
}

function dotClass(w) {
  if (!w.isActive) return "paused";
  if (w.unseenChanges > 0) return "news";
  if (w.lastStatus === "error") return "error";
  if (w.lastStatus === "pending") return "pending";
  return "ok";
}

// Sidebar

function renderList() {
  const current = route();
  $("#count").textContent = watches.length ? String(watches.length) : "";
  $("#list").replaceChildren(
    ...watches.map((w) => {
      let meta;
      if (!w.isActive) meta = el("span", { class: "item-meta" }, `Pausado · ${host(w.url)}`);
      else if (w.lastStatus === "error") meta = el("span", { class: "item-meta err" }, `Erro: ${w.lastError}`);
      else meta = el("span", { class: "item-meta" }, `${host(w.url)} · quando ${MODE[w.monitorMode].short} · ${w.checking || busy.has(w.id) ? "checando..." : w.lastCheckedAt ? ago(w.lastCheckedAt) : "esperando 1ª leitura"}`);
      return el("li", {},
        el("a", { class: `item${w.id === current ? " active" : ""}`, href: `#/w/${w.id}` },
          el("span", { class: `dot ${dotClass(w)}` }),
          el("span", { class: "item-title", title: w.label }, w.label),
          w.unseenChanges > 0 ? el("em", { class: "pill" }, w.unseenChanges > 1 ? `${w.unseenChanges} novas` : "nova") : el("span"),
          meta));
    })
  );
  const unseen = watches.reduce((n, w) => n + w.unseenChanges, 0);
  document.title = unseen ? `(${unseen}) Vigil` : "Vigil";
}

// Main area

function renderWelcome() {
  $("#shell").classList.add("solo");
  $("#sidebar").hidden = true;
  $("#main").replaceChildren(
    el("div", { class: "welcome" },
      el("div", { class: "welcome-mark", html: ICON.logo }),
      el("h1", {}, "Vigie qualquer pedaço da web"),
      el("p", { class: "lead" }, "Circule um trecho de uma página e o Vigil avisa quando ele mudar, aparecer ou sumir. Tudo roda aqui no seu computador."),
      el("div", { class: "steps" },
        step(1, "Instale a extensão", el("span", {}, "Em ", el("code", {}, "chrome://extensions"), ", ligue o modo do desenvolvedor e carregue a pasta ", el("code", {}, "extension/"), ".")),
        step(2, "Circule o trecho", el("span", {}, "Em qualquer site, clique no ícone do Vigil (ou ", el("code", {}, "Alt+Shift+V"), ") e circule o que importa.")),
        step(3, "Receba o aviso", el("span", {}, "Notificação no Chrome quando mudar, e aqui o antes e depois de cada mudança."))),
      el("p", { class: "welcome-alt" }, "Prefere digitar? ", el("button", { class: "linklike", onclick: () => openEditor() }, "Crie um alerta à mão"))));
}

function step(n, title, body) {
  return el("div", { class: "card step" }, el("div", { class: "step-n" }, String(n)), el("h3", {}, title), el("p", {}, body));
}

async function renderDetail(id, { force = false } = {}) {
  const w = watches.find((x) => x.id === id);
  if (!w) {
    location.hash = watches.length ? `#/w/${watches[0].id}` : "#/";
    return;
  }
  // Re-render only when something visible changed, so polling does not flicker.
  const key = JSON.stringify([w, busy.has(id), Math.floor(Date.now() / 60000)]);
  if (!force && key === detailKey) return;
  detailKey = key;

  const [{ current }, { changes }] = await Promise.all([api(`/watches/${id}`), api(`/watches/${id}/changes`)]);
  if (route() !== id) return;

  const isBusy = busy.has(id) || w.checking;
  const statusChip = !w.isActive
    ? el("span", { class: "chip muted" }, "Pausado")
    : w.lastStatus === "error"
      ? el("span", { class: "chip warn" }, "Com erro")
      : w.lastStatus === "pending"
        ? el("span", { class: "chip muted" }, "Esperando 1ª leitura")
        : el("span", { class: "chip ok" }, "Em dia");

  const head = el("div", { class: "detail-head" },
    el("div", { style: "min-width:0;flex:1" },
      el("div", { class: "chips" }, statusChip, el("span", { class: "chip" }, MODE[w.monitorMode].chip), el("span", { class: "chip" }, `A cada ${every(w.intervalMinutes)}`)),
      el("h1", {}, w.label),
      el("a", { class: "url", href: w.url, target: "_blank", rel: "noreferrer" }, shortUrl(w.url), el("span", { html: ICON.out }))),
    el("div", { class: "head-actions" },
      el("button", { class: "btn primary", disabled: isBusy || !w.isActive, onclick: () => checkNow(w) },
        el("span", { html: ICON.refresh, class: isBusy ? "spin" : "", style: "display:grid" }), isBusy ? "Checando..." : "Checar agora"),
      el("button", { class: "btn", onclick: () => togglePause(w) }, el("span", { html: w.isActive ? ICON.pause : ICON.play, style: "display:grid" }), w.isActive ? "Pausar" : "Retomar"),
      el("button", { class: "btn", onclick: () => openEditor(w) }, el("span", { html: ICON.edit, style: "display:grid" }), "Editar"),
      el("button", { class: "btn danger", "aria-label": "Excluir", title: "Excluir", onclick: () => remove(w) }, el("span", { html: ICON.trash, style: "display:grid" }))));

  const stats = el("div", { class: "stats" },
    stat("Última checagem", w.lastCheckedAt ? ago(w.lastCheckedAt) : "ainda não"),
    stat("Próxima", !w.isActive ? "pausado" : isBusy ? "agora" : inFuture(w.nextCheckAt)),
    stat("Mudanças", w.totalChanges ? `${w.totalChanges}${w.lastChangedAt ? ` · última ${ago(w.lastChangedAt)}` : ""}` : "nenhuma ainda"));

  const banner = w.lastStatus === "error"
    ? el("div", { class: "banner warn" },
        el("div", {},
          el("strong", {}, "A última checagem falhou"),
          el("p", {}, `${w.lastError}. ${w.consecutiveErrors > 1 ? `${w.consecutiveErrors} falhas seguidas, então o Vigil está esperando mais entre as tentativas.` : "O Vigil tenta de novo no próximo horário."}`)))
    : null;

  $("#main").replaceChildren(head, stats, banner || "", nowSection(w, current), historySection(w, changes),
    el("p", { class: "meta-foot" }, `Criado ${when(w.createdAt)}.`));

  if (w.unseenChanges > 0) {
    setTimeout(async () => {
      if (route() !== id) return;
      await api(`/watches/${id}/seen`, { method: "POST" }).catch(() => {});
      await refresh();
    }, 1500);
  }
}

function stat(label, value) {
  return el("div", { class: "stat" }, el("div", { class: "stat-label" }, label), el("div", { class: "stat-value" }, value));
}

function nowSection(w, current) {
  const title = el("div", { class: "section-head" },
    el("h2", {}, "Agora na página"),
    current ? el("span", { class: "section-note" }, `igual desde ${when(current.since)}`) : null);

  if (!current) {
    return el("section", { class: "section" }, title,
      el("div", { class: "card now" }, el("p", { class: "help", style: "margin:0" }, w.lastStatus === "error" ? "Ainda não deu para ler a página." : "A primeira leitura sai em instantes.")));
  }

  if (w.monitorMode !== "text_changed") {
    const yes = Boolean(current.present);
    return el("section", { class: "section" }, title,
      el("div", { class: "card now presence" },
        el("div", { class: `presence-state ${yes ? "yes" : "no"}`, html: yes ? ICON.yes : ICON.no }),
        el("div", {},
          el("strong", {}, yes ? "Está na página" : "Não está na página"),
          el("p", {}, `Procurando “${w.targetText}” na página inteira.`))));
  }

  return el("section", { class: "section" }, title,
    el("div", { class: "card now" },
      el("div", { class: "now-text" }, current.excerpt || "O trecho não está na página agora."),
      el("div", { class: "now-foot" },
        w.cssSelector
          ? el("span", {}, "Elemento ", el("code", {}, w.cssSelector))
          : el("span", {}, "Achado pelo texto “", w.targetText.slice(0, 80), "”"))));
}

function historySection(w, changes) {
  const head = el("div", { class: "section-head" }, el("h2", {}, "Histórico"),
    changes.length ? el("span", { class: "section-note" }, `${changes.length} ${changes.length === 1 ? "mudança" : "mudanças"}`) : null);
  if (!changes.length) {
    return el("section", { class: "section" }, head,
      el("div", { class: "empty-history" },
        w.lastCheckedAt
          ? `Nenhuma mudança ainda. O Vigil compara a cada ${every(w.intervalMinutes)} e avisa quando ${MODE[w.monitorMode].short}.`
          : "Assim que a primeira leitura sair, as mudanças aparecem aqui."));
  }
  return el("section", { class: "section" }, head, el("div", { class: "timeline" }, changes.map(changeCard)));
}

const KIND = { changed: "Mudou", appeared: "Apareceu", disappeared: "Sumiu" };

function changeCard(c) {
  const isNew = !c.seenAt;
  let body;
  if (c.kind === "appeared") {
    body = el("div", { class: "presence-change add" }, el("span", { html: ICON.plus, style: "display:grid" }), c.afterText);
  } else if (c.kind === "disappeared") {
    body = el("div", { class: "presence-change del" }, el("span", { html: ICON.minus, style: "display:grid" }), c.beforeText);
  } else {
    body = diffView(c.rows);
  }
  return el("article", { class: `card change${isNew ? " new" : ""}` },
    el("div", { class: "change-head" },
      el("span", { class: `change-kind${isNew ? " new" : ""}` }, isNew ? `${KIND[c.kind]} · nova` : KIND[c.kind]),
      el("span", { class: "change-summary" }, c.summary),
      el("time", { class: "change-time", datetime: c.createdAt, title: new Date(c.createdAt).toLocaleString("pt-BR") }, when(c.createdAt))),
    body);
}

function segments(segs, tag) {
  return segs.map(([marked, text]) => (marked ? el(tag, {}, text) : text));
}

function diffView(rows) {
  const grid = el("div", { class: "diff" }, el("div", { class: "diff-col-head" }, "Antes"), el("div", { class: "diff-col-head" }, "Depois"));
  for (const row of rows) {
    if (row.type === "skip") {
      grid.append(el("div", { class: "diff-skip" }, `${row.lines} ${row.lines === 1 ? "linha igual" : "linhas iguais"}`));
    } else if (row.type === "same") {
      grid.append(el("div", { class: "diff-cell same" }, row.text), el("div", { class: "diff-cell same" }, row.text));
    } else {
      const hasBefore = row.before.some(([, t]) => t.trim());
      const hasAfter = row.after.some(([, t]) => t.trim());
      grid.append(
        el("div", { class: `diff-cell ${hasBefore ? "del" : "empty"}` }, segments(row.before, "del")),
        el("div", { class: `diff-cell ${hasAfter ? "add" : "empty"}` }, segments(row.after, "ins")));
    }
  }
  return grid;
}

// Actions

async function checkNow(w) {
  busy.add(w.id);
  renderList();
  renderDetail(w.id, { force: true });
  try {
    const { check } = await api(`/watches/${w.id}/check`, { method: "POST" });
    if (check.status === "error") toast(`A checagem falhou: ${check.error}`);
    else if (check.change) toast(`Mudou: ${check.change.summary}`);
    else toast("Checado agora. Nada mudou.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy.delete(w.id);
    await refresh({ force: true });
  }
}

async function togglePause(w) {
  try {
    await api(`/watches/${w.id}`, { method: "PATCH", body: { isActive: !w.isActive } });
    toast(w.isActive ? "Alerta pausado" : "Alerta retomado. Checando agora.");
  } catch (err) {
    toast(err.message);
  }
  await refresh({ force: true });
}

async function remove(w) {
  if (!confirm(`Excluir "${w.label}"? O histórico de mudanças vai junto.`)) return;
  try {
    await api(`/watches/${w.id}`, { method: "DELETE" });
    toast("Alerta excluído");
    location.hash = "#/";
  } catch (err) {
    toast(err.message);
  }
  await refresh({ force: true });
}

// Editor dialog

const dialog = $("#editor");
const form = $("#editor-form");
let editing = null;
let editorMode = "text_changed";

function setEditorMode(mode) {
  editorMode = mode;
  for (const b of form.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  const presence = mode !== "text_changed";
  $("#target-label").textContent = mode === "text_appears" ? "Texto que deve aparecer" : mode === "text_disappears" ? "Texto que deve sumir" : "Texto do trecho";
  $("#target-help").textContent = presence
    ? "Procurado na página inteira, sem diferenciar maiúsculas."
    : "Com seletor, o Vigil compara o elemento inteiro. Sem seletor, compara o texto em volta deste trecho.";
  $("#selector-field").hidden = presence;
}

function openEditor(w = null) {
  editing = w;
  form.reset();
  $("#editor-error").hidden = true;
  $("#editor-title").textContent = w ? "Editar alerta" : "Novo alerta";
  $("#editor-submit").textContent = w ? "Salvar" : "Criar alerta";
  $("#editor-tip").hidden = Boolean(w);
  if (w) {
    form.url.value = w.url;
    form.label.value = w.label;
    form.targetText.value = w.targetText;
    form.cssSelector.value = w.cssSelector || "";
    form.webhookUrl.value = w.webhookUrl || "";
    const sel = form.intervalMinutes;
    if (![...sel.options].some((o) => Number(o.value) === w.intervalMinutes)) {
      sel.append(el("option", { value: String(w.intervalMinutes) }, every(w.intervalMinutes)));
    }
    sel.value = String(w.intervalMinutes);
    form.querySelector("details").open = Boolean(w.webhookUrl);
  }
  setEditorMode(w ? w.monitorMode : "text_changed");
  dialog.showModal();
  form.url.focus();
}

form.addEventListener("click", (e) => {
  const mode = e.target.closest("[data-mode]")?.dataset.mode;
  if (mode) setEditorMode(mode);
  if (e.target.closest("[data-close]")) dialog.close();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const presence = editorMode !== "text_changed";
  const body = {
    url: form.url.value.trim(),
    label: form.label.value.trim() || undefined,
    monitorMode: editorMode,
    targetText: form.targetText.value.trim(),
    intervalMinutes: Number(form.intervalMinutes.value),
    cssSelector: presence ? null : form.cssSelector.value.trim() || null,
    webhookUrl: form.webhookUrl.value.trim() || null,
  };
  const submit = $("#editor-submit");
  submit.disabled = true;
  submit.textContent = "Salvando...";
  try {
    if (editing) {
      await api(`/watches/${editing.id}`, { method: "PATCH", body });
      toast("Alerta salvo");
    } else {
      const { watch, check } = await api("/watches", { method: "POST", body });
      toast(check?.status === "error" ? `Criado, mas a primeira leitura falhou: ${check.error}` : "Alerta criado. Primeira leitura feita.");
      location.hash = `#/w/${watch.id}`;
    }
    dialog.close();
    await refresh({ force: true });
  } catch (err) {
    $("#editor-error").textContent = err.message;
    $("#editor-error").hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = editing ? "Salvar" : "Criar alerta";
  }
});

$("#new-watch").addEventListener("click", () => openEditor());

// Loop

async function refresh({ force = false } = {}) {
  try {
    const data = await api("/watches");
    watches = data.watches;
    loaded = true;
  } catch {
    renderConn();
    return;
  }
  renderConn();
  renderList();
  const id = route();
  if (!watches.length) {
    renderWelcome();
    detailKey = "";
    return;
  }
  $("#shell").classList.remove("solo");
  $("#sidebar").hidden = false;
  if (id === null) {
    const first = watches.find((w) => w.unseenChanges > 0) || watches[0];
    location.hash = `#/w/${first.id}`;
    return;
  }
  await renderDetail(id, { force });
}

window.addEventListener("hashchange", () => {
  detailKey = "";
  refresh({ force: true });
});

refresh({ force: true });
setInterval(() => {
  if (!dialog.open) refresh();
}, 8000);
