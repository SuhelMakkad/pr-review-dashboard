import {
  isGeneratedPath,
  type DiffFile,
  type DiffManifest,
  type DiffMode,
  type FileStatus,
} from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubApi, RemoteFile } from '@/github/api.js';
import { textPatch } from '@/diff/patch.js';

const CACHE_LIMIT = 40;
const MAX_INTERDIFF_FILES = 300;

const statuses: FileStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];
const shortSha = (oid: string) => oid.slice(0, 7);

function toDiffFile(file: RemoteFile, viewed?: DiffFile['viewed']): DiffFile {
  const status = (
    statuses.includes(file.status as FileStatus) ? file.status : 'modified'
  ) as FileStatus;
  const changedLines = file.additions + file.deletions;

  return {
    path: file.path,
    previousPath: file.previousPath,
    status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    binary: !file.patch && changedLines === 0 && status !== 'renamed' ? true : undefined,
    tooLarge: !file.patch && changedLines > 0 ? true : undefined,
    generated: isGeneratedPath(file.path) || undefined,
    viewed,
  };
}

/**
 * Builds review diffs: the full PR diff, or what changed since the viewer's last review, including
 * after rebases and force pushes. Results are keyed by commit SHAs, which never change meaning.
 */
export class DiffService {
  private readonly cache = new Map<string, DiffManifest>();

  constructor(private readonly github: GitHubApi) {}

  private remember(key: string, manifest: DiffManifest): DiffManifest {
    this.cache.delete(key);
    this.cache.set(key, manifest);

    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);

    return manifest;
  }

  private withViewed(manifest: DiffManifest, pr: PullRequestSnapshot): DiffManifest {
    const viewed = new Map(pr.files.map((file) => [file.path, file.viewerViewedState]));

    return {
      ...manifest,
      files: manifest.files.map((file) => ({ ...file, viewed: viewed.get(file.path) })),
    };
  }

  async manifest(
    pr: PullRequestSnapshot,
    mode: DiffMode,
    reviewOid: string | null,
  ): Promise<DiffManifest> {
    if (mode === 'full' || !reviewOid) return this.withViewed(await this.full(pr), pr);

    return this.withViewed(await this.sinceReview(pr, reviewOid), pr);
  }

  private async full(pr: PullRequestSnapshot): Promise<DiffManifest> {
    const key = `${pr.repository}:${pr.baseOid}:${pr.headOid}:full`;
    const cached = this.cache.get(key);

    if (cached) return cached;

    const files = await this.github.pullFiles(pr.repository, pr.number);

    return this.remember(key, {
      prId: pr.id,
      mode: 'full',
      kind: 'full',
      fromOid: pr.baseOid ?? pr.baseRefName,
      toOid: pr.headOid,
      files: files.map((file) => toDiffFile(file)),
    });
  }

  private async sinceReview(pr: PullRequestSnapshot, reviewOid: string): Promise<DiffManifest> {
    const base = {
      prId: pr.id,
      mode: 'since-review' as const,
      fromOid: reviewOid,
      toOid: pr.headOid,
    };

    if (reviewOid === pr.headOid) return { ...base, kind: 'identical', files: [] };

    const key = `${pr.repository}:${reviewOid}:${pr.headOid}:since`;
    const cached = this.cache.get(key);

    if (cached) return cached;

    const comparison = await this.github.compare(pr.repository, reviewOid, pr.headOid);

    if (!comparison) {
      const full = await this.full(pr);

      return {
        ...full,
        mode: 'since-review',
        kind: 'unavailable',
        note: `The commit you reviewed (${shortSha(reviewOid)}) is no longer on GitHub, so this shows the full diff.`,
      };
    }

    if (comparison.status === 'identical')
      return this.remember(key, { ...base, kind: 'identical', files: [] });

    const prPaths = new Set(pr.files.flatMap((file) => [file.path]));

    if (comparison.status === 'ahead') {
      const relevant = comparison.files.filter(
        (file) => prPaths.has(file.path) || (file.previousPath && prPaths.has(file.previousPath)),
      );
      const hidden = comparison.files.length - relevant.length;
      const merges = comparison.commits.filter((commit) => commit.parents.length > 1).length;

      return this.remember(key, {
        ...base,
        kind: 'fast-forward',
        hiddenBaseFiles: hidden || undefined,
        note:
          merges > 0 && hidden > 0
            ? `Includes ${merges === 1 ? 'a merge' : `${merges} merges`} of ${pr.baseRefName}; ${hidden} ${hidden === 1 ? 'file' : 'files'} changed only by that are hidden.`
            : undefined,
        files: relevant.map((file) => toDiffFile(file)),
      });
    }

    return this.remember(key, await this.rebased(pr, reviewOid, prPaths, base));
  }

  /** History was rewritten: diff each file as reviewed against its current content. */
  private async rebased(
    pr: PullRequestSnapshot,
    reviewOid: string,
    prPaths: Set<string>,
    base: Pick<DiffManifest, 'prId' | 'mode' | 'fromOid' | 'toOid'>,
  ): Promise<DiffManifest> {
    const atReview = await this.github.compare(pr.repository, pr.baseRefName, reviewOid);
    const paths = [...new Set([...prPaths, ...(atReview?.files.map((file) => file.path) ?? [])])]
      .sort()
      .slice(0, MAX_INTERDIFF_FILES);
    const blobs = await this.github.blobs(pr.repository, [
      ...paths.map((path) => ({ oid: reviewOid, path })),
      ...paths.map((path) => ({ oid: pr.headOid, path })),
    ]);
    const files: DiffFile[] = [];

    paths.forEach((path, index) => {
      const before = blobs[index];
      const after = blobs[index + paths.length];

      if (!before && !after) return;
      if (before?.text === after?.text && before?.isBinary === after?.isBinary) return;

      const status: FileStatus = !before ? 'added' : !after ? 'removed' : 'modified';

      if (before?.isBinary || after?.isBinary) {
        files.push({ path, status, additions: 0, deletions: 0, binary: true });
        return;
      }

      if (before?.isTruncated || after?.isTruncated) {
        files.push({ path, status, additions: 0, deletions: 0, tooLarge: true });
        return;
      }

      const patch = textPatch(before?.text ?? '', after?.text ?? '');

      files.push(
        patch
          ? { path, status, ...patch, generated: isGeneratedPath(path) || undefined }
          : { path, status, additions: 0, deletions: 0, tooLarge: true },
      );
    });

    return {
      ...base,
      kind: 'rebased',
      note: `The branch was rebased or force-pushed since your review at ${shortSha(reviewOid)}. Each file is compared as you reviewed it with its current version, so changes brought in from ${pr.baseRefName} can appear too.`,
      files,
    };
  }
}
