import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '../../shared/events';
import type { PullRequestList, SyncStatus } from '../../shared/types';
import { queryKeys } from './query-keys';
import { session } from './session';
import { present } from './notifications';

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
    case 'status': {
      const previous = client.getQueryData<SyncStatus>(queryKeys.status);
      const list = client.getQueryData<PullRequestList>(queryKeys.pulls);

      client.setQueryData(queryKeys.status, event.status);

      if (
        previous?.account?.login !== event.status.account?.login ||
        (list && list.account !== (event.status.account?.login ?? null))
      ) {
        void client.invalidateQueries();
      }

      return;
    }
    case 'pulls.changed':
      void client.invalidateQueries({ queryKey: queryKeys.pulls });

      for (const id of event.ids) {
        void client.invalidateQueries({ queryKey: queryKeys.detail(id) });
        void client.invalidateQueries({ queryKey: ['diff', id] });
        void client.invalidateQueries({ queryKey: ['ai', id] });
      }

      void client.invalidateQueries({ queryKey: queryKeys.mine });

      return;
    case 'notify':
      void present(event.notifications);
      return;
    case 'insights.updated':
      void client.invalidateQueries({ queryKey: ['insights'] });
      return;
    case 'ai.updated':
      void client.invalidateQueries({ queryKey: ['ai', event.prId] });
      return;
    case 'draft.updated':
      void client.invalidateQueries({ queryKey: ['draft', event.id] });
      void client.invalidateQueries({ queryKey: ['ai', event.id] });
      return;
    case 'triage.updated':
      void client.invalidateQueries({ queryKey: queryKeys.pulls });
      void client.invalidateQueries({ queryKey: queryKeys.detail(event.id) });
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
