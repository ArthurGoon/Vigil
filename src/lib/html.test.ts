import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { extractFromHtml, foldText, hashText, normalizeText } from "./html.js";

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
    assert.throws(() => extractFromHtml(fixture, "#missing"), /não encontrou nada/);
  });
});

describe("foldText", () => {
  it("does not care where the line breaks are", () => {
    assert.equal(foldText("Data\n  Analyst"), foldText("data analyst"));
  });
});

describe("extractFromHtml with a selector", () => {
  it("can select inside header and nav, like the live page", () => {
    const html = "<body><header><span id='badge'>3 novas</span></header><main>x</main></body>";
    assert.equal(extractFromHtml(html, "#badge"), "3 novas");
  });

  it("uses the alt text of a selected image", () => {
    const html = "<body><a id='banner'><img alt='Promoção de inverno' src='/b.png'></a></body>";
    assert.equal(extractFromHtml(html, "#banner"), "Promoção de inverno");
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
