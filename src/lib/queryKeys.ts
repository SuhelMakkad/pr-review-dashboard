export const queryKeys = {
  status: ['status'] as const,
  pulls: ['pulls'] as const,
  mine: ['mine'] as const,
  detail: (id: string) => ['detail', id] as const,
  diff: (id: string, mode: string) => ['diff', id, mode] as const,
};
