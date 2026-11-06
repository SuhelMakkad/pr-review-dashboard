import { describe, expect, it } from 'vitest';
import { commentableLines, mapLine, parseHunks, withFileHeaders } from '@review-desk/shared/diff';
import { textPatch } from '../apps/server/src/diff/patch';
import { DiffService } from '../apps/server/src/diff/service';
import { Store } from '../apps/server/src/db/store';
import { FixtureGitHub } from '../apps/server/src/demo/fixture-github';
import { defaultScenario } from '../apps/server/src/demo/scenario';
import { SyncService } from '../apps/server/src/sync/index';

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
    expect(manifest.files.map((file) => file.path)).toEqual(['src/collections/CollectionFilterEditor.tsx']);
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
