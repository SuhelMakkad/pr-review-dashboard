import { useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { routes, serverEvent } from '@review-desk/shared/contract';
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

let switches = 0;

/** How many times the account shown has changed: an answer that crossed a switch is not cached. */
export function accountSwitches(): number {
  return switches;
}

const isDraft = (key: QueryKey) => key[0] === queryKeys.account(null)[0] && key[2] === 'draft';
const isInsights = (query: Query) =>
  query.queryKey[0] === queryKeys.account(null)[0] && query.queryKey[2] === 'insights';

/**
 * Shows a new sync status, the only way one is shown. Of two statuses from this server process,
 * the one with the lower revision is older, however late it arrives, and is ignored; one from
 * another process means the server restarted with a new session, so the page reloads, as it does
 * when the event stream says so.
 *
 * Every account's answers are keyed by that account (`queryKeys.account`), so none is ever shown
 * for another, and the rest are no one account's. When the account shown changes, its answers
 * are read again, and every account's drafts are dropped: editable, they are never shown from
 * before a switch. The routed pages remount at the same time (`useRemountKey` in the shell), so
 * nothing they hold carries over either.
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

  if (switched) {
    switches += 1;
    client.removeQueries({ predicate: (query: Query) => isDraft(query.queryKey) });
  }

  client.setQueryData(queryKeys.status, status);

  // Answers kept from when this account was last shown may be out of date (a snooze that has
  // ended since, say): read them again. The account left keeps its AI runs, whose restarts now
  // wait for it: read again too, so none shows a countdown that is not running.
  if (switched) {
    refresh(client, queryKeys.account(login));
    refresh(client, queryKeys.aiReviews(shown));
    refresh(
      client,
      (query: Query) =>
        query.queryKey[0] === queryKeys.account(null)[0] &&
        query.queryKey[1] === shown &&
        query.queryKey[2] === 'ai',
    );
  }

  // The first status names the account the cached answers were loaded for; refresh them.
  if (!switched && previous?.account?.login !== status.account?.login)
    void client.invalidateQueries();
}

/**
 * Refetches what an event changed. TanStack Query folds an invalidation into a first load that is
 * already on its way, and that load can carry the state from just before the event (a reload
 * racing an outbox update, say), so such a load is invalidated again once it lands.
 */
export function refresh(client: QueryClient, target: QueryKey | ((query: Query) => boolean)): void {
  const cache = client.getQueryCache();
  const filters = typeof target === 'function' ? { predicate: target } : { queryKey: target };

  for (const query of cache.findAll(filters)) {
    if (query.state.data !== undefined || query.state.fetchStatus !== 'fetching') continue;

    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type !== 'removed' && query.state.fetchStatus === 'fetching') return;

      unsubscribe();
      if (event.type !== 'removed')
        void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    });
  }

  void client.invalidateQueries(filters);
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
      // Through `refresh`, so a first load on its way is read again once it lands.
      refresh(client, everything);
      return;
    case 'status':
      adoptStatus(client, event.status);
      return;
    case 'pulls.changed':
      // Only the account whose PRs changed: another account's screens never refetch for it.
      refresh(client, queryKeys.pulls(event.account));
      // New commits can make a saved review out of date.
      refresh(client, queryKeys.aiReviews(event.account));

      for (const id of event.ids) {
        refresh(client, queryKeys.detail(event.account, id));
        refresh(client, queryKeys.diff(event.account, id));
        // A draft shows the pending review the PR has on the forge.
        refresh(client, queryKeys.draft(event.account, id));
        // A PR's tickets come from its branch, title and body.
        refresh(client, queryKeys.tickets(event.account, id));
        refresh(client, queryKeys.ai(event.account, id));
      }

      refresh(client, queryKeys.mine(event.account));

      return;
    case 'notify':
      void present(event.notifications);
      return;
    case 'insights.updated':
      // Null: the review target every account's Insights measure against changed.
      refresh(client, event.account === null ? isInsights : queryKeys.insights(event.account));
      return;
    case 'operation.updated':
      refresh(client, queryKeys.operations(event.account));
      refresh(client, queryKeys.draft(event.account, event.prId));
      if (['needs_attention', 'cancelled'].includes(event.status))
        refresh(client, queryKeys.diff(event.account, event.prId));
      return;
    case 'ai.updated':
      refresh(client, queryKeys.ai(event.account, event.prId));
      refresh(client, queryKeys.aiReviews(event.account));
      return;
    case 'draft.updated':
      refresh(client, queryKeys.draft(event.account, event.id));
      refresh(client, queryKeys.ai(event.account, event.id));
      return;
    case 'triage.updated':
      refresh(client, queryKeys.pulls(event.account));
      // My PRs shows which of your PRs have a note.
      refresh(client, queryKeys.mine(event.account));
      refresh(client, queryKeys.detail(event.account, event.id));
      return;
  }
}

