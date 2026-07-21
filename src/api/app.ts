import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { consumeMagicLink, destroySession, requestMagicLink } from "../domain/auth.js";
import {
  buildGoogleAuthUrl,
  decodeOAuthState,
  defaultGoogleRedirectUri,
  encodeOAuthState,
  exchangeGoogleCode,
  googleClientId,
  googleConfigured,
  loginWithGoogleProfile,
  verifyGoogleIdToken,
} from "../domain/googleAuth.js";
import { getWatchForUser, listWatches, runWatchCheck } from "../domain/check.js";
import {
  NotFoundError,
  RateLimitError,
  WatchLimitError,
  createWatch,
  createWatchSchema,
  deleteWatch,
  updateWatch,
  updateWatchSchema,
} from "../domain/watches.js";
import { db } from "../db/client.js";
import { changeEvents, snapshots } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";
import { hashIp, hashUa } from "../lib/crypto.js";
import { EVENT_NAMES, isEventName, track, trackMany } from "../lib/events.js";
import {
  AuthError,
  clearSessionCookie,
  requireUser,
  sessionMiddleware,
  writeSessionCookie,
  type AppVariables,
} from "./middleware.js";

export const app = new Hono<{ Variables: AppVariables }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  })
);
app.use("*", sessionMiddleware);

app.get("/health", (c) => c.json({ ok: true, service: "vigil" }));

app.get("/auth/google/config", (c) => {
  if (!googleConfigured()) {
    return c.json({ ok: true, enabled: false });
  }
  return c.json({
    ok: true,
    enabled: true,
    clientId: googleClientId(),
    redirectUri: defaultGoogleRedirectUri(),
  });
});

app.get("/auth/google", (c) => {
  if (!googleConfigured()) {
    return c.json(
      {
        ok: false,
        error: "Google login não configurado. Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.",
      },
      503
    );
  }

  const redirectParam = c.req.query("redirect") || "/app.html";
  const redirectUri = c.req.query("redirect_uri") || defaultGoogleRedirectUri();
  const mode = c.req.query("mode") || "web";
  const state = encodeOAuthState({
    r: redirectParam.startsWith("/") ? redirectParam : "/app.html",
    m: mode,
    n: randomNonce(),
  });

  const url = buildGoogleAuthUrl({ redirectUri, state });

  // Extension asks for JSON instead of redirect
  if (c.req.query("format") === "json") {
    return c.json({ ok: true, url, redirectUri, state });
  }
  return c.redirect(url);
});

app.get("/auth/google/callback", async (c) => {
  if (!googleConfigured()) {
    return c.json({ ok: false, error: "Google login not configured" }, 503);
  }

  const err = c.req.query("error");
  if (err) {
    return c.html(googleErrorPage(err), 400);
  }

  const code = c.req.query("code");
  const stateRaw = c.req.query("state");
  if (!code) return c.json({ ok: false, error: "Missing code" }, 400);

  const state = decodeOAuthState(stateRaw);
  const redirectUri = defaultGoogleRedirectUri();

  try {
    const profile = await exchangeGoogleCode(code, redirectUri);
    const result = await loginWithGoogleProfile(profile, "google_web");
    writeSessionCookie(c, result.sessionToken);

    const next = state.r && state.r.startsWith("/") && !state.r.startsWith("//") ? state.r : "/app.html";
    // Extension bridge page can read token from query when opened in launchWebAuthFlow... 
    // For web, just redirect.
    if (state.m === "extension_bridge") {
      return c.redirect(
        `/auth/extension-bridge.html?sessionToken=${encodeURIComponent(result.sessionToken)}&email=${encodeURIComponent(result.email)}`
      );
    }
    return c.redirect(next);
  } catch (e) {
    console.error("[auth/google/callback]", e);
    return c.html(googleErrorPage(e instanceof Error ? e.message : "Auth failed"), 400);
  }
});

