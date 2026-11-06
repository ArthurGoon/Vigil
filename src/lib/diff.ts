import { createTwoFilesPatch, diffArrays, diffLines } from "diff";

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

/** Splits on whitespace only, so "R$ 1.899,90" changes as whole tokens, not "899". */
const tokens = (text: string) => text.split(/(\s+)/).filter(Boolean);

function wordSegments(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const out = { before: [] as Segment[], after: [] as Segment[] };
  const push = (list: Segment[], marked: 0 | 1, text: string) => {
    const last = list[list.length - 1];
    if (last && last[0] === marked) last[1] += text;
    else list.push([marked, text]);
  };
  for (const part of diffArrays(tokens(before), tokens(after))) {
    const text = part.value.join("");
    if (part.added) push(out.after, 1, text);
    else if (part.removed) push(out.before, 1, text);
    else {
      push(out.before, 0, text);
      push(out.after, 0, text);
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

/** Text from the first to the last marked segment, keeping the common words in between. */
function changedSpan(segs: Segment[]): string {
  const first = segs.findIndex(([marked]) => marked === 1);
  if (first < 0) return "";
  let last = first;
  segs.forEach(([marked], i) => {
    if (marked === 1) last = i;
  });
  return segs
    .slice(first, last + 1)
    .map(([, text]) => text)
    .join("");
}

/** One line for notifications: what left and what came in. */
export function shortSummary(before: string, after: string, max = 120): string {
  const segs = wordSegments(before, after);
  const out = clip(changedSpan(segs.before), max);
  const inn = clip(changedSpan(segs.after), max);
  if (out && inn) return `“${out}” virou “${inn}”`;
  if (inn) return `Entrou: “${inn}”`;
  if (out) return `Saiu: “${out}”`;
  return "O trecho mudou";
}
