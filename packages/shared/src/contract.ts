import { z } from 'zod';
import { defaultAiSettings } from '@/ai.js';
import type {
  AiProviderStatus,
  AiReviewStatus,
  AiRun,
  AiRunsResponse,
  AiSettings,
  CodexAccountStatus,
} from '@/ai.js';
import type { AuthorItem } from '@/author.js';
import type { DiffManifest } from '@/diff.js';
import type { ServerEvent } from '@/events.js';
import type { Insights } from '@/insights.js';
import type { NotificationSettings, ReviewNotification } from '@/notify.js';
import type { GitHubOperation, OperationList, OperationReceipt } from '@/operations.js';
import type { DraftAttempt, DraftComment, ReviewDraft } from '@/review.js';
import type { LinearIssue, LinearStatus } from '@/tickets.js';
import type { GitHubAccountList, PullRequestDetail, PullRequestList, SyncStatus } from '@/types.js';

/**
 * The HTTP API, one entry per route, shared by the server that serves it and the web app that
 * calls it. Requests are zod schemas, checked by the server; responses are types only, known at
 * compile time (`as<T>()`), keyed by the status that carries them.
 */

/** A response body's type, for the compiler only. */
export interface As<T> {
  readonly __type?: T;
}

export const as = <T>(): As<T> => ({});

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a refusal carries: a message, often a code, and any details the route adds. */
export const errorBody = z.object({ error: z.string(), code: z.string().optional() }).passthrough();

export type ErrorBody = z.infer<typeof errorBody>;

/**
 * A request body. `canonical`: the schema the server parses with the path's account in it, as the
 * routes that once named the account in their body did, so an action's fingerprint is unchanged
 * (the account first, then the fields in order). `body`: a schema parsed as sent.
 */
export type Body =
  | { canonical: z.ZodType<Record<string, unknown>> }
  | {
      /** Parsed as sent: a route that takes no body at all says so with a default. */
      schema: z.ZodType;
      invalid?: { error: string; details?: boolean };
    };

export interface JsonRoute<
  M extends Method = Method,
  P extends string = string,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends Body | undefined = Body | undefined,
  R extends Record<number, As<unknown>> = Record<number, As<unknown>>,
> {
  kind: 'json';
  method: M;
  path: P;
  query?: Q;
  body?: B;
  responses: R;
  /** An outbox action: sent with an ID kept across a lost answer (`command`). */
  queued?: true;
}

/** A route whose request is a queued action. */
export type QueuedRoute = JsonRoute & { queued: true };

/** The event stream: frames, not a JSON reply. */
export interface StreamRoute<P extends string = string> {
  kind: 'stream';
  method: 'GET';
  path: P;
}

/** A route that sends the browser elsewhere. */
export interface RedirectRoute<P extends string = string> {
  kind: 'redirect';
  method: 'GET';
  path: P;
  status: 303;
  /** Checked by the handler, which redirects either way. */
  query?: z.ZodType;
}

export type Route = JsonRoute | StreamRoute | RedirectRoute;

/** `{ account, id }` for `/api/accounts/:account/pulls/:id`. */
export type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : Record<never, never>;

/** The body a caller sends: a canonical schema's without the account the path names. */
export type BodyOf<B> = B extends { canonical: infer S extends z.ZodType }
  ? Omit<z.input<S>, 'account'>
  : B extends { schema: infer S extends z.ZodType }
    ? z.input<S>
    : never;

/** Every success a route answers with: its status and its body. */
export type Reply<R extends JsonRoute> = {
  [S in keyof R['responses'] & number]: {
    status: S;
    body: R['responses'][S] extends As<infer T> ? T : never;
  };
}[keyof R['responses'] & number];

export type ResponseOf<R extends JsonRoute> = Reply<R>['body'];

const json = <
  M extends Method,
  P extends string,
  R extends Record<number, As<unknown>>,
  Q extends z.ZodType | undefined = undefined,
  B extends Body | undefined = undefined,
