import { z } from "zod";
import { type FetchResult, extractFromHtml, fetchPage, foldText, loadClean, pageTitle, selectText } from "../lib/html.js";
import { findText } from "./observation.js";

/**
 * The extension sees the page after JavaScript ran; the checks only see the
 * HTML that fetch returns. Before saving, the extension asks the server to
 * look at the same URL and say what it can actually find there: which of the
 * candidate selectors works, and whether the text exists at all.
 */

export const probeSchema = z.object({
  url: z.string().url(),
  selectors: z.array(z.string().max(1000)).max(8).default([]),
  text: z.string().max(2000).default(""),
});

export type ProbeResult = {
  title: string;
  /** First candidate that matches exactly one element containing the text, or null. */
  selector: string | null;
  /** What the check will compare when that selector is used. */
  selectorText: string;
  /** The captured text exists somewhere in the fetched HTML. */
  textFound: boolean;
  candidates: { selector: string; matches: number; hasText: boolean }[];
};

const squash = (s: string) => foldText(s).replace(/\s+/g, "");

type CacheEntry = { at: number; page: Promise<FetchResult> };
const CACHE_MS = 60_000;

/** Short cache so adjusting the scope (maior/menor) does not refetch the page every click. */
export class PageCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly fetcher: typeof fetchPage = fetchPage) {}

  get(url: string): Promise<FetchResult> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at > CACHE_MS) this.entries.delete(key);
    }
    const hit = this.entries.get(url);
    if (hit) return hit.page;
    const page = this.fetcher(url);
    this.entries.set(url, { at: now, page });
    page.catch(() => this.entries.delete(url));
    return page;
  }
}

export function probeHtml(html: string, selectors: string[], text: string): ProbeResult {
  const $ = loadClean(html, { keepChrome: true });
  const wanted = squash(text);
  const candidates = selectors.map((selector) => {
    const found = selectText($, selector);
    return {
      selector,
      matches: found?.count ?? 0,
      hasText: Boolean(found && wanted && squash(found.text).includes(wanted)),
      text: found?.text ?? "",
    };
  });

  const chosen = candidates.find((c) => c.matches === 1 && c.hasText) ?? null;

  let pageText = "";
  try {
    pageText = extractFromHtml(html, null, { keepChrome: true });
  } catch {
    pageText = "";
  }

  return {
    title: pageTitle(html),
    selector: chosen?.selector ?? null,
    selectorText: chosen ? chosen.text.slice(0, 1200) : "",
    textFound: Boolean(text.trim()) && (findText(pageText, text) !== null || squash(pageText).includes(wanted)),
    candidates: candidates.map(({ selector, matches, hasText }) => ({ selector, matches, hasText })),
  };
}

export async function probe(cache: PageCache, raw: unknown): Promise<ProbeResult> {
  const input = probeSchema.parse(raw);
  const page = await cache.get(input.url);
  return probeHtml(page.html, input.selectors, input.text);
}
