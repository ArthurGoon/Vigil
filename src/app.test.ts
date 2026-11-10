import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp, isAllowedRequest } from "./app.js";
import { Store } from "./db/store.js";
import { Checker } from "./domain/check.js";
import { PageCache } from "./domain/probe.js";
import { fetchPage } from "./lib/html.js";
import { Scheduler } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "../fixtures/sample.html"), "utf8");

/** A real local site whose content the test changes between checks. */
let page = fixture;
let status = 200;
let server: Server;
let siteUrl = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/latin1") {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(Buffer.from("<body><p>Inscrições abertas</p></body>", "latin1"));
      return;
    }
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/vagas`;
});

after(() => server.close());

function setup() {
  const store = new Store(":memory:");
  const checker = new Checker(store);
  const app = createApp({ store, checker, pages: new PageCache() });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://localhost:3000${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { store, checker, app, call };
}

beforeEach(() => {
  page = fixture;
  status = 200;
});

describe("API: full cycle", () => {
  it("creates its own baseline without claiming an older due watch", async () => {
    const { call, store } = setup();
    const older = store.insertWatch({
      url: siteUrl, label: "Aguardando", cssSelector: null, targetText: "Data Analyst",
      monitorMode: "text_changed", intervalMinutes: 60, webhookUrl: null, isActive: true,
    }, new Date(0));
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Backend Engineer" });
    assert.equal(created.status, 201);
    assert.equal(created.json.check?.status, "ok");
    assert.ok(store.latestSnapshot(created.json.watch.id));
    assert.equal(store.getWatch(older.id)?.nextCheckAt, older.nextCheckAt);
  });

  it("does not check a watch created paused", async () => {
    const { call, store } = setup();
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Data Analyst", isActive: false });
    assert.equal(created.status, 201);
    assert.equal(created.json.check, null);
    assert.equal(store.latestSnapshot(created.json.watch.id), null);
  });

  it("creates with a baseline, detects the change and lists it with a diff", async () => {
    const { call } = setup();
    const created = await call("POST", "/api/watches", {
      url: siteUrl,
      label: "Vagas ACME",
      cssSelector: "#job-list",
      targetText: "Backend Engineer",
      monitorMode: "text_changed",
      intervalMinutes: 15,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.check.status, "ok");
    assert.equal(created.json.check.change, null);
    assert.equal(created.json.watch.lastStatus, "ok");
    const id = created.json.watch.id;

    page = fixture.replace("Data Analyst", "ML Engineer");
    const checked = await call("POST", `/api/watches/${id}/check`);
    assert.equal(checked.json.check.change.summary, "“Data Analyst” virou “ML Engineer”");

    const detail = await call("GET", `/api/watches/${id}`);
    assert.match(detail.json.current.excerpt, /ML Engineer/);

    const changes = await call("GET", `/api/watches/${id}/changes`);
    assert.equal(changes.json.changes.length, 1);
    const row = changes.json.changes[0].rows.find((r: any) => r.type === "change");
    assert.deepEqual(row.after.filter((s: any) => s[0] === 1).map((s: any) => s[1]), ["ML", "Engineer"]);

    const feed = await call("GET", "/api/changes?after=0");
    assert.equal(feed.json.unseen, 1);
    assert.equal(feed.json.changes[0].watchLabel, "Vagas ACME");

    await call("POST", `/api/watches/${id}/seen`);
    assert.equal((await call("GET", "/api/changes?after=0")).json.unseen, 0);
  });

  it("enforces the manual check cooldown", async () => {
    const { call } = setup();
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Data Analyst" });
    const id = created.json.watch.id;
    const first = await call("POST", `/api/watches/${id}/check`);
    assert.equal(first.status, 200);
    const second = await call("POST", `/api/watches/${id}/check`);
    assert.equal(second.status, 429);
    assert.match(second.json.error, /Espere/);
  });

  it("records HTTP errors and backs off", async () => {
    const { call, store } = setup();
    status = 500;
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Data Analyst", intervalMinutes: 60 });
    const watch = store.getWatch(created.json.watch.id)!;
    assert.equal(watch.lastStatus, "error");
    assert.match(watch.lastError ?? "", /HTTP 500/);
    assert.equal(watch.consecutiveErrors, 1);
    assert.ok(new Date(watch.nextCheckAt).getTime() > Date.now() + 59 * 60_000);
  });

  it("pausing keeps it out of the scheduler and resuming checks right away", async () => {
    const { call, store, checker } = setup();
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Data Analyst" });
    const id = created.json.watch.id;
    await call("PATCH", `/api/watches/${id}`, { isActive: false });
    store.updateWatch(id, { nextCheckAt: new Date(0).toISOString() });
    const scheduler = new Scheduler(store, checker, { concurrency: 3, pollMs: 60_000 });
    assert.equal(scheduler.tick().length, 0);
    await call("PATCH", `/api/watches/${id}`, { isActive: true });
    const started = scheduler.tick();
    assert.equal(started.length, 1);
    await scheduler.stop();
  });

  it("retargeting starts a new baseline instead of alerting", async () => {
    const { call } = setup();
    const created = await call("POST", "/api/watches", { url: siteUrl, cssSelector: "#job-list", targetText: "Backend" });
    const id = created.json.watch.id;
    const patched = await call("PATCH", `/api/watches/${id}`, { cssSelector: "h1" });
    assert.equal(patched.json.watch.lastStatus, "pending");
    await new Promise((r) => setTimeout(r, 1));
    const { json } = await call("GET", `/api/watches/${id}/changes`);
    assert.equal(json.changes.length, 0);
  });

  it("validates input with readable messages", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/watches", { url: "ftp://x", targetText: "a", intervalMinutes: 1 });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /http ou https/);
    assert.match(res.json.error, /mínimo/);
  });

  it("probes a page for the extension", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/probe", {
      url: siteUrl,
      selectors: ["#job-list > ul > li:nth-of-type(2)"],
      text: "Data Analyst",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.selector, "#job-list > ul > li:nth-of-type(2)");
    assert.equal(res.json.title, "Careers");
  });
});

describe("Scheduler", () => {
  it("does not start a watch that is already being checked manually", async () => {
    const { store, checker, call } = setup();
    const created = await call("POST", "/api/watches", { url: siteUrl, targetText: "Data Analyst" });
    const id = created.json.watch.id;
    store.updateWatch(id, { nextCheckAt: new Date(0).toISOString(), lastManualCheckAt: null });
    const manual = call("POST", `/api/watches/${id}/check`);
    const scheduler = new Scheduler(store, checker, { concurrency: 3, pollMs: 60_000 });
    assert.equal(scheduler.tick().length, 0);
    await manual;
    await scheduler.stop();
  });
});

describe("request guard", () => {
  it("accepts the panel, the extension and tools without Origin", () => {
    assert.ok(isAllowedRequest("http://localhost:3000/api/watches", undefined));
    assert.ok(isAllowedRequest("http://localhost:3000/api/watches", "http://localhost:3000"));
    assert.ok(isAllowedRequest("http://127.0.0.1:3000/api/watches", "chrome-extension://abc"));
  });

  it("rejects other sites and DNS rebinding", () => {
    assert.ok(!isAllowedRequest("http://localhost:3000/api/watches", "https://evil.example"));
    assert.ok(!isAllowedRequest("http://localhost:3000/api/watches", "http://localhost:8080"));
    assert.ok(!isAllowedRequest("http://evil.example:3000/api/watches", undefined));
  });

  it("answers 403 to a cross-site request", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/changes/seen", {}, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });
});

describe("fetchPage", () => {
  it("decodes the charset the server declares", async () => {
    const result = await fetchPage(siteUrl.replace("/vagas", "/latin1"));
    assert.match(result.html, /Inscrições abertas/);
  });

  it("treats non 2xx as an error", async () => {
    status = 404;
    await assert.rejects(fetchPage(siteUrl), /HTTP 404/);
  });
});
