import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type {
  PullRequestDetail,
  PullRequestItem,
  PullRequestList,
  SyncStatus,
  TriageUpdate,
} from '@review-desk/shared/types';
import type { AuthorItem } from '@review-desk/shared/author';
import type { NotificationSettings } from '@review-desk/shared/notify';
import type { DiffManifest, DiffMode } from '@review-desk/shared/diff';

export interface MineList {
  account: string | null;
  items: AuthorItem[];
}
import { api } from '@/lib/api';
import { cacheBelongsTo, fallbackInterval, useLive } from '@/lib/live';
import { queryKeys } from '@/lib/query-keys';

export function useStatus() {
  const live = useLive();

  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api<SyncStatus>('/api/status'),
    refetchInterval: fallbackInterval(live, 10_000),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function usePulls() {
  const live = useLive();

  return useQuery({
    queryKey: queryKeys.pulls,
    queryFn: () => api<PullRequestList>('/api/pulls'),
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function useMine() {
  const live = useLive();

  return useQuery({
    queryKey: queryKeys.mine,
    queryFn: () => api<MineList>('/api/mine'),
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function usePullDetail(id: string | null) {
  const live = useLive();

  return useQuery({
    queryKey: queryKeys.detail(id ?? 'none'),
    queryFn: () => api<PullRequestDetail>(`/api/pulls/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function useDiff(id: string | null, mode: DiffMode) {
  return useQuery({
    queryKey: queryKeys.diff(id ?? 'none', mode),
    queryFn: () => api<DiffManifest>(`/api/pulls/${encodeURIComponent(id!)}/diff?mode=${mode}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: ['notify-settings'],
    queryFn: () => api<NotificationSettings>('/api/notifications/settings'),
    staleTime: 60_000,
  });
}

export function useSyncNow() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => api<SyncStatus>('/api/sync', { method: 'POST' }),
    // A reply sent before a switch must not switch the screens back; switches arrive through
    // adoptStatus.
    onSuccess: (status) => {
      if (status.account && cacheBelongsTo(client, status.account.login, queryKeys.status))
        client.setQueryData(queryKeys.status, status);
    },
  });
}

type Update = Omit<TriageUpdate, 'account'>;

/** Predicts how a triage update changes a list item, so the UI responds instantly. */
export function applyOptimistic(
  item: PullRequestItem,
  update: Update,
  now = Date.now(),
): PullRequestItem {
  let next = { ...item };

  if (update.note !== undefined) next.hasNote = update.note.trim().length > 0;

  if (update.seenReplyKeys) {
    const seen = new Set(update.seenReplyKeys);

    next.unreadReplyKeys = next.unreadReplyKeys.filter((key) => !seen.has(key));
    next.reasons = next.reasons.filter(
      (reason) => reason.kind !== 'reply' || !seen.has(reason.key),
    );
  }

  if (update.snoozeUntil !== undefined) {
    next =
      update.snoozeUntil && Date.parse(update.snoozeUntil) > now
        ? { ...next, queue: 'snoozed', snoozedUntil: update.snoozeUntil, doneAt: null }
        : { ...next, snoozedUntil: null };
  }

  if (update.done !== undefined) {
    next = update.done
      ? { ...next, queue: 'caught_up', doneAt: new Date(now).toISOString(), snoozedUntil: null }
      : { ...next, doneAt: null };
  }

  return next;
}

export interface TriageVariables {
  id: string;
  account: string;
  update: Update;
}

/**
 * Applies a triage update optimistically, writes it, and rolls back on failure. Independent of any
 * component, so callers can navigate away (e.g. auto-advance) without losing the result. The
 * cached queue and PR belong to the account it was sent for, so they are left alone once another
 * account is on screen.
 */
export async function runTriage(
  client: QueryClient,
  { id, account, update }: TriageVariables,
): Promise<PullRequestDetail> {
  const owned = (key: QueryKey) => cacheBelongsTo(client, account, key);

  await client.cancelQueries({ queryKey: queryKeys.pulls });

  const previous = owned(queryKeys.pulls)
    ? client.getQueryData<PullRequestList>(queryKeys.pulls)
    : undefined;

  if (previous) {
    client.setQueryData<PullRequestList>(queryKeys.pulls, {
      ...previous,
      items: previous.items.map((item) => (item.id === id ? applyOptimistic(item, update) : item)),
    });
  }

  try {
    const detail = await api<PullRequestDetail>(`/api/pulls/${encodeURIComponent(id)}/triage`, {
      method: 'PATCH',
      body: { account, ...update },
    });

    if (owned(queryKeys.detail(id))) client.setQueryData(queryKeys.detail(id), detail);

    return detail;
  } catch (error) {
    if (previous && owned(queryKeys.pulls)) client.setQueryData(queryKeys.pulls, previous);

    throw error;
  } finally {
    void client.invalidateQueries({ queryKey: queryKeys.pulls });
  }
}

export function useTriage() {
  const client = useQueryClient();

  return useMutation({ mutationFn: (variables: TriageVariables) => runTriage(client, variables) });
}
