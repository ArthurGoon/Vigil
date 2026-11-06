import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { LIMITS, ROOT_DIR } from "./config.js";
import type { Store, Watch } from "./db/store.js";
import { AlreadyCheckingError, type Checker } from "./domain/check.js";
import { parseSnapshot } from "./domain/observation.js";
import { type PageCache, probe } from "./domain/probe.js";
import { manualCheckWaitSeconds } from "./domain/schedule.js";
import { createWatch, updateWatch } from "./domain/watches.js";
import { diffRows } from "./lib/diff.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string
  ) {
    super(message);
  }
}

/**
 * There is no login: the server listens on 127.0.0.1 and trusts whoever can
 * reach it. That only holds if other sites open in the same browser cannot
 * use it, so requests must come to a local host name (blocks DNS rebinding)
 * and, when the browser sends an Origin, it must be this panel or a Chrome
 * extension (blocks cross-site requests).
 */
export function isAllowedRequest(url: string, origin: string | undefined): boolean {
  const self = new URL(url);
  if (!LOCAL_HOSTS.has(self.hostname)) return false;
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  return origin === self.origin;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export type AppDeps = {
  store: Store;
  checker: Checker;
  pages: PageCache;
  webDir?: string;
};

export function createApp({ store, checker, pages, webDir = join(ROOT_DIR, "web") }: AppDeps) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isAllowedRequest(c.req.url, c.req.header("origin"))) {
      return c.json({ error: "Origem não permitida" }, 403);
    }
    await next();
  });

  const idParam = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Alerta não encontrado");
    return id;
  };

  const mustGet = (id: number): Watch => {
    const watch = store.getWatch(id);
    if (!watch) throw new HttpError(404, "Alerta não encontrado");
    return watch;
  };

  const withBusy = <T extends Watch>(w: T) => ({ ...w, checking: checker.isBusy(w.id) });

  const body = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      throw new HttpError(400, "JSON inválido");
    }
  };

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "vigil",
      minIntervalMinutes: LIMITS.minIntervalMinutes,
      unseen: store.unseenCount(),
    })
  );

  app.get("/api/watches", (c) => c.json({ watches: store.listWatches().map(withBusy) }));

  /** Creates the watch and runs the first check right away, so the caller sees the baseline (or the error). */
  app.post("/api/watches", async (c) => {
    const watch = createWatch(store, await body(c));
    const claimed = store.claimDue(1, LIMITS.claimLeaseSeconds, new Date(), checker.busyIds())
      .find((w) => w.id === watch.id);
    const result = claimed ? await checker.run(claimed) : null;
    return c.json({ watch: withBusy(store.getWatch(watch.id) ?? watch), check: result }, 201);
  });

  app.get("/api/watches/:id", (c) => {
    const watch = mustGet(idParam(c));
    const snap = store.latestSnapshot(watch.id);
    const parsed = snap ? parseSnapshot(snap.contentText) : null;
    return c.json({
      watch: withBusy(watch),
      current: parsed ? { excerpt: parsed.excerpt, present: parsed.present, since: snap!.fetchedAt } : null,
    });
  });

  app.patch("/api/watches/:id", async (c) => {
    const watch = updateWatch(store, idParam(c), await body(c));
    if (!watch) throw new HttpError(404, "Alerta não encontrado");
    return c.json({ watch: withBusy(watch) });
  });

  app.delete("/api/watches/:id", (c) => {
    if (!store.deleteWatch(idParam(c))) throw new HttpError(404, "Alerta não encontrado");
    return c.json({ ok: true });
  });

  app.post("/api/watches/:id/check", async (c) => {
    const watch = mustGet(idParam(c));
    const wait = manualCheckWaitSeconds(watch.lastManualCheckAt, new Date());
    if (wait > 0) throw new HttpError(429, `Espere ${wait}s para checar de novo`);
    const result = await checker.run(watch, { manual: true });
    return c.json({ watch: withBusy(mustGet(watch.id)), check: result });
  });

  app.get("/api/watches/:id/changes", (c) => {
    const watch = mustGet(idParam(c));
    const changes = store.listChanges({ watchId: watch.id, limit: 50 }).map((change) => ({
      ...change,
      rows: change.kind === "changed" ? diffRows(change.beforeText, change.afterText) : [],
    }));
    return c.json({ changes });
  });

  app.post("/api/watches/:id/seen", (c) => {
    const watch = mustGet(idParam(c));
    return c.json({ marked: store.markSeen(watch.id), unseen: store.unseenCount() });
  });

  /** Feed for notifications: changes with id greater than `after`, newest first. */
  app.get("/api/changes", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({
      changes: store.listChanges({
        afterId: Number.isFinite(after) ? after : 0,
        limit: Number.isFinite(limit) ? limit : 20,
      }),
      latestId: store.latestChangeId(),
      unseen: store.unseenCount(),
    });
  });

  app.post("/api/changes/seen", (c) => c.json({ marked: store.markSeen(), unseen: 0 }));

  app.post("/api/probe", async (c) => c.json(await probe(pages, await body(c))));

  app.all("/api/*", (c) => c.json({ error: "Rota não encontrada" }, 404));

  app.get("*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
    const file = join(webDir, relative);
    if (!file.startsWith(webDir + sep)) return c.notFound();
    try {
      if (!(await stat(file)).isFile()) return c.notFound();
      return c.body(await readFile(file), 200, {
        "Content-Type": STATIC_TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.notFound();
    }
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof AlreadyCheckingError) return c.json({ error: err.message }, 409);
    if (err instanceof z.ZodError) {
      const message = err.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      return c.json({ error: message }, 400);
    }
    // Probe fetch errors are user facing ("A página respondeu HTTP 404").
    if (c.req.path === "/api/probe" && err instanceof Error) return c.json({ error: err.message }, 422);
    console.error(err);
    return c.json({ error: "Erro interno" }, 500);
  });

  return app;
}
