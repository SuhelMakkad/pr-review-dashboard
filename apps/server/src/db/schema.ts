import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AiEffort,
  AiProvider,
  AiPublication,
  AiRunContext,
  AiRunStatus,
  AiRunTrigger,
  AiTask,
  ReviewInputs,
} from '@review-desk/shared/ai';
import type { ActivityKind } from '@review-desk/shared/insights';
import type { OperationRecord } from '@/operations/types.js';
import type { DraftComment, ReviewDraft, ReviewEvent, Side } from '@review-desk/shared/review';
import type { LocalTriageState, PullRequestSnapshot, Source } from '@review-desk/shared/types';

/**
 * The database schema, and the source of truth for migrations: after changing it, run
 * `pnpm db:generate --name <change>` and commit the new folder under `drizzle/`.
 */

/** Cached GitHub pull requests, one JSON document per PR. */
export const snapshots = sqliteTable(
  'snapshots',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    data: text('data', { mode: 'json' }).$type<PullRequestSnapshot>().notNull(),
    /**
     * The document's own state, read from it by SQLite so the two never disagree. Null for a row
     * whose JSON is malformed, which the index can then still hold.
     */
    state: text('state')
      .$type<PullRequestSnapshot['state']>()
      .generatedAlwaysAs(sql`CASE WHEN json_valid(data) THEN json_extract(data, '$.state') END`, {
        mode: 'virtual',
      }),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.id] }),
    // Open PRs in ID order, without reading closed and merged ones.
    index('snapshots_by_state').on(table.account, table.state, table.id),
  ],
);

/** Local triage (snoozes, notes, last review marker) per PR. */
export const triage = sqliteTable(
  'triage',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    data: text('data', { mode: 'json' }).$type<Partial<LocalTriageState>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.account, table.id] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
});

/** When each PR was last fetched in full, and its fingerprint at the time. */
export const prSync = sqliteTable(
  'pr_sync',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    fingerprint: text('fingerprint'),
    lastFullAt: text('last_full_at'),
    nextFullAt: text('next_full_at'),
  },
  (table) => [primaryKey({ columns: [table.account, table.id] })],
);

/** Which discovery feeds currently return each PR. */
export const feedMembership = sqliteTable(
  'feed_membership',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    feed: text('feed').$type<Source>().notNull(),
    seenAt: text('seen_at').notNull(),
    /**
     * Names one manual membership, from the add that made it to its removal: an Undo removes only
     * the membership its add made, never one added again since. Null for other feeds, and for
     * manual rows made before it existed.
     */
    membershipId: text('membership_id'),
  },
  (table) => [primaryKey({ columns: [table.account, table.id, table.feed] })],
);

export const activityEvents = sqliteTable(
  'activity_events',
  {
    account: text('account').notNull(),
    key: text('key').notNull(),
    prId: text('pr_id').notNull(),
    repository: text('repository').notNull(),
    number: integer('number').notNull(),
    kind: text('kind').$type<ActivityKind>().notNull(),
    actor: text('actor'),
    at: text('at').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.key] }),
    index('activity_events_by_time').on(table.account, table.at),
  ],
);

export const queueSamples = sqliteTable(
  'queue_samples',
  {
    account: text('account').notNull(),
    at: text('at').notNull(),
    attention: integer('attention').notNull(),
    waiting: integer('waiting').notNull(),
    authoredBlocked: integer('authored_blocked').notNull(),
    oldestAttentionAt: text('oldest_attention_at'),
  },
  (table) => [primaryKey({ columns: [table.account, table.at] })],
);

export const reviewDrafts = sqliteTable(
  'review_drafts',
  {
    account: text('account').notNull(),
    prId: text('pr_id').notNull(),
    body: text('body').notNull().default(''),
    event: text('event').$type<ReviewEvent>().notNull().default('COMMENT'),
    githubReviewId: text('github_review_id'),
    activeOperationId: text('active_operation_id'),
    preparedReview: text('prepared_review', { mode: 'json' }).$type<
      ReviewDraft['preparedReview']
    >(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.account, table.prId] })],
);

export const draftComments = sqliteTable(
  'draft_comments',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull(),
    prId: text('pr_id').notNull(),
    path: text('path').notNull(),
    line: integer('line'),
    side: text('side').$type<Side>().notNull().default('RIGHT'),
    startLine: integer('start_line'),
    startSide: text('start_side').$type<Side>(),
    subjectType: text('subject_type')
      .$type<DraftComment['subjectType']>()
      .notNull()
      .default('LINE'),
    body: text('body').notNull(),
    origin: text('origin').$type<DraftComment['origin']>().notNull().default('user'),
    anchorOid: text('anchor_oid').notNull(),
    status: text('status').$type<DraftComment['status']>().notNull().default('draft'),
    githubThreadId: text('github_thread_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('draft_comments_by_pr').on(table.account, table.prId, table.createdAt)],
);

/**
 * Each PR's draft versions, kept when its draft is cleared. `revision` rises with every change to
 * the draft; `generation` with every clear, lock and unlock as well; `observation` with every
 * snapshot of the PR committed. Writes from the web are fenced by them (see `db/drafts.ts`).
 */
export const draftVersions = sqliteTable(
  'draft_versions',
  {
    account: text('account').notNull(),
    prId: text('pr_id').notNull(),
    revision: integer('revision').notNull().default(0),
    generation: integer('generation').notNull().default(0),
    observation: integer('observation').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.account, table.prId] })],
);

