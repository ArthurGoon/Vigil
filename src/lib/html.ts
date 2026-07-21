import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { LIMITS } from "./config.js";

export type ExtractResult = {
  text: string;
  hash: string;
  httpStatus: number;
  bytes: number;
};

export function normalizeText(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function extractFromHtml(html: string, cssSelector?: string | null): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, nav, footer, header").remove();

  let raw = "";
  if (cssSelector) {
    const nodes = $(cssSelector);
    if (nodes.length === 0) {
      throw new Error(`CSS selector matched nothing: ${cssSelector}`);
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

export async function fetchAndExtract(
  url: string,
  cssSelector?: string | null
): Promise<ExtractResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VigilBot/0.1 (+https://github.com/vigil; change-monitor)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > LIMITS.maxHtmlBytes) {
      throw new Error(`HTML exceeds ${LIMITS.maxHtmlBytes} bytes`);
    }

    const html = buf.toString("utf8");
    const text = extractFromHtml(html, cssSelector);
    return {
      text,
      hash: hashText(text),
      httpStatus: response.status,
      bytes: buf.byteLength,
    };
  } finally {
    clearTimeout(timer);
  }
}
