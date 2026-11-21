import { createHash } from 'node:crypto';
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

/** A write's state as its answer carries it. */
export interface AttemptState {
  id: string;
  state: WriteClaim['state'];
}

/** The fence of a write guarded by `guard`, for `account`'s draft of `prId`. */
export function fenceFor(
  store: Store,
  account: string,
  prId: string,
  guard: WriteGuard,
): WriteFence {
  return {
    check() {
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
      if (!guard.writeId) return;

      store.draftWrites.settle(account, guard.writeId, 'committed', {
        revision: draftVersionsOf(store, account, prId).revision,
        body,
      });
    },
  };
}

/** A fingerprint of the request a write id was first sent with. */
export const requestFingerprint = (request: unknown) =>
  createHash('sha256').update(JSON.stringify(request)).digest('hex');

const attempt = (id: string, state: WriteClaim['state']): { attempt: AttemptState } => ({
  attempt: { id, state },
});

/** The answer a claim already made gives, to a retry of the same request. */
function answerOf(
  claim: WriteClaim,
  fingerprint: string,
  replayed: () => unknown,
): { status: number; body: unknown } | Failed {
  if (claim.fingerprint !== fingerprint)
    return failed(409, {
      error: 'This write id was already used for another request.',
      code: 'WRITE_ID_CONFLICT',
    });

  if (claim.state === 'pending') return ok(202, { pending: true, ...attempt(claim.id, 'pending') });

  const result = claim.result as { status?: number; body?: unknown } | null;

  if (claim.state === 'refused')
    return failed(result?.status ?? 409, {
      ...(result?.body as { error: string }),
      ...attempt(claim.id, 'refused'),
    });

  // A commit answers with what it answered; one that kept no answer (a meta save) with the draft now.
  const body = (result?.body ?? replayed()) as Record<string, unknown>;

  return ok(200, { ...body, ...attempt(claim.id, 'committed') });
}

/**
 * Runs a draft write, or AI start, under its guard. With a write id, it is claimed as it arrives,
 * before any await: a retry answers from the original's outcome, never from its own path. The
 * write commits through its fence; a refusal is recorded as the claim's outcome. Without an id, it
 * runs as it always did.
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
    /** The answer to a replayed commit that kept none (a meta save): the current draft. */
    replayed?: () => unknown;
    /** The draft now, which a revision conflict answers with so the web can rebase on it. */
    current?: () => unknown;
  },
  run: (fence: WriteFence) => Promise<B> | B,
  refusal: (error: unknown) => Failed,
): Promise<{ status: number; body: unknown } | Failed> {
  const { account, prId, kind, guard } = claim;
  const fence = fenceFor(store, account, prId, guard);
  const id = guard.writeId;
  // A refusal as answered: a revision conflict with the draft it conflicts with.
  const refused = (error: unknown) => {
    const answer = refusal(error);

    return error instanceof ReviewError && error.code === 'DRAFT_REVISION_CONFLICT' && claim.current
      ? failed(answer.status, { ...answer.body, draft: claim.current() })
      : answer;
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

  if (existing) return answerOf(existing, fingerprint, claim.replayed ?? (() => ({})));

  try {
    const body = await run(fence);

    return ok(200, { ...body, ...attempt(id, 'committed') });
  } catch (error) {
    const answer = refused(error);

    // Settled now: the write's own transaction rolled back, or it threw before writing.
    store.draftWrites.settle(account, id, 'refused', { status: answer.status, body: answer.body });

    return failed(answer.status, { ...answer.body, ...attempt(id, 'refused') });
  }
}