/** Every query: what a resync, or a frame that could not be read, reads again. */
const everything = () => true;

/** Queries with a read again already due once their read in flight lands. */
const followUps = new WeakSet<Query>();

/**
 * Reads every query again after frames that could not be read, never cancelling a read already
 * on its way: a refetch slower than a recovery window still finishes. Such a read may have started
 * before the frames, so it is read once more when it lands; one more at most, however many
 * recoveries came meanwhile.
 */
function recover(client: QueryClient): void {
  const cache = client.getQueryCache();

  for (const query of cache.getAll()) {
    if (query.state.fetchStatus !== 'fetching') {
      void client.invalidateQueries(
        { queryKey: query.queryKey, exact: true },
        { cancelRefetch: false },
      );
      continue;
    }

    if (followUps.has(query)) continue;

    followUps.add(query);

    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type !== 'removed' && query.state.fetchStatus === 'fetching') return;

      unsubscribe();
      followUps.delete(query);

      if (event.type !== 'removed')
        void client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
    });
  }
}

/** How long unreadable frames are gathered before the one refresh that recovers from them. */
export const UNREADABLE_WINDOW_MS = 250;

let warned = false;

/**
 * Reads the frames of the event stream, checked against the contract (`serverEvent`). A frame
 * that cannot be read, malformed or of an unknown shape, may have announced a change that is
 * now never applied: while the stream is up nothing polls, so everything is read again. The first
 * such frame schedules that refresh for `UNREADABLE_WINDOW_MS` later; those after it, until then,
 * join it, since it comes after them all. However long a burst lasts, a refresh comes every
 * window. It stays due across the stream's own reconnects, since a replay may skip a frame already
 * received; only closing the stream cancels it.
 */
export function frameReader(client: QueryClient) {
  const firstHello = { value: true };
  let due: ReturnType<typeof setTimeout> | null = null;

  const unreadable = (problem: unknown) => {
    if (!warned) {
      warned = true;
      console.warn('Review Desk could not read an update from the server; reading again.', problem);
    }

    if (due) return;

    due = setTimeout(() => {
      due = null;
      recover(client);
    }, UNREADABLE_WINDOW_MS);
  };

  return {
    read(data: string) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(data);
      } catch (error) {
        unreadable(error);
        return;
      }

      const frame = serverEvent.safeParse(parsed);

      if (!frame.success) {
        unreadable(frame.error);
        return;
      }

      handle(client, frame.data as ServerEvent, firstHello);
    },
    close() {
      if (due) clearTimeout(due);
      due = null;
    },
  };
}

/** Opens the server event stream. EventSource reconnects by itself and replays via Last-Event-ID. */
export function startLive(client: QueryClient): () => void {
  if (typeof EventSource === 'undefined') return () => {};

  const frames = frameReader(client);
  const source = new EventSource(routes.events.path);

  source.onopen = () => setState({ connected: true, disconnectedAt: null });
  source.onerror = () => {
    if (state.connected) setState({ connected: false, disconnectedAt: Date.now() });
  };
  source.onmessage = (message) => frames.read(message.data);

  return () => {
    source.close();
    frames.close();
  };
}
