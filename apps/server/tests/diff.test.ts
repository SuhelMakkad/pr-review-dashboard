import { describe, expect, it } from 'vitest';
import { commentableLines, mapLine, parseHunks, withFileHeaders } from '@review-desk/shared/diff';
import { textPatch } from '@/diff/patch.js';
import { DiffService } from '@/diff/service.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { SyncService } from '@/sync/index.js';

async function demo() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, github);

  await service.sync();

  const byNumber = (number: number) => {
    const item = [...service.list().items, ...service.mine().items].find(
      (entry) => entry.number === number,
    )!;

    return service.detail(item.id)!;
  };

  return { service, github, diffs: new DiffService(github), byNumber, close: () => store.close() };
}

describe('patch helpers', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const after = before
    .replace('line 5\n', 'line 5 changed\n')
    .replace('line 12\n', 'line 12\nline 12b\nline 12c\n');
  const patch = textPatch(before, after)!;

  it('builds GitHub-style hunks and counts lines', () => {
    expect(patch.additions).toBe(3);
    expect(patch.deletions).toBe(1);
    expect(parseHunks(patch.patch).length).toBeGreaterThanOrEqual(1);
    expect(withFileHeaders({ path: 'a.ts', status: 'modified', patch: patch.patch })).toMatch(
      /^diff --git a\/a.ts b\/a.ts\n--- a\/a.ts\n\+\+\+ b\/a.ts\n@@/,
    );
  });

  it('maps unchanged lines across edits and refuses changed ones', () => {
    expect(mapLine(patch.patch, 2)).toBe(2);
    expect(mapLine(patch.patch, 5)).toBeNull();
    expect(mapLine(patch.patch, 10)).toBe(10);
    expect(mapLine(patch.patch, 15)).toBe(17);
  });

  it('lists the lines GitHub will accept comments on', () => {
    const lines = commentableLines(patch.patch);

    expect(lines.right.has(5)).toBe(true);
    expect(lines.left.has(5)).toBe(true);
    expect(lines.right.has(13)).toBe(true);
    expect(lines.right.has(1)).toBe(false);
  });
});

describe('review diffs', () => {
  it('shows a force-pushed PR as a content interdiff since your review', async () => {
    const { diffs, byNumber, close } = await demo();
    const detail = byNumber(2041);
    const manifest = await diffs.manifest(
      detail.snapshot,
      'since-review',
      detail.item.latestReview!.commitOid,
    );

    expect(manifest.kind).toBe('rebased');
    expect(manifest.note).toMatch(/rebased or force-pushed/);
    expect(manifest.files.map((file) => file.path)).toEqual([
      'pnpm-lock.yaml',
      'src/db/migrations/0042_product_metadata.sql',
      'src/facts/backfill.ts',
      'src/facts/repository.ts',
      'tests/facts/repository.test.ts',
    ]);
    expect(manifest.files.find((file) => file.path === 'pnpm-lock.yaml')?.generated).toBe(true);
    expect(manifest.files.find((file) => file.path.endsWith('.sql'))?.patch).toMatch(
      /\+CREATE INDEX product_metadata_by_product_kind/,
    );
    close();
  });

  it('shows only the new commits for a fast-forward', async () => {
    const { diffs, byNumber, close } = await demo();
    const detail = byNumber(877);
    const manifest = await diffs.manifest(
      detail.snapshot,
      'since-review',
      detail.item.latestReview!.commitOid,
    );

    expect(manifest.kind).toBe('fast-forward');
    expect(manifest.files.map((file) => file.path)).toEqual([
      'src/collections/CollectionFilterEditor.tsx',
    ]);
    close();
  });

  it('reports nothing new when you reviewed the current head, and the full diff otherwise', async () => {
    const { diffs, byNumber, close } = await demo();
    const reviewedAtHead = byNumber(870);

    expect(
      (
        await diffs.manifest(
          reviewedAtHead.snapshot,
          'since-review',
          reviewedAtHead.snapshot.headOid,
        )
      ).kind,
    ).toBe('identical');

    const full = await diffs.manifest(byNumber(2041).snapshot, 'full', null);

    expect(full.kind).toBe('full');
    expect(full.files.map((file) => file.path)).toContain('src/facts/types.ts');
    expect(full.files.every((file) => file.viewed === 'UNVIEWED')).toBe(true);
    close();
  });

  it('falls back to the full diff when the reviewed commit no longer exists', async () => {
    const { diffs, byNumber, close } = await demo();
    const detail = byNumber(2041);
    const manifest = await diffs.manifest(detail.snapshot, 'since-review', 'f'.repeat(40));

    expect(manifest.kind).toBe('unavailable');
    expect(manifest.note).toMatch(/no longer on GitHub/);
    expect(manifest.files.length).toBeGreaterThan(0);
    close();
  });

  it('keeps demo snapshots consistent with their diffs', async () => {
    const { byNumber, close } = await demo();
    const pr = byNumber(2041).snapshot;

    expect(pr.changedFiles).toBe(pr.files.length);
    expect(pr.additions).toBe(pr.files.reduce((sum, file) => sum + file.additions, 0));
    close();
  });
});

