import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from "diff";

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/** Unified diff of the hunks only (no file headers), truncated to maxChars. Used by the webhook and the log. */
export function summarizeDiff(oldText: string, newText: string, maxChars = 2000): string {
  if (oldText === newText) return "(sem mudança)";
  const patch = createTwoFilesPatch("antes", "depois", withNewline(oldText), withNewline(newText), "", "", {
    context: 2,
  });
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const body = lines.slice(Math.max(firstHunk, 0)).join("\n").trimEnd();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n...[diff cortado]`;
}

/** [0, text] is common to both sides, [1, text] was removed (before) or added (after). */
export type Segment = [0 | 1, string];

export type DiffRow =
  | { type: "same"; text: string }
  | { type: "skip"; lines: number }
  | { type: "change"; before: Segment[]; after: Segment[] };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function wordSegments(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const out = { before: [] as Segment[], after: [] as Segment[] };
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.added) out.after.push([1, part.value]);
    else if (part.removed) out.before.push([1, part.value]);
    else {
      out.before.push([0, part.value]);
      out.after.push([0, part.value]);
    }
  }
  return out;
}

/**
 * Side by side diff for the UI: changed lines are paired and highlighted word
 * by word, long runs of unchanged lines collapse into a "skip" row so a
 * one-word change in a long element stays readable.
 */
export function diffRows(before: string, after: string, context = 2): DiffRow[] {
  const parts = diffLines(withNewline(before), withNewline(after));
  const rows: DiffRow[] = [];
  let pendingBefore: string[] = [];
  let pendingAfter: string[] = [];

  const flushChange = () => {
    if (!pendingBefore.length && !pendingAfter.length) return;
    rows.push({ type: "change", ...wordSegments(pendingBefore.join("\n"), pendingAfter.join("\n")) });
    pendingBefore = [];
    pendingAfter = [];
  };

  parts.forEach((part, index) => {
    const lines = splitLines(part.value);
    if (part.removed) {
      pendingBefore.push(...lines);
      return;
    }
    if (part.added) {
      pendingAfter.push(...lines);
      return;
    }
    flushChange();
    const keepHead = index === 0 ? 0 : context;
    const keepTail = index === parts.length - 1 ? 0 : context;
    if (lines.length <= keepHead + keepTail + 1) {
      for (const text of lines) rows.push({ type: "same", text });
      return;
    }
    for (const text of lines.slice(0, keepHead)) rows.push({ type: "same", text });
    rows.push({ type: "skip", lines: lines.length - keepHead - keepTail });
    for (const text of lines.slice(lines.length - keepTail)) rows.push({ type: "same", text });
  });
  flushChange();
  return rows;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** One line for notifications: what left and what came in. */
export function shortSummary(before: string, after: string, max = 120): string {
  const removed: string[] = [];
  const added: string[] = [];
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.added) added.push(part.value);
    else if (part.removed) removed.push(part.value);
  }
  const out = clip(removed.join(" "), max);
  const inn = clip(added.join(" "), max);
  if (out && inn) return `“${out}” virou “${inn}”`;
  if (inn) return `Entrou: “${inn}”`;
  if (out) return `Saiu: “${out}”`;
  return "O trecho mudou";
}
