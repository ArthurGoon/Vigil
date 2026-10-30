import "dotenv/config";
import { lt } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import { events } from "../db/schema.js";
import { runWatchCheck } from "../domain/check.js";
import { LIMITS } from "../lib/config.js";
import { claimDueWatches } from "./claim.js";

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
      const result = await runWatchCheck(watch);
      console.log(`[worker] ${watch.id} → ${result.status}${result.error ? ` (${result.error})` : ""}`);
    })
  );
}

let ticks = 0;
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let running: Promise<void> = Promise.resolve();

async function tick() {
  ticks += 1;
  try {
    await processBatch();
    if (ticks % 120 === 0) {
      await purgeOldEvents();
      console.log("[worker] purged events older than retention window");
    }
  } catch (err) {
    console.error("[worker] batch error", err);
  }
}

function loop() {
  if (stopping) return;
  running = tick().finally(() => {
    if (!stopping) timer = setTimeout(loop, LIMITS.workerPollMs);
  });
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  console.log(`[worker] ${signal} received, finishing current batch…`);
  await running;
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(
  `Vigil worker starting (poll=${LIMITS.workerPollMs}ms, concurrency=${LIMITS.workerConcurrency})`
);
loop();
