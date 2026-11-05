import { createContext, useContext } from 'react';

export interface InboxNavigation {
  /** Moves the selection off the current PR (to the next, else the previous) before it leaves the queue. */
  advance: () => void;
}

export const InboxContext = createContext<InboxNavigation | null>(null);

export const useInboxNavigation = () => useContext(InboxContext);
