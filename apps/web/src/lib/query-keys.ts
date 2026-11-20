export const queryKeys = {
  status: ['status'] as const,
  accounts: ['accounts'] as const,
  /**
   * Everything one account's PRs hold, each fetched for that account, so one account's answer is
   * never another's: its queue, its own PRs, each PR, its diffs and its tickets.
   */
  account: (account: string | null) => ['account', account] as const,
  pulls: (account: string | null) => ['account', account, 'pulls'] as const,
  mine: (account: string | null) => ['account', account, 'mine'] as const,
  detail: (account: string | null, id: string) => ['account', account, 'detail', id] as const,
  /** Without `mode`, every view of the PR's diff. */
  diff: (account: string | null, id: string, mode?: string) =>
    mode === undefined
      ? (['account', account, 'diff', id] as const)
      : (['account', account, 'diff', id, mode] as const),
  tickets: (account: string | null, id: string) => ['account', account, 'tickets', id] as const,
  /** Fetched for a named account, so the account is part of the key: one never serves another. */
  draft: (prId: string, account: string) => ['draft', prId, account] as const,
  ai: (prId: string, account: string) => ['ai', prId, account] as const,
};
