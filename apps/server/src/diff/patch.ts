import { structuredPatch } from 'diff';

const MAX_TEXT_BYTES = 1_000_000;

/** Too large to patch: `textPatch` returns null for it, and a worker is never sent it. */
export const overCap = (oldText: string, newText: string) =>
  oldText.length > MAX_TEXT_BYTES || newText.length > MAX_TEXT_BYTES;

export interface TextPatch {
  patch: string;
  additions: number;
  deletions: number;
}

/** Unified hunks (GitHub style, no file headers) between two versions of a text file. */
export function textPatch(oldText: string, newText: string, context = 3): TextPatch | null {
  if (overCap(oldText, newText)) return null;

  const result = structuredPatch('a', 'b', oldText, newText, '', '', { context });
  let additions = 0;
  let deletions = 0;

  const patch = result.hunks
    .map((hunk) => {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }

      return [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ].join('\n');
    })
    .join('\n');

  return { patch, additions, deletions };
}
