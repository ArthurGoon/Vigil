import { inArray } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import { watches, type Watch } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";

/**
 * Claims up to `limit` due watches. FOR UPDATE SKIP LOCKED lets several
 * workers run this at the same time without picking the same rows, and
 * pushing next_check_at forward acts as a lease: if the worker dies mid-check
 * the watch becomes due again after the lease instead of being lost.
 * runWatchCheck then sets the real next_check_at.
 */
export async function claimDueWatches(limit: number): Promise<Watch[]> {
  const claimed = await sql<{ id: string }[]>`
    UPDATE watches
    SET next_check_at = NOW() + make_interval(secs => ${LIMITS.claimLeaseSeconds})
    WHERE id IN (
      SELECT id FROM watches
      WHERE is_active = true
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id
  `;
  if (!claimed.length) return [];
  return db
    .select()
    .from(watches)
    .where(inArray(watches.id, claimed.map((r) => r.id)));
}
