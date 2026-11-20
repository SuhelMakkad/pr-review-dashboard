import { useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type { ServerEvent } from '@review-desk/shared/events';
import type { SyncStatus } from '@review-desk/shared/types';
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

/**
 * Answers that survive an account switch: those that hold nothing of any one account, and those
 * keyed by the account they were fetched for (`queryKeys.account`), which can never be shown for
 * another one and are left to expire on their own.
 */
const SHARED_QUERIES = new Set<unknown>([
  queryKeys.status[0],
  'status-poll',
  queryKeys.accounts[0],
  queryKeys.account(null)[0],
]);

/**
 * Shows a new sync status, the only way one is shown. Of two statuses from this server process,
 * the one with the lower revision is older, however late it arrives, and is ignored; one from
 * another process means the server restarted with a new session, so the page reloads, as it does
 * when the event stream says so.
 *
 * When it names another account than the one shown, answers not keyed by an account are dropped
 * rather than refetched, so no screen shows, or starts editing, the previous account's drafts or
 * runs while the new account's load. The routed pages remount at the same time (`useRemountKey`
 * in the shell), so nothing they hold carries over either.
 */
export function adoptStatus(client: QueryClient, status: SyncStatus): void {
  const boot = session.bootId();

  if (status.bootId && boot && status.bootId !== boot) {
    window.location.reload();
    return;
  }

  const previous = client.getQueryData<SyncStatus>(queryKeys.status);

  if (
    previous?.revision !== undefined &&
    status.revision !== undefined &&
    previous.bootId === status.bootId &&
    status.revision < previous.revision
  )
    return;

  const login = status.account?.login ?? null;
  const shown = previous?.account?.login ?? null;
  const switched = shown !== null && shown !== login;

  if (switched)
    client.removeQueries({ predicate: (query: Query) => !SHARED_QUERIES.has(query.queryKey[0]) });

  client.setQueryData(queryKeys.status, status);

  // Answers kept from when this account was last shown may be out of date (a snooze that has
  // ended since, say): read them again.
  if (switched) void client.invalidateQueries({ queryKey: queryKeys.account(login) });

  // The first status names the account the cached answers were loaded for; refresh them.
  if (!switched && previous?.account?.login !== status.account?.login)
    void client.invalidateQueries();
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

/** Applies one server event to the cache. Exported for tests. */
export function handle(client: QueryClient, event: ServerEvent, firstHello: { value: boolean }) {
  switch (event.type) {
    case 'hello': {
      const expected = session.bootId();

      // A different boot means the server restarted with a new session token.
      if (expected && event.bootId !== expected) {
        window.location.reload();
        return;
      }

      setState({ demo: event.demo });

      // Every connection reads the status again, the first included: another window may have
      // switched accounts between this page's first status and the stream opening.
      // `refresh` reads again after a first read already on its way, which could predate a switch.
      if (firstHello.value) refresh(client, ['status-poll']);
      else void client.invalidateQueries();

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
      // Only the account whose PRs changed: another account's screens never refetch for it.
      refresh(client, queryKeys.pulls(event.account));
      // New commits can make a saved review out of date.
      refresh(client, ['ai-reviews']);

      for (const id of event.ids) {
        refresh(client, queryKeys.detail(event.account, id));
        refresh(client, queryKeys.diff(event.account, id));
        // A PR's tickets come from its branch, title and body.
        refresh(client, queryKeys.tickets(event.account, id));
        refresh(client, ['ai', id]);
      }

      refresh(client, queryKeys.mine(event.account));

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
        refresh(client, queryKeys.diff(event.account, event.prId));
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
      refresh(client, queryKeys.pulls(event.account));
      // My PRs shows which of your PRs have a note.
      refresh(client, queryKeys.mine(event.account));
      refresh(client, queryKeys.detail(event.account, event.id));
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
