/**
 * Diff contract between the server and the review workspace. Every file carries a GitHub-style
 * unified patch (hunks only); the client adds file headers when rendering.
 */

export type DiffMode = 'full' | 'since-review';

/**
 * - `full`: base...head, what GitHub shows on "Files changed".
 * - `identical`: nothing changed since your review.
 * - `fast-forward`: new commits on top of the commit you reviewed (exact).
 * - `rebased`: history was rewritten; compares file contents at your review vs. now.
 * - `unavailable`: the reviewed commit is gone; the full diff is shown instead.
 */
export type DiffKind = 'full' | 'identical' | 'fast-forward' | 'rebased' | 'unavailable';

export type FileStatus =
  'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface DiffFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified hunks; absent for binary or very large files. */
  patch?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** Lockfiles, build output, snapshots: collapsed by default. */
  generated?: boolean;
  viewed?: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
  /** Identifies this file's diff where the forge does (GitLab); a viewed mark names it. */
  viewedKey?: string;
}

export interface DiffManifest {
  prId: string;
  /** The PR's head and base this view was built from; a viewed mark made here names them. */
  revision?: { headOid: string; baseOid: string | null };
  /** The account whose view this is (viewed state, "since your review"); set by the diff route. */
  account?: string;
  mode: DiffMode;
  kind: DiffKind;
  /** Left side of the comparison (base or your reviewed commit) and right side (head). */
  fromOid: string;
  toOid: string;
  /** Human explanation for the banner (rebases, base merges, fallbacks). */
  note?: string;
  /** Files changed only by merging the base branch in, hidden from the interdiff. */
  hiddenBaseFiles?: number;
  files: DiffFile[];
}

const GENERATED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /(^|\/)(dist|build|vendor)\//,
  /\.snap$/,
  /__snapshots__\//,
  /\.generated\.\w+$/,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path));
}

/** Prepends git file headers so a hunk-only patch can be parsed as a full unified diff. */
export function withFileHeaders(
  file: Pick<DiffFile, 'path' | 'previousPath' | 'status' | 'patch'>,
): string {
  const oldPath = file.status === 'added' ? '/dev/null' : `a/${file.previousPath ?? file.path}`;
  const newPath = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;

  return [
    `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    file.patch ?? '',
  ].join('\n');
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Parses GitHub-style hunks ("@@ -a,b +c,d @@ ...") with their body lines. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];

  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (header) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      });
    } else if (hunks.length && line !== '') {
      hunks.at(-1)!.lines.push(line);
    }
  }

  return hunks;
}

/** Lines visible in a patch, per side; GitHub only accepts review comments on these. */
export function commentableLines(patch: string | undefined): {
  left: Set<number>;
  right: Set<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();

  if (!patch) return { left, right };

  for (const hunk of parseHunks(patch)) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;

      if (line.startsWith('-')) {
        left.add(oldLine++);
      } else if (line.startsWith('+')) {
        right.add(newLine++);
      } else {
        left.add(oldLine++);
        right.add(newLine++);
      }
    }
  }

  return { left, right };
}

/**
 * Maps a line in the old version of a file to the new version using the hunks between them.
 * Returns null when the line itself was changed or removed (its comment needs a human decision).
 */
export function mapLine(patch: string, oldLineNumber: number): number | null {
  let offset = 0;

  for (const hunk of parseHunks(patch)) {
    const hunkEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;

    if (oldLineNumber < hunk.oldStart) break;

    if (oldLineNumber <= hunkEnd) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;

      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue;

        if (line.startsWith('-')) {
          if (oldLine === oldLineNumber) return null;
          oldLine++;
        } else if (line.startsWith('+')) {
          newLine++;
        } else {
          if (oldLine === oldLineNumber) return newLine;
          oldLine++;
          newLine++;
        }
      }

      return null;
    }

    offset = hunk.newStart + hunk.newLines - (hunk.oldStart + hunk.oldLines);
  }

  return oldLineNumber + offset;
}
