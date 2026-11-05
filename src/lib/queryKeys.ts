export const queryKeys = {
  status: ['status'] as const,
  pulls: ['pulls'] as const,
  detail: (id: string) => ['detail', id] as const,
};
