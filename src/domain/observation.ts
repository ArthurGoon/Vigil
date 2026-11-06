import { LIMITS } from "../config.js";
import type { ChangeKind, MonitorMode, Watch } from "../db/store.js";
import { MONITOR_MODES } from "../db/store.js";
import { shortSummary, summarizeDiff } from "../lib/diff.js";
import { SelectorMissError, extractFromHtml, foldText, hashText, normalizeText } from "../lib/html.js";

/**
 * Pure decision logic for a check: no database, no network.
 * check.ts fetches the page and persists; everything that decides
 * "did it change / should we alert" lives here so it can be tested.
 */

export { MONITOR_MODES };
export type { MonitorMode };

export type WatchTarget = Pick<Watch, "monitorMode" | "targetText" | "cssSelector">;

export type Observation = {
  key: string;
  /** Short human readable state, shown in the lists ("valor atual"). */
  preview: string;
  present: boolean;
  /** What is stored and diffed. Empty when the target is not on the page. */
  excerpt: string;
};

export type PreviousSnapshot = {
  contentHash: string;
  contentText: string;
};

export type DetectedChange = {
  kind: ChangeKind;
  before: string;
  after: string;
  summary: string;
  diff: string;
};

export type CheckDecision = {
  observation: Observation;
  /** Same key as the latest snapshot: nothing to store. */
  unchanged: boolean;
  snapshotPayload: string;
  /** Set when this check must raise an alert. */
  change: DetectedChange | null;
};

export function normalizeMode(mode: string | null | undefined): MonitorMode {
  return (MONITOR_MODES as readonly string[]).includes(mode ?? "")
    ? (mode as MonitorMode)
    : "text_changed";
}

export function isPresenceMode(mode: MonitorMode): boolean {
  return mode === "text_appears" || mode === "text_disappears";
}

/**
 * Text used for the comparison. In appears/disappears modes a selector that
 * no longer matches usually means the element was removed, so we fall back
 * to the whole page instead of failing the check.
 */
export function pageTextFor(watch: WatchTarget, html: string): string {
  const presence = isPresenceMode(normalizeMode(watch.monitorMode));
  if (!watch.cssSelector) return extractFromHtml(html, null, { keepChrome: presence });
  try {
    return extractFromHtml(html, watch.cssSelector);
  } catch (err) {
    if (err instanceof SelectorMissError && presence) {
      return extractFromHtml(html, null, { keepChrome: true });
    }
    throw err;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds `target` in `page` ignoring case and whitespace, even inside words:
 * the browser and cheerio disagree on spaces between inline tags
 * ("R$<b>10</b>" reads "R$ 10" in one and "R$10" in the other).
 */
export function findText(page: string, target: string): { index: number; length: number } | null {
  const chars = [...normalizeText(target).replace(/\s+/g, "")];
  if (!chars.length) return null;
  const match = new RegExp(chars.map(escapeRegExp).join("\\s*"), "i").exec(page);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** Window of text around the target, used by "mudou" when there is no selector. Empty if the target is gone. */
export function extractAround(page: string, target: string, radius = 80): string {
  if (!target) return page.slice(0, 500);
  const hit = findText(page, target);
  if (!hit) return "";
  const start = Math.max(0, hit.index - radius);
  const end = Math.min(page.length, hit.index + hit.length + radius);
  return page.slice(start, end).trim();
}

export function buildObservation(watch: WatchTarget, pageText: string): Observation {
  const target = normalizeText(watch.targetText || "");
  const page = normalizeText(pageText);
  const present = target ? findText(page, target) !== null : false;
  const mode = normalizeMode(watch.monitorMode);

  if (isPresenceMode(mode)) {
    // Key only depends on presence, so edits elsewhere on the page are ignored.
    return {
      key: hashText(`${mode}:${present ? "1" : "0"}:${foldText(target)}`),
      preview: present ? "Está na página" : "Não está na página",
      present,
      excerpt: present ? target : "",
    };
  }

  // text_changed: with a selector the whole element is the excerpt,
  // otherwise a window of text around the target.
  const excerpt = watch.cssSelector ? page.slice(0, LIMITS.maxTextChars) : extractAround(page, target);
  return {
    key: hashText(excerpt ? `changed:${foldText(excerpt)}` : `changed:missing:${foldText(target)}`),
    preview: excerpt ? excerpt.slice(0, 400) : "O trecho não está mais na página",
    present,
    excerpt,
  };
}

export function parseSnapshot(contentText: string): { present: boolean | null; excerpt: string } {
  try {
    const parsed = JSON.parse(contentText) as { present?: unknown; excerpt?: unknown };
    return {
      present: typeof parsed.present === "boolean" ? parsed.present : null,
      excerpt: typeof parsed.excerpt === "string" ? parsed.excerpt : contentText,
    };
  } catch {
    return { present: null, excerpt: contentText };
  }
}

export function shouldNotify(
  mode: MonitorMode,
  hadLatest: boolean,
  prevPresent: boolean | null,
  next: Observation
): boolean {
  // First snapshot is the baseline, never an alert.
  if (!hadLatest) return false;
  if (mode === "text_appears") return !prevPresent && next.present;
  if (mode === "text_disappears") return Boolean(prevPresent) && !next.present;
  return true; // text_changed: caller only asks when the key differs
}

export function decideCheck(
  watch: WatchTarget,
  pageText: string,
  latest: PreviousSnapshot | null
): CheckDecision {
  const mode = normalizeMode(watch.monitorMode);
  const observation = buildObservation(watch, pageText);
  const snapshotPayload = JSON.stringify({
    mode,
    present: observation.present,
    excerpt: observation.excerpt,
  });

  if (latest && latest.contentHash === observation.key) {
    return { observation, unchanged: true, snapshotPayload, change: null };
  }

  const previous = latest ? parseSnapshot(latest.contentText) : null;
  if (!previous || !shouldNotify(mode, true, previous.present, observation)) {
    return { observation, unchanged: false, snapshotPayload, change: null };
  }

  const target = normalizeText(watch.targetText).replace(/\s+/g, " ");
  let change: DetectedChange;
  if (mode === "text_appears") {
    change = { kind: "appeared", before: "", after: target, summary: `Apareceu: “${target}”`, diff: `+${target}` };
  } else if (mode === "text_disappears") {
    change = { kind: "disappeared", before: target, after: "", summary: `Sumiu: “${target}”`, diff: `-${target}` };
  } else {
    const before = previous.excerpt;
    const after = observation.excerpt;
    change = {
      kind: "changed",
      before,
      after,
      summary: after ? shortSummary(before, after) : "O trecho não está mais na página",
      diff: summarizeDiff(before, after),
    };
  }
  return { observation, unchanged: false, snapshotPayload, change };
}
