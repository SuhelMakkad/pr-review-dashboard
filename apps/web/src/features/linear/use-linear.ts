import { call } from '@/lib/call';
import { routes } from '@review-desk/shared/contract';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';

export function useLinearStatus() {
  return useQuery({
    queryKey: ['linear-status'],
    queryFn: ({ signal }) => call(routes.linearStatus, { params: {}, signal }),
    staleTime: 5 * 60_000,
  });
}

/** The Linear issues a PR names, for the account on screen: its own copy of the PR. */
export function useTickets(prId: string | null) {
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.tickets(account, prId ?? 'none'),
    queryFn: ({ signal }) =>
      call(routes.tickets, { params: { account: account!, id: prId! }, signal }),
    enabled: Boolean(prId) && account !== null,
    staleTime: 5 * 60_000,
  });
}

/** Every account's tickets, as after connecting or disconnecting Linear. */
export const isTicketQuery = (key: readonly unknown[]) =>
  key[0] === queryKeys.account(null)[0] && key[2] === 'tickets';