>(
  method: M,
  path: P,
  spec: { responses: R; query?: Q; body?: B },
): JsonRoute<M, P, Q, B, R> => ({ kind: 'json', method, path, ...spec });

/** An outbox action's route. */
const queued = <
  M extends Method,
  P extends string,
  R extends Record<number, As<unknown>>,
  B extends Body,
>(
  method: M,
  path: P,
  spec: { responses: R; body: B },
): JsonRoute<M, P, undefined, B, R> & { queued: true } => ({
  kind: 'json',
  method,
  path,
  ...spec,
  queued: true,
});

// Shared pieces --------------------------------------------------------------------------------

const account = z.string().min(1).max(100);
const text = z.string().trim().min(1).max(65_536);
const side = z.enum(['LEFT', 'RIGHT']);
const event = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const line = z.number().int().positive().nullable();
const operationId = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9-]+$/);
const oid = z.string().min(7).max(64);

/**
 * A draft write's guard, all optional: the id a retry of it answers by, and the draft revision
 * (and generation) it saw, which it is refused against once the draft has moved on.
 */
const guard = {
  writeId: operationId.optional(),
  baseRevision: z.number().int().nonnegative().optional(),
  baseGeneration: z.number().int().nonnegative().optional(),
};

/**
 * The PR a guarded write to a run's draft is for: its claim is that PR's, and the run must be one
 * of it. Runs are addressed by their own id, which names no PR.
 */
const runPr = z.string().min(1).max(200).optional();

/** A claimed write to a run's draft names its PR: its outcome is that PR's to look up. */
const namesItsPr = (value: { writeId?: string; prId?: string }) =>
  value.writeId === undefined || value.prId !== undefined;

const newComment = z
  .object({
    account,
    path: z.string().min(1).max(1000),
    line,
    side: side.optional(),
    startLine: line.optional(),
    startSide: side.nullable().optional(),
    body: text,
    origin: z.enum(['user', 'ai']).optional(),
    revision: z.object({ headOid: oid, baseOid: oid.nullable() }).strict().optional(),
  })
  .strict();

/** The review routes' requests, with the account: their order is the outbox fingerprint's. */
export const reviewRequests = {
  draft: z
    .object({
      account,
      body: z.string().max(65_536).optional(),
      event: event.optional(),
      ...guard,
    })
    .strict(),
  comment: newComment.extend(guard).strict(),
  edit: z.object({ account, body: text, ...guard }).strict(),
  remove: z.object({ account, ...guard }).strict(),
  discard: z
    .object({
      account,
      operationId,
      baseRevision: guard.baseRevision,
      baseGeneration: guard.baseGeneration,
    })
    .strict(),
  submit: z
    .object({
      account,
      event,
      body: z.string().max(65_536),
      expectedHeadOid: oid,
      allowNewHead: z.boolean().optional(),
      operationId,
      baseRevision: guard.baseRevision,
      baseGeneration: guard.baseGeneration,
      /** The pending review the sheet showed (none: null); refused when admission finds another. */
      expectedPendingReviewId: z.string().min(1).max(200).nullable().optional(),
    })
    .strict(),
  now: newComment
    .extend({ path: z.string().max(1000), operationId, expectedHeadOid: oid })
    .strict(),
  reply: z.object({ account, prId: z.string().min(1), body: text, operationId }).strict(),
  resolve: z
    .object({ account, prId: z.string().min(1), resolved: z.boolean(), operationId })
    .strict(),
  viewed: z
    .object({
      account,
      path: z.string().min(1).max(1000),
      viewed: z.boolean(),
      /** The diff the page showed when you marked the file: its PR head and base, and file key. */
      target: z
        .object({
          headOid: oid,
          baseOid: oid.nullable(),
          fileKey: z.string().min(1).max(200).optional(),
        })
        .strict()
        .optional(),
      operationId,
    })
    .strict(),
  reviewers: z
    .object({
      account,
      operationId,
      logins: z
        // GitHub logins, and GitLab usernames, which can also contain `.` and `_`.
        .array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/))
        .min(1)
        .max(15),
    })
    .strict(),
};

