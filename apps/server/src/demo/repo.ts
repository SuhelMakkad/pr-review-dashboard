import type { BlobText, CompareResult, RemoteFile } from '@/github/api.js';
import { textPatch } from '@/diff/patch.js';

interface Commit {
  oid: string;
  parents: string[];
  files: Record<string, string>;
  committedAt?: string;
}

/** A tiny in-memory git model (commits, parents, file contents, refs) for demo diffs. */
export class FixtureRepos {
  private readonly commits = new Map<string, Map<string, Commit>>();
  private readonly refs = new Map<string, Map<string, string>>();

  commit(
    repository: string,
    oid: string,
    parents: string[],
    files: Record<string, string>,
    committedAt?: string,
  ): void {
    if (!this.commits.has(repository)) this.commits.set(repository, new Map());

    this.commits.get(repository)!.set(oid, { oid, parents, files, committedAt });
  }

  /** Builds a child commit by applying changes (null deletes a file) to its parent. */
  derive(
    repository: string,
    oid: string,
    parent: string,
    changes: Record<string, string | null>,
    committedAt?: string,
  ): void {
    const files = { ...this.get(repository, parent)!.files };

    for (const [path, content] of Object.entries(changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }

    this.commit(repository, oid, [parent], files, committedAt);
  }

  ref(repository: string, name: string, oid: string): void {
    if (!this.refs.has(repository)) this.refs.set(repository, new Map());

    this.refs.get(repository)!.set(name, oid);
  }

  has(repository: string, oid: string): boolean {
    return Boolean(this.get(repository, oid));
  }

  files(repository: string, oid: string): Record<string, string> {
    const commit = this.get(repository, oid);

    if (!commit) throw new Error('The repository snapshot is unavailable.');

    return { ...commit.files };
  }

  private resolve(repository: string, refOrOid: string): string {
    return this.refs.get(repository)?.get(refOrOid) ?? refOrOid;
  }

  private get(repository: string, refOrOid: string): Commit | undefined {
    return this.commits.get(repository)?.get(this.resolve(repository, refOrOid));
  }

  private ancestors(repository: string, oid: string): string[] {
    const order: string[] = [];
    const queue = [oid];

    while (queue.length) {
      const current = queue.shift()!;

      if (order.includes(current)) continue;

      order.push(current);
      queue.push(...(this.get(repository, current)?.parents ?? []));
    }

    return order;
  }

  diff(repository: string, from: string, to: string): RemoteFile[] {
    const before = this.get(repository, from)?.files ?? {};
    const after = this.get(repository, to)?.files ?? {};
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const files: RemoteFile[] = [];

    for (const path of paths) {
      if (before[path] === after[path]) continue;

      const patch = textPatch(before[path] ?? '', after[path] ?? '')!;

      files.push({
        path,
        status:
          before[path] === undefined ? 'added' : after[path] === undefined ? 'removed' : 'modified',
        additions: patch.additions,
        deletions: patch.deletions,
        patch: patch.patch,
        sha: null,
      });
    }

    return files;
  }

  compare(repository: string, base: string, head: string): CompareResult | null {
    const baseOid = this.resolve(repository, base);
    const headOid = this.resolve(repository, head);

    if (!this.get(repository, baseOid) || !this.get(repository, headOid)) return null;

    if (baseOid === headOid)
      return { status: 'identical', mergeBaseOid: baseOid, files: [], commits: [] };

    const headAncestors = this.ancestors(repository, headOid);
    const baseAncestors = new Set(this.ancestors(repository, baseOid));
    const mergeBase = headAncestors.find((oid) => baseAncestors.has(oid)) ?? null;
    const status: CompareResult['status'] =
      mergeBase === baseOid ? 'ahead' : mergeBase === headOid ? 'behind' : 'diverged';
    const commits = headAncestors
      .filter((oid) => !baseAncestors.has(oid))
      .reverse()
      .map((oid) => {
        const commit = this.get(repository, oid)!;

        return { oid, parents: commit.parents, committedAt: commit.committedAt ?? null };
      });

    return {
      status,
      mergeBaseOid: mergeBase,
      files: mergeBase ? this.diff(repository, mergeBase, headOid) : [],
      commits,
    };
  }

  blob(repository: string, oid: string, path: string): BlobText | null {
    const text = this.get(repository, oid)?.files[path];

    return text === undefined
      ? null
      : { text, isBinary: false, isTruncated: false, byteSize: text.length };
  }
}
