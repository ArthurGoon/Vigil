import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { LIMITS } from "./config.js";

export type FetchResult = {
  html: string;
  httpStatus: number;
  bytes: number;
};

export class SelectorMissError extends Error {
  constructor(selector: string) {
    super(`CSS selector matched nothing: ${selector}`);
    this.name = "SelectorMissError";
  }
}

/** Trims every line and drops blank lines, so indentation and markup nesting never count as a change. */
export function normalizeText(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const BLOCK_TAGS =
  "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, form, h1, h2, h3, h4, h5, h6, li, main, ol, p, pre, section, table, tr, td, th, ul";

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function extractFromHtml(html: string, cssSelector?: string | null): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, nav, footer, header").remove();
  // Minified HTML has no whitespace between blocks: "<li>A</li><li>B</li>" would read "AB".
  $("br").replaceWith("\n");
  $(BLOCK_TAGS).after("\n");

  let raw = "";
  if (cssSelector) {
    const nodes = $(cssSelector);
    if (nodes.length === 0) {
      throw new SelectorMissError(cssSelector);
    }
    raw = nodes
      .map((_, el) => {
        const node = $(el);
        if (node.is("img")) {
          const alt = node.attr("alt") || "";
          const src = node.attr("src") || node.attr("data-src") || "";
          return alt || (src ? `IMG:${src}` : "");
        }
        const text = node.text();
        if (text.trim()) return text;
        const nestedImg = node.find("img").first();
        if (nestedImg.length) {
          const alt = nestedImg.attr("alt") || "";
          const src = nestedImg.attr("src") || nestedImg.attr("data-src") || "";
          return alt || (src ? `IMG:${src}` : "");
        }
        return text;
      })
      .get()
      .join("\n");
  } else {
    raw = $("body").text() || $.root().text();
  }

  const normalized = normalizeText(raw);
  if (!normalized) {
    throw new Error("Extracted content is empty (page may be JS-only or selector wrong)");
  }
  return normalized.slice(0, LIMITS.maxTextChars);
}

export async function fetchPage(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VigilBot/0.1 (+https://github.com/ArthurGoon/Vigil)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    // A 404/500 page would be compared as if it were the real content.
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ao buscar a página`);
    }

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > LIMITS.maxHtmlBytes) {
      throw new Error(`HTML exceeds ${LIMITS.maxHtmlBytes} bytes`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > LIMITS.maxHtmlBytes) {
      throw new Error(`HTML exceeds ${LIMITS.maxHtmlBytes} bytes`);
    }

    return {
      html: buf.toString("utf8"),
      httpStatus: response.status,
      bytes: buf.byteLength,
    };
  } finally {
    clearTimeout(timer);
  }
}
