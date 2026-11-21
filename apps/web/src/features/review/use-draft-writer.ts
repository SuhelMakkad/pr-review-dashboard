import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { routes } from '@review-desk/shared/contract';
import type { ReviewDraft } from '@review-desk/shared/review';
import { toast } from 'sonner';
import { call } from '@/lib/call';
import { accountSwitches } from '@/lib/live';
import { queryKeys } from '@/lib/query-keys';
import { draftWriter, type DraftWriter, type Transport } from '@/features/review/draft-writer';

/** The draft routes the writer sends, by name (as its journal keeps them). */
const writeRoutes = {
  saveDraft: routes.saveDraft,
  addComment: routes.addComment,
  editComment: routes.editComment,
  deleteComment: routes.deleteComment,
  acceptAi: routes.acceptAi,
  prepareAi: routes.prepareAi,
  applyAi: routes.applyAi,
} as const;

/**
 * Of two answers for one draft, the newer of each part: the draft's own (its body, verdict,
 * comments and lock) by its revision, what the forge shows (its pending review) by its
 * observation. An answer from an older server, without versions, is taken as it is.
 */
export function newerDraft(cached: ReviewDraft | undefined, incoming: ReviewDraft): ReviewDraft {
  const had = cached?.versions;
  const has = incoming.versions;

  if (!cached || !had || !has) return incoming;

  const local = has.revision >= had.revision ? incoming : cached;
  const forge = has.observation >= had.observation ? incoming : cached;

  return {
    ...local,
    githubPendingReview: forge.githubPendingReview,
    versions: {
      revision: local.versions!.revision,
      generation: local.versions!.generation,
      observation: forge.versions!.observation,
    },
  };
}

/**
 * Writes `draft` into the cache, keeping the newer of each part (`newerDraft`): false, writing
 * nothing, when the account shown changed since `since`.
 */
export function seedNewer(
  client: QueryClient,
  account: string,
  prId: string,
  draft: ReviewDraft,
  since = accountSwitches(),
): boolean {
  if (accountSwitches() !== since) return false;

  const key = queryKeys.draft(account, prId);

  // A read that started before this write must not land after it.
  void client.cancelQueries({ queryKey: key, exact: true });
  client.setQueryData<ReviewDraft>(key, (cached) => newerDraft(cached, draft));

  return true;
}

function transport(client: QueryClient, account: string, prId: string): Transport {
  // The account switches as the write now on its way was sent (the queue sends one at a time):
  // an answer that crossed a switch must not refill the drafts it dropped, to be read afresh.
  let sentAt = accountSwitches();

  return {
    send: (request) => {
      sentAt = accountSwitches();

      return call(
        writeRoutes[request.route as keyof typeof writeRoutes] as never,
        {
          params: request.params,
          body: request.body,
          strict: true,
        } as never,
      );
    },
    lookup: (writeId, base) =>
      call(routes.draftAttempt, {
        params: { account, id: prId, attemptId: writeId },
        query: { base: base.revision, generation: base.generation },
        strict: true,
      }),
    committed: (draft) => {
      if (draft) seedNewer(client, account, prId, draft, sentAt);
    },
    stale: () => void client.invalidateQueries({ queryKey: queryKeys.draft(account, prId) }),
    refused: (reason) => void toast.error(reason),
  };
}

/**
 * The writer of `account`'s draft of `prId`, re-rendering as it changes. It learns each draft the
 * page reads, so a write queued while nothing runs acts on the draft as shown.
 */
export function useDraftWriter(
  account: string,
  prId: string,
  draft: ReviewDraft | undefined,
): DraftWriter {
  const client = useQueryClient();
  const writer = draftWriter(client, account, prId, () => transport(client, account, prId));

  useSyncExternalStore(
    (listener) => writer.subscribe(listener),
    () => writer.version,
  );

  useEffect(() => {
    if (draft) writer.observe(draft);
  }, [writer, draft]);

  return writer;
}
