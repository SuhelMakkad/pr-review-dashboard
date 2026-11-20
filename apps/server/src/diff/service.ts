import {
  isGeneratedPath,
  type DiffFile,
  type DiffManifest,
  type DiffMode,
  type FileStatus,
} from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubApi, RemoteFile } from '@/github/api.js';
import { asAccount } from '@/github/credentials.js';
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

/**
 * One manifest build: the account it reads as, and the cache entries it may publish once its reads
 * are known to have been that account's.
 */
interface Build {
  account: string | null;
  staged: [string, DiffManifest][];
}

export function toDiffFile(file: RemoteFile, viewed?: DiffFile['viewed']): DiffFile {
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
    binary:
      !file.patch && !file.tooLarge && changedLines === 0 && status !== 'renamed'
        ? true
        : undefined,
    tooLarge: file.tooLarge || (!file.patch && changedLines > 0) ? true : undefined,
    generated: isGeneratedPath(file.path) || undefined,
    viewed,
    ...(file.viewedKey ? { viewedKey: file.viewedKey } : {}),
  };
}

/**
 * Builds review diffs: the full PR diff, or what changed since the viewer's last review, including
 * after rebases and force pushes. Results are keyed by commit SHAs, which never change meaning.
 */
export class DiffService {
  private readonly cache = new Map<string, DiffManifest>();

  constructor(private readonly github: GitHubApi) {}

  /** A cache key for this build's account: one account's diff is never served to another. */
  private key(build: Build, key: string): string {
    return `${build.account ?? ''}\u0000${key}`;
  }

  /** Staged with the build, published only when the build is (see `manifest`). */
  private remember(build: Build, key: string, manifest: DiffManifest): DiffManifest {
    build.staged.push([key, manifest]);

    return manifest;
  }

  private publish(build: Build): void {
    for (const [key, manifest] of build.staged) {
      this.cache.delete(key);
      this.cache.set(key, manifest);

      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    }
  }

  /**
   * The manifest with the PR's viewed state, for the revision it was built for (its cache key holds
   * the same head and base). Where the forge keys each file's diff, a file's key comes from the
   * diff the manifest renders, and the PR's viewed state shows only where it is about that diff.
   */
  private withViewed(manifest: DiffManifest, pr: PullRequestSnapshot): DiffManifest {
    const files = new Map(pr.files.map((file) => [file.path, file]));

    return {
      ...manifest,
      revision: { headOid: pr.headOid, baseOid: pr.baseOid ?? null },
      files: manifest.files.map((file) => {
        const stored = files.get(file.path);
        // Keyed by diff: the stored state is shown only where it is about this very diff.
        const same = manifest.keyed
          ? file.viewedKey !== undefined && stored?.viewedKey === file.viewedKey
          : true;

        return { ...file, viewed: same ? stored?.viewerViewedState : 'UNVIEWED' };
      }),
    };
  }

  /**
   * Each file's key for viewed marks, from the full diff of the same revision. Without one (the
   * full diff could not be read, or not as this head's), the view still shows; those files just
   * cannot be marked viewed from it.
   */
  private async withKeys(
    build: Build,
    manifest: DiffManifest,
    pr: PullRequestSnapshot,
  ): Promise<DiffManifest> {
    // Nothing to key; or the full diff itself, shown because the reviewed commit is gone, whose
    // keys (or their absence) are its own.
    if (manifest.files.length === 0 || manifest.kind === 'unavailable') return manifest;
    if (!pr.files.some((file) => file.viewedKey)) return manifest;

    const full = await this.full(build, pr).catch(() => null);
    const keys = new Map(full?.files.map((file) => [file.path, file.viewedKey]) ?? []);

    return {
      ...manifest,
      keyed: true,
      files: manifest.files.map((file) => {
        const viewedKey = keys.get(file.path);

        return viewedKey ? { ...file, viewedKey } : file;
      }),
    };
  }

