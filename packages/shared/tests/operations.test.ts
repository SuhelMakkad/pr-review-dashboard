import { describe, expect, it } from 'vitest';
import { showsViewedTarget } from '@/operations.js';

const revision = { headOid: 'a'.repeat(40), baseOid: 'b'.repeat(40) };

describe('which view shows the diff a viewed mark names', () => {
  it('matches the file’s own diff where the forge identifies it', () => {
    expect(showsViewedTarget({ ...revision, fileKey: 'diff-a' }, revision, 'diff-a')).toBe(true);
    expect(showsViewedTarget({ ...revision, fileKey: 'diff-a' }, revision, 'diff-b')).toBe(false);
    // The same diff under a newer head still matches; the head alone decides nothing here.
    expect(
      showsViewedTarget(
        { ...revision, fileKey: 'diff-a' },
        { ...revision, headOid: 'c' },
        'diff-a',
      ),
    ).toBe(true);
  });

  it('never matches when only one side identifies the file’s diff', () => {
    expect(showsViewedTarget(revision, revision, 'diff-a')).toBe(false);
    expect(showsViewedTarget({ ...revision, fileKey: 'diff-a' }, revision, undefined)).toBe(false);
  });

  it('otherwise needs the same head and base', () => {
    expect(showsViewedTarget(revision, revision, undefined)).toBe(true);
    expect(showsViewedTarget(revision, { ...revision, headOid: 'c'.repeat(40) }, undefined)).toBe(
      false,
    );
    expect(showsViewedTarget(revision, { ...revision, baseOid: null }, undefined)).toBe(false);
  });
});
