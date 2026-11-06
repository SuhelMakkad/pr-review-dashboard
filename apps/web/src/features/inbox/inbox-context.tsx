import { createContext, useContext } from 'react';
import type { QueueSlug } from '@/features/pulls/meta';

export interface InboxNavigation {
  queue?: QueueSlug;
  /** Moves the selection off the current PR (to the next, else the previous) before it leaves the queue. */
  advance: () => void;
}

export const InboxContext = createContext<InboxNavigation | null>(null);

export const useInboxNavigation = () => useContext(InboxContext);
