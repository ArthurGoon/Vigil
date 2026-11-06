import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Store, type NewWatch } from "./store.js";

const base: NewWatch = {
  label: "Vagas",
  url: "http://localhost:9/vagas",
  cssSelector: null,
  monitorMode: "text_changed",
  targetText: "Data Analyst",
  intervalMinutes: 60,
  webhookUrl: null,
  isActive: true,
};

const t0 = new Date("2026-01-01T12:00:00Z");
const later = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe("Store.claimDue", () => {
  it("never hands the same watch to two claims", () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 5; i++) store.insertWatch({ ...base, label: `w${i}` }, t0);

    const first = store.claimDue(3, 120, later(1));
    const second = store.claimDue(3, 120, later(1));
    const third = store.claimDue(3, 120, later(1));

    assert.equal(first.length, 3);
    assert.equal(second.length, 2);
    assert.equal(third.length, 0);
    const ids = [...first, ...second].map((w) => w.id);
    assert.equal(new Set(ids).size, 5);
  });

  it("gives a claimed watch back when the lease runs out", () => {
    const store = new Store(":memory:");
    store.insertWatch(base, t0);
    assert.equal(store.claimDue(1, 120, later(1)).length, 1);
    assert.equal(store.claimDue(1, 120, later(60)).length, 0);
    assert.equal(store.claimDue(1, 120, later(122)).length, 1);
  });

  it("skips paused watches and the ones already running", () => {
    const store = new Store(":memory:");
    const paused = store.insertWatch({ ...base, isActive: false }, t0);
    const busy = store.insertWatch(base, t0);
    const free = store.insertWatch(base, t0);
    const claimed = store.claimDue(5, 120, later(1), [busy.id]);
    assert.deepEqual(claimed.map((w) => w.id), [free.id]);
    assert.ok(!claimed.some((w) => w.id === paused.id));
  });

  it("takes the most overdue first", () => {
    const store = new Store(":memory:");
    const recent = store.insertWatch(base, later(30));
    const old = store.insertWatch(base, t0);
    assert.deepEqual(store.claimDue(1, 120, later(60)).map((w) => w.id), [old.id]);
    assert.deepEqual(store.claimDue(1, 120, later(60)).map((w) => w.id), [recent.id]);
  });
});

describe("Store changes", () => {
  it("tracks unseen changes per watch and as a feed", () => {
    const store = new Store(":memory:");
    const a = store.insertWatch(base, t0);
    const b = store.insertWatch({ ...base, label: "Outro" }, t0);
    const change = (watchId: number) =>
      store.insertChange({
        watchId,
        kind: "changed",
        beforeText: "a",
        afterText: "b",
        summary: "“a” virou “b”",
        diff: "-a\n+b",
        createdAt: t0.toISOString(),
      });
    const c1 = change(a.id);
    change(b.id);
    change(a.id);

    assert.equal(store.unseenCount(), 3);
    assert.deepEqual(
      store.listChanges({ afterId: c1.id }).map((c) => c.watchLabel),
      ["Vagas", "Outro"]
    );
    assert.equal(store.markSeen(a.id), 2);
    const list = store.listWatches();
    assert.equal(list.find((w) => w.id === a.id)?.unseenChanges, 0);
    assert.equal(list.find((w) => w.id === b.id)?.unseenChanges, 1);
    assert.equal(store.latestChangeId(), 3);
  });

  it("deletes snapshots and changes with the watch", () => {
    const store = new Store(":memory:");
    const w = store.insertWatch(base, t0);
    store.insertSnapshot({ watchId: w.id, contentHash: "h", contentText: "{}", httpStatus: 200, fetchedAt: t0.toISOString() });
    assert.ok(store.deleteWatch(w.id));
    assert.equal(store.latestSnapshot(w.id), null);
  });

  it("prunes old rows but keeps the newest", () => {
    const store = new Store(":memory:");
    const w = store.insertWatch(base, t0);
    for (let i = 0; i < 5; i++) {
      store.insertSnapshot({ watchId: w.id, contentHash: `h${i}`, contentText: "{}", httpStatus: 200, fetchedAt: t0.toISOString() });
    }
    store.prune("snapshots", w.id, 2);
    assert.equal(store.latestSnapshot(w.id)?.contentHash, "h4");
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    assert.equal(count.n, 2);
  });
});
