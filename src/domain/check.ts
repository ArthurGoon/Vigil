import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { changeEvents, snapshots, users, watches, type Watch } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";
import { track } from "../lib/events.js";
import { fetchPage } from "../lib/html.js";
import { deliverEmail, deliverWebhook, modeLabel } from "../lib/notify.js";
import { decideCheck, normalizeMode, pageTextFor } from "./observation.js";
import { nextCheckAt } from "./schedule.js";

export type CheckStatus = "ok" | "changed" | "error";

export type CheckResult = {
  status: CheckStatus;
  preview: string;
  hash: string | null;
  error: string | null;
  changeEventId?: string;
};

export async function runWatchCheck(
  watch: Watch,
  opts: { manual?: boolean; userId?: string | null } = {}
): Promise<CheckResult> {
  const now = new Date();
  const mode = normalizeMode(watch.monitorMode);
  const manualPatch = opts.manual ? { lastManualCheckAt: now } : {};

  try {
    if (!watch.targetText?.trim()) {
      throw new Error("Watch sem trecho alvo (targetText)");
    }

    const page = await fetchPage(watch.url);
    const pageText = pageTextFor(watch, page.html);

    const [latest] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.watchId, watch.id))
      .orderBy(desc(snapshots.fetchedAt))
      .limit(1);

    const decision = decideCheck(watch, pageText, latest ?? null);
    const { observation } = decision;

    if (decision.unchanged) {
      await db
        .update(watches)
        .set({
          lastCheckedAt: now,
          lastStatus: "ok",
          lastError: null,
          consecutiveErrors: 0,
          nextCheckAt: nextCheckAt(now, watch.intervalMinutes, 0),
          ...manualPatch,
        })
        .where(eq(watches.id, watch.id));

      return { status: "ok", preview: observation.preview, hash: observation.key, error: null };
    }

    const [newSnap] = await db
      .insert(snapshots)
      .values({
        watchId: watch.id,
        contentHash: observation.key,
        contentText: decision.snapshotPayload,
        httpStatus: page.httpStatus,
        fetchedAt: now,
      })
      .returning();

    let changeEventId: string | undefined;

    if (latest && decision.notify) {
      const diffSummary = decision.diffSummary ?? modeLabel(mode);
      const [event] = await db
        .insert(changeEvents)
        .values({
          watchId: watch.id,
          oldSnapshotId: latest.id,
          newSnapshotId: newSnap.id,
          diffSummary,
        })
        .returning();
      changeEventId = event.id;

      await track({
        name: "watch_change_detected",
        userId: opts.userId ?? watch.userId,
        props: { watchId: watch.id, url: watch.url, mode },
      });

      const notified = await notifyOwner(watch, {
        watchId: watch.id,
        url: watch.url,
        changedAt: now.toISOString(),
        title: modeLabel(mode),
        summary: diffSummary.slice(0, 500),
        preview: observation.preview,
      });

      if (notified) {
        await db
          .update(changeEvents)
          .set({ notifiedAt: new Date() })
          .where(eq(changeEvents.id, event.id));
      }
    }

    const status: CheckStatus = changeEventId ? "changed" : "ok";

    await db
      .update(watches)
      .set({
        lastCheckedAt: now,
        lastChangedAt: status === "changed" ? now : watch.lastChangedAt,
        lastStatus: status,
        lastError: null,
        consecutiveErrors: 0,
        nextCheckAt: nextCheckAt(now, watch.intervalMinutes, 0),
        ...manualPatch,
      })
      .where(eq(watches.id, watch.id));

    await pruneSnapshots(watch.id);

    return {
      status,
      preview: observation.preview,
      hash: observation.key,
      error: null,
      changeEventId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "check failed";
    const errors = (watch.consecutiveErrors ?? 0) + 1;
    await db
      .update(watches)
      .set({
        lastCheckedAt: now,
        lastStatus: "error",
        lastError: message,
        consecutiveErrors: errors,
        nextCheckAt: nextCheckAt(now, watch.intervalMinutes, errors),
        ...manualPatch,
      })
      .where(eq(watches.id, watch.id));

    return { status: "error", preview: "", hash: null, error: message };
  }
}

/** E-mail (or console, without RESEND_API_KEY) and optional webhook. */
async function notifyOwner(
  watch: Watch,
  payload: Parameters<typeof deliverEmail>[1]
): Promise<boolean> {
  let notified = false;

  if (watch.notifyEmail !== false) {
    const [owner] = await db.select().from(users).where(eq(users.id, watch.userId)).limit(1);
    if (owner?.email) {
      const email = await deliverEmail(owner.email, payload);
      if (email.ok) notified = true;
      else {
        await track({
          name: "webhook_failed",
          userId: watch.userId,
          props: { watchId: watch.id, channel: "email", error: email.error },
        });
      }
    }
  }

  if (watch.webhookUrl) {
    const hook = await deliverWebhook(watch.webhookUrl, payload);
    if (hook.ok) notified = true;
    await track({
      name: hook.ok ? "webhook_delivered" : "webhook_failed",
      userId: watch.userId,
      props: { watchId: watch.id, channel: "webhook", status: hook.status, error: hook.error },
    });
  }

  return notified;
}

async function pruneSnapshots(watchId: string): Promise<void> {
  const rows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.watchId, watchId))
    .orderBy(desc(snapshots.fetchedAt));

  const toDelete = rows.slice(LIMITS.maxSnapshotsPerWatch).map((r) => r.id);
  for (const id of toDelete) {
    await db.delete(snapshots).where(eq(snapshots.id, id));
  }
}

export async function getWatchForUser(watchId: string, userId: string): Promise<Watch | null> {
  const [row] = await db
    .select()
    .from(watches)
    .where(and(eq(watches.id, watchId), eq(watches.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function listWatches(userId: string): Promise<Watch[]> {
  return db
    .select()
    .from(watches)
    .where(eq(watches.userId, userId))
    .orderBy(asc(watches.createdAt));
}
