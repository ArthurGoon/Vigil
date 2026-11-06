import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeHtml } from "./probe.js";

const html = `<!doctype html><html><head><title>Vagas | ACME</title></head><body>
  <header><nav>Menu</nav></header>
  <main>
    <ul class="jobs">
      <li class="job"><span>Backend Engineer</span></li>
      <li class="job"><span>Data Analyst</span></li>
    </ul>
    <div id="price">R$<b>365</b>,90</div>
  </main>
</body></html>`;

describe("probeHtml", () => {
  it("picks the first selector that matches one element with the text", () => {
    const result = probeHtml(html, ["#gone", "li.job", "ul.jobs > li:nth-of-type(2)"], "Data Analyst");
    assert.equal(result.title, "Vagas | ACME");
    assert.equal(result.selector, "ul.jobs > li:nth-of-type(2)");
    assert.equal(result.selectorText, "Data Analyst");
    assert.equal(result.textFound, true);
    assert.deepEqual(
      result.candidates.map((c) => c.matches),
      [0, 2, 1]
    );
  });

  it("returns no selector when none holds the text, but still finds the text", () => {
    const result = probeHtml(html, ["ul.jobs > li:nth-of-type(1)"], "Data Analyst");
    assert.equal(result.selector, null);
    assert.equal(result.textFound, true);
  });

  it("matches text split by inline tags, like the browser shows it", () => {
    const result = probeHtml(html, ["#price"], "R$ 365,90");
    assert.equal(result.selector, "#price");
    assert.equal(result.textFound, true);
  });

  it("reports text the server cannot see (rendered by JavaScript)", () => {
    const result = probeHtml(html, [], "Carregado via JS");
    assert.equal(result.textFound, false);
  });

  it("survives selectors cheerio cannot parse", () => {
    const result = probeHtml(html, ["li:has-text(Data)", "#price"], "365");
    assert.equal(result.selector, "#price");
  });
});
