import { randomUUID } from 'node:crypto';
import type { DraftComment, ReviewEvent, Side } from '../../shared/review.js';
import type { Store } from '../db/store.js';

interface DraftRow {
  body: string;
  event: ReviewEvent;
  github_review_id: string | null;
  updated_at: string;
}

const toComment = (row: Record<string, unknown>): DraftComment => ({
  id: String(row.id),
  path: String(row.path),
  line: row.line === null ? null : Number(row.line),
  side: String(row.side) as Side,
  startLine: row.start_line === null ? null : Number(row.start_line),
  startSide: row.start_side === null ? null : (String(row.start_side) as Side),
  subjectType: String(row.subject_type) as DraftComment['subjectType'],
  body: String(row.body),
  origin: String(row.origin) as DraftComment['origin'],
  anchorOid: String(row.anchor_oid),
  status: String(row.status) as DraftComment['status'],
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

/** Local, unsubmitted review drafts. Nothing here reaches GitHub until the user submits. */
export class DraftStore {
  constructor(private readonly store: Store) {}

  draft(account: string, prId: string): (DraftRow & { comments: DraftComment[] }) | null {
    const row = this.store.db
      .prepare(
        'SELECT body, event, github_review_id, updated_at FROM review_drafts WHERE account = ? AND pr_id = ?',
      )
      .get(account, prId) as DraftRow | undefined;
    const comments = this.comments(account, prId);

    if (!row && comments.length === 0) return null;

    return {
      body: row?.body ?? '',
      event: row?.event ?? 'COMMENT',
      github_review_id: row?.github_review_id ?? null,
      updated_at: row?.updated_at ?? comments.at(-1)!.updatedAt,
      comments,
    };
  }

  comments(account: string, prId: string): DraftComment[] {
    return (
      this.store.db
        .prepare(
          'SELECT * FROM draft_comments WHERE account = ? AND pr_id = ? ORDER BY created_at, rowid',
        )
        .all(account, prId) as Record<string, unknown>[]
    ).map(toComment);
  }

  /** PR ids with a draft in progress, for badges in the inbox. */
  prsWithDrafts(account: string): Set<string> {
    const rows = this.store.db
      .prepare(
        "SELECT pr_id FROM draft_comments WHERE account = ? UNION SELECT pr_id FROM review_drafts WHERE account = ? AND (body != '' OR event != 'COMMENT')",
      )
      .all(account, account) as { pr_id: string }[];

    return new Set(rows.map((row) => row.pr_id));
  }

  saveMeta(
    account: string,
    prId: string,
    changes: { body?: string; event?: ReviewEvent; githubReviewId?: string | null },
  ): void {
    const current = this.draft(account, prId);
    const now = new Date().toISOString();

    this.store.db
      .prepare(
        'INSERT OR REPLACE INTO review_drafts (account, pr_id, body, event, github_review_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        account,
        prId,
        changes.body ?? current?.body ?? '',
        changes.event ?? current?.event ?? 'COMMENT',
        changes.githubReviewId !== undefined
          ? changes.githubReviewId
          : (current?.github_review_id ?? null),
        now,
      );
  }

  addComment(
    account: string,
    prId: string,
    input: Omit<DraftComment, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
  ): DraftComment {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.store.db
      .prepare(
        `INSERT INTO draft_comments (id, account, pr_id, path, line, side, start_line, start_side, subject_type, body, origin, anchor_oid, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        account,
        prId,
        input.path,
        input.line,
        input.side,
        input.startLine,
        input.startSide,
        input.subjectType,
        input.body,
        input.origin,
        input.anchorOid,
        now,
        now,
      );

    return this.comment(account, id)!;
  }

  comment(account: string, id: string): DraftComment | null {
    const row = this.store.db
      .prepare('SELECT * FROM draft_comments WHERE account = ? AND id = ?')
      .get(account, id) as Record<string, unknown> | undefined;

    return row ? toComment(row) : null;
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

    this.store.db
      .prepare(
        'UPDATE draft_comments SET body = ?, line = ?, start_line = ?, status = ?, anchor_oid = ?, github_thread_id = COALESCE(?, github_thread_id), updated_at = ? WHERE account = ? AND id = ?',
      )
      .run(
        changes.body ?? current.body,
        changes.line !== undefined ? changes.line : current.line,
        changes.startLine !== undefined ? changes.startLine : current.startLine,
        changes.status ?? current.status,
        changes.anchorOid ?? current.anchorOid,
        changes.githubThreadId ?? null,
        new Date().toISOString(),
        account,
        id,
      );
  }

  deleteComment(account: string, id: string): void {
    this.store.db
      .prepare('DELETE FROM draft_comments WHERE account = ? AND id = ?')
      .run(account, id);
  }

  clear(account: string, prId: string): void {
    this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM draft_comments WHERE account = ? AND pr_id = ?')
        .run(account, prId);
      this.store.db
        .prepare('DELETE FROM review_drafts WHERE account = ? AND pr_id = ?')
        .run(account, prId);
    });
  }
}
