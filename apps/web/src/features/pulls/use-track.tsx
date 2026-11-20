import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { instanceUrl, isSameUser, parseAccount } from '@review-desk/shared/accounts';
import type { PullRequestDetail, PullRequestItem } from '@review-desk/shared/types';
import { api } from '@/lib/api';
import { formatRef, refOf, type PrRef } from '@/lib/pr-ref';
import { useForge, useStatus } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/ui/button';
import { inQueue, type QueueSlug } from '@/features/pulls/meta';

type PullLike = { id: string; repository: string; number: number; url?: string };

/** True when you are the only reason this PR is tracked, so removing it takes it off the queue. */
export const onlyAddedByHand = (item: { sources: PullRequestItem['sources'] }) =>
  item.sources.length > 0 && item.sources.every((source) => source === 'manual');

const refreshQueue = (client: QueryClient, account: string) =>
  Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.pulls(account) }),
    client.invalidateQueries({ queryKey: queryKeys.mine(account) }),
  ]);

/** Adds the PR, then waits for the queue to refetch so it is there when the caller navigates. */
async function trackPull(client: QueryClient, account: string, ref: PrRef) {
  const detail = await api<PullRequestDetail>('/api/pulls/track', {
    body: {
      account,
      repository: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      ...(ref.host ? { host: ref.host } : {}),
      ...(ref.gitlab ? { gitlab: true } : {}),
    },
  });

  await refreshQueue(client, account);
  toast.success(`Added ${formatRef(refOf(detail.snapshot))} to your review queue`);

  return detail;
}

/** Adds a PR to your review queue by hand. Callers decide how to show a failure. */
export function useTrackPull() {
  const client = useQueryClient();
  const account = useStatus().data?.account?.login ?? '';

  return useMutation({
    mutationKey: ['track'],
    mutationFn: (ref: PrRef) => trackPull(client, account, ref),
  });
}

/** Removes a PR you added by hand. The toast can add it back. */
export function useUntrackPull() {
  const client = useQueryClient();
  const account = useStatus().data?.account?.login ?? '';

  return useMutation({
    mutationFn: async (item: PullLike) => {
      const result = await api<{ tracked: boolean }>(
        `/api/pulls/${encodeURIComponent(item.id)}/track`,
        { method: 'DELETE', body: { account } },
      );
      const ref = refOf(item);

      await refreshQueue(client, account);

      if (result.tracked) {
        toast(`${formatRef(ref)} stays in your queue`, {
          description: 'You are still listed on it, for example as a requested reviewer.',
        });
      } else {
        // Undo runs after this component may have unmounted, so it does not use a hook.
        toast(`Removed ${formatRef(ref)} from your review queue`, {
          action: {
            label: 'Undo',
            onClick: () =>
              void trackPull(client, account, ref).catch((error: Error) =>
                toast.error(error.message),
              ),
          },
        });
      }

      return result;
    },
    onError: (error) => toast.error(error.message),
  });
}

/** The queue a PR is listed in, for linking to it from outside the inbox. */
export function queueOf(item: PullRequestItem): QueueSlug {
  const slugs: QueueSlug[] = ['attention', 'waiting', 'caught-up', 'snoozed'];

  return slugs.find((slug) => inQueue(item, slug)) ?? 'all';
}

/** Adds a PR and opens it where it now lives: your inbox, or My PRs when you wrote it. */
export function useAddAndOpen() {
  const track = useTrackPull();
  const navigate = useNavigate();
  const account = useStatus().data?.account?.login ?? '';

  const add = async (ref: PrRef) => {
    const detail = await track.mutateAsync(ref);
    // The server's path is canonical: a GitLab link can carry the host's relative URL root.
    const added = refOf(detail.snapshot);
    const params = { owner: added.owner, repo: added.repo, number: String(added.number) };

    if (isSameUser(detail.snapshot.author.login, account)) {
      await navigate({ to: '/mine/$owner/$repo/$number', params });
    } else {
      await navigate({
        to: '/inbox/$queue/$owner/$repo/$number',
        params: { queue: queueOf(detail.item), ...params },
      });
    }

    return detail;
  };

  return { add, pending: track.isPending, error: track.error, reset: track.reset };
}

/** What you can do on a "not tracked" screen: add the PR (it then appears in place) or open it. */
export function NotTrackedActions({ pullRef }: { pullRef: PrRef }) {
  const actor = useStatus().data?.account;
  const account = parseAccount(actor?.login ?? '');
  const forge = useForge();
  const path = `${pullRef.owner}/${pullRef.repo}`;
  // The instance's own address keeps its protocol, port and relative URL root.
  const gitlab = instanceUrl(actor?.webUrl) ?? `https://${account.host}`;
  const href =
    account.forge === 'gitlab'
      ? `${gitlab}/${path}/-/merge_requests/${pullRef.number}`
      : `https://github.com/${path}/pull/${pullRef.number}`;

  return (
    <div className="flex flex-col items-center gap-3">
      <AddToQueueButton
        pullRef={account.forge === 'gitlab' ? { ...pullRef, gitlab: true } : pullRef}
      />
      <a
        className="inline-flex items-center gap-1 text-sm text-accent underline"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        Open on {forge.name} <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

/** The action on a "not tracked" screen: the PR then appears in place. */
export function AddToQueueButton({ pullRef }: { pullRef: PrRef }) {
  const track = useTrackPull();

  return (
    <Button
      variant="primary"
      icon={<Plus size={14} />}
      disabled={track.isPending}
      onClick={() => track.mutate(pullRef, { onError: (error) => toast.error(error.message) })}
    >
      {track.isPending ? 'Adding…' : 'Add to review queue'}
    </Button>
  );
}
