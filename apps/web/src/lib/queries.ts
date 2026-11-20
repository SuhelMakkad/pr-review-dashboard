import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  GitHubAccountList,
  PullRequestDetail,
  PullRequestItem,
  PullRequestList,
  SyncStatus,
  TriageUpdate,
} from '@review-desk/shared/types';
import { forgeTerms, type ForgeTerms } from '@review-desk/shared/accounts';
import type { AuthorItem } from '@review-desk/shared/author';
import type { NotificationSettings } from '@review-desk/shared/notify';
import type { DiffManifest, DiffMode } from '@review-desk/shared/diff';

export interface MineList {
  account: string | null;
  items: AuthorItem[];
}
import { api } from '@/lib/api';
import { adoptStatus, fallbackInterval, useLive } from '@/lib/live';
import { queryKeys } from '@/lib/query-keys';

/** Polls the server's status under its own key; what it reads is shown only by `adoptStatus`. */
const statusPoll = (client: QueryClient) => ({
  queryKey: ['status-poll'] as const,
  queryFn: async () => {
    const status = await api<SyncStatus>('/api/status');

    adoptStatus(client, status);

    return status.revision ?? 0;
  },
});

/** Reads the status now (with a poll already on its way, that one), adopting it. */
export function readStatus(client: QueryClient): Promise<unknown> {
  return client.fetchQuery({ ...statusPoll(client), staleTime: 0 });
}

/**
 * The status shown. `adoptStatus` is its only writer, whatever the source (this poll, the event
 * stream, a sync or switch reply), so an older status that arrives late never replaces a newer one:
 * the query itself never fetches.
 */
export function useStatus() {
  const client = useQueryClient();
  const live = useLive();

  useQuery({
    ...statusPoll(client),
    refetchInterval: fallbackInterval(live, 10_000),
    staleTime: live.connected ? Infinity : 0,
  });

  return useQuery<SyncStatus>({ queryKey: queryKeys.status, queryFn: skipToken });
}

/** The account on screen: every query of its PRs is for it. Null until the first status. */
export function useAccount(): string | null {
  return useStatus().data?.account?.login ?? null;
}

/** A route of one account's PRs: `/api/accounts/<account><path>`. */
export function accountPath(account: string, path: string): string {
  return `/api/accounts/${encodeURIComponent(account)}${path}`;
}

/** Names for the current account's forge (GitHub or GitLab, PR or MR), for labels and messages. */
export function useForge(): ForgeTerms {
  return forgeTerms(useStatus().data?.account?.login);
}

/**
 * An account's list, or, before any account is known, the status: read here too, so a failure to
 * read it shows as this list's error, with its retry, instead of a list that never loads. Once the
 * status is known its account's list loads under that account's key; with no account at all (no
 * sign-in) the list is empty, as the server's own answer for no account is.
 */
async function listFor<T>(
  client: QueryClient,
  account: string | null,
  path: string,
  none: T,
): Promise<T> {
  if (account) return api<T>(accountPath(account, path));
  if (!client.getQueryData(queryKeys.status)) await readStatus(client);

  return none;
}

export function usePulls() {
  const client = useQueryClient();
  const live = useLive();
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.pulls(account),
    queryFn: () =>
      listFor<PullRequestList>(client, account, '/pulls', { account: null, items: [] }),
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function useMine() {
  const client = useQueryClient();
  const live = useLive();
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.mine(account),
    queryFn: () => listFor<MineList>(client, account, '/mine', { account: null, items: [] }),
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function usePullDetail(id: string | null) {
  const live = useLive();
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.detail(account, id ?? 'none'),
    queryFn: () =>
      api<PullRequestDetail>(accountPath(account!, `/pulls/${encodeURIComponent(id!)}`)),
    enabled: Boolean(id) && account !== null,
    refetchInterval: fallbackInterval(live),
    staleTime: live.connected ? Infinity : 0,
  });
}

export function useDiff(id: string | null, mode: DiffMode) {
  const account = useAccount();

  return useQuery({
    queryKey: queryKeys.diff(account, id ?? 'none', mode),
    queryFn: () =>
      api<DiffManifest>(
        accountPath(account!, `/pulls/${encodeURIComponent(id!)}/diff?mode=${mode}`),
      ),
    enabled: Boolean(id) && account !== null,
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

/** GitHub CLI sign-ins. Listing checks each one with GitHub, so it loads only when shown. */
export function useAccounts(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => api<GitHubAccountList>('/api/accounts'),
    enabled,
    staleTime: 60_000,
  });
}

/** Switches Review Desk to another GitHub CLI account; the GitHub CLI itself stays as it is. */
export function useSwitchAccount() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (variables: { from: string | null; to: string }) =>
      api<SyncStatus>('/api/accounts/switch', { body: variables }),
    onSuccess: (status) => adoptStatus(client, status),
  });
}

export function useSyncNow() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => api<SyncStatus>('/api/sync', { method: 'POST' }),
    // Ordered by its revision like every status: a reply older than the status shown is ignored.
    onSuccess: (status) => adoptStatus(client, status),
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
 * Applies a triage update optimistically to the account's queue, writes it to that account, and
 * rolls back on failure. Independent of any component, so callers can navigate away (e.g.
 * auto-advance) without losing the result. Everything it touches is keyed by the account it was
 * sent for, so a switch meanwhile never shows it on the other account's screens. The reply is not
 * written into the PR's detail: it could be older than a refresh that arrived meanwhile, so the
 * detail is read again instead.
 */
export async function runTriage(
  client: QueryClient,
  { id, account, update }: TriageVariables,
): Promise<PullRequestDetail> {
  const queue = queryKeys.pulls(account);

  await client.cancelQueries({ queryKey: queue });

  const previous = client.getQueryData<PullRequestList>(queue);

  if (previous) {
    client.setQueryData<PullRequestList>(queue, {
      ...previous,
      items: previous.items.map((item) => (item.id === id ? applyOptimistic(item, update) : item)),
    });
  }

  try {
    return await api<PullRequestDetail>(
      accountPath(account, `/pulls/${encodeURIComponent(id)}/triage`),
      { method: 'PATCH', body: update },
    );
  } catch (error) {
    if (previous) client.setQueryData(queue, previous);

    throw error;
  } finally {
    void client.invalidateQueries({ queryKey: queue });
    void client.invalidateQueries({ queryKey: queryKeys.mine(account) });
    void client.invalidateQueries({ queryKey: queryKeys.detail(account, id) });
  }
}

export function useTriage() {
  const client = useQueryClient();

  return useMutation({ mutationFn: (variables: TriageVariables) => runTriage(client, variables) });
}
