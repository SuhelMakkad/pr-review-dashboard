import { useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type { ServerEvent } from '@review-desk/shared/events';
import type { PullRequestList, SyncStatus } from '@review-desk/shared/types';
import { queryKeys } from '@/lib/query-keys';
import { session } from '@/lib/session';
import { present } from '@/lib/notifications';

export interface LiveState {
  connected: boolean;
  /** When the stream last dropped; queries fall back to polling while disconnected. */
  disconnectedAt: number | null;
  demo: boolean;
}

let state: LiveState = { connected: false, disconnectedAt: Date.now(), demo: session.demo() };
const listeners = new Set<() => void>();

function setState(next: Partial<LiveState>) {
  state = { ...state, ...next };

  for (const listener of listeners) listener();
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Polling interval to use for a query: none while the event stream is healthy. */
export function fallbackInterval(live: LiveState, ms = 15_000): number | false {
  return live.connected ? false : ms;
}

/** Answers that hold nothing of any one account, so they survive an account switch. */
const SHARED_QUERIES = new Set<unknown>([queryKeys.status[0], queryKeys.accounts[0]]);

/**
 * Shows a new sync status. When it names another account than the cached answers belong to, they
 * are dropped rather than refetched, so no screen shows, or starts editing, the previous account's
 * PRs, notes or drafts while the new account's load. The routed pages remount at the same time
 * (`useRemountKey` in the shell), so nothing they hold carries over either.
 */
export function adoptStatus(client: QueryClient, status: SyncStatus): void {
  const login = status.account?.login ?? null;
  const previous = client.getQueryData<SyncStatus>(queryKeys.status);
  const shown = previous?.account?.login ?? null;
  const listed = client.getQueryData<PullRequestList>(queryKeys.pulls)?.account ?? null;
  const switched = (shown !== null && shown !== login) || (listed !== null && listed !== login);

  if (switched)
    client.removeQueries({ predicate: (query: Query) => !SHARED_QUERIES.has(query.queryKey[0]) });

  client.setQueryData(queryKeys.status, status);

  // The first status names the account the cached answers were loaded for; refresh them.
  if (!switched && previous?.account?.login !== status.account?.login)
    void client.invalidateQueries();
}

/**
 * True when the cached answer at `queryKey` belongs to `account`, so a write made for that account
 * may update it or roll it back. A write can finish after a switch (removing queries does not stop
 * it), and the switch can reach the cache in either order: through the answer itself (another
 * window switched, and new PR data arrived before the status) or through the status (the answer was
 * dropped). So the answer's own account decides, and the status only when there is none. Every
 * mutation checks this before writing into a key both accounts share (a PR's detail, the queue, a
 * diff), so the previous account's data never reappears on the new account's screens.
 */
export function cacheBelongsTo(client: QueryClient, account: string, queryKey: QueryKey): boolean {
  const answer = client.getQueryData<{ account?: unknown }>(queryKey);
  const owner =
    typeof answer?.account === 'string'
      ? answer.account
      : client.getQueryData<SyncStatus>(queryKeys.status)?.account?.login;

  // Before the first status nothing can have switched yet.
  return owner === undefined || owner === account;
}

/**
 * Refetches what an event changed. TanStack Query folds an invalidation into a first load that is
 * already on its way, and that load can carry the state from just before the event (a reload
 * racing an outbox update, say), so such a load is invalidated again once it lands.
 */
export function refresh(client: QueryClient, queryKey: QueryKey): void {
  const cache = client.getQueryCache();

  for (const query of cache.findAll({ queryKey })) {
    if (query.state.data !== undefined || query.state.fetchStatus !== 'fetching') continue;

    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type !== 'removed' && query.state.fetchStatus === 'fetching') return;

      unsubscribe();
      if (event.type !== 'removed')
        void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    });
  }

  void client.invalidateQueries({ queryKey });
}

function handle(client: QueryClient, event: ServerEvent, firstHello: { value: boolean }) {
  switch (event.type) {
    case 'hello': {
      const expected = session.bootId();

      // A different boot means the server restarted with a new session token.
      if (expected && event.bootId !== expected) {
        window.location.reload();
        return;
      }

      setState({ demo: event.demo });

      if (!firstHello.value) void client.invalidateQueries();

      firstHello.value = false;
      return;
    }
    case 'resync':
      void client.invalidateQueries();
      return;
    case 'status':
      adoptStatus(client, event.status);
      return;
    case 'pulls.changed':
      refresh(client, queryKeys.pulls);
      // New commits can make a saved review out of date.
      refresh(client, ['ai-reviews']);

      for (const id of event.ids) {
        refresh(client, queryKeys.detail(id));
        refresh(client, ['diff', id]);
        refresh(client, ['ai', id]);
      }

      refresh(client, queryKeys.mine);

      return;
    case 'notify':
      void present(event.notifications);
      return;
    case 'insights.updated':
      refresh(client, ['insights']);
      return;
    case 'operation.updated':
      refresh(client, ['operations', event.account]);
      refresh(client, ['draft', event.prId]);
      if (['needs_attention', 'cancelled'].includes(event.status))
        refresh(client, ['diff', event.prId]);
      return;
    case 'ai.updated':
      refresh(client, ['ai', event.prId]);
      refresh(client, ['ai-reviews']);
      return;
    case 'draft.updated':
      refresh(client, ['draft', event.id]);
      refresh(client, ['ai', event.id]);
      return;
    case 'triage.updated':
      refresh(client, queryKeys.pulls);
      refresh(client, queryKeys.detail(event.id));
      return;
  }
}

/** Opens the server event stream. EventSource reconnects by itself and replays via Last-Event-ID. */
export function startLive(client: QueryClient): () => void {
  if (typeof EventSource === 'undefined') return () => {};

  const firstHello = { value: true };
  const source = new EventSource('/api/events');

  source.onopen = () => setState({ connected: true, disconnectedAt: null });
  source.onerror = () => {
    if (state.connected) setState({ connected: false, disconnectedAt: Date.now() });
  };
  source.onmessage = (message) => {
    try {
      handle(client, JSON.parse(message.data) as ServerEvent, firstHello);
    } catch {
      // Ignore malformed frames; the next event or resync restores consistency.
    }
  };

  return () => source.close();
}