const provider = z.enum(['codex', 'claude']);
const task = z.enum([
  'full_review',
  'brief',
  'since_review',
  'draft_comments',
  'author_feedback',
  'draft_summary',
]);
const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const taskSettings = z.strictObject({
  provider: provider.nullable(),
  effort,
  model: z.string().max(100).nullable(),
});

/** The AI routes' requests. */
export const aiRequests = {
  settings: z.strictObject({
    account,
    settings: z.strictObject({
      defaultProvider: provider,
      tasks: z.strictObject({
        full_review: taskSettings.optional().default(defaultAiSettings().tasks.full_review),
        brief: taskSettings,
        since_review: taskSettings,
        draft_comments: taskSettings,
        author_feedback: taskSettings,
        draft_summary: taskSettings,
      }),
      // `since` is set by the server; a value sent back from the client is ignored.
      autoReview: z
        .strictObject({ enabled: z.boolean(), since: z.string().max(40).nullable().optional() })
        .optional(),
      // Optional so a window opened before the setting existed keeps its saved value.
      postFindings: z.boolean().optional(),
      approveFindings: z.boolean().optional(),
      resolveThreads: z.boolean().optional(),
    }),
  }),
  // Only the switches you changed: a save never resends, and so never restores, the others.
  automation: z.strictObject({
    account,
    changes: z
      .strictObject({
        autoReview: z.boolean().optional(),
        postFindings: z.boolean().optional(),
        approveFindings: z.boolean().optional(),
        resolveThreads: z.boolean().optional(),
      })
      .refine((changes) => Object.keys(changes).length > 0, 'Nothing to change.'),
  }),
  start: z.strictObject({
    account,
    task,
    provider: provider.optional(),
    force: z.boolean().optional(),
    /** The start's own id: a retry answers with the run it started or joined. */
    attemptId: guard.writeId,
    baseRevision: guard.baseRevision,
    baseGeneration: guard.baseGeneration,
  }),
  run: z.strictObject({ account }),
  apply: z.strictObject({ account, ...guard, prId: runPr }).refine(namesItsPr),
  accept: z
    .strictObject({
      account,
      index: z.number().int().min(0),
      body: z.string().trim().min(1).max(65_536).optional(),
      ...guard,
      prId: runPr,
    })
    .refine(namesItsPr),
  prepare: z
    .strictObject({
      account,
      indices: z.array(z.number().int().min(0)).max(100),
      replace: z.boolean().optional(),
      expectedDraftRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      ...guard,
      prId: runPr,
    })
    .refine((value) => !value.replace || Boolean(value.expectedDraftRevision))
    .refine(namesItsPr),
};

