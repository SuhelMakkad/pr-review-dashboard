import { useCallback } from 'react';
import { toast } from 'sonner';
import type { PullRequestItem } from '@review-desk/shared/types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SyncStatus } from '@review-desk/shared/types';
import { queryKeys } from '@/lib/query-keys';
import { numberSign } from '@/lib/pr-ref';
import { runTriage, usePulls, type TriageVariables } from '@/lib/queries';
import { shortDateTime } from '@/lib/time';

interface Undo {
  label: string;
  account: string;
  run: () => void;
}

/** Each account's most recent reversible action: a late reply for one never displaces another's. */
const lastUndo = new Map<string, Undo>();

const shownAccount = (client: QueryClient) =>
  client.getQueryData<SyncStatus>(queryKeys.status)?.account?.login ?? null;

/**
 * Undoes `undo`, only while the account it was made for is on screen: after a switch it would
 * change another account's queue than the one shown.
 */
function runUndo(client: QueryClient, undo: Undo): boolean {
  if (undo.account !== shownAccount(client)) {
    toast.error(`Switch back to ${undo.account} to undo this.`);
    return false;
  }

  if (lastUndo.get(undo.account) === undo) lastUndo.delete(undo.account);

  undo.run();
  toast(`Undone: ${undo.label}`);

  return true;
}

/** Undo for the most recent reversible triage action of the account shown (bound to Z). */
export function undoLast(client: QueryClient): boolean {
  const shown = shownAccount(client);
  const undo = shown ? lastUndo.get(shown) : undefined;

  return undo ? runUndo(client, undo) : false;
}

type Update = TriageVariables['update'];

/** Triage actions for one PR, each with feedback and an undo where it is reversible. */
export function usePullActions() {
  const client = useQueryClient();
  const pulls = usePulls();
  const account = pulls.data?.account ?? null;

  const write = useCallback(
    (item: PullRequestItem, update: Update, success?: { message: string; undo?: Update }) => {
      if (!account) return;

      runTriage(client, { id: item.id, account, update }).then(
        () => {
          if (!success) return;

          const reverse = success.undo;
          const undo: Undo | null = reverse
            ? {
                label: success.message,
                account,
                run: () =>
                  void runTriage(client, { id: item.id, account, update: reverse }).catch(
                    (error: Error) => toast.error(error.message),
                  ),
              }
            : null;

          if (undo) lastUndo.set(account, undo);
          else lastUndo.delete(account);

          // This toast's Undo is this action's, whatever has happened since.
          toast(success.message, {
            description: `${numberSign(item.url)}${item.number} ${item.title}`,
            action: undo ? { label: 'Undo', onClick: () => void runUndo(client, undo) } : undefined,
          });
        },
        (error: Error) => {
          toast.error(error.message, {
            action: { label: 'Retry', onClick: () => write(item, update, success) },
          });
        },
      );
    },
    [account, client],
  );

  return {
    account,
    done: (item: PullRequestItem) =>
      item.doneAt
        ? write(item, { done: false }, { message: 'Moved back to its queue' })
        : write(
            item,
            { done: true },
            { message: 'Marked done until new activity', undo: { done: false } },
          ),
    snooze: (item: PullRequestItem, until: Date) =>
      write(
        item,
        { snoozeUntil: until.toISOString() },
        {
          message: `Snoozed until ${shortDateTime(until.toISOString())}`,
          undo: { snoozeUntil: null },
        },
      ),
    wake: (item: PullRequestItem) => write(item, { snoozeUntil: null }, { message: 'Woken up' }),
    markSeen: (item: PullRequestItem) =>
      item.unreadReplyKeys.length > 0 &&
      write(item, { seenReplyKeys: item.unreadReplyKeys }, { message: 'Replies marked as seen' }),
    openOnGitHub: (item: PullRequestItem) => window.open(item.url, '_blank', 'noopener,noreferrer'),
    copyLink: async (item: PullRequestItem) => {
      try {
        await navigator.clipboard.writeText(item.url);
        toast('Link copied', { description: item.url });
      } catch {
        toast.error('Could not copy the link');
      }
    },
  };
}
