import {
  isGeneratedPath,
  type DiffFile,
  type DiffManifest,
  type DiffMode,
  type FileStatus,
} from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubApi, RemoteFile } from '@/github/api.js';
import { AccountUnavailable, unattributed } from '@/forge/account.js';
import { accountCheck, bindForge, declaredTraits } from '@/forge/bind.js';
import { textPatch, type TextPatch } from '@/diff/patch.js';
import { PatchAborted, PoolClosed, type PatchPool } from '@/diff/patch-pool.js';
import { ReviewError } from '@/review/errors.js';

const CACHE_LIMIT = 40;
const MAX_INTERDIFF_FILES = 300;
/** Rebased builds at once: each holds up to twice `MAX_INTERDIFF_FILES` texts while it runs. */
const REBASED_BUILDS = 2;

/** The server is stopping: no build starts, and none goes on reading or publishes. */
const shuttingDown = () =>
  new ReviewError('SHUTTING_DOWN', 503, 'The server is restarting. Try again shortly.');

/** A build stopped by its caller or by shutdown: never a forge failure. */
export const cancelled = (error: unknown) =>
  error instanceof PatchAborted ||
  error instanceof PoolClosed ||
  (error instanceof ReviewError && error.code === 'SHUTTING_DOWN');

/** At most `limit` holders at once; the rest wait in order, each until its signal aborts. */
class Admission {
  private active = 0;
  private closed = false;
  private readonly waiting: { admit: () => void; refuse: (error: Error) => void }[] = [];

  constructor(private readonly limit: number) {}

