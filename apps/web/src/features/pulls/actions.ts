import { useCallback } from 'react';
import { toast } from 'sonner';
import type { PullRequestItem } from '@review-desk/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { numberSign } from '@/lib/pr-ref';
import { runTriage, usePulls, type TriageVariables } from '@/lib/queries';
import { shortDateTime } from '@/lib/time';

type Undo = { label: string; run: () => void } | null;

let lastUndo: Undo = null;

/** Undo for the most recent reversible triage action (bound to Z). */
export function undoLast(): boolean {
  const undo = lastUndo;

  if (!undo) return false;

  lastUndo = null;
  undo.run();
  toast(`Undone: ${undo.label}`);

  return true;
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

          const undo = success.undo;

          lastUndo = undo
            ? {
                label: success.message,
                run: () =>
                  void runTriage(client, { id: item.id, account, update: undo }).catch(
                    (error: Error) => toast.error(error.message),
                  ),
              }
            : null;

          toast(success.message, {
            description: `${numberSign(item.url)}${item.number} ${item.title}`,
            action: undo ? { label: 'Undo', onClick: () => undoLast() } : undefined,
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
