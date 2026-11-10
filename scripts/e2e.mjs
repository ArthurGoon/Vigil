// Real Chrome + extension + API + SQLite, against an editable local fixture.
// No external sites, credentials or user data. CHROME_PATH overrides Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_CANDIDATES, launchChrome, loadExtension, screenshot } from "./cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "vigil-e2e-"));
const checks = [];
const fixture = readFileSync(join(root, "fixtures/demo/produto.html"), "utf8");
let html = fixture;
let httpStatus = 200;
let app;
let browser;
let logs = "";
const errors = [];
const site = createServer((_req, res) => {
  res.writeHead(httpStatus, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = setTimeout(() => { console.error("E2E excedeu 3 minutos"); process.exit(1); }, 180_000);
deadline.unref();

function check(name, condition) {
  assert.ok(condition, name);
  checks.push({ name, ok: true });
  console.log(`✓ ${name}`);
}

async function waitFor(page, expression, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await page.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timeout: ${expression}`);
}

try {
  const chromePath = CHROME_CANDIDATES.find(existsSync);
  assert.ok(chromePath, "Instale Google Chrome/Chromium ou defina CHROME_PATH");
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/produto`;

  app = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0", VIGIL_DB: join(out, "vigil.db"), VIGIL_CHECK_COOLDOWN: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(`Servidor não iniciou: ${logs}`)), 15_000);
    app.once("error", no);
    app.once("exit", (code) => { clearTimeout(timer); no(new Error(`Servidor saiu (${code}): ${logs}`)); });
    app.stderr.on("data", (b) => { logs += b; });
    app.stdout.on("data", (b) => {
      logs += b;
      const match = logs.match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); yes(match[0]); }
    });
  });
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const res = await fetch(`${base}/api${path}`, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    assert.ok(res.ok, JSON.stringify(data));
    return data;
  };
  check("servidor inicia com SQLite temporário", (await api("/health")).ok);
  browser = await launchChrome({ chromePath });
  browser.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
  });
  const extId = await loadExtension(browser, join(root, "extension"));
  const swInfo = await browser.waitForTarget((t) => t.type === "service_worker" && t.url.includes(extId));
  const sw = await browser.session(swInfo.targetId);
  await sw.send("Runtime.enable");
  await waitFor(sw, 'typeof chrome !== "undefined" && !!chrome.storage?.local');
  await sw.evaluate(`chrome.storage.local.set({ server: ${JSON.stringify(base)}, lastChangeId: 0 })`);

  const panel = await browser.openPage(base, { width: 1280, height: 900 });
  await panel.send("Runtime.enable");
  await waitFor(panel, '!!document.querySelector(".welcome")');
  check("painel inicial explica instalação e criação de alertas", await panel.evaluate('document.body.innerText.includes("Crie um alerta à mão")'));
  await screenshot(panel, join(out, "01-inicio.png"));
  await panel.evaluate('document.querySelector(".welcome-cta").click()');
  await waitFor(panel, 'document.querySelector("#editor").open');
  check("primeira ação abre o editor com foco na página e opções avançadas recolhidas", await panel.evaluate('document.activeElement.name === "url" && !document.querySelector("#editor details").open'));
  await screenshot(panel, join(out, "editor.png"));
  await panel.evaluate('document.querySelector("#editor [data-close]").click()');
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check("entrada funciona no celular sem rolagem horizontal", await panel.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await screenshot(panel, join(out, "inicio-celular.png"));
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const page = await browser.openPage(siteUrl, { width: 1280, height: 900 });
  await page.send("Runtime.enable");
  const tabId = await sw.evaluate(`chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(siteUrl)}).id)`);
  const started = await sw.evaluate(`self.vigilStartPen(${tabId})`);
  check("extensão ativa a caneta na página", started.ok);
  const shadow = 'document.querySelector("vigil-ui")?.shadowRoot';
  await waitFor(page, `!!${shadow}?.querySelector("canvas")`);
  const box = await page.evaluate(`(() => { const r = document.querySelector('.price').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  // Draw the same closed stroke a user draws with the mouse.
  for (let i = 0; i <= 48; i++) {
    const angle = i / 48 * Math.PI * 2;
    const x = box.x + box.width / 2 + (box.width / 2 + 8) * Math.cos(angle);
    const y = box.y + box.height / 2 + (box.height / 2 + 8) * Math.sin(angle);
    if (i === 0) await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    else await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    if (i === 48) await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }
  await waitFor(page, `!!${shadow}?.querySelector(".card .btn.primary:not([disabled])")`);
  check("caneta reconhece o preço e valida a leitura no servidor", await page.evaluate(`${shadow}.textContent.includes("1.899")`));
  await screenshot(page, join(out, "02-caneta.png"));
  await page.evaluate(`${shadow}.querySelector(".card .btn.primary").click()`);
  await waitFor(page, `${shadow}?.textContent.includes("Ver no painel")`);
  const price = (await api("/watches")).watches[0];
  check("caneta salva com seletor e primeira leitura", price.cssSelector && price.lastStatus === "ok");

  async function createInPanel(mode, label, text) {
    await panel.evaluate('document.querySelector("#new-watch").click()');
    await panel.evaluate(`(() => {
      const f = document.querySelector('#editor-form');
      f.querySelector('[data-mode="${mode}"]').click();
      f.elements.url.value = ${JSON.stringify(siteUrl)};
      f.elements.label.value = ${JSON.stringify(label)};
      f.elements.targetText.value = ${JSON.stringify(text)};
      f.requestSubmit();
    })()`);
    await waitFor(panel, '!document.querySelector("#editor").open');
    const watch = (await api("/watches")).watches.find((w) => w.label === label);
    check(`painel cria alerta: ${mode}`, watch?.lastStatus === "ok");
    return watch;
  }
  const appears = await createInPanel("text_appears", "Estoque esgotado", "Esgotado");
  const disappears = await createInPanel("text_disappears", "Estoque disponível", "Últimas 3 unidades");
  check("primeira leitura não gera notificações", (await api("/changes")).changes.length === 0);
  html = fixture.replaceAll("1.899", "1.799").replace("Últimas 3 unidades", "Esgotado");

  async function checkInPanel(watch) {
    await panel.evaluate(`location.hash = '#/w/${watch.id}'`);
    await waitFor(panel, `document.querySelector('#main h1')?.textContent === ${JSON.stringify(watch.label)} && document.querySelector('.chip')?.textContent === 'Em dia' && location.hash === '#/w/${watch.id}'`);
    await panel.evaluate(`document.querySelector('.head-actions .primary').click()`);
    await waitFor(panel, 'document.querySelector(".head-actions .primary")?.textContent.includes("Checar agora")');
    await waitFor(panel, '!!document.querySelector(".timeline .change")');
  }
  await checkInPanel(price);
  check("mudança de preço aparece no histórico", (await api(`/watches/${price.id}/changes`)).changes[0]?.kind === "changed");
  await waitFor(panel, 'document.querySelectorAll("#toasts .toast").length === 0');
  await screenshot(panel, join(out, "03-mudanca.png"));
  await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  check("painel acompanha o modo escuro do sistema", await panel.evaluate('getComputedStyle(document.documentElement).colorScheme === "dark"'));
  await screenshot(panel, join(out, "modo-escuro.png"));
  await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await checkInPanel(appears);
  check("texto que apareceu gera alerta", (await api(`/watches/${appears.id}/changes`)).changes[0]?.kind === "appeared");
  await checkInPanel(disappears);
  check("texto que sumiu gera alerta", (await api(`/watches/${disappears.id}/changes`)).changes[0]?.kind === "disappeared");

  await sw.evaluate("self.vigilPoll()");
  check("extensão avança o cursor das notificações", (await sw.evaluate('chrome.storage.local.get("lastChangeId")')).lastChangeId === 3);
  const popup = await browser.openPage(`chrome-extension://${extId}/popup.html`, { width: 380, height: 640 });
  await popup.send("Runtime.enable");
  await waitFor(popup, 'document.querySelectorAll("li.item").length === 3');
  check("popup lista os três alertas", true);
  await screenshot(popup, join(out, "04-popup.png"));

  await panel.send("Page.reload");
  await waitFor(panel, 'document.querySelectorAll("#list li").length === 3');
  check("recarregar mantém os alertas salvos", true);
  await panel.evaluate(`(() => { const q = document.querySelector('#watch-search'); q.value = 'esgotado'; q.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  check("busca encontra um alerta pelo nome", await panel.evaluate('document.querySelectorAll("#list li").length === 1 && document.querySelector("#list").textContent.includes("esgotado")'));
  await panel.evaluate(`(() => { const q = document.querySelector('#watch-search'); q.value = 'nenhumresultado'; q.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  check("busca vazia orienta o próximo passo", await panel.evaluate('document.querySelectorAll("#list li").length === 0 && !document.querySelector("#list-empty").hidden'));
  await panel.evaluate(`(() => { const q = document.querySelector('#watch-search'); q.value = ''; q.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await panel.evaluate(`[...document.querySelectorAll('.head-actions > button')].find(b => b.textContent.includes('Pausar')).click()`);
  await waitFor(panel, 'document.querySelector(".chip")?.textContent === "Pausado"');
  await panel.evaluate('document.querySelector(\'[data-list-filter="paused"]\').click()');
  check("filtro mostra apenas o alerta pausado", await panel.evaluate('document.querySelectorAll("#list li").length === 1 && document.querySelector("#list .item-meta").textContent.includes("Pausado")'));
  await panel.evaluate('document.querySelector(\'[data-list-filter="all"]\').click()');
  await panel.evaluate(`[...document.querySelectorAll('.head-actions > button')].find(b => b.textContent.includes('Retomar')).click()`);
  await waitFor(panel, 'document.querySelector(".chip")?.textContent === "Em dia"');
  await waitFor(panel, 'document.querySelectorAll("#toasts .toast").length === 0');
  check("interface funciona em largura de celular", await (async () => {
    await panel.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    return panel.evaluate('document.documentElement.scrollWidth <= innerWidth');
  })());
  await screenshot(panel, join(out, "05-celular.png"));
  await panel.evaluate('document.querySelector("#mobile-list-toggle").click()');
  check("navegação móvel abre os alertas sem perder o detalhe", await panel.evaluate('document.querySelector("#mobile-list-toggle").getAttribute("aria-expanded") === "true" && getComputedStyle(document.querySelector("#watch-navigation")).display !== "none"'));
  await panel.evaluate('document.querySelector("#mobile-list-toggle").click()');
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await panel.evaluate('document.querySelector(".watch-menu summary").click(); document.querySelector(".menu-delete").click()');
  await waitFor(panel, 'document.querySelector("#delete-dialog").open');
  check("exclusão pede confirmação com foco em manter o alerta", await panel.evaluate('document.activeElement.id === "delete-cancel"') && (await api('/watches')).watches.length === 3);
  await screenshot(panel, join(out, "confirmacao-exclusao.png"));
  await panel.evaluate('document.querySelector("#delete-cancel").click()');
  check("cancelar exclusão preserva o alerta e o histórico", (await api('/watches')).watches.length === 3 && (await api(`/watches/${disappears.id}/changes`)).changes.length === 1);
  check("cancelar devolve o foco às opções do alerta", await panel.evaluate('document.activeElement.matches(".watch-menu summary")'));
  await panel.evaluate('document.querySelector(".watch-menu").open = true; document.querySelector(".menu-delete").click()');
  await panel.evaluate('document.querySelector("#delete-confirm").click()');
  await waitFor(panel, '!document.querySelector("#delete-dialog").open');
  check("confirmar exclusão remove somente o alerta escolhido", (await api('/watches')).watches.length === 2 && (await fetch(`${base}/api/watches/${disappears.id}`)).status === 404 && (await api(`/watches/${price.id}/changes`)).changes.length === 1);

  httpStatus = 503;
  const failed = await api(`/watches/${price.id}/check`, {}, "POST");
  check("HTTP 503 vira erro sem gerar mudança falsa", failed.check.status === "error" && failed.check.change === null);
  check("não houve exceções JavaScript na interface", errors.length === 0);
} catch (err) {
  console.error(err);
  checks.push({ name: "execução completa", ok: false, detail: err.message });
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const stopped = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    const kill = setTimeout(() => app.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(kill);
  }
  await new Promise((r) => site.close(r));
  clearTimeout(deadline);
  writeFileSync(join(out, "checks.json"), JSON.stringify(checks, null, 2));
  writeFileSync(join(out, "server.log"), logs);
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} verificações ok. Artefatos: ${out}`);
}
