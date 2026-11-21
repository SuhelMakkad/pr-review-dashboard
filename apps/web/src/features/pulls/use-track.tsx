import { call } from '@/lib/call';
import { routes } from '@review-desk/shared/contract';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { instanceUrl, isSameUser, parseAccount } from '@review-desk/shared/accounts';
import type { PullRequestDetail, PullRequestItem, SyncStatus } from '@review-desk/shared/types';
import { formatRef, refOf, type PrRef } from '@/lib/pr-ref';
import { useAccount, useForge, useStatus } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/ui/button';
import { inQueue, type QueueSlug } from '@/features/pulls/meta';
import { forgeTraits } from '@review-desk/shared/traits';

type PullLike = { id: string; repository: string; number: number; url?: string };

/** True when you are the only reason this PR is tracked, so removing it takes it off the queue. */
export const onlyAddedByHand = (item: { sources: PullRequestItem['sources'] }) =>
  item.sources.length > 0 && item.sources.every((source) => source === 'manual');

const refreshQueue = (client: QueryClient, account: string) =>
  Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.pulls(account) }),
    client.invalidateQueries({ queryKey: queryKeys.mine(account) }),
  ]);

/** A PR added by hand, with the membership that add made: null when it was already added. */
type Added = PullRequestDetail & { membershipId: string | null };

/** The account shown now, read when an action ends rather than when it began. */
const shownAccount = (client: QueryClient) =>
  client.getQueryData<SyncStatus>(queryKeys.status)?.account?.login ?? null;

/** Removes a PR `account` added by hand; with `membershipId`, only the membership one add made. */
async function untrackPull(
  client: QueryClient,
  account: string,
  item: PullLike,
  membershipId?: string,
) {
  const result = await call(routes.untrack, {
    params: { account, id: item.id },
    body: membershipId ? { membershipId } : {},
  });

  await refreshQueue(client, account);

  return result;
}

/**
 * Adds the PR for `account`, then waits for its queue to refetch so it is there when the caller
 * navigates. The toast can undo the add, but only an add that made the membership: one already
 * there was not this add's to remove.
 */
async function trackPull(client: QueryClient, account: string, ref: PrRef): Promise<Added> {
  const detail: Added = await call(routes.track, {
    params: { account },
    body: {
      repository: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      ...(ref.host ? { host: ref.host } : {}),
      ...(ref.gitlab ? { gitlab: true } : {}),
    },
  });
  const added = formatRef(refOf(detail.snapshot));

  await refreshQueue(client, account);

  const membershipId = detail.membershipId;

  toast.success(
    `Added ${added} to your review queue`,
    membershipId
      ? {
          action: {
            label: 'Undo',
            // Runs after the caller may have unmounted, so it does not use a hook.
            onClick: () =>
              void untrackPull(client, account, detail.snapshot, membershipId).then(
                // A feed may list it too: then it stays, without the add.
                ({ tracked }) =>
                  toast(
                    tracked
                      ? `${added} stays in your queue`
                      : `Removed ${added} from your review queue`,
                  ),
                (error: Error) => toast.error(error.message),
              ),
          },
        }
      : undefined,
  );

  return detail;
}

/**
 * Adds a PR to an account's review queue: the account travels with the request, so it is the one
 * shown when the add began, whatever is shown when it runs. Callers decide how to show a failure.
 */
export function useTrackPull() {
  const client = useQueryClient();

  return useMutation({
    mutationKey: ['track'],
    mutationFn: ({ ref, account }: { ref: PrRef; account: string }) =>
      trackPull(client, account, ref),
  });
}

/** Removes a PR its account added by hand. The toast can add it back, for that same account. */
export function useUntrackPull() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ item, account }: { item: PullLike; account: string }) => {
      const result = await untrackPull(client, account, item);
      const ref = refOf(item);

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

/**
 * Adds a PR and opens it where it now lives: your inbox, or My PRs when you wrote it. Only while
 * the account it was added for is still shown: the PR pages show the account in use.
 */
export function useAddAndOpen() {
  const client = useQueryClient();
  const track = useTrackPull();
  const navigate = useNavigate();
  const account = useAccount() ?? '';

  const add = async (ref: PrRef) => {
    const detail = await track.mutateAsync({ ref, account });

    if (shownAccount(client) !== account) {
      toast(`Added for ${account}.`);
      return detail;
    }

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
        pullRef={
          forgeTraits[account.forge].reference.separator === '!'
            ? { ...pullRef, gitlab: true }
            : pullRef
        }
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
  const account = useAccount() ?? '';

  return (
    <Button
      variant="primary"
      icon={<Plus size={14} />}
      disabled={track.isPending}
      onClick={() =>
        track.mutate({ ref: pullRef, account }, { onError: (error) => toast.error(error.message) })
      }
    >
      {track.isPending ? 'Adding…' : 'Add to review queue'}
    </Button>
  );
}
