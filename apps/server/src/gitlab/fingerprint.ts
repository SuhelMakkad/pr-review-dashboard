import { createHash } from 'node:crypto';

/** A short, stable digest; used to notice that something GitLab returned has changed. */
export function fingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Identifies a file's diff for viewed marks. A diff GitLab left out (too large or collapsed) or
 * that only says the file is binary reads the same in every revision, so its key is tied to the
 * revision instead: a mark on it then lasts until the next push, never across one.
 */
export function diffKey(
  diff: { diff: string; new_path: string; too_large?: boolean; collapsed?: boolean },
  revision: { head: string; start: string | null },
): string {
  const omitted = !diff.diff || diff.diff.startsWith('Binary files');

  return omitted
    ? fingerprint(['omitted', revision.head, revision.start, diff.new_path])
    : fingerprint(diff.diff);
}
