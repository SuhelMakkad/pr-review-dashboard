import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { union } from 'drizzle-orm/sqlite-core';
import type { DraftComment, ReviewDraft, ReviewEvent } from '@review-desk/shared/review';
import { draftComments, reviewDrafts, type ReviewDraftRow } from '@/db/schema.js';
import type { Store } from '@/db/store.js';
import { ReviewError } from '@/review/errors.js';

type DraftMeta = Pick<
  ReviewDraftRow,
  'body' | 'event' | 'githubReviewId' | 'updatedAt' | 'preparedReview' | 'activeOperationId'
>;

const commentFields = {
  id: draftComments.id,
  path: draftComments.path,
  line: draftComments.line,
  side: draftComments.side,
  startLine: draftComments.startLine,
  startSide: draftComments.startSide,
  subjectType: draftComments.subjectType,
  body: draftComments.body,
  origin: draftComments.origin,
  anchorOid: draftComments.anchorOid,
  status: draftComments.status,
  createdAt: draftComments.createdAt,
  updatedAt: draftComments.updatedAt,
  githubThreadId: draftComments.githubThreadId,
};

/** Local, unsubmitted review drafts. Nothing here reaches GitHub until the user submits. */
export class DraftStore {
  constructor(
    private readonly store: Store,
    private readonly operationId?: string,
    private readonly beforeWrite?: () => void,
  ) {}

  private get db() {
    return this.store.db;
  }

  draft(account: string, prId: string): (DraftMeta & { comments: DraftComment[] }) | null {
    const row = this.db
      .select({
        body: reviewDrafts.body,
        event: reviewDrafts.event,
        githubReviewId: reviewDrafts.githubReviewId,
        preparedReview: reviewDrafts.preparedReview,
        activeOperationId: reviewDrafts.activeOperationId,
        updatedAt: reviewDrafts.updatedAt,
      })
      .from(reviewDrafts)
      .where(and(eq(reviewDrafts.account, account), eq(reviewDrafts.prId, prId)))
      .get();
    const comments = this.comments(account, prId);

    if (!row && comments.length === 0) return null;

    return {
      body: row?.body ?? '',
      event: row?.event ?? 'COMMENT',
      githubReviewId: row?.githubReviewId ?? null,
      activeOperationId: row?.activeOperationId ?? null,
      preparedReview: row?.preparedReview ?? null,
      updatedAt: row?.updatedAt ?? comments.at(-1)!.updatedAt,
      comments,
    };
  }

  comments(account: string, prId: string): DraftComment[] {
    return this.db
      .select(commentFields)
      .from(draftComments)
      .where(and(eq(draftComments.account, account), eq(draftComments.prId, prId)))
      .orderBy(asc(draftComments.createdAt), sql`rowid`)
      .all();
  }

  /** PR ids with a draft in progress, for badges in the inbox. */
  prsWithDrafts(account: string): Set<string> {
    const rows = union(
      this.db
        .select({ prId: draftComments.prId })
        .from(draftComments)
        .where(eq(draftComments.account, account)),
      this.db
        .select({ prId: reviewDrafts.prId })
        .from(reviewDrafts)
        .where(
          and(
            eq(reviewDrafts.account, account),
            or(ne(reviewDrafts.body, ''), ne(reviewDrafts.event, 'COMMENT')),
          ),
        ),
    ).all();

    return new Set(rows.map((row) => row.prId));
  }

  saveMeta(
    account: string,
    prId: string,
    changes: {
      body?: string;
      event?: ReviewEvent;
      githubReviewId?: string | null;
      preparedReview?: ReviewDraft['preparedReview'];
    },
  ): void {
    this.assertEditable(account, prId);

    const current = this.draft(account, prId);
    const meta = {
      body: changes.body ?? current?.body ?? '',
      event: changes.event ?? current?.event ?? 'COMMENT',
      githubReviewId:
        changes.githubReviewId !== undefined
          ? changes.githubReviewId
          : (current?.githubReviewId ?? null),
      updatedAt: new Date().toISOString(),
      preparedReview: changes.preparedReview ?? current?.preparedReview ?? null,
    };

    this.db
      .insert(reviewDrafts)
      .values({ account, prId, ...meta })
      .onConflictDoUpdate({ target: [reviewDrafts.account, reviewDrafts.prId], set: meta })
      .run();
  }