/**
 * The claim ledger: each draft write or AI start that carries an id, claimed as it arrives and
 * settled in the transaction that decides it, so a retry answers from the original's outcome
 * (see `db/draft-writes.ts`).
 */
export const draftWrites = sqliteTable(
  'draft_writes',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    prId: text('pr_id').notNull(),
    kind: text('kind').$type<'write' | 'start'>().notNull(),
    /** The request the id was first sent with: a reuse with another is refused. */
    fingerprint: text('fingerprint').notNull(),
    baseRevision: integer('base_revision'),
    baseGeneration: integer('base_generation'),
    state: text('state').$type<'pending' | 'committed' | 'refused'>().notNull(),
    /** A commit's revision and result, or a refusal's status and answer. */
    result: text('result', { mode: 'json' }).$type<unknown>(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.id] }),
    index('draft_writes_by_state').on(table.state, table.createdAt),
  ],
);

/** AI task runs. `result` and `usage` stay serialised so secrets can be redacted as text. */
export const aiRuns = sqliteTable(
  'ai_runs',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull(),
    prId: text('pr_id').notNull(),
    task: text('task').$type<AiTask>().notNull(),
    provider: text('provider').$type<AiProvider>().notNull(),
    model: text('model'),
    effort: text('effort').$type<AiEffort>().notNull(),
    headOid: text('head_oid').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    cacheKey: text('cache_key').notNull(),
    context: text('context', { mode: 'json' }).$type<AiRunContext>(),
    request: text('request', { mode: 'json' }).$type<{
      input: string;
      instructions: string;
      schema: Record<string, unknown>;
      snapshot: PullRequestSnapshot;
    }>(),
    threadId: text('thread_id'),
    pauseReason: text('pause_reason').$type<'user' | 'restart'>(),
    status: text('status').$type<AiRunStatus>().notNull(),
    progress: text('progress'),
    result: text('result'),
    error: text('error'),
    usage: text('usage'),
    trigger: text('trigger').$type<AiRunTrigger>().notNull().default('manual'),
    /** What a full review was given to read, saved before the agent starts (`ReviewInputs`). */
    inputs: text('inputs', { mode: 'json' }).$type<ReviewInputs>(),
    /** Whether a finished full review was posted, decided when it settled (`AiPublication`). */
    publication: text('publication', { mode: 'json' }).$type<AiPublication>(),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('ai_runs_by_pr').on(table.account, table.prId, table.task, table.createdAt),
    index('ai_runs_by_key').on(table.cacheKey, table.createdAt),
  ],
);

/** Notifications already delivered, so each one is sent at most once per channel key. */
export const notificationLog = sqliteTable(
  'notification_log',
  {
    account: text('account').notNull(),
    key: text('key').notNull(),
    prId: text('pr_id').notNull(),
    channel: text('channel').notNull(),
    sentAt: text('sent_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.account, table.key] })],
);

/**
 * Review requests automatic review has handled, keyed like attention reasons, so each request is
 * reviewed at most once. `primed` marks requests that were already waiting when it was turned on.
 */
export const autoReviewLog = sqliteTable(
  'auto_review_log',
  {
    account: text('account').notNull(),
    key: text('key').notNull(),
    prId: text('pr_id').notNull(),
    /**
     * `checking`: its automatic review finished and is being checked for commits that arrived
     * while it ran. `waiting`: new commits stopped or outdated its automatic review; a fresh one
     * starts at `restartAt`.
     */
    status: text('status')
      .$type<'primed' | 'started' | 'skipped' | 'failed' | 'waiting' | 'checking'>()
      .notNull(),
    runId: text('run_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    updatedAt: text('updated_at').notNull(),
    /** While waiting: the newest head seen. Another push starts the wait over. */
    headOid: text('head_oid'),
    restartAt: text('restart_at'),
    /** When the wait began; pushes do not move it. A review started since replaces the restart. */
    waitingSince: text('waiting_since'),
  },
  (table) => [primaryKey({ columns: [table.account, table.key] })],
);

export type AiRunRow = typeof aiRuns.$inferSelect;
export type DraftCommentRow = typeof draftComments.$inferSelect;
export type ReviewDraftRow = typeof reviewDrafts.$inferSelect;

/** Durable GitHub outbox. The document includes immutable input and per-mutation receipts. */
export const githubOperations = sqliteTable(
  'github_operations',
  {
    account: text('account').notNull(),
    id: text('id').notNull(),
    prId: text('pr_id').notNull(),
    status: text('status').$type<OperationRecord['status']>().notNull(),
    createdAt: text('created_at').notNull(),
    data: text('data', { mode: 'json' }).$type<OperationRecord>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.id] }),
    index('github_operations_by_account').on(table.account, table.createdAt, table.id),
    index('github_operations_by_pr').on(table.account, table.prId, table.status),
  ],
);
