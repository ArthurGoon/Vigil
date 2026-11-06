import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildObservation,
  decideCheck,
  extractAround,
  pageTextFor,
  type PreviousSnapshot,
  type WatchTarget,
} from "./observation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "../../fixtures/sample.html"), "utf8");

/** Runs a sequence of page versions through decideCheck, carrying the snapshot like check.ts does. */
function simulate(watch: WatchTarget, pages: string[]) {
  let latest: PreviousSnapshot | null = null;
  return pages.map((html) => {
    const decision = decideCheck(watch, pageTextFor(watch, html), latest);
    if (!decision.unchanged) {
      latest = { contentHash: decision.observation.key, contentText: decision.snapshotPayload };
    }
    return { ...decision, notify: decision.change !== null };
  });
}

const withJobs = (...jobs: string[]) =>
  fixture.replace(
    /<ul>[\s\S]*<\/ul>/,
    `<ul>${jobs.map((j) => `<li>${j}</li>`).join("")}</ul>`
  );

describe("text_changed", () => {
  const watch: WatchTarget = {
    monitorMode: "text_changed",
    targetText: "Backend Engineer",
    cssSelector: "#job-list",
  };

  it("first check is a baseline, not an alert", () => {
    const [first] = simulate(watch, [fixture]);
    assert.equal(first.unchanged, false);
    assert.equal(first.notify, false);
  });

  it("same content twice is unchanged", () => {
    const [, second] = simulate(watch, [fixture, fixture]);
    assert.equal(second.unchanged, true);
    assert.equal(second.notify, false);
  });

  it("alerts with a diff when the selected element changes", () => {
    const [, second] = simulate(watch, [fixture, withJobs("Backend Engineer", "ML Engineer")]);
    assert.equal(second.notify, true);
    assert.match(second.change?.diff ?? "", /-.*Data Analyst/);
    assert.match(second.change?.diff ?? "", /\+.*ML Engineer/);
    assert.equal(second.change?.summary, "“Data Analyst” virou “ML Engineer”");
  });

  it("ignores changes outside the selector", () => {
    const noisy = fixture.replace("Open roles", "Open roles (updated daily)");
    const [, second] = simulate(watch, [fixture, noisy]);
    assert.equal(second.unchanged, true);
  });

  it("is case and whitespace insensitive", () => {
    const shouty = fixture.replace("Backend Engineer", "BACKEND    ENGINEER");
    const [, second] = simulate(watch, [fixture, shouty]);
    assert.equal(second.unchanged, true);
  });

  it("fails loudly when the selector disappears", () => {
    const gone = fixture.replace('id="job-list"', 'id="other"');
    assert.throws(() => pageTextFor(watch, gone), /não encontrou nada/);
  });
});

describe("text_changed without selector", () => {
  const watch: WatchTarget = {
    monitorMode: "text_changed",
    targetText: "Data Analyst",
    cssSelector: null,
  };

  it("watches a window of text around the target", () => {
    const obs = buildObservation(watch, "aaa Data Analyst bbb");
    assert.equal(obs.excerpt, "aaa Data Analyst bbb");
    assert.equal(obs.present, true);
  });

  it("alerts once when the target text itself is gone", () => {
    const gone = withJobs("Backend Engineer");
    const [, second, third] = simulate(watch, [fixture, gone, gone]);
    assert.equal(second.notify, true);
    assert.equal(second.observation.excerpt, "");
    assert.equal(second.change?.summary, "O trecho não está mais na página");
    assert.equal(third.unchanged, true);
  });

  it("finds the target even when line breaks fall elsewhere", () => {
    const obs = buildObservation(watch, "Vagas: Data\nAnalyst (remoto)");
    assert.equal(obs.present, true);
  });
});

describe("text_appears", () => {
  const watch: WatchTarget = {
    monitorMode: "text_appears",
    targetText: "ML Engineer",
    cssSelector: null,
  };

  it("alerts only on the absent → present transition", () => {
    const results = simulate(watch, [
      fixture, // baseline: absent
      fixture.replace("Open roles", "Open roles today"), // unrelated edit
      withJobs("Backend Engineer", "ML Engineer"), // appears
      withJobs("Backend Engineer", "ML Engineer", "Designer"), // still present
    ]);
    assert.deepEqual(
      results.map((r) => r.notify),
      [false, false, true, false]
    );
    assert.equal(results[1].unchanged, true);
    assert.equal(results[3].unchanged, true);
    assert.equal(results[2].change?.kind, "appeared");
    assert.equal(results[2].change?.summary, "Apareceu: “ML Engineer”");
  });

  it("does not alert when it disappears", () => {
    const results = simulate(watch, [withJobs("ML Engineer"), withJobs("Backend Engineer")]);
    assert.equal(results[1].notify, false);
    assert.equal(results[1].unchanged, false);
  });
});

describe("text_disappears", () => {
  const watch: WatchTarget = {
    monitorMode: "text_disappears",
    targetText: "Data Analyst",
    // what the extension sends: a path to the exact element
    cssSelector: "#job-list > ul > li:nth-child(2)",
  };

  it("alerts when the element (and its text) is removed", () => {
    const results = simulate(watch, [fixture, withJobs("Backend Engineer")]);
    assert.deepEqual(
      results.map((r) => r.notify),
      [false, true]
    );
    assert.equal(results[1].change?.kind, "disappeared");
  });

  it("does not alert if the text only moved on the page", () => {
    const moved = withJobs("Data Analyst"); // now first child, selector misses
    const results = simulate(watch, [fixture, moved]);
    assert.equal(results[1].notify, false);
    assert.equal(results[1].observation.present, true);
  });
});

describe("extractAround", () => {
  it("is empty for a missing target", () => {
    assert.equal(extractAround("hello world", "bye"), "");
  });

  it("ignores case and spacing of the target", () => {
    assert.equal(extractAround("preço: R$ 10,00 à vista", "r$10,00", 0), "R$ 10,00");
  });

  it("limits the window by radius", () => {
    const page = `${"a".repeat(200)}TARGET${"b".repeat(200)}`;
    assert.equal(extractAround(page, "TARGET", 3), "aaaTARGETbbb");
  });
});
