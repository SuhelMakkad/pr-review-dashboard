import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ReviewInputs } from '@review-desk/shared/ai';
import type { DiffFile, DiffManifest } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { toDiffFile } from '@/diff/service.js';
import type { CompareResult, RemoteFile } from '@/github/api.js';

/** Gaps listed by path; the count covers the rest. */
const LISTED_GAPS = 50;

/**
 * True when `path` opens for reading as a regular file inside `root`. Forge paths never leave the
 * snapshot, and a symlink is never followed.
 */
async function readable(root: string, path: string): Promise<boolean> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) return false;

  try {
    const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      return (await file.stat()).isFile();
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

/** The files a full review's workspace must hold, by side, for a list of changed files. */
export async function unreadableFiles(
  directory: string,
  files: Pick<RemoteFile, 'path' | 'previousPath' | 'status'>[],
): Promise<{ unreadable: ReviewInputs['unreadable']; unreadableCount: number }> {
  const unreadable: ReviewInputs['unreadable'] = [];
  let unreadableCount = 0;

  for (const file of files) {
    for (const { side, path } of sides(file)) {
      if (await readable(join(directory, side), path)) continue;

      unreadableCount++;
      if (unreadable.length < LISTED_GAPS) unreadable.push({ path, side });
    }
  }

  return { unreadable, unreadableCount };
}

/** The changed file's content at each reviewed commit it exists at. */
function sides(file: Pick<RemoteFile, 'path' | 'previousPath' | 'status'>) {
  return [
    ...(file.status === 'added'
      ? []
      : [{ side: 'before' as const, path: file.previousPath ?? file.path }]),
    ...(file.status === 'removed' ? [] : [{ side: 'after' as const, path: file.path }]),
  ];
}

/**
 * The files the reviewed commits change, with their patches, where the forge can prove the list
 * whole: GitHub compares the two commits; GitLab's record of the revision counts when its diffs
 * start from the same merge base. Null when neither is known to be complete.
 */
function inventoryOf(
  comparison: CompareResult,
  diff: DiffManifest,
  mergeBaseOid: string,
): DiffFile[] | null {
  if (comparison.filesComplete) return comparison.files.map((file) => toDiffFile(file));
  if (diff.listing?.complete && diff.listing.mergeBaseOid === mergeBaseOid && !diff.unpinned)
    return diff.files;

  return null;
}

/**
 * The files a full review is given, and what the server observed of them in the prepared
 * workspace. With a verified inventory the agent gets exactly the reviewed commits' files and
 * patches. Without one it gets the PR's listed paths but no patches, which might be another
 * revision's, and reads the snapshots instead. Files left out of the archive (symlinks,
 * submodules, export-ignored paths, files past the extraction limit) or a list that cannot be
 * proven whole make the record incomplete.
 */
export async function observeInputs(
  directory: string,
  pr: PullRequestSnapshot,
  diff: DiffManifest,
  comparison: CompareResult,
  mergeBaseOid: string,
): Promise<{ inputs: ReviewInputs; files: DiffFile[] }> {
  const inventory = inventoryOf(comparison, diff, mergeBaseOid);
  const files = inventory ?? diff.files.map(({ patch: _patch, ...file }) => file);
  const { unreadable, unreadableCount } = await unreadableFiles(directory, files);

  return {
    inputs: {
      v: 1,
      headOid: pr.headOid,
      mergeBaseOid,
      targetBaseOid: pr.baseOid ?? null,
      inventory: inventory ? 'verified' : 'unverified',
      changedFiles: pr.changedFiles,
      unreadable,
      unreadableCount,
      complete: Boolean(inventory && unreadableCount === 0 && pr.changedFiles === inventory.length),
    },
    files,
  };
}

/**
 * Evidence for a run that saved some already: a new measurement can only take it down. An answer
 * may come from a turn that read the earlier workspace, so a better later one never counts.
 */
export function downgraded(saved: ReviewInputs, measured: ReviewInputs): ReviewInputs {
  if (measured.complete) return saved;

  return {
    ...saved,
    inventory:
      saved.inventory === 'verified' && measured.inventory === 'verified'
        ? 'verified'
        : 'unverified',
    unreadable: [...saved.unreadable, ...measured.unreadable].slice(0, LISTED_GAPS),
    unreadableCount: saved.unreadableCount + measured.unreadableCount,
    complete: false,
  };
}

/** The saved workspace a run reuses, as `prepareReviewWorkspace` wrote it. */
export interface PreparedContext {
  headOid?: string;
  repository?: string;
  /** The merge base the snapshots were extracted at. */
  baseOid?: string;
  files?: DiffFile[];
  inputs?: ReviewInputs;
}

/**
 * Checks a reused workspace again: files that can no longer be read take its evidence down.
 * A workspace prepared before evidence was recorded names its commits but claims no coverage.
 * Null when it does not say which merge base it holds.
 */
export async function revalidated(
  directory: string,
  context: PreparedContext,
  pr: PullRequestSnapshot,
): Promise<ReviewInputs | null> {
  const { unreadable, unreadableCount } = await unreadableFiles(directory, context.files ?? []);
  const saved: ReviewInputs | null = context.inputs
    ? context.inputs
    : context.baseOid
      ? unverified(pr, context.baseOid)
      : null;

  if (!saved) return null;

  return downgraded(saved, {
    ...saved,
    unreadable,
    unreadableCount,
    complete: unreadableCount === 0,
  });
}

/** Evidence that names the reviewed commits but claims nothing about what was read. */
export function unverified(pr: PullRequestSnapshot, mergeBaseOid: string): ReviewInputs {
  return {
    v: 1,
    headOid: pr.headOid,
    mergeBaseOid,
    targetBaseOid: pr.baseOid ?? null,
    inventory: 'unverified',
    changedFiles: pr.changedFiles,
    unreadable: [],
    unreadableCount: 0,
    complete: false,
  };
}

/**
 * What a run's answer rests on, given what its workspace holds now (`measured`). Saved evidence
 * is only ever taken down: the answer may come from a turn that read an earlier workspace. A
 * checkpoint from before evidence was recorded (a thread, no evidence) names its commits but
 * claims nothing about what it read; without them it has no evidence at all.
 */
export function evidence(
  run: { inputs: ReviewInputs | null; threadId: string | null } | null,
  measured: ReviewInputs | null,
  reviewed: PullRequestSnapshot,
): ReviewInputs | null {
  if (run?.inputs) return measured ? downgraded(run.inputs, measured) : run.inputs;
  if (!measured) return null;
  if (run?.threadId) return unverified(reviewed, measured.mergeBaseOid);

  return measured;
}
