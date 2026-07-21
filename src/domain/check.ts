import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { changeEvents, snapshots, users, watches, type Watch } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";
import { summarizeDiff } from "../lib/diff.js";
import { track } from "../lib/events.js";
import { fetchAndExtract, hashText, normalizeText } from "../lib/html.js";
import { deliverEmail, deliverWebhook, modeLabel } from "../lib/notify.js";

export type CheckStatus = "ok" | "changed" | "error";

export type CheckResult = {
  status: CheckStatus;
  preview: string;
  hash: string | null;
  error: string | null;
  changeEventId?: string;
  observation?: string;
};

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function backoffMinutes(consecutiveErrors: number): number {
  const base = Math.min(
    24 * 60,
    LIMITS.minIntervalMinutes * Math.pow(2, Math.max(0, consecutiveErrors))
  );
  return Math.max(LIMITS.minIntervalMinutes, base);
}

type Observation = {
  key: string;
  preview: string;
  present: boolean;
  excerpt: string;
};

function buildObservation(watch: Watch, pageText: string): Observation {
  const target = normalizeText(watch.targetText || "");
  const page = normalizeText(pageText);
  const present = target ? page.toLowerCase().includes(target.toLowerCase()) : false;
  const mode = watch.monitorMode || "text_changed";

  if (mode === "text_appears" || mode === "text_disappears") {
    return {
      key: hashText(`${mode}:${present ? "1" : "0"}:${target.toLowerCase()}`),
      preview: present
        ? `Encontrado: “${target.slice(0, 180)}”`
        : `Não encontrado: “${target.slice(0, 180)}”`,
      present,
      excerpt: present ? target : "",
    };
  }

  // text_changed: monitor the selected excerpt (or selector text already in pageText)
  const excerpt = watch.cssSelector
    ? page.slice(0, LIMITS.maxTextChars)
    : extractAround(page, target);
  return {
    key: hashText(`changed:${excerpt.toLowerCase()}`),
    preview: excerpt.slice(0, 400) || `Alvo: “${target.slice(0, 180)}”`,
    present,
    excerpt,
  };
}

function extractAround(page: string, target: string): string {
  if (!target) return page.slice(0, 500);
  const idx = page.toLowerCase().indexOf(target.toLowerCase());
  if (idx < 0) return `MISSING:${target}`;
  const start = Math.max(0, idx - 80);
  const end = Math.min(page.length, idx + target.length + 80);
  return page.slice(start, end);
}

function shouldNotify(
  mode: string,
  hadLatest: boolean,
  prevPresent: boolean | null,
  next: Observation
): boolean {
  if (!hadLatest) return false;
  if (mode === "text_appears") return !prevPresent && next.present;
  if (mode === "text_disappears") return Boolean(prevPresent) && !next.present;
  return true; // text_changed when hash differs (caller already checked)
}

function parsePrevPresent(contentText: string): boolean | null {
  try {
    const parsed = JSON.parse(contentText) as { present?: boolean };
    if (typeof parsed.present === "boolean") return parsed.present;
  } catch {
    /* legacy plain text */
  }
  return null;
}