/** Triage of the account the path names: the body carries no account of its own. */
export const triageBody = z
  .object({
    note: z.string().max(30_000).optional(),
    seenReplyKeys: z.array(z.string().max(250)).max(10_000).optional(),
    snoozeUntil: z.iso.datetime().nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

/** Adding a PR by hand for the account the path names. */
export const trackBody = z
  .object({
    // `owner/repo` on GitHub; GitLab projects can sit in nested groups (`group/sub/project`).
    repository: z
      .string()
      .max(400)
      .regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
    number: z.number().int().positive().max(1_000_000_000),
    /** The host of a pasted link (`github.com`, or a GitLab host, port included). */
    host: z
      .string()
      .max(255)
      .regex(/^[\w.-]+(?::\d{1,5})?$/)
      .optional(),
    /** True for a GitLab reference (`group/project!123` or an MR link). */
    gitlab: z.boolean().optional(),
  })
  .strict();

/** Undo names the membership its add made; Remove names none, and removes the current one. */
export const untrackBody = z.object({ membershipId: z.uuid().optional() }).strict();

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notificationSettingsBody = z.strictObject({
  account: z.string().min(1),
  settings: z.strictObject({
    kinds: z.strictObject({
      first_review: z.boolean(),
      changed: z.boolean(),
      requested_again: z.boolean(),
      reply: z.boolean(),
      mention: z.boolean(),
      dismissed: z.boolean(),
      changes_requested: z.boolean(),
      approved: z.boolean(),
      ci_failing: z.boolean(),
      ai_review_ready: z.boolean(),
    }),
    quietHours: z.strictObject({ start: time, end: time }).nullable(),
    macosWhenClosed: z.boolean(),
    badgeIncludesMine: z.boolean(),
  }),
});

const login = z.string().min(1).max(100);

/** The PRs you wrote, for an account. */
export interface MineList {
  account: string | null;
  items: AuthorItem[];
}

/** A PR's Linear tickets. */
export interface TicketsResponse {
  identifiers: string[];
  issues: LinearIssue[];
  error: string | null;
}

/** An account's Insights, with its history import and the shared review target. */
export interface InsightsResponse {
  insights: Insights | null;
  backfill: {
    doneWindows: string[];
    finishedAt: string | null;
    lastError: string | null;
    running: boolean;
  } | null;
  slaHours: number;
  repositories: string[];
}

export interface AiOverview {
  settings: AiSettings;
  providers: AiProviderStatus[];
  codex: CodexAccountStatus | null;
}

/** A body these routes treat as empty when it is missing, or `null`, as they always have. */
const orEmpty = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => value ?? {}, schema) as unknown as z.ZodType<
    z.output<S>,
    z.input<S> | undefined
  >;

/** What Linear sends back after sign-in. */
export const linearCallbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
  iss: z.string().max(200).optional(),
});

const ok = as<{ ok: true }>();
const receipt = as<OperationReceipt>();
/** A guarded draft write's answer carries its outcome; one still pending answers 202. */
type Attempted = { attempt?: DraftAttempt };
const pendingAttempt = as<{ pending: true; attempt: DraftAttempt }>();
const pulls = '/api/accounts/:account/pulls' as const;
const runs = '/api/accounts/:account/ai/runs/:runId' as const;

// The routes ------------------------------------------------------------------------------------

