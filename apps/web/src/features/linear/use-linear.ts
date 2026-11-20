import { useQuery } from '@tanstack/react-query';
import type { LinearIssue, LinearStatus } from '@review-desk/shared/tickets';
import { api } from '@/lib/api';
import { accountPath, useAccount } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';

export function useLinearStatus() {
  return useQuery({
    queryKey: ['linear-status'],
    queryFn: () => api<LinearStatus>('/api/linear/status'),
    staleTime: 5 * 60_000,
  });
}

/** The Linear issues a PR names, for the account on screen: its own copy of the PR. */
export function useTickets(prId: string | null) {
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.tickets(account, prId ?? 'none'),
    queryFn: () =>
      api<{ identifiers: string[]; issues: LinearIssue[]; error: string | null }>(
        accountPath(account!, `/pulls/${encodeURIComponent(prId!)}/tickets`),
      ),
    enabled: Boolean(prId) && account !== null,
    staleTime: 5 * 60_000,
  });
}

/** Every account's tickets, as after connecting or disconnecting Linear. */
export const isTicketQuery = (key: readonly unknown[]) =>
  key[0] === queryKeys.account(null)[0] && key[2] === 'tickets';
