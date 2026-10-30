import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { summarizeDiff } from "../lib/diff.js";
import { extractFromHtml, hashText, normalizeText } from "../lib/html.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "../../fixtures/sample.html"), "utf8");

describe("normalizeText", () => {
  it("collapses whitespace", () => {
    assert.equal(normalizeText("  hello   world  "), "hello world");
  });
});

describe("extractFromHtml", () => {
  it("extracts full body text without scripts", () => {
    const text = extractFromHtml(fixture);
    assert.match(text, /Open roles/i);
    assert.doesNotMatch(text, /should not appear/i);
  });

  it("extracts by CSS selector", () => {
    const text = extractFromHtml(fixture, "#job-list");
    assert.match(text, /Backend Engineer/);
    assert.doesNotMatch(text, /Ignore this nav/i);
  });

  it("throws when selector matches nothing", () => {
    assert.throws(() => extractFromHtml(fixture, "#missing"), /matched nothing/);
  });
});

describe("hashText", () => {
  it("is stable for same content", () => {
    const a = hashText("hello");
    const b = hashText("hello");
    assert.equal(a, b);
    assert.notEqual(hashText("hello"), hashText("hello!"));
  });
});

describe("summarizeDiff", () => {
  it("returns truncated patch for changes", () => {
    const summary = summarizeDiff("line1\n", "line1\nline2\n");
    assert.match(summary, /line2/);
  });
});

describe("summarizeDiff format", () => {
  it("keeps only the hunks, without file headers or newline noise", () => {
    const summary = summarizeDiff("Backend Engineer\nData Analyst", "Backend Engineer\nML Engineer");
    assert.match(summary, /^@@/);
    assert.match(summary, /^-Data Analyst$/m);
    assert.match(summary, /^\+ML Engineer$/m);
    assert.doesNotMatch(summary, /No newline|\+\+\+ after/);
  });

  it("truncates long diffs", () => {
    const summary = summarizeDiff("a\n", `${"b".repeat(5000)}\n`, 100);
    assert.match(summary, /diff truncated/);
  });
});

describe("extractFromHtml block separation", () => {
  it("keeps adjacent blocks apart in minified HTML", () => {
    const text = extractFromHtml("<body><ul><li>ML Engineer</li><li>Designer</li></ul><p>a<br>b</p></body>");
    assert.equal(text, "ML Engineer\nDesigner\na\nb");
  });

  it("ignores indentation-only differences", () => {
    const a = extractFromHtml("<body><div>\n      Price: 10\n</div></body>");
    const b = extractFromHtml("<body><div>Price:   10</div></body>");
    assert.equal(a, b);
  });
});