export const routes = {
  // Status and sync: every window's, not one account's.
  status: json('GET', '/api/status', { responses: { 200: as<SyncStatus>() } }),
  sync: json('POST', '/api/sync', { responses: { 202: as<SyncStatus>() } }),
  events: { kind: 'stream', method: 'GET', path: '/api/events' } as StreamRoute<'/api/events'>,

  // Accounts.
  accounts: json('GET', '/api/accounts', { responses: { 200: as<GitHubAccountList>() } }),
  switchAccount: json('POST', '/api/accounts/switch', {
    body: {
      schema: z.strictObject({ from: login.nullable(), to: login }),
      invalid: { error: 'Choose an account to switch to.', details: true },
    },
    responses: { 200: as<SyncStatus>() },
  }),

  // An account's PRs.
  pulls: json('GET', pulls, { responses: { 200: as<PullRequestList>() } }),
  mine: json('GET', '/api/accounts/:account/mine', { responses: { 200: as<MineList>() } }),
  detail: json('GET', `${pulls}/:id`, { responses: { 200: as<PullRequestDetail>() } }),
  refresh: json('POST', `${pulls}/:id/refresh`, { responses: { 200: as<PullRequestDetail>() } }),
  triage: json('PATCH', `${pulls}/:id/triage`, {
    body: { schema: triageBody, invalid: { error: 'Invalid triage update.', details: true } },
    responses: { 200: as<PullRequestDetail>() },
  }),
  track: json('POST', `${pulls}/track`, {
    body: {
      schema: trackBody,
      invalid: {
        error:
          'Enter a PR as owner/repo#123, a GitLab MR as group/project!123, or a link to either.',
        details: true,
      },
    },
    responses: { 200: as<PullRequestDetail & { membershipId: string | null }>() },
  }),
  untrack: json('DELETE', `${pulls}/:id/track`, {
    // Remove sends no body at all.
    body: {
      schema: orEmpty(untrackBody),
      invalid: { error: 'Invalid request.', details: true },
    },
    responses: { 200: as<{ tracked: boolean }>() },
  }),
  diff: json('GET', `${pulls}/:id/diff`, {
    // An unknown mode is the full diff, as it always was.
    query: z.object({ mode: z.enum(['full', 'since-review']).catch('full').optional() }),
    responses: { 200: as<DiffManifest & { account: string }>() },
  }),
  tickets: json('GET', `${pulls}/:id/tickets`, { responses: { 200: as<TicketsResponse>() } }),

  // An account's review drafts and actions.
  draft: json('GET', `${pulls}/:id/draft`, { responses: { 200: as<ReviewDraft>() } }),
  saveDraft: json('PUT', `${pulls}/:id/draft`, {
    body: { canonical: reviewRequests.draft },
    responses: { 200: as<ReviewDraft & Attempted>(), 202: pendingAttempt },
  }),
  discard: queued('DELETE', `${pulls}/:id/draft`, {
    body: { canonical: reviewRequests.discard },
    // Cleared at once when nothing is on the forge; queued otherwise, or replayed.
    responses: { 200: ok, 202: receipt },
  }),
  addComment: json('POST', `${pulls}/:id/draft/comments`, {
    body: { canonical: reviewRequests.comment },
    responses: { 200: as<DraftComment & Attempted>(), 202: pendingAttempt },
  }),
  editComment: json('PATCH', `${pulls}/:id/draft/comments/:cid`, {
    body: { canonical: reviewRequests.edit },
    responses: { 200: as<DraftComment & Attempted>(), 202: pendingAttempt },
  }),
  deleteComment: json('DELETE', `${pulls}/:id/draft/comments/:cid`, {
    body: { canonical: reviewRequests.remove },
    responses: { 200: as<{ ok: true } & Attempted>(), 202: pendingAttempt },
  }),
  draftAttempt: json('GET', `${pulls}/:id/draft/attempts/:attemptId`, {
    query: z.object({
      base: z.coerce.number().int().nonnegative().optional(),
      generation: z.coerce.number().int().nonnegative().optional(),
    }),
    responses: {
      200: as<
        { attempt: DraftAttempt & { result?: unknown } } | { arrived: false; fenced: boolean }
      >(),
    },
  }),
  submit: queued('POST', `${pulls}/:id/review`, {
    body: { canonical: reviewRequests.submit },
    responses: { 202: receipt },
  }),
  commentNow: queued('POST', `${pulls}/:id/comments`, {
    body: { canonical: reviewRequests.now },
    responses: { 202: receipt },
  }),
  viewed: queued('POST', `${pulls}/:id/viewed`, {
    body: { canonical: reviewRequests.viewed },
    responses: { 202: receipt },
  }),
  reviewers: queued('POST', `${pulls}/:id/reviewers`, {
    body: { canonical: reviewRequests.reviewers },
    responses: { 202: receipt },
  }),
  reply: queued('POST', '/api/accounts/:account/threads/:threadId/replies', {
    body: { canonical: reviewRequests.reply },
    responses: { 202: receipt },
  }),
  resolve: queued('POST', '/api/accounts/:account/threads/:threadId/resolution', {
    body: { canonical: reviewRequests.resolve },
    responses: { 202: receipt },
  }),

  // An account's Activity.
  operations: json('GET', '/api/accounts/:account/operations', {
    query: z.object({ cursor: z.string().optional() }),
    responses: { 200: as<OperationList>() },
  }),
  operation: json('GET', '/api/accounts/:account/operations/:id', {
    responses: { 200: as<{ operation: GitHubOperation }>() },
  }),
  operationReceipt: json('GET', '/api/accounts/:account/operations/:id/receipt', {
    responses: {
      200: as<{
        kind: 'local' | 'forge';
        status: GitHubOperation['status'];
        /** For a finished operation, the draft versions its last write to the draft left. */
        draft?: { revision: number; generation: number };
      }>(),
    },
  }),
  operationCommand: json('POST', '/api/accounts/:account/operations/:id/:command', {
    body: {
      schema: orEmpty(z.object({ confirm: z.boolean().optional() }).strict()),
      invalid: { error: 'Invalid operation command.' },
    },
    responses: { 200: receipt },
  }),

  // AI: settings are shared; runs are an account's.
  ai: json('GET', '/api/ai', { responses: { 200: as<AiOverview>() } }),
  aiSettings: json('PUT', '/api/ai/settings', {
    body: { schema: aiRequests.settings, invalid: { error: 'Invalid request.', details: true } },
    responses: { 200: as<AiSettings>() },
  }),
  aiAutomation: json('PUT', '/api/ai/automation', {
    body: { schema: aiRequests.automation, invalid: { error: 'Invalid request.', details: true } },
    responses: { 200: as<AiSettings>() },
  }),
  aiReviews: json('GET', '/api/accounts/:account/ai/reviews', {
    responses: { 200: as<{ reviews: AiReviewStatus[] }>() },
  }),
  aiRuns: json('GET', `${pulls}/:id/ai`, { responses: { 200: as<AiRunsResponse>() } }),
  startAi: json('POST', `${pulls}/:id/ai`, {
    body: { canonical: aiRequests.start },
    responses: { 200: as<AiRun & Attempted>(), 202: pendingAttempt },
  }),
  cancelAi: json('DELETE', runs, { body: { canonical: aiRequests.run }, responses: { 200: ok } }),
  pauseAi: json('POST', `${runs}/pause`, {
    body: { canonical: aiRequests.run },
    responses: { 200: ok },
  }),
  resumeAi: json('POST', `${runs}/resume`, {
    body: { canonical: aiRequests.run },
    responses: { 200: as<AiRun>() },
  }),
  acceptAi: json('POST', `${runs}/accept`, {
    body: { canonical: aiRequests.accept },
    responses: { 200: as<DraftComment & Attempted>(), 202: pendingAttempt },
  }),
  prepareAi: json('POST', `${runs}/draft`, {
    body: { canonical: aiRequests.prepare },
    responses: { 200: as<ReviewDraft & Attempted>(), 202: pendingAttempt },
  }),
  applyAi: json('POST', `${runs}/summary`, {
    body: { canonical: aiRequests.apply },
    responses: { 200: as<ReviewDraft & Attempted>(), 202: pendingAttempt },
  }),

  // Insights: an account's; the review target is every account's.
  insights: json('GET', '/api/accounts/:account/insights', {
    query: z.object({
      // The ranges offered; anything else is the default, as it always was.
      days: z.coerce
        .number()
        .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
        .catch(30)
        .optional() as unknown as z.ZodType<7 | 30 | 90 | undefined, 7 | 30 | 90 | undefined>,
      repo: z.string().optional(),
    }),
    responses: { 200: as<InsightsResponse>() },
  }),
  backfill: json('POST', '/api/accounts/:account/insights/backfill', {
    body: { schema: orEmpty(z.strictObject({})), invalid: { error: 'Invalid request.' } },
    responses: { 202: as<{ started: true }>() },
  }),
  insightsSettings: json('PUT', '/api/insights/settings', {
    body: {
      schema: z.strictObject({
        account: z.string().min(1),
        slaHours: z.number().int().min(1).max(240),
      }),
      invalid: { error: 'Choose a review target between 1 and 240 hours.' },
    },
    responses: { 200: as<{ slaHours: number }>() },
  }),

  // Notifications.
  notificationSettings: json('GET', '/api/notifications/settings', {
    responses: { 200: as<NotificationSettings>() },
  }),
  saveNotificationSettings: json('PUT', '/api/notifications/settings', {
    body: {
      schema: notificationSettingsBody,
      invalid: { error: 'Invalid notification settings.' },
    },
    responses: { 200: as<NotificationSettings>() },
  }),
  testNotification: json('POST', '/api/notifications/test', { responses: { 200: ok } }),

  // Linear: connected once, for every account.
  linearStatus: json('GET', '/api/linear/status', { responses: { 200: as<LinearStatus>() } }),
  linearConnect: json('POST', '/api/linear/connect', { responses: { 200: as<{ url: string }>() } }),
  linearCallback: {
    kind: 'redirect',
    method: 'GET',
    path: '/api/linear/callback',
    status: 303,
    query: linearCallbackQuery,
  } as RedirectRoute<'/api/linear/callback'>,
  linearDisconnect: json('POST', '/api/linear/disconnect', {
    responses: { 200: as<LinearStatus>() },
  }),
} as const;