  addComment(
    account: string,
    prId: string,
    input: Omit<DraftComment, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
  ): DraftComment {
    this.assertEditable(account, prId);

    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .insert(draftComments)
      .values({
        id,
        account,
        prId,
        path: input.path,
        line: input.line,
        side: input.side,
        startLine: input.startLine,
        startSide: input.startSide,
        subjectType: input.subjectType,
        body: input.body,
        origin: input.origin,
        anchorOid: input.anchorOid,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.comment(account, id)!;
  }

  /** The PR a draft comment belongs to, or null when there is no such comment. */
  commentPrId(account: string, id: string): string | null {
    return currentPrId(this.store, account, id) || null;
  }

  comment(account: string, id: string): DraftComment | null {
    const row = this.db
      .select(commentFields)
      .from(draftComments)
      .where(and(eq(draftComments.account, account), eq(draftComments.id, id)))
      .get();

    return row ?? null;
  }

  updateComment(
    account: string,
    id: string,
    changes: Partial<Pick<DraftComment, 'body' | 'line' | 'startLine' | 'status' | 'anchorOid'>> & {
      githubThreadId?: string;
    },
  ): void {
    const current = this.comment(account, id);

    if (!current) return;

    this.assertEditable(account, currentPrId(this.store, account, id));

    this.db
      .update(draftComments)
      .set({
        body: changes.body ?? current.body,
        line: changes.line !== undefined ? changes.line : current.line,
        startLine: changes.startLine !== undefined ? changes.startLine : current.startLine,
        status: changes.status ?? current.status,
        anchorOid: changes.anchorOid ?? current.anchorOid,
        // Only overwrite the thread id when a new one is given.
        ...(changes.githubThreadId !== undefined ? { githubThreadId: changes.githubThreadId } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(draftComments.account, account), eq(draftComments.id, id)))
      .run();
  }

  deleteComment(account: string, id: string): void {
    this.assertEditable(account, currentPrId(this.store, account, id));

    this.db
      .delete(draftComments)
      .where(and(eq(draftComments.account, account), eq(draftComments.id, id)))
      .run();
  }

  clear(account: string, prId: string): void {
    this.assertEditable(account, prId);

    this.store.transaction(() => {
      this.db
        .delete(draftComments)
        .where(and(eq(draftComments.account, account), eq(draftComments.prId, prId)))
        .run();
      this.db
        .delete(reviewDrafts)
        .where(and(eq(reviewDrafts.account, account), eq(reviewDrafts.prId, prId)))
        .run();
    });
  }

  assertEditable(account: string, prId: string): void {
    this.beforeWrite?.();

    const lock = this.db
      .select({ id: reviewDrafts.activeOperationId })
      .from(reviewDrafts)
      .where(and(eq(reviewDrafts.account, account), eq(reviewDrafts.prId, prId)))
      .get()?.id;

    if (lock && lock !== this.operationId) {
      throw new ReviewError(
        'REVIEW_QUEUED',
        409,
        'This review is saved in Activity. Resolve or cancel its action before editing.',
        { operationId: lock },
      );
    }
  }

  lock(account: string, prId: string, operationId: string): void {
    this.assertEditable(account, prId);
    this.saveMeta(account, prId, {});

    this.db
      .update(reviewDrafts)
      .set({ activeOperationId: operationId })
      .where(and(eq(reviewDrafts.account, account), eq(reviewDrafts.prId, prId)))
      .run();
  }

  unlock(account: string, prId: string, operationId: string): void {
    this.db
      .update(reviewDrafts)
      .set({ activeOperationId: null })
      .where(
        and(
          eq(reviewDrafts.account, account),
          eq(reviewDrafts.prId, prId),
          eq(reviewDrafts.activeOperationId, operationId),
        ),
      )
      .run();
  }
}

function currentPrId(store: Store, account: string, id: string): string {
  return (
    store.db
      .select({ prId: draftComments.prId })
      .from(draftComments)
      .where(and(eq(draftComments.account, account), eq(draftComments.id, id)))
      .get()?.prId ?? ''
  );
}
