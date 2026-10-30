import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * Integration test against a real Postgres (SKIP LOCKED cannot be faked).
 * Runs only when TEST_DATABASE_URL points to a disposable, migrated database:
 *   TEST_DATABASE_URL=postgres://vigil:vigil@localhost:5432/vigil_test npm test
 */
const url = process.env.TEST_DATABASE_URL;

describe("claimDueWatches (Postgres)", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let mod: {
    claimDueWatches: typeof import("./claim.js").claimDueWatches;
    db: typeof import("../db/client.js").db;
    sql: typeof import("../db/client.js").sql;
    schema: typeof import("../db/schema.js");
  };
  let userId: string;

  before(async () => {
    // The test wipes the watches table: refuse anything that is not clearly a test DB.
    assert.match(new URL(url!).pathname, /test/, "TEST_DATABASE_URL must point to a *test* database");
    process.env.DATABASE_URL = url;
    const client = await import("../db/client.js");
    mod = {
      claimDueWatches: (await import("./claim.js")).claimDueWatches,
      db: client.db,
      sql: client.sql,
      schema: await import("../db/schema.js"),
    };
    await mod.sql`DELETE FROM watches`;
    const [user] = await mod.db
      .insert(mod.schema.users)
      .values({ email: `claim-${Date.now()}@test.local` })
      .returning();
    userId = user.id;
  });

  after(async () => {
    if (!mod) return;
    await mod.sql`DELETE FROM users WHERE id = ${userId}`;
    await mod.sql.end({ timeout: 5 });
  });

  it("concurrent claims never return the same watch", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    await mod.db.insert(mod.schema.watches).values([
      ...Array.from({ length: 6 }, (_, i) => ({
        userId,
        url: `https://example.com/${i}`,
        targetText: `due ${i}`,
        nextCheckAt: past,
      })),
      { userId, url: "https://example.com/later", targetText: "later", nextCheckAt: future },
      { userId, url: "https://example.com/off", targetText: "off", nextCheckAt: past, isActive: false },
    ]);

    const batches = await Promise.all([
      mod.claimDueWatches(4),
      mod.claimDueWatches(4),
      mod.claimDueWatches(4),
    ]);
    const ids = batches.flat().map((w) => w.id);

    assert.equal(ids.length, 6, "only the 6 due + active watches are claimed");
    assert.equal(new Set(ids).size, ids.length, "no watch claimed twice");
    for (const w of batches.flat()) {
      assert.ok(w.nextCheckAt.getTime() > Date.now(), "claim pushes next_check_at forward (lease)");
    }

    const again = await mod.claimDueWatches(10);
    assert.equal(again.length, 0, "leased watches are not due again");
  });
});