export async function runWatchCheck(
  watch: Watch,
  opts: { manual?: boolean; userId?: string | null } = {}
): Promise<CheckResult> {
  const now = new Date();
  const mode = watch.monitorMode || "text_changed";

  try {
    if (!watch.targetText?.trim()) {
      throw new Error("Watch sem trecho alvo (targetText)");
    }

    const extracted = await fetchAndExtract(watch.url, watch.cssSelector);
    const observation = buildObservation(watch, extracted.text);
    const snapshotPayload = JSON.stringify({
      mode,
      present: observation.present,
      excerpt: observation.excerpt,
      targetText: watch.targetText,
    });

    const [latest] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.watchId, watch.id))
      .orderBy(desc(snapshots.fetchedAt))
      .limit(1);

    const unchanged = latest && latest.contentHash === observation.key;

    if (unchanged) {
      await db
        .update(watches)
        .set({
          lastCheckedAt: now,
          lastStatus: "ok",
          lastError: null,
          consecutiveErrors: 0,
          nextCheckAt: addMinutes(now, watch.intervalMinutes),
          ...(opts.manual ? { lastManualCheckAt: now } : {}),
        })
        .where(eq(watches.id, watch.id));

      return {
        status: "ok",
        preview: observation.preview,
        hash: observation.key,
        error: null,
        observation: observation.preview,
      };
    }

    const prevPresent = latest ? parsePrevPresent(latest.contentText) : null;
    const notify = shouldNotify(mode, Boolean(latest), prevPresent, observation);

    // For appears/disappears, hash change might be present toggle — if not a notify event, still save?
    // If mode is appears and still absent→absent shouldn't happen (same key). Good.

    const [newSnap] = await db
      .insert(snapshots)
      .values({
        watchId: watch.id,
        contentHash: observation.key,
        contentText: snapshotPayload,
        httpStatus: extracted.httpStatus,
        fetchedAt: now,
      })
      .returning();

    let changeEventId: string | undefined;

    if (latest && notify) {
      const diffSummary =
        mode === "text_changed"
          ? summarizeDiff(
              String(JSON.parse(latest.contentText)?.excerpt ?? latest.contentText),
              observation.excerpt
            )
          : `${modeLabel(mode)}: “${watch.targetText}”`;

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

      const [owner] = await db.select().from(users).where(eq(users.id, watch.userId)).limit(1);
      const payload = {
        watchId: watch.id,
        url: watch.url,
        changedAt: now.toISOString(),
        title: modeLabel(mode),
        summary: diffSummary.slice(0, 500),
        preview: observation.preview,
      };

      let notified = false;
      if (watch.notifyEmail !== false && owner?.email) {
        const email = await deliverEmail(owner.email, payload);
        if (email.ok) notified = true;
        else {
          await track({
            name: "webhook_failed",
            userId: owner.id,
            props: { watchId: watch.id, channel: "email", error: email.error },
          });
        }
      }

      if (watch.webhookUrl) {
        const hook = await deliverWebhook(watch.webhookUrl, payload);
        if (hook.ok) {
          notified = true;
          await track({
            name: "webhook_delivered",
            userId: opts.userId ?? watch.userId,
            props: { watchId: watch.id, status: hook.status },
          });
        } else {
          await track({
            name: "webhook_failed",
            userId: opts.userId ?? watch.userId,
            props: { watchId: watch.id, error: hook.error },
          });
        }
      }

      if (notified) {
        await db
          .update(changeEvents)
          .set({ notifiedAt: new Date() })
          .where(eq(changeEvents.id, event.id));
        await track({
          name: "webhook_delivered",
          userId: opts.userId ?? watch.userId,
          props: { watchId: watch.id, channel: "notify" },
        });
      }
    }

    const status: CheckStatus = latest && notify ? "changed" : "ok";

    await db
      .update(watches)
      .set({
        lastCheckedAt: now,
        lastChangedAt: status === "changed" ? now : watch.lastChangedAt,
        lastStatus: status,
        lastError: null,
        consecutiveErrors: 0,
        nextCheckAt: addMinutes(now, watch.intervalMinutes),
        ...(opts.manual ? { lastManualCheckAt: now } : {}),
      })
      .where(eq(watches.id, watch.id));

    await pruneSnapshots(watch.id);

    return {
      status,
      preview: observation.preview,
      hash: observation.key,
      error: null,
      changeEventId,
      observation: observation.preview,
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
        nextCheckAt: addMinutes(now, backoffMinutes(errors)),
        ...(opts.manual ? { lastManualCheckAt: now } : {}),
      })
      .where(eq(watches.id, watch.id));

    return { status: "error", preview: "", hash: null, error: message };
  }
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
