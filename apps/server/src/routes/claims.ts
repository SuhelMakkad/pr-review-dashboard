import { createHash } from 'node:crypto';
import type { DraftAttempt } from '@review-desk/shared/review';
import type { WriteClaim } from '@/db/draft-writes.js';
import type { Store } from '@/db/store.js';
import { draftVersionsOf, type WriteFence } from '@/db/versions.js';
import { failed, ok, type Failed } from '@/http/serve.js';
import { ReviewError } from '@/review/errors.js';

/**
 * A draft write's guard, from its body: the draft revision (and generation) the web saw, and the
 * id that makes a retry of it answer from the original's outcome. Each is optional: a write
 * without them applies as it always did.
 */
export interface WriteGuard {
  writeId?: string;
  baseRevision?: number;
  baseGeneration?: number;
}

/** A write's outcome as its answer carries it: a commit with the revision it made. */
export type AttemptState = DraftAttempt;

/** A claim settled before its write could commit (an account reset): its outcome stands. */
class ClaimSettled extends Error {
  constructor(readonly claim: WriteClaim) {
    super('This write was settled before it could be saved.');
  }
}

/** The fence of a write guarded by `guard`, for `account`'s draft of `prId`. */
export function fenceFor(
  store: Store,
  account: string,
  prId: string,
  guard: WriteGuard,
): WriteFence {
  const id = guard.writeId;
  // A claimed write commits only while its claim is pending: one an account reset recorded as
  // interrupted keeps that outcome, base or none.
  const assertPending = () => {
    const claim = id ? store.draftWrites.find(account, id) : undefined;

    if (claim && claim.state !== 'pending') throw new ClaimSettled(claim);
  };

  return {
    check() {
      assertPending();

      if (guard.baseRevision === undefined) return;

      const versions = draftVersionsOf(store, account, prId);

      if (
        versions.revision !== guard.baseRevision ||
        (guard.baseGeneration !== undefined && versions.generation !== guard.baseGeneration)
      )
        throw new ReviewError(
          'DRAFT_REVISION_CONFLICT',
          409,
          'This draft changed since you saw it. Nothing was saved.',
          { revision: versions.revision, generation: versions.generation },
        );
    },
    committed(body) {
      if (!id) return;

      const settled = store.draftWrites.settle(account, id, 'committed', {
        revision: draftVersionsOf(store, account, prId).revision,
        body,
      });

      // Settled meanwhile: the write rolls back with the transaction, and the outcome stands.
      if (!settled) throw new ClaimSettled(store.draftWrites.find(account, id)!);
    },
  };
}

/** A fingerprint of the request a write id was first sent with. */
export const requestFingerprint = (request: unknown) =>
  createHash('sha256').update(JSON.stringify(request)).digest('hex');

/** A claim's outcome, as every answer about it carries it: a commit with its revision. */
export function attemptOf(claim: WriteClaim): AttemptState {
  const result = claim.result as { revision?: number } | null;

  return claim.state === 'committed'
    ? { id: claim.id, state: 'committed', revision: result?.revision ?? 0 }
    : { id: claim.id, state: claim.state };
}

/** The answer a claim gives: to a retry of its request, or once its write settled it. */
function answerOf(claim: WriteClaim): { status: number; body: unknown } | Failed {
  if (claim.state === 'pending') return ok(202, { pending: true, attempt: attemptOf(claim) });

  const result = claim.result as { status?: number; body?: unknown } | null;

  if (claim.state === 'refused')
    return failed(result?.status ?? 409, {
      ...(result?.body as { error: string }),
      attempt: attemptOf(claim),
    });

  // A commit answers with what it answered when it committed, never with the draft as it is now.
  return ok(200, { ...(result?.body as object), attempt: attemptOf(claim) });
}

/**
 * Runs a draft write, or AI start, under its guard. With a write id, it is claimed as it arrives,
 * before any await: a retry answers from the original's outcome, never from its own path. The
 * write commits through its fence, which records the claim with its answer and revision; a
 * refusal is recorded as the claim's outcome. Without an id, it runs as it always did.
 */
export async function claimed<B extends object>(
  store: Store,
  claim: {
    account: string;
    prId: string;
    kind: 'write' | 'start';
    guard: WriteGuard;
    /** The request as received: a reuse of its id with another is refused. */
    request: unknown;
    /** The draft now, which a revision conflict answers with so the web can rebase on it. */
    current?: () => unknown;
  },
  run: (fence: WriteFence) => Promise<B> | B,
  refusal: (error: unknown) => Failed,
): Promise<{ status: number; body: unknown } | Failed> {
  const { account, prId, kind, guard } = claim;
  const fence = fenceFor(store, account, prId, guard);
  const id = guard.writeId;
  // A refusal as answered: a revision conflict with the draft it conflicts with, its versions
  // taken from that same read, so the web rebases on one consistent draft.
  const refused = (error: unknown) => {
    const answer = refusal(error);

    if (!(
      error instanceof ReviewError &&
      error.code === 'DRAFT_REVISION_CONFLICT' &&
      claim.current
    ))
      return answer;

    const draft = claim.current() as { versions?: { revision: number; generation: number } };

    return failed(answer.status, {
      ...answer.body,
      ...(draft.versions
        ? { revision: draft.versions.revision, generation: draft.versions.generation }
        : {}),
      draft,
    });
  };

  if (!id) {
    try {
      return ok(200, await run(fence));
    } catch (error) {
      return refused(error);
    }
  }

  const fingerprint = requestFingerprint(claim.request);
  const existing = store.transaction(() => {
    const found = store.draftWrites.find(account, id);

    if (found) return found;

    store.draftWrites.claim({
      account,
      id,
      prId,
      kind,
      fingerprint,
      baseRevision: guard.baseRevision ?? null,
      baseGeneration: guard.baseGeneration ?? null,
      createdAt: new Date().toISOString(),
    });

    return null;
  });

  if (existing)
    return existing.fingerprint === fingerprint
      ? answerOf(existing)
      : failed(409, {
          error: 'This write id was already used for another request.',
          code: 'WRITE_ID_CONFLICT',
        });

  try {
    await run(fence);
  } catch (error) {
    if (error instanceof ClaimSettled) return answerOf(error.claim);

    const answer = refused(error);

    // Recorded now: the write's own transaction rolled back, or it threw before writing. A claim
    // settled meanwhile (an account reset) keeps that outcome instead.
    store.draftWrites.settle(account, id, 'refused', { status: answer.status, body: answer.body });

    return answerOf(store.draftWrites.find(account, id)!);
  }

  // Answered as the commit recorded it, so a retry gets the very same answer.
  return answerOf(store.draftWrites.find(account, id)!);
}