/** Extension / mobile: exchange authorization code (with the same redirect_uri used). */
app.post("/auth/google/code", async (c) => {
  if (!googleConfigured()) {
    return c.json({ ok: false, error: "Google login not configured" }, 503);
  }
  const body = z
    .object({
      code: z.string().min(10),
      redirectUri: z.string().url(),
    })
    .parse(await c.req.json());

  try {
    const profile = await exchangeGoogleCode(body.code, body.redirectUri);
    const result = await loginWithGoogleProfile(profile, "google_extension");
    writeSessionCookie(c, result.sessionToken);
    return c.json({
      ok: true,
      sessionToken: result.sessionToken,
      userId: result.userId,
      email: result.email,
      isNew: result.isNew,
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : "Auth failed" }, 400);
  }
});

/** Optional: GIS / id_token from client. */
app.post("/auth/google/id-token", async (c) => {
  if (!googleConfigured()) {
    return c.json({ ok: false, error: "Google login not configured" }, 503);
  }
  const body = z.object({ idToken: z.string().min(20) }).parse(await c.req.json());
  try {
    const profile = await verifyGoogleIdToken(body.idToken);
    const result = await loginWithGoogleProfile(profile, "google_id_token");
    writeSessionCookie(c, result.sessionToken);
    return c.json({
      ok: true,
      sessionToken: result.sessionToken,
      userId: result.userId,
      email: result.email,
      isNew: result.isNew,
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : "Auth failed" }, 400);
  }
});

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function googleErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/><title>Vigil — login</title>
  <style>body{font-family:system-ui;background:#eef1ec;color:#14181c;padding:2rem}
  a{color:#14181c}</style></head><body>
  <h1>Não deu para entrar com Google</h1>
  <p>${message.replace(/</g, "&lt;")}</p>
  <p><a href="/login.html">Voltar ao login</a></p></body></html>`;
}

app.post("/auth/magic-link", async (c) => {
  const body = z.object({ email: z.string().email() }).parse(await c.req.json());
  const result = await requestMagicLink(body.email);
  return c.json({ ok: true, ...result });
});

app.post("/auth/exchange", async (c) => {
  const body = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  try {
    const { sessionToken, userId } = await consumeMagicLink(body.token);
    writeSessionCookie(c, sessionToken);
    return c.json({ ok: true, sessionToken, userId });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Auth failed" }, 400);
  }
});

app.get("/auth/callback", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ ok: false, error: "Missing token" }, 400);
  try {
    const { sessionToken } = await consumeMagicLink(token);
    writeSessionCookie(c, sessionToken);
    const redirect = c.req.query("redirect") || "/app.html";
    // Always redirect browsers to the app after login
    if (redirect.startsWith("/") && !redirect.startsWith("//")) {
      return c.redirect(redirect);
    }
    return c.json({ ok: true, message: "Logged in. Cookie set." });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Auth failed" }, 400);
  }
});

app.post("/auth/logout", async (c) => {
  await destroySession(c.get("sessionToken") ?? undefined);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Unauthorized" }, 401);
  return c.json({ ok: true, user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

app.get("/watches", async (c) => {
  const user = requireUser(c);
  const rows = await listWatches(user.id);
  return c.json({ ok: true, watches: rows });
});

app.post("/watches", async (c) => {
  const user = requireUser(c);
  await track({ name: "watch_create_started", userId: user.id });
  const input = createWatchSchema.parse(await c.req.json());
  const watch = await createWatch(user.id, input);
  return c.json({ ok: true, watch }, 201);
});

app.get("/watches/:id", async (c) => {
  const user = requireUser(c);
  const watch = await getWatchForUser(c.req.param("id"), user.id);
  if (!watch) return c.json({ ok: false, error: "Not found" }, 404);
  return c.json({ ok: true, watch });
});

app.patch("/watches/:id", async (c) => {
  const user = requireUser(c);
  const input = updateWatchSchema.parse(await c.req.json());
  const watch = await updateWatch(user.id, c.req.param("id"), input);
  return c.json({ ok: true, watch });
});

app.delete("/watches/:id", async (c) => {
  const user = requireUser(c);
  await deleteWatch(user.id, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/watches/:id/check", async (c) => {
  const user = requireUser(c);
  const watch = await getWatchForUser(c.req.param("id"), user.id);
  if (!watch) return c.json({ ok: false, error: "Not found" }, 404);

  await track({ name: "watch_check_clicked", userId: user.id, props: { watchId: watch.id } });

  if (watch.lastManualCheckAt) {
    const elapsed = Date.now() - new Date(watch.lastManualCheckAt).getTime();
    if (elapsed < LIMITS.manualCheckCooldownMinutes * 60_000) {
      throw new RateLimitError(
        `Manual check limited to once per ${LIMITS.manualCheckCooldownMinutes} minutes`
      );
    }
  }

  const result = await runWatchCheck(watch, { manual: true, userId: user.id });
  await track({
    name: result.status === "error" ? "watch_check_failed" : "watch_check_succeeded",
    userId: user.id,
    props: { watchId: watch.id, status: result.status },
  });

  return c.json({
    ok: true,
    status: result.status,
    preview: result.preview,
    hash: result.hash,
    error: result.error,
  });
});

app.get("/watches/:id/snapshots", async (c) => {
  const user = requireUser(c);
  const watch = await getWatchForUser(c.req.param("id"), user.id);
  if (!watch) return c.json({ ok: false, error: "Not found" }, 404);

  const rows = await db
    .select({
      id: snapshots.id,
      contentHash: snapshots.contentHash,
      httpStatus: snapshots.httpStatus,
      fetchedAt: snapshots.fetchedAt,
      preview: snapshots.contentText,
    })
    .from(snapshots)
    .where(eq(snapshots.watchId, watch.id))
    .orderBy(desc(snapshots.fetchedAt))
    .limit(50);

  return c.json({
    ok: true,
    snapshots: rows.map((r) => ({
      ...r,
      preview: r.preview.slice(0, 300),
    })),
  });
});

app.get("/watches/:id/changes", async (c) => {
  const user = requireUser(c);
  const watch = await getWatchForUser(c.req.param("id"), user.id);
  if (!watch) return c.json({ ok: false, error: "Not found" }, 404);

  const rows = await db
    .select()
    .from(changeEvents)
    .where(eq(changeEvents.watchId, watch.id))
    .orderBy(desc(changeEvents.createdAt))
    .limit(50);

  return c.json({ ok: true, changes: rows });
});

const ingestSchema = z.object({
  anonymousId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        props: z.record(z.unknown()).optional(),
        occurredAt: z.string().datetime().optional(),
      })
    )
    .min(1)
    .max(LIMITS.ingestBatchMax),
});

app.post("/ingest/events", async (c) => {
  const body = ingestSchema.parse(await c.req.json());
  const user = c.get("user");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip");
  const ua = c.req.header("user-agent");

  const valid = body.events.filter((e) => isEventName(e.name));
  if (!valid.length) {
    return c.json({ ok: false, error: `Allowed names: ${EVENT_NAMES.join(", ")}` }, 400);
  }

  const inserted = await trackMany(
    valid.map((e) => ({
      name: e.name as (typeof EVENT_NAMES)[number],
      anonymousId: body.anonymousId,
      sessionId: body.sessionId,
      userId: user?.id,
      props: e.props,
      ipHash: hashIp(ip),
      uaHash: hashUa(ua),
      occurredAt: e.occurredAt ? new Date(e.occurredAt) : undefined,
    }))
  );

  return c.json({ ok: true, inserted });
});

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ ok: false, error: err.message }, 401);
  if (err instanceof WatchLimitError || err instanceof RateLimitError || err instanceof NotFoundError) {
    return c.json({ ok: false, error: err.message }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json({ ok: false, error: err.flatten() }, 400);
  }
  console.error(err);
  return c.json({ ok: false, error: err instanceof Error ? err.message : "Internal error" }, 500);
});

// Static frontend (same origin → cookies work)
app.get("/", serveStatic({ path: "./web/index.html" }));
app.use("/*", serveStatic({ root: "./web" }));
