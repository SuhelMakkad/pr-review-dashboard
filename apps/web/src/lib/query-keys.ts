export const queryKeys = {
  status: ['status'] as const,
  accounts: ['accounts'] as const,
  pulls: ['pulls'] as const,
  mine: ['mine'] as const,
  detail: (id: string) => ['detail', id] as const,
  diff: (id: string, mode: string) => ['diff', id, mode] as const,
  /** Fetched for a named account, so the account is part of the key: one never serves another. */
  draft: (prId: string, account: string) => ['draft', prId, account] as const,
  ai: (prId: string, account: string) => ['ai', prId, account] as const,
};
