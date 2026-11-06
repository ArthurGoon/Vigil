import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS } from "../config.js";
import { backoffMinutes, manualCheckWaitSeconds, nextCheckAt } from "./schedule.js";

const now = new Date("2026-01-01T12:00:00Z");
const minutesFromNow = (d: Date) => (d.getTime() - now.getTime()) / 60_000;

describe("nextCheckAt", () => {
  it("uses the watch interval after a successful check", () => {
    assert.equal(minutesFromNow(nextCheckAt(now, 60, 0)), 60);
  });

  it("never schedules below the minimum interval", () => {
    assert.equal(minutesFromNow(nextCheckAt(now, 1, 0)), LIMITS.minIntervalMinutes);
  });

  it("backs off after errors", () => {
    assert.equal(minutesFromNow(nextCheckAt(now, 60, 3)), 240);
  });
});

describe("backoffMinutes", () => {
  it("doubles per consecutive error starting at the interval", () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => backoffMinutes(60, n)),
      [60, 120, 240, 480]
    );
  });

  it("is capped at 24h", () => {
    assert.equal(backoffMinutes(60, 50), 24 * 60);
  });

  it("keeps intervals longer than the cap", () => {
    assert.equal(backoffMinutes(48 * 60, 5), 48 * 60);
  });
});

describe("manualCheckWaitSeconds", () => {
  it("allows the first manual check", () => {
    assert.equal(manualCheckWaitSeconds(null, now, 30), 0);
  });

  it("returns the remaining cooldown", () => {
    const tenSecondsAgo = new Date(now.getTime() - 10_000);
    assert.equal(manualCheckWaitSeconds(tenSecondsAgo, now, 30), 20);
  });

  it("allows again after the cooldown", () => {
    const longAgo = new Date(now.getTime() - 31_000).toISOString();
    assert.equal(manualCheckWaitSeconds(longAgo, now, 30), 0);
  });

  it("can be disabled with a zero cooldown", () => {
    assert.equal(manualCheckWaitSeconds(now, now, 0), 0);
  });
});