  /**
   * The PR's diff for `mode`, read as `account` (the account whose PR it is) when given. Every forge
   * read of the build runs as that account. Where the forge cannot carry the account with each call
   * (GitLab), its sign-in is checked before the build and after its last read, and nothing it read
   * is cached or returned unless both checks pass.
   */
  async manifest(
    pr: PullRequestSnapshot,
    mode: DiffMode,
    reviewOid: string | null,
    account: string | null = null,
  ): Promise<DiffManifest> {
    const build: Build = { account, staged: [] };
    const work = async () => {
      if (mode === 'full' || !reviewOid) return this.withViewed(await this.full(build, pr), pr);

      // A mark from this view is about the file's whole diff, so its key is the full diff's.
      return this.withViewed(
        await this.withKeys(build, await this.sinceReview(build, pr, reviewOid), pr),
        pr,
      );
    };

    if (!account) {
      const manifest = await work();

      this.publish(build);

      return manifest;
    }

    return asAccount(account, async () => {
      await this.github.verifyAccount?.(account);

      const manifest = await work();

      await this.github.verifyAccount?.(account);
      this.publish(build);

      return manifest;
    });
  }

  private async full(build: Build, pr: PullRequestSnapshot): Promise<DiffManifest> {
    const key = this.key(build, `${pr.url}:${pr.baseOid}:${pr.headOid}:full`);
    const cached = this.cache.get(key) ?? build.staged.find(([staged]) => staged === key)?.[1];

    if (cached) return cached;

    // Where viewed state follows each diff, the files of exactly this revision, keyed.
    const listing =
      (await this.github.pinnedFiles?.(pr.repository, pr.number, {
        headOid: pr.headOid,
        baseOid: pr.baseOid ?? null,
      })) ?? null;
    const files = listing ? listing.files : await this.github.pullFiles(pr.repository, pr.number);
    const keyed = listing !== null;
    const manifest: DiffManifest = {
      prId: pr.id,
      mode: 'full',
      kind: 'full',
      fromOid: pr.baseOid ?? pr.baseRefName,
      toOid: pr.headOid,
      ...(keyed ? { keyed: true } : {}),
      ...(listing?.complete && listing.mergeBaseOid
        ? { listing: { complete: true as const, mergeBaseOid: listing.mergeBaseOid } }
        : {}),
      files: files.map((file) => toDiffFile(file)),
    };

    // Diffs that could not be pinned to this revision are shown, not kept: the next view reads
    // them again, and meanwhile they cannot be marked viewed or commented on by line. This holds
    // for an empty list too.
    if (listing && !listing.pinned) return { ...manifest, unpinned: true };

    return this.remember(build, key, manifest);
  }

  private async sinceReview(
    build: Build,
    pr: PullRequestSnapshot,
    reviewOid: string,
  ): Promise<DiffManifest> {
    const base = {
      prId: pr.id,
      mode: 'since-review' as const,
      fromOid: reviewOid,
      toOid: pr.headOid,
    };

    if (reviewOid === pr.headOid) return { ...base, kind: 'identical', files: [] };

    const key = this.key(build, `${pr.url}:${reviewOid}:${pr.headOid}:since`);
    const cached = this.cache.get(key);

    if (cached) return cached;

    const comparison = await this.github.compare(pr.repository, reviewOid, pr.headOid);

    if (!comparison) {
      const full = await this.full(build, pr);

      return {
        ...full,
        mode: 'since-review',
        kind: 'unavailable',
        note: `The commit you reviewed (${shortSha(reviewOid)}) is no longer on ${pr.url.includes('/-/merge_requests/') ? 'GitLab' : 'GitHub'}, so this shows the full diff.`,
      };
    }

    if (comparison.status === 'identical')
      return this.remember(build, key, { ...base, kind: 'identical', files: [] });

    const prPaths = new Set(pr.files.flatMap((file) => [file.path]));

    if (comparison.status === 'ahead') {
      const relevant = comparison.files.filter(
        (file) => prPaths.has(file.path) || (file.previousPath && prPaths.has(file.previousPath)),
      );
      const hidden = comparison.files.length - relevant.length;
      const merges = comparison.commits.filter((commit) => commit.parents.length > 1).length;

      return this.remember(build, key, {
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

    return this.remember(build, key, await this.rebased(pr, reviewOid, prPaths, base));
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
