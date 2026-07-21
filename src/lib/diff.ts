import { createTwoFilesPatch } from "diff";

export function summarizeDiff(oldText: string, newText: string, maxChars = 2000): string {
  if (oldText === newText) return "(no change)";
  const patch = createTwoFilesPatch("before", "after", oldText, newText, "", "", {
    context: 2,
  });
  if (patch.length <= maxChars) return patch;
  return `${patch.slice(0, maxChars)}\n...[diff truncated]`;
}
