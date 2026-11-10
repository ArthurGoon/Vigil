import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { Agent, fetch } from "undici";
import { LIMITS } from "../config.js";

export type FetchResult = {
  html: string;
  httpStatus: number;
  finalUrl: string;
};

export class SelectorMissError extends Error {
  constructor(selector: string) {
    super(`O seletor não encontrou nada na página: ${selector}`);
    this.name = "SelectorMissError";
  }
}

/** Trims every line and drops blank lines, so indentation and markup nesting never count as a change. */
export function normalizeText(input: string): string {
  return input
    .replace(/ /g, " ")
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Comparison form of a text: one line, single spaces, lower case. The browser
 * (innerText) and cheerio break lines in different places, so matching and
 * hashing must not depend on where the line breaks fall.
 */
export function foldText(input: string): string {
  return normalizeText(input).replace(/\s+/g, " ").toLowerCase();
}

const BLOCK_TAGS =
  "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, form, h1, h2, h3, h4, h5, h6, li, main, ol, p, pre, section, table, tr, td, th, ul";

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type Root = ReturnType<typeof cheerio.load>;

/** Loads the HTML with the same cleanup used everywhere: no scripts or chrome, blocks separated by newlines. */
export function loadClean(html: string, opts: { keepChrome?: boolean } = {}): Root {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, svg, iframe").remove();
  if (!opts.keepChrome) $("nav, footer, header").remove();
  // Minified HTML has no whitespace between blocks: "<li>A</li><li>B</li>" would read "AB".
  $("br").replaceWith("\n");
  $(BLOCK_TAGS).after("\n");
  separateAdjacentWords($);
  return $;
}

/**
 * "<span>Pleno</span><span>Remoto</span>" is laid out apart by CSS (flex,
 * margins) but reads "PlenoRemoto" as text. Add a space where two sibling
 * elements touch letter to letter; "1.899" + ",90" stays glued.
 */
function separateAdjacentWords($: Root): void {
  $("body *").each((_, el) => {
    const next = (el as { next?: { type?: string } | null }).next;
    if (!next || next.type !== "tag") return;
    const a = $(el).text();
    const b = $(next as Parameters<Root>[0]).text();
    if (/[\p{L}\p{N}]$/u.test(a) && /^[\p{L}\p{N}]/u.test(b)) $(el).after(" ");
  });
}

function imageText($: Root, el: Parameters<Root>[0]): string {
  const node = $(el);
  const img = node.is("img") ? node : node.find("img").first();
  if (!img.length) return "";
  const alt = img.attr("alt") || "";
  const src = img.attr("src") || img.attr("data-src") || "";
  return alt || (src ? `IMG:${src}` : "");
}

/** Text of the elements matched by a selector, or null if it matches nothing. */
export function selectText($: Root, cssSelector: string): { text: string; count: number } | null {
  let nodes;
  try {
    nodes = $(cssSelector);
  } catch {
    return null; // selector cheerio cannot parse
  }
  if (nodes.length === 0) return null;
  const raw = nodes
    .map((_, el) => {
      const text = $(el).text();
      return text.trim() ? text : imageText($, el);
    })
    .get()
    .join("\n");
  return { text: normalizeText(raw), count: nodes.length };
}

/**
 * Text the checks compare. With a selector, only that element. Without one,
 * the whole body; header, nav and footer are dropped unless `keepChrome`
 * (presence checks keep them, a text can appear anywhere).
 */
export function extractFromHtml(
  html: string,
  cssSelector?: string | null,
  opts: { keepChrome?: boolean } = {}
): string {
  let text: string;
  if (cssSelector) {
    // The selector was taken from the live page, which still has its header and nav.
    const found = selectText(loadClean(html, { keepChrome: true }), cssSelector);
    if (!found) throw new SelectorMissError(cssSelector);
    text = found.text;
  } else {
    const $ = loadClean(html, opts);
    text = normalizeText($("body").text() || $.root().text());
  }
  if (!text) {
    throw new Error("A página veio sem texto nesse ponto (pode depender de JavaScript)");
  }
  return text.slice(0, LIMITS.maxTextChars);
}

export function pageTitle(html: string): string {
  const $ = cheerio.load(html);
  const title = $("meta[property='og:title']").attr("content") || $("title").first().text() || "";
  return normalizeText(title).replace(/\s+/g, " ").slice(0, 200);
}

function charsetOf(contentType: string | null, head: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const sniff = head.subarray(0, 2048).toString("latin1");
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? "utf-8";
}

function decode(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Vigil/2.0 (+https://github.com/ArthurGoon/Vigil)";

/**
 * HTTP/2 when the site offers it. Some sites answer HTTP/1.1 clients that do
 * not look like a browser with an error page (Hacker News returns 419), and
 * the global fetch in Node only speaks HTTP/1.1.
 */
const dispatcher = new Agent({ allowH2: true });

export async function fetchPage(url: string): Promise<FetchResult> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      dispatcher,
      signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    const cause = err instanceof Error ? err.name : "";
    if (cause === "TimeoutError") throw new Error("A página demorou demais para responder");
    throw new Error("Não consegui acessar a página");
  }

  // A 404/500 page would be compared as if it were the real content.
  if (!response.ok) {
    throw new Error(`A página respondeu HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > LIMITS.maxHtmlBytes) {
    throw new Error("Página grande demais (limite de 3 MB)");
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > LIMITS.maxHtmlBytes) {
    throw new Error("Página grande demais (limite de 3 MB)");
  }

  return {
    html: decode(buf, charsetOf(response.headers.get("content-type"), buf)),
    httpStatus: response.status,
    finalUrl: response.url || url,
  };
}
