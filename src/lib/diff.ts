import { createTwoFilesPatch } from "diff";

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/** Unified diff of the hunks only (no file headers), truncated to maxChars. */
export function summarizeDiff(oldText: string, newText: string, maxChars = 2000): string {
  if (oldText === newText) return "(no change)";
  const patch = createTwoFilesPatch("before", "after", withNewline(oldText), withNewline(newText), "", "", {
    context: 2,
  });
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const body = lines.slice(Math.max(firstHunk, 0)).join("\n").trimEnd();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n...[diff truncated]`;
}
