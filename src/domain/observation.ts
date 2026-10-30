import type { Watch } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";
import { summarizeDiff } from "../lib/diff.js";
import { SelectorMissError, extractFromHtml, hashText, normalizeText } from "../lib/html.js";
import { modeLabel } from "../lib/notify.js";

/**
 * Pure decision logic for a check: no DB, no network.
 * check.ts fetches the page and persists; everything that decides
 * "did it change / should we alert" lives here so it can be tested.
 */

export const MONITOR_MODES = ["text_changed", "text_appears", "text_disappears"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

export type WatchTarget = Pick<Watch, "monitorMode" | "targetText" | "cssSelector">;

export type Observation = {
  key: string;
  preview: string;
  present: boolean;
  excerpt: string;
};

export type PreviousSnapshot = {
  contentHash: string;
  contentText: string;
};

export type CheckDecision = {
  observation: Observation;
  /** Same hash as the latest snapshot: nothing to store. */
  unchanged: boolean;
  /** Store a new snapshot and raise an alert. */
  notify: boolean;
  snapshotPayload: string;
  diffSummary: string | null;
};

export function normalizeMode(mode: string | null | undefined): MonitorMode {
  return (MONITOR_MODES as readonly string[]).includes(mode ?? "")
    ? (mode as MonitorMode)
    : "text_changed";
}

function isPresenceMode(mode: MonitorMode): boolean {
  return mode === "text_appears" || mode === "text_disappears";
}

/**
 * Text used for the comparison. In appears/disappears modes a selector that
 * no longer matches usually means the element was removed, so we fall back
 * to the whole page instead of failing the check.
 */
export function pageTextFor(watch: WatchTarget, html: string): string {
  if (!watch.cssSelector) return extractFromHtml(html);
  try {
    return extractFromHtml(html, watch.cssSelector);
  } catch (err) {
    if (err instanceof SelectorMissError && isPresenceMode(normalizeMode(watch.monitorMode))) {
      return extractFromHtml(html);
    }
    throw err;
  }
}

export function extractAround(page: string, target: string, radius = 80): string {
  if (!target) return page.slice(0, 500);
  const idx = page.toLowerCase().indexOf(target.toLowerCase());
  if (idx < 0) return `MISSING:${target}`;
  const start = Math.max(0, idx - radius);
  const end = Math.min(page.length, idx + target.length + radius);
  return page.slice(start, end);
}

export function buildObservation(watch: WatchTarget, pageText: string): Observation {
  const target = normalizeText(watch.targetText || "");
  const page = normalizeText(pageText);
  const present = target ? page.toLowerCase().includes(target.toLowerCase()) : false;
  const mode = normalizeMode(watch.monitorMode);

  if (isPresenceMode(mode)) {
    // Key only depends on presence, so edits elsewhere on the page are ignored.
    return {
      key: hashText(`${mode}:${present ? "1" : "0"}:${target.toLowerCase()}`),
      preview: present
        ? `Encontrado: “${target.slice(0, 180)}”`
        : `Não encontrado: “${target.slice(0, 180)}”`,
      present,
      excerpt: present ? target : "",
    };
  }

  // text_changed: with a selector the whole element is the excerpt,
  // otherwise a window of text around the target.
  const excerpt = watch.cssSelector
    ? page.slice(0, LIMITS.maxTextChars)
    : extractAround(page, target);
  return {
    key: hashText(`changed:${excerpt.toLowerCase()}`),
    preview: excerpt.slice(0, 400) || `Alvo: “${target.slice(0, 180)}”`,
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
  return true; // text_changed: caller only asks when the hash differs
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
    targetText: watch.targetText,
  });

  if (latest && latest.contentHash === observation.key) {
    return { observation, unchanged: true, notify: false, snapshotPayload, diffSummary: null };
  }

  const previous = latest ? parseSnapshot(latest.contentText) : null;
  const notify = shouldNotify(mode, Boolean(latest), previous?.present ?? null, observation);

  let diffSummary: string | null = null;
  if (notify && previous) {
    diffSummary =
      mode === "text_changed"
        ? summarizeDiff(previous.excerpt, observation.excerpt)
        : `${modeLabel(mode)}: “${watch.targetText}”`;
  }

  return { observation, unchanged: false, notify, snapshotPayload, diffSummary };
}
