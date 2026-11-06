import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffRows, shortSummary, summarizeDiff } from "./diff.js";

describe("summarizeDiff", () => {
  it("keeps only the hunks, without file headers or newline noise", () => {
    const summary = summarizeDiff("Backend Engineer\nData Analyst", "Backend Engineer\nML Engineer");
    assert.match(summary, /^@@/);
    assert.match(summary, /^-Data Analyst$/m);
    assert.match(summary, /^\+ML Engineer$/m);
    assert.doesNotMatch(summary, /No newline|\+\+\+ depois/);
  });

  it("truncates long diffs", () => {
    const summary = summarizeDiff("a\n", `${"b".repeat(5000)}\n`, 100);
    assert.match(summary, /diff cortado/);
  });
});

describe("diffRows", () => {
  it("pairs the changed line and marks only the changed words", () => {
    const rows = diffRows("Preço\nR$ 365,90 à vista", "Preço\nR$ 329,90 à vista");
    assert.deepEqual(rows[0], { type: "same", text: "Preço" });
    const change = rows[1];
    assert.equal(change.type, "change");
    if (change.type !== "change") return;
    assert.deepEqual(
      change.before.filter(([marked]) => marked).map(([, t]) => t),
      ["365"]
    );
    assert.deepEqual(
      change.after.filter(([marked]) => marked).map(([, t]) => t),
      ["329"]
    );
  });

  it("collapses long unchanged runs around a change", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `linha ${i}`);
    const after = [...lines];
    after[15] = "linha quinze";
    const rows = diffRows(lines.join("\n"), after.join("\n"));
    const skips = rows.filter((r) => r.type === "skip");
    assert.equal(skips.length, 2);
    assert.equal(rows.filter((r) => r.type === "change").length, 1);
    assert.ok(rows.length < 12);
  });

  it("handles a side that became empty", () => {
    const rows = diffRows("algo", "");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "change");
  });
});

describe("shortSummary", () => {
  it("says what left and what came in", () => {
    assert.equal(shortSummary("Vagas: Data Analyst", "Vagas: ML Engineer"), "“Data Analyst” virou “ML Engineer”");
  });

  it("handles pure additions and removals", () => {
    assert.equal(shortSummary("a b", "a b c"), "Entrou: “c”");
    assert.equal(shortSummary("a b c", "a b"), "Saiu: “c”");
  });
});
