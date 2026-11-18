import { createHash } from 'node:crypto';
import type { Side } from '@review-desk/shared/review';
import { GitHubError } from '@/github/errors.js';
import type { ThreadInput } from '@/github/write.js';

/** One line of a unified diff, numbered the way GitLab's diff parser numbers it. */
export interface DiffLine {
  kind: 'added' | 'removed' | 'context';
  oldLine: number | null;
  newLine: number | null;
  /** The old/new counters at this line; GitLab builds line codes from them. */
  oldPos: number;
  newPos: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a GitLab diff (hunks only, no file headers), as the MR diffs API returns it. */
export function parseDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  const hunks: Hunk[] = [];
  let oldPos = 1;
  let newPos = 1;

  for (const text of diff.replace(/\n$/, '').split('\n')) {
    const header = HUNK.exec(text);

    if (header) {
      oldPos = Number(header[1]);
      newPos = Number(header[3]);
      hunks.push({
        oldStart: oldPos,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newPos,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
      });
      continue;
    }

    if (hunks.length === 0 || text.startsWith('\\')) continue;

    if (text.startsWith('+')) {
      lines.push({ kind: 'added', oldLine: null, newLine: newPos, oldPos, newPos });
      newPos++;
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'removed', oldLine: oldPos, newLine: null, oldPos, newPos });
      oldPos++;
    } else if (text.startsWith(' ')) {
      lines.push({ kind: 'context', oldLine: oldPos, newLine: newPos, oldPos, newPos });
      oldPos++;
      newPos++;
    }
  }

  return { lines, hunks };
}

/**
 * The diff line at `line` on `side`. Unchanged lines outside every hunk (expanded context) are
 * numbered from the hunks before them.
 */
export function locate(diff: ParsedDiff, side: Side, line: number): DiffLine {
  const found = diff.lines.find((candidate) =>
    side === 'RIGHT' ? candidate.newLine === line : candidate.oldLine === line,
  );

  if (found) return found;

  let delta = 0;

  for (const hunk of diff.hunks) {
    const end = side === 'RIGHT' ? hunk.newStart + hunk.newCount : hunk.oldStart + hunk.oldCount;

    if (end > line) break;

    delta += hunk.newCount - hunk.oldCount;
  }

  const oldLine = side === 'RIGHT' ? line - delta : line;
  const newLine = side === 'RIGHT' ? line : line + delta;

  if (oldLine < 1 || newLine < 1)
    throw new GitHubError(`Line ${line} is not part of this file.`, null, 422, 'rejected');

  return { kind: 'context', oldLine, newLine, oldPos: oldLine, newPos: newLine };
}

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface DiffFileRef {
  oldPath: string;
  newPath: string;
  diff: string;
}

const lineCode = (path: string, line: DiffLine) =>
  `${createHash('sha1').update(path).digest('hex')}_${line.oldPos}_${line.newPos}`;

function rangeEnd(path: string, line: DiffLine) {
  return {
    line_code: lineCode(path, line),
    type: line.kind === 'added' ? 'new' : 'old',
    old_line: line.oldLine,
    new_line: line.newLine,
  };
}

/**
 * GitLab's `position` for a comment: on a file, on one line, or on a range of lines. Removed lines
 * carry only `old_line`, added lines only `new_line`, and unchanged lines need both.
 */
export function commentPosition(
  file: DiffFileRef,
  refs: DiffRefs,
  thread: ThreadInput,
): Record<string, unknown> {
  const base = {
    base_sha: refs.base_sha,
    start_sha: refs.start_sha,
    head_sha: refs.head_sha,
    old_path: file.oldPath,
    new_path: file.newPath,
  };

  if (thread.subjectType === 'FILE' || thread.line === null || thread.line === undefined)
    return { ...base, position_type: 'file' };

  const parsed = parseDiff(file.diff);
  const side = thread.side ?? 'RIGHT';
  const end = locate(parsed, side, thread.line);
  const position: Record<string, unknown> = {
    ...base,
    position_type: 'text',
    old_line: end.oldLine,
    new_line: end.newLine,
  };

  if (thread.startLine && thread.startLine !== thread.line) {
    const start = locate(parsed, thread.startSide ?? side, thread.startLine);
    const path = file.newPath;

    position.line_range = { start: rangeEnd(path, start), end: rangeEnd(path, end) };
  }

  return position;
}
