import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { routes } from '@review-desk/shared/contract';
import type { ReviewDraft } from '@review-desk/shared/review';
import { toast } from 'sonner';
import { pathOf } from '@/lib/call';
import { forgetLegacy, legacyIds } from '@/lib/operation-command';
import { ApiError } from '@/lib/api';
import { call } from '@/lib/call';
import { accountSwitches, onServerEvent } from '@/lib/live';
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
 * nothing, when the account shown changed since `since`. A read on its way is left to finish: it
 * merges the same way as it lands, so neither an older read nor an older write undoes a newer.
 */
export function seedNewer(
  client: QueryClient,
  account: string,
  prId: string,
  draft: ReviewDraft,
  since: number,
): boolean {
  if (accountSwitches() !== since) return false;

  client.setQueryData<ReviewDraft>(queryKeys.draft(account, prId), (cached) =>
    newerDraft(cached, draft),
  );

  return true;
}

function transport(client: QueryClient, account: string, prId: string): Transport {
  const key = queryKeys.draft(account, prId);

  return {
    send: (request) =>
      call(
        writeRoutes[request.route as keyof typeof writeRoutes] as never,
        { params: request.params, body: request.body, strict: true } as never,
      ),
    lookup: (writeId, base) =>
      call(routes.draftAttempt, {
        params: { account, id: prId, attemptId: writeId },
        query: { base: base.revision, generation: base.generation },
        strict: true,
      }),
    stamp: accountSwitches,
    // An answer to a write sent before a switch must not refill the drafts it dropped: read again.
    committed: (draft, stamp) => {
      if (!seedNewer(client, account, prId, draft, stamp))
        void client.invalidateQueries({ queryKey: key });
    },
    stale: () => void client.invalidateQueries({ queryKey: key }),
    refused: (reason) => void toast.error(reason),
    epoch: () =>
      call(routes.receiptEpoch, { params: { account }, strict: true }).then(({ epoch }) => epoch),
    sendCommand: (request) =>
      call(
        commandRoutes[request.route] as never,
        { params: request.params, body: request.body, strict: true } as never,
      ),
    // Nothing received under the id: a 404 the receipt route answers as such.
    receipt: (id) =>
      call(routes.operationReceipt, { params: { account, id }, strict: true }).catch(
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND')
            return null;

          throw error;
        },
      ),
    abandon: (id, kind, epoch) =>
      call(routes.abandonCommand, {
        params: { account, id: prId, commandId: id },
        body: { type: kind === 'submit' ? 'review' : 'discard', epoch },
        strict: true,
      }),
  };
}

/** The commands the writer sends, by name. */
const commandRoutes = { submit: routes.submit, discard: routes.discard } as const;

/**
 * Hands the writer the submit and discard ids an earlier version kept for this draft: forgotten
 * there only once the writer recorded them.
 */
function adoptLegacy(writer: DraftWriter, account: string, prId: string) {
  const pr = { account, id: prId };
  const legacy = [
    ...legacyIds(pathOf(routes.submit, pr), 'POST').map((entry) => ({
      ...entry,
      kind: 'submit' as const,
    })),
    ...legacyIds(pathOf(routes.discard, pr), 'DELETE').map((entry) => ({
      ...entry,
      kind: 'discard' as const,
    })),
  ];

  // Held by the writer at once; each forgotten here only once its journal holds it, or its
  // outcome. Called with none too, so the writer drops what it kept for ids already gone here.
  writer.adopt(
    legacy.map(({ id, kind, key }) => ({ id, kind, forget: () => forgetLegacy(key, id) })),
  );
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
  const writer = draftWriter(
    client,
    account,
    prId,
    () => transport(client, account, prId),
    (made) => adoptLegacy(made, account, prId),
  );

  useSyncExternalStore(
    (listener) => writer.subscribe(listener),
    () => writer.version,
  );

  useEffect(() => {
    if (draft) writer.observe(draft);
  }, [writer, draft]);

  // Its commands are looked up as soon as anything says they may have moved: their operation
  // changed, or the stream connected again after a gap.
  useEffect(
    () =>
      onServerEvent((event) => {
        if (
          event.type === 'hello' ||
          event.type === 'resync' ||
          (event.type === 'operation.updated' && event.account === account && event.prId === prId)
        )
          void writer.reconcile();
      }),
    [writer, account, prId],
  );

  return writer;
}
