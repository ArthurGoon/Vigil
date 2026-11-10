import assert from "node:assert/strict";
import { it } from "node:test";
import { Store } from "../db/store.js";
import { Checker, AlreadyCheckingError } from "./check.js";
import { createWatch, updateWatch } from "./watches.js";
import type { FetchResult } from "../lib/html.js";

function pendingCheck() {
  const store = new Store(":memory:");
  const watch = createWatch(store, { url: "https://example.com/old", targetText: "Vagas abertas" });
  let reject!: (err: Error) => void;
  const page = new Promise<FetchResult>((_yes, no) => { reject = no; });
  const checker = new Checker(store, () => page);
  return { store, watch, checker, reject };
}

it("a failed request for the old URL cannot overwrite a retargeted watch", async () => {
  const { store, watch, checker, reject } = pendingCheck();
  try {
    const running = checker.run(watch, { manual: true });
    const updated = updateWatch(store, watch.id, { url: "https://example.com/new" });
    reject(new Error("HTTP 404 from the old URL"));
    await running;
    assert.deepEqual(store.getWatch(watch.id), updated);
    assert.equal(store.latestSnapshot(watch.id), null);
  } finally { store.close(); }
});

it("an in-flight check cannot overwrite a newly selected interval on failure", async () => {
  const { store, watch, checker, reject } = pendingCheck();
  try {
    const running = checker.run(watch);
    updateWatch(store, watch.id, { intervalMinutes: 120 });
    reject(new Error("network failure"));
    await running;
    const saved = store.getWatch(watch.id)!;
    assert.equal(saved.lastStatus, "error");
    assert.ok(Date.parse(saved.nextCheckAt) > Date.now() + 119 * 60_000);
  } finally { store.close(); }
});

it("only one check per watch can run while a request is pending", async () => {
  const { store, watch, checker, reject } = pendingCheck();
  try {
    const running = checker.run(watch);
    await assert.rejects(checker.run(watch), AlreadyCheckingError);
    assert.deepEqual(checker.busyIds(), [watch.id]);
    reject(new Error("network failure"));
    await running;
    assert.equal(checker.isBusy(watch.id), false);
  } finally { store.close(); }
});
