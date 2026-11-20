import { useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { GitHubOperation, OperationList } from '@review-desk/shared/operations';
import { api } from '@/lib/api';
import { fallbackInterval, useLive } from '@/lib/live';
import { accountPath } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';

let open = false;
const listeners = new Set<() => void>();

export function setActivityOpen(next: boolean) {
  open = next;

  for (const listener of listeners) listener();
}

export const openActivity = () => setActivityOpen(true);

export function useActivityOpen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    () => open,
  );
}

/** One operation by id, whichever page of Activity it is on; null while there is none. */
export function useOperation(account: string, id: string | null) {
  const live = useLive();

  return useQuery({
    queryKey: queryKeys.operation(account, id),
    queryFn: () =>
      api<{ operation: GitHubOperation }>(
        accountPath(account, `/operations/${encodeURIComponent(id!)}`),
      ).then((response) => response.operation),
    enabled: Boolean(account && id),
    staleTime: live.connected ? Infinity : 0,
    refetchInterval: fallbackInterval(live),
  });
}

export function useOperations(account: string) {
  const live = useLive();

  return useInfiniteQuery({
    queryKey: queryKeys.operations(account),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<OperationList>(
        accountPath(
          account,
          `/operations${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(account),
    staleTime: live.connected ? Infinity : 0,
    refetchInterval: fallbackInterval(live),
  });
}