/** Demo-only controls, registered only against the scripted scenario. */
export const devRoutes = {
  advance: json('POST', '/api/dev/advance', { responses: { 200: as<{ label: string | null }>() } }),
  writes: json('GET', '/api/dev/writes', {
    responses: { 200: as<{ writes: { op: string; details: Record<string, unknown> }[] }>() },
  }),
  fail: json('POST', '/api/dev/fail', {
    // Each field checked on its own by the control, as the e2e helpers send them; none is fine.
    body: { schema: z.unknown() },
    responses: { 200: as<{ failNext: string | null }>() },
  }),
  operations: json('POST', '/api/dev/operations', {
    body: { schema: z.unknown() },
    responses: { 200: as<{ delayMs: number }>() },
  }),
  reset: json('POST', '/api/dev/reset', { responses: { 200: ok } }),
} as const;

// The event stream's frames ----------------------------------------------------------------------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A sync status as the server sends it, checked so a malformed one is never shown. */
const syncStatus = z.object({
  account: z
    .object({ login: z.string(), avatarUrl: z.string().optional(), webUrl: z.string().optional() })
    .nullable(),
  capabilities: z.object({ requestChanges: z.boolean() }).optional(),
  teams: z.array(z.string()),
  syncing: z.boolean(),
  lastAttemptAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastSuccessfulSync: z.string().nullable(),
  nextSyncAt: z.string().nullable(),
  retryAt: z.string().nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  bootId: z.string().optional(),
  revision: z.number().optional(),
});