describe('viewed keys in diff manifests', () => {
  it('names the diff the manifest renders, and shows viewed state only for that diff', async () => {
    const { diffs, github, byNumber, close } = await demo();

    try {
      const pr = byNumber(1839).snapshot;
      const path = pr.files[0]!.path;
      const pullFiles = github.pullFiles.bind(github);

      // The forge keys each file's diff (as GitLab does); the manifest is built and cached for A.
      github.pullFiles = async (...args) =>
        (await pullFiles(...args)).map((file) => ({
          ...file,
          keyed: true,
          viewedKey: `rendered:${file.path}`,
        }));

      const first = await diffs.manifest(
        { ...pr, files: pr.files.map((file) => ({ ...file, viewedKey: `rendered:${file.path}` })) },
        'full',
        null,
      );

      expect(first.revision).toEqual({ headOid: pr.headOid, baseOid: pr.baseOid ?? null });
      expect(first.files.find((file) => file.path === path)?.viewedKey).toBe(`rendered:${path}`);

      // The stored PR now carries another diff's key and its viewed state, under the same head.
      const later = await diffs.manifest(
        {
          ...pr,
          files: pr.files.map((file) => ({
            ...file,
            viewedKey: `newer:${file.path}`,
            viewerViewedState: 'VIEWED' as const,
          })),
        },
        'full',
        null,
      );
      const file = later.files.find((candidate) => candidate.path === path)!;

      expect(file.viewedKey).toBe(`rendered:${path}`);
      expect(file.viewed).toBe('UNVIEWED');
    } finally {
      close();
    }
  });
});

describe('diffs whose revision cannot be confirmed', () => {
  it('shows them without keeping them, and they cannot be marked viewed', async () => {
    const { diffs, github, byNumber, close } = await demo();

    try {
      const pr = byNumber(1839).snapshot;
      const keyed = { ...pr, files: pr.files.map((file) => ({ ...file, viewedKey: 'stored' })) };
      const pullFiles = github.pullFiles.bind(github);
      let reads = 0;

      // A forge that keys diffs, but could not pin this listing to the head asked for.
      github.pullFiles = async (...args) => {
        reads++;

        return (await pullFiles(...args)).map((file) => ({ ...file, keyed: true }));
      };

      const first = await diffs.manifest(keyed, 'full', null);

      expect(first.keyed).toBe(true);
      expect(first.files.every((file) => !file.viewedKey && file.viewed === 'UNVIEWED')).toBe(true);

      await diffs.manifest(keyed, 'full', null);
      expect(reads).toBe(2);
    } finally {
      close();
    }
  });

  it('keeps a since-review view when its keys cannot be read, and skips the read when empty', async () => {
    const { diffs, github, byNumber, close } = await demo();

    try {
      const pr = byNumber(2041).snapshot;
      const keyed = { ...pr, files: pr.files.map((file) => ({ ...file, viewedKey: 'stored' })) };
      let reads = 0;

      github.pullFiles = async () => {
        reads++;
        throw new Error('GitLab is unavailable');
      };

      // Reviewed at the current head: nothing changed, and nothing is read for it.
      const same = await diffs.manifest(keyed, 'since-review', pr.headOid);

      expect(same.kind).toBe('identical');
      expect(reads).toBe(0);

      const review = pr.reviews.find((entry) => entry.commitOid && entry.commitOid !== pr.headOid);
      const since = await diffs.manifest(keyed, 'since-review', review!.commitOid);

      expect(since.files.length).toBeGreaterThan(0);
      expect(since.keyed).toBe(true);
      expect(since.files.every((file) => !file.viewedKey)).toBe(true);
    } finally {
      close();
    }
  });
});
