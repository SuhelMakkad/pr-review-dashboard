import { describe, expect, it } from 'vitest';
import { forgeTraits, traitsOf } from '@/traits.js';

describe('forge traits', () => {
  it("are each account's forge's, and frozen all the way down", () => {
    expect(traitsOf('octo')).toBe(forgeTraits.github);
    expect(traitsOf('rev@gitlab.example')).toBe(forgeTraits.gitlab);
    expect(traitsOf('rev@gitlab.example').signIn('gitlab.example')).toBe(
      'glab auth login --hostname gitlab.example',
    );

    expect(Object.isFrozen(forgeTraits)).toBe(true);
    expect(Object.isFrozen(forgeTraits.github)).toBe(true);
    expect(Object.isFrozen(forgeTraits.github.reference)).toBe(true);
    expect(Object.isFrozen(forgeTraits.gitlab.reference)).toBe(true);
  });
});