  /** Admitted: resolves with the release, which frees the place for the next. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(shuttingDown());
    if (signal?.aborted) return Promise.reject(new PatchAborted());

    let released = false;
    const release = () => {
      if (released) return;

      released = true;
      this.active--;
      this.waiting.shift()?.admit();
    };

    if (this.active < this.limit) {
      this.active++;

      return Promise.resolve(release);
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(new PatchAborted());
      };
      const entry = {
        admit: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          resolve(release);
        },
        refuse: (error: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  /** Admits no one more: those waiting are refused as shutting down. */
  close(): void {
    this.closed = true;

    for (const entry of this.waiting.splice(0)) entry.refuse(shuttingDown());
  }
}

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
  /** The forge, bound to `account` when there is one, so every read is that account's. */
  forge: GitHubApi;
  staged: [string, DiffManifest][];
  /** Its caller stops waiting: nothing more is read or published. */
  signal?: AbortSignal;
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
  private readonly admission = new Admission(REBASED_BUILDS);
  /** Builds in progress, which `close` waits for. */
  private readonly builds = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    private readonly github: GitHubApi,
    /** Patches rebased diffs off the event loop; without it they are computed in place. */
    private readonly patches: PatchPool | null = null,
  ) {}

  /**
   * Starts no build, refuses those waiting for a place, and waits for those in progress, which
   * read nothing more and publish nothing.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.admission.close();

    await Promise.allSettled([...this.builds]);
  }

  /** Before each read and before publishing: stopped by shutdown, or by the build's caller. */
  private guard(build: Build): void {
    if (this.closing) throw shuttingDown();
    if (build.signal?.aborted) throw new PatchAborted();
  }

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

    // Best effort, but never past a cancelled build.
    const full = await this.full(build, pr).catch((error: unknown) => {
      if (cancelled(error)) throw error;

      return null;
    });
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
    /** The caller's own binding to `account`, kept for its whole operation; else one is made. */
    forge?: GitHubApi,
    /** Aborted when the caller stops waiting: the build reads and publishes nothing more. */
    signal?: AbortSignal,
  ): Promise<DiffManifest> {
    const build: Build = {
      account,
      forge: forge ?? (account ? bindForge(this.github, account) : this.github),
      staged: [],
      signal,
    };

    this.guard(build);

    const running = this.build(build, pr, mode, reviewOid, account);

    this.builds.add(running);
    void running.finally(() => this.builds.delete(running)).catch(() => undefined);

    return running;
  }

  private async build(
    build: Build,
    pr: PullRequestSnapshot,
    mode: DiffMode,
    reviewOid: string | null,
    account: string | null,
  ): Promise<DiffManifest> {
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

      this.guard(build);
      this.publish(build);

      return manifest;
    }

    const verify = accountCheck(build.forge);

    if (!verify) {
      const manifest = await work();

      this.guard(build);
      this.publish(build);

      return manifest;
    }

    return (async () => {
      // A limit met by a check itself cannot be tied to the account: it is nobody's cooldown.
      const check = () =>
        verify(account).catch((error: unknown) => Promise.reject(unattributed(error)));

      await check();

      let manifest: DiffManifest;

      try {
        manifest = await work();
      } catch (error) {
        // Stopped, not failed: no sign-in check, and its own error.
        if (error instanceof AccountUnavailable || cancelled(error)) throw error;

        // A limit met while building is the account's only if glab is still signed in as it.
        const confirmed = await verify(account).then(
          () => true,
          () => false,
        );

        throw confirmed ? error : unattributed(error);
      }

      await check();
      // Checked again after the sign-in check, right before publishing.
      this.guard(build);
      this.publish(build);

      return manifest;
    })();
  }

  private async full(build: Build, pr: PullRequestSnapshot): Promise<DiffManifest> {
    const key = this.key(build, `${pr.url}:${pr.baseOid}:${pr.headOid}:full`);
    const cached = this.cache.get(key) ?? build.staged.find(([staged]) => staged === key)?.[1];

    if (cached) return cached;

    this.guard(build);

    // Where viewed state follows each diff, the files of exactly this revision, keyed.
    const listing = declaredTraits(build.forge).pinnedFiles
      ? ((await build.forge.pinnedFiles?.(pr.repository, pr.number, {
          headOid: pr.headOid,
          baseOid: pr.baseOid ?? null,
        })) ?? null)
      : null;
    const files = listing ? listing.files : await build.forge.pullFiles(pr.repository, pr.number);
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

    this.guard(build);

    const comparison = await build.forge.compare(pr.repository, reviewOid, pr.headOid);

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

    return this.remember(build, key, await this.rebased(build, pr, reviewOid, prPaths, base));
  }

  /** History was rewritten: diff each file as reviewed against its current content. */
  private async rebased(
    build: Build,
    pr: PullRequestSnapshot,
    reviewOid: string,
    prPaths: Set<string>,
    base: Pick<DiffManifest, 'prId' | 'mode' | 'fromOid' | 'toOid'>,
  ): Promise<DiffManifest> {
    // A place before its texts are read: a few builds hold them at once, never every request's.
    const release = await this.admission.acquire(build.signal);

    try {
      this.guard(build);

      const forge = build.forge;
      const atReview = await forge.compare(pr.repository, pr.baseRefName, reviewOid);
      const paths = [...new Set([...prPaths, ...(atReview?.files.map((file) => file.path) ?? [])])]
        .sort()
        .slice(0, MAX_INTERDIFF_FILES);

      this.guard(build);

      const blobs = await forge.blobs(pr.repository, [
        ...paths.map((path) => ({ oid: reviewOid, path })),
        ...paths.map((path) => ({ oid: pr.headOid, path })),
      ]);

      this.guard(build);

      // Each file decided from its texts, in path order; text pairs are patched below.
      const decided: (
        DiffFile | { path: string; status: FileStatus; before: string; after: string }
      )[] = [];

      paths.forEach((path, index) => {
        const before = blobs[index];
        const after = blobs[index + paths.length];

        if (!before && !after) return;
        if (before?.text === after?.text && before?.isBinary === after?.isBinary) return;

        const status: FileStatus = !before ? 'added' : !after ? 'removed' : 'modified';

        if (before?.isBinary || after?.isBinary)
          decided.push({ path, status, additions: 0, deletions: 0, binary: true });
        else if (before?.isTruncated || after?.isTruncated)
          decided.push({ path, status, additions: 0, deletions: 0, tooLarge: true });
        else decided.push({ path, status, before: before?.text ?? '', after: after?.text ?? '' });
      });

      const patches = await this.patchAll(
        build,
        decided.flatMap((file) => ('before' in file ? [file] : [])),
      );
      const files = decided.map((file): DiffFile => {
        if (!('before' in file)) return file;

        const patch = patches.get(file)!;

        return patch
          ? {
              path: file.path,
              status: file.status,
              ...patch,
              generated: isGeneratedPath(file.path) || undefined,
            }
          : { path: file.path, status: file.status, additions: 0, deletions: 0, tooLarge: true };
      });

      return {
        ...base,
        kind: 'rebased',
        note: `The branch was rebased or force-pushed since your review at ${shortSha(reviewOid)}. Each file is compared as you reviewed it with its current version, so changes brought in from ${pr.baseRefName} can appear too.`,
        files,
      };
    } finally {
      release();
    }
  }

  /**
   * Each pair's patch, as `textPatch` computes it: through the pool, off the event loop, when there
   * is one. The first patch to fail stops the build's others, and is its error.
   */
  private async patchAll<P extends { before: string; after: string }>(
    build: Build,
    pairs: P[],
  ): Promise<Map<P, TextPatch | null>> {
    if (!this.patches)
      return new Map(pairs.map((pair) => [pair, textPatch(pair.before, pair.after)]));

    const pool = this.patches;
    const controller = new AbortController();
    const stop = () => controller.abort();

    build.signal?.addEventListener('abort', stop, { once: true });

    try {
      const results = await Promise.all(
        pairs.map((pair) =>
          pool.patch(pair.before, pair.after, controller.signal).catch((error: unknown) => {
            controller.abort();

            throw error;
          }),
        ),
      );

      return new Map(pairs.map((pair, index) => [pair, results[index]]));
    } catch (error) {
      if (error instanceof PoolClosed) throw shuttingDown();

      throw error;
    } finally {
      build.signal?.removeEventListener('abort', stop);
    }
  }
}
