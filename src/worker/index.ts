import "dotenv/config";
import { lt } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import { events, type Watch } from "../db/schema.js";
import { runWatchCheck } from "../domain/check.js";
import { LIMITS } from "../lib/config.js";

async function claimDueWatches(limit: number): Promise<Watch[]> {
  const rows = await sql`
    UPDATE watches
    SET next_check_at = NOW() + INTERVAL '1 minute'
    WHERE id IN (
      SELECT id FROM watches
      WHERE is_active = true
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `;
  return rows as unknown as Watch[];
}

async function purgeOldEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - LIMITS.eventRetentionDays * 24 * 60 * 60_000);
  await db.delete(events).where(lt(events.occurredAt, cutoff));
}

async function processBatch(): Promise<void> {
  const due = await claimDueWatches(LIMITS.workerConcurrency);
  if (!due.length) return;

  console.log(`[worker] claimed ${due.length} watch(es)`);

  await Promise.all(
    due.map(async (watch) => {
      // Re-map snake_case from raw SQL to camel if needed
      const normalized = normalizeWatch(watch);
      const result = await runWatchCheck(normalized);
      console.log(`[worker] ${normalized.id} → ${result.status}${result.error ? ` (${result.error})` : ""}`);
    })
  );
}

function normalizeWatch(row: Record<string, unknown> | Watch): Watch {
  if ("userId" in row && (row as Watch).userId && "monitorMode" in row) {
    return row as Watch;
  }
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    userId: String(r.user_id ?? (r as Watch).userId),
    url: String(r.url),
    cssSelector: (r.css_selector as string) ?? (r as Watch).cssSelector ?? null,
    monitorMode: String(r.monitor_mode ?? (r as Watch).monitorMode ?? "text_changed"),
    targetText: (r.target_text as string) ?? (r as Watch).targetText ?? null,
    intervalMinutes: Number(r.interval_minutes ?? (r as Watch).intervalMinutes ?? 360),
    webhookUrl: (r.webhook_url as string) ?? (r as Watch).webhookUrl ?? null,
    notifyEmail:
      r.notify_email === undefined
        ? ((r as Watch).notifyEmail ?? true)
        : Boolean(r.notify_email),
    isActive: r.is_active === undefined ? Boolean((r as Watch).isActive ?? true) : Boolean(r.is_active),
    lastCheckedAt: (r.last_checked_at as Date) ?? (r as Watch).lastCheckedAt ?? null,
    lastChangedAt: (r.last_changed_at as Date) ?? (r as Watch).lastChangedAt ?? null,
    lastManualCheckAt: (r.last_manual_check_at as Date) ?? (r as Watch).lastManualCheckAt ?? null,
    lastStatus: String(r.last_status ?? (r as Watch).lastStatus ?? "ok"),
    lastError: (r.last_error as string) ?? (r as Watch).lastError ?? null,
    consecutiveErrors: Number(r.consecutive_errors ?? (r as Watch).consecutiveErrors ?? 0),
    nextCheckAt: new Date(
      (r.next_check_at as string | Date) ?? (r as Watch).nextCheckAt ?? Date.now()
    ),
    createdAt: new Date((r.created_at as string | Date) ?? (r as Watch).createdAt ?? Date.now()),
  };
}

let ticks = 0;

async function loop() {
  ticks += 1;
  try {
    await processBatch();
    if (ticks % 120 === 0) {
      await purgeOldEvents();
      console.log("[worker] purged events older than retention window");
    }
  } catch (err) {
    console.error("[worker] batch error", err);
  } finally {
    setTimeout(loop, LIMITS.workerPollMs);
  }
}

console.log(
  `Vigil worker starting (poll=${LIMITS.workerPollMs}ms, concurrency=${LIMITS.workerConcurrency})`
);
loop();