const reviewNotification = z.object({
  key: z.string(),
  kind: z.enum([
    'first_review',
    'changed',
    'requested_again',
    'reply',
    'mention',
    'dismissed',
    'changes_requested',
    'approved',
    'ci_failing',
    'ai_review_ready',
  ]),
  prId: z.string(),
  title: z.string(),
  body: z.string(),
  path: z.string(),
});

/** The schemas and the types say the same: a new field must be added to both. */
export const statusInStep: Same<z.infer<typeof syncStatus>, SyncStatus> = true;
export const notificationInStep: Same<
  z.infer<typeof reviewNotification>,
  ReviewNotification
> = true;

const operationStatus = z.enum([
  'queued',
  'running',
  'waiting',
  'checking',
  'needs_attention',
  'succeeded',
  'cancelled',
]);

/** One frame of `/api/events`. The large payloads (a status, notifications) are their own types. */
export const serverEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    bootId: z.string(),
    account: z.string().nullable(),
    demo: z.boolean(),
  }),
  z.object({ type: z.literal('resync') }),
  z.object({
    type: z.literal('status'),
    status: syncStatus,
  }),
  z.object({ type: z.literal('pulls.changed'), account: z.string(), ids: z.array(z.string()) }),
  z.object({ type: z.literal('triage.updated'), account: z.string(), id: z.string() }),
  z.object({ type: z.literal('draft.updated'), account: z.string(), id: z.string() }),
  z.object({
    type: z.literal('operation.updated'),
    account: z.string(),
    prId: z.string(),
    operationId: z.string(),
    status: operationStatus,
  }),
  z.object({
    type: z.literal('ai.updated'),
    account: z.string(),
    prId: z.string(),
    runId: z.string().optional(),
  }),
  z.object({
    type: z.literal('notify'),
    notifications: z.array(reviewNotification),
  }),
  z.object({ type: z.literal('insights.updated'), account: z.string().nullable() }),
]);

/** The schema and the type say the same: a new event must be added to both. */
export const eventsInStep: Same<z.infer<typeof serverEvent>, ServerEvent> = true;
