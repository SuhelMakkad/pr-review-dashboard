import { useState } from 'react';

/**
 * A React key for content that belongs to one identity, such as an account or an account and a PR.
 * It changes whenever the identity changes from one known value to another, so the content
 * remounts and drops what it holds (unsaved editor text, pending autosaves) instead of carrying it
 * over. It stays the same while the identity first loads, so startup never remounts anything.
 */
export function useRemountKey(identity: string | null | undefined): number {
  const [scope, setScope] = useState({ identity: identity || null, generation: 0 });

  if (identity && identity !== scope.identity) {
    setScope({ identity, generation: scope.identity ? scope.generation + 1 : scope.generation });
  }

  return scope.generation;
}
