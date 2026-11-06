import { useQuery } from '@tanstack/react-query';
import type { LinearIssue, LinearStatus } from '@review-desk/shared/tickets';
import { api } from '../../lib/api';

export function useLinearStatus() {
  return useQuery({
    queryKey: ['linear-status'],
    queryFn: () => api<LinearStatus>('/api/linear/status'),
    staleTime: 5 * 60_000,
  });
}

export function useTickets(prId: string | null) {
  return useQuery({
    queryKey: ['tickets', prId],
    queryFn: () =>
      api<{ identifiers: string[]; issues: LinearIssue[]; error: string | null }>(
        `/api/pulls/${encodeURIComponent(prId!)}/tickets`,
      ),
    enabled: Boolean(prId),
    staleTime: 5 * 60_000,
  });
}
