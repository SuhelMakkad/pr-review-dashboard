import type {
  Actor,
  Check,
  CiState,
  ConversationComment,
  PullFile,
  PullRequestSnapshot,
  RequestEvent,
  Review,
  ReviewerVerdict,
  ReviewState,
  ReviewThread,
} from '@review-desk/shared/types';
import { accountHandle, isSameUser } from '@review-desk/shared/accounts';
import { SNAPSHOT_VERSION } from '@review-desk/shared/snapshot';
import type { RemoteFile } from '@/github/api.js';
import { diffKey } from '@/gitlab/fingerprint.js';
import {
  discussionId,
  mergeRequestId,
  pendingReviewId,
  reviewNoteId,
  type MergeRequestRef,
} from '@/gitlab/ids.js';
import type { DiffRefs } from '@/gitlab/positions.js';

export interface RawUser {
  id: number;
  username: string;
  avatar_url?: string | null;
  web_url?: string;
}

export interface RawPipeline {
  id: number;
  project_id: number;
  status: string;
  web_url?: string;
}

export interface RawMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  created_at: string;
  updated_at: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author: RawUser | null;
  sha: string;
  diff_refs?: DiffRefs | null;
  source_branch: string;
  target_branch: string;
  detailed_merge_status?: string;
  merge_status?: string;
  has_conflicts?: boolean;
  user_notes_count?: number;
  reviewers?: RawUser[];
  assignees?: RawUser[];
  web_url: string;
  references?: { full?: string };
  head_pipeline?: RawPipeline | null;
  discussion_locked?: boolean | null;
  blocking_discussions_resolved?: boolean;
}

export interface RawPosition {
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
  old_path: string;
  new_path: string;
  position_type: 'text' | 'image' | 'file';
  old_line?: number | null;
  new_line?: number | null;
  line_range?: {
    start?: { old_line?: number | null; new_line?: number | null };
    end?: { old_line?: number | null; new_line?: number | null };
  } | null;
}

export interface RawNote {
  id: number;
  type: string | null;
  body: string;
  author: RawUser | null;
  created_at: string;
  updated_at: string;
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: RawPosition | null;
}

export interface RawDiscussion {
  id: string;
  individual_note: boolean;
  notes: RawNote[];
}

export interface RawDiff {
  diff: string;
  new_path: string;
  old_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  /** Set by GitLab releases that report a diff left out for its size. */
  too_large?: boolean;
  collapsed?: boolean;
}

export interface RawVersion {
  id: number;
  head_commit_sha: string;
  /** The target branch commit the version's diff starts from (a snapshot's base). */
  start_commit_sha?: string | null;
  base_commit_sha?: string | null;
  created_at: string;
}

export interface RawReviewer {
  user: RawUser;
  state?: string;
  created_at?: string;
}

export interface RawApprovals {
  approved?: boolean;
  user_has_approved?: boolean;
  approved_by?: { user: RawUser }[];
}

export interface RawDraftNote {
  id: number;
  note: string;
  commit_id?: string | null;
  position?: Partial<RawPosition> | null;
}

/** What is known about a review submitted from Review Desk. */
export interface SubmissionEvidence {
  startedAt: string;
  afterNoteId?: number;
}

export interface RawJob {
  id: number;
  name: string;
  stage?: string;
  status: string;
  web_url?: string;
  allow_failure?: boolean;
}

/** Everything one merge request snapshot is built from. */
export interface MergeRequestData {
  mr: RawMergeRequest;
  discussions: RawDiscussion[];
  reviewers: RawReviewer[];
  approvals: RawApprovals;
  versions: RawVersion[];
  /** Absent for the light snapshots review history uses. */
  diffs?: RawDiff[];
  drafts?: RawDraftNote[];
  jobs?: RawJob[];
  headCommittedAt?: string | null;
  /** Viewed-file marks kept by Review Desk: path → fingerprint of the diff when viewed. */
  viewed?: Record<string, string>;
  /** Review Desk's last submission of your review here, if any. */
  submission?: SubmissionEvidence | null;
}

const DELETED_USER = 'deleted-user';
/** Notes and approvals this close together belong to one review (GitLab publishes them in turn). */
const REVIEW_GAP_MS = 60_000;
/** Notes this close to a submission from Review Desk were published by it (clocks may differ). */
const SUBMISSION_WINDOW_MS = 2 * 60_000;

const time = (value: string) => Date.parse(value);
const actor = (user: RawUser | null | undefined): Actor =>
  user
    ? { login: user.username, avatarUrl: user.avatar_url ?? undefined }
    : { login: DELETED_USER };

export const noteUrl = (mr: { web_url: string }, noteId: number) => `${mr.web_url}#note_${noteId}`;

/** `group/sub/project!12` → `group/sub/project`; falls back to the web URL's path. */
export function repositoryOf(mr: Pick<RawMergeRequest, 'references' | 'web_url'>): string {
  const full = mr.references?.full;

  if (full && full.includes('!')) return full.slice(0, full.lastIndexOf('!'));

  const match = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(mr.web_url);

  return match?.[1] ?? '';
}

export function stateOf(state: RawMergeRequest['state']): PullRequestSnapshot['state'] {
  return state === 'merged' ? 'MERGED' : state === 'closed' ? 'CLOSED' : 'OPEN';
}

export function pipelineState(status: string | null | undefined): CiState {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'canceled':
    case 'canceling':
      return 'failure';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'waiting_for_callback':
    case 'pending':
    case 'running':
    case 'scheduled':
    case 'manual':
      return 'pending';
    default:
      return 'none';
  }
}

function jobState(job: RawJob): CiState {
  if (job.status === 'failed') return job.allow_failure ? 'success' : 'failure';
  if (job.status === 'skipped') return 'success';
  if (job.status === 'manual') return job.allow_failure ? 'none' : 'pending';

  return pipelineState(job.status);
}

export const checks = (jobs: RawJob[]): Check[] =>
  jobs.map((job) => ({
    name: job.stage ? `${job.stage}: ${job.name}` : job.name,
    state: jobState(job),
    url: job.web_url ?? null,
  }));

/** GitHub's merge state names for GitLab's `detailed_merge_status`, as the author view reads them. */
export function mergeStateOf(mr: RawMergeRequest): {
  mergeable: string;
  mergeStateStatus: string | null;
} {
  const status = mr.detailed_merge_status ?? '';
  const conflicting = mr.has_conflicts || status === 'conflict' || status === 'broken_status';

  if (conflicting) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  if (status === 'mergeable') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (status === 'need_rebase') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
  if (status === 'draft_status') return { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' };
  if (status === 'ci_must_pass' || status === 'ci_still_running')
    return { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' };
  if (['checking', 'unchecked', 'preparing', 'approvals_syncing', 'not_open', ''].includes(status))
    return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };

  // not_approved, discussions_not_resolved, requested_changes, blocked_status, and the other
  // policy checks: mergeable once someone else acts.
  return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
}

const mentions = (text: string) =>
  [...text.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)].map((match) =>
    match[1].replace(/\.+$/, ''),
  );

/** Reviewers added and removed by a system note, e.g. "requested review from @a and @b". */
export function reviewerChanges(body: string): { added: string[]; removed: string[] } | null {
  const text = body.trim();
  const removedAt = text.indexOf('removed review request for ');
  const requested = text.startsWith('requested review from ');

  if (!requested && removedAt === -1) return null;

  return {
    added: requested ? mentions(removedAt === -1 ? text : text.slice(0, removedAt)) : [],
    removed: removedAt === -1 ? [] : mentions(text.slice(removedAt)),
  };
}

type Verdict = 'approved' | 'unapproved' | 'requested_changes';

function verdictOf(note: RawNote): Verdict | null {
  if (!note.system) return null;

  const body = note.body.trim();

  if (body === 'approved this merge request') return 'approved';
  if (body === 'unapproved this merge request') return 'unapproved';
  if (body === 'requested changes') return 'requested_changes';

  return null;
}

/** Review evidence: a comment or reply on code, an approval, or a change request. */
const isReviewNote = (note: RawNote) => Boolean(verdictOf(note) || (!note.system && note.position));

/** The head commit of the version that was current at `at` (MR versions record every push). */
export function headAt(versions: RawVersion[], at: string): string | null {
  const ordered = [...versions].sort((a, b) => time(a.created_at) - time(b.created_at));
  const current = ordered.filter((version) => time(version.created_at) <= time(at)).at(-1);

  return (current ?? ordered[0])?.head_commit_sha ?? null;
}

function requestEvents(notes: RawNote[], reviewers: RawReviewer[]): RequestEvent[] {
  const events: RequestEvent[] = [];

  for (const note of notes) {
    if (!note.system) continue;

    const change = reviewerChanges(note.body);

    if (!change) continue;

    for (const [logins, removed] of [
      [change.added, false],
      [change.removed, true],
    ] as const) {
      for (const login of logins) {
        events.push({
          id: `note-${note.id}-${login}`,
          createdAt: note.created_at,
          removed,
          reviewer: { kind: 'user', login, name: login },
        });
      }
    }
  }

  // Reviewers chosen when the MR was created have no system note; their assignment time stands in.
  for (const reviewer of reviewers) {
    if (!reviewer.created_at) continue;

    const noted = events.some(
      (event) =>
        !event.removed &&
        event.reviewer?.login.toLowerCase() === reviewer.user.username.toLowerCase() &&
        Math.abs(time(event.createdAt) - time(reviewer.created_at!)) < REVIEW_GAP_MS,
    );

    if (!noted)
      events.push({
        id: `reviewer-${reviewer.user.id}-${reviewer.created_at}`,
        createdAt: reviewer.created_at,
        removed: false,
        reviewer: { kind: 'user', login: reviewer.user.username, name: reviewer.user.username },
      });
  }

  return events.sort((a, b) => time(a.createdAt) - time(b.createdAt));
}

/** The latest time each user commented, approved or requested changes. */
function lastActivity(notes: RawNote[]): Map<string, number> {
  const latest = new Map<string, number>();

  for (const note of notes) {
    if (!note.author || !isReviewNote(note)) continue;

    const login = note.author.username.toLowerCase();

    latest.set(login, Math.max(latest.get(login) ?? 0, time(note.created_at)));
  }

  return latest;
}

/**
 * Reviewers whose review is still pending. GitLab keeps reviewers listed after they review, and
 * plain comments do not change their state, so a reviewer counts as requested only while they
 * have not commented, approved or requested changes since they were (re-)requested.
 */
function pendingReviewers(
  mr: RawMergeRequest,
  reviewers: RawReviewer[],
  events: RequestEvent[],
  notes: RawNote[],
  viewer: { login: string; reviewedAt: string | null },
) {
  const activity = lastActivity(notes);
  const own = accountHandle(viewer.login).toLowerCase();

  // Your own reviews count even when they are only a summary (submitted from Review Desk), which
  // GitLab notes alone cannot show for anyone else.
  if (viewer.reviewedAt)
    activity.set(own, Math.max(activity.get(own) ?? 0, time(viewer.reviewedAt)));

  return reviewers
    .filter((reviewer) => {
      if (reviewer.state && !['unreviewed', 'review_started'].includes(reviewer.state))
        return false;

      const login = reviewer.user.username.toLowerCase();
      const requestedAt = Math.max(
        time(mr.created_at),
        ...events
          .filter((event) => !event.removed && event.reviewer?.login.toLowerCase() === login)
          .map((event) => time(event.createdAt)),
      );

      return (activity.get(login) ?? 0) < requestedAt;
    })
    .map((reviewer) => ({
      kind: 'user' as const,
      login: reviewer.user.username,
      name: reviewer.user.username,
    }));
}

/**
 * The viewer's own reviews. GitLab has no review objects: a review is a run of the viewer's notes,
 * approvals and change requests, each within a minute of the previous one. Its state is the
 * verdict given in it (an approval later withdrawn counts as a comment), and its body is its first
 * top-level comment, which is where a review summary goes.
 */
export function viewerReviews(
  mr: RawMergeRequest,
  discussions: RawDiscussion[],
  versions: RawVersion[],
  viewer: string,
  /** Review Desk's last submission of a review here: its summary counts even on its own. */
  submission?: SubmissionEvidence | null,
): Review[] {
  const submitted = submission ? time(submission.startedAt) : null;
  // Only notes newer than the last one before sending can be the submission's (note ids grow);
  // a record from before ids were kept falls back to the time around it.
  const fromSubmission = (note: RawNote) =>
    submitted !== null &&
    time(note.created_at) <= submitted + SUBMISSION_WINDOW_MS &&
    (submission?.afterNoteId !== undefined
      ? note.id > submission.afterNoteId
      : time(note.created_at) >= submitted - SUBMISSION_WINDOW_MS);
  const own = discussions
    .flatMap((discussion) =>
      discussion.notes.map((note, index) => ({ note, topLevel: index === 0 })),
    )
    .filter(
      ({ note }) =>
        note.author &&
        isSameUser(note.author.username, viewer) &&
        (!note.system || verdictOf(note)),
    )
    .sort((a, b) => time(a.note.created_at) - time(b.note.created_at));
  const groups: (typeof own)[] = [];

  for (const entry of own) {
    const group = groups.at(-1);
    const previous = group?.at(-1);

    if (
      group &&
      previous &&
      time(entry.note.created_at) - time(previous.note.created_at) <= REVIEW_GAP_MS
    )
      group.push(entry);
    else groups.push([entry]);
  }

  const reviews: Review[] = [];

  for (const group of groups) {
    // A comment in the conversation is not a review, as on GitHub: a review has code comments,
    // replies on code, an approval or a change request, or was submitted from Review Desk.
    if (!group.some(({ note }) => isReviewNote(note) || fromSubmission(note))) continue;

    const verdicts = group.map(({ note }) => verdictOf(note)).filter(Boolean) as Verdict[];
    const last = verdicts.at(-1);

    // Withdrawing an approval on its own retracts the earlier approval rather than reviewing.
    if (verdicts.length === group.length && last === 'unapproved') {
      const approval = [...reviews].reverse().find((review) => review.state === 'APPROVED');

      if (approval) approval.state = 'COMMENTED';

      continue;
    }

    const state: ReviewState =
      last === 'requested_changes'
        ? 'CHANGES_REQUESTED'
        : last === 'approved'
          ? 'APPROVED'
          : 'COMMENTED';
    const first = group[0].note;
    const end = group.at(-1)!.note;
    const diffHead = group
      .map(({ note }) => note.position?.head_sha)
      .filter(Boolean)
      .at(-1);
    // The summary is the top-level comment the submission published, else the first one.
    const topLevel = group.filter(
      ({ note, topLevel }) => topLevel && !note.system && !note.position,
    );
    const summary = topLevel.find(({ note }) => fromSubmission(note)) ?? topLevel[0];

    reviews.push({
      id: reviewNoteId(first.id),
      state,
      submittedAt: end.created_at,
      updatedAt: group.reduce(
        (latest, { note }) => (time(note.updated_at) > time(latest) ? note.updated_at : latest),
        end.created_at,
      ),
      commitOid: diffHead ?? headAt(versions, end.created_at),
      body: summary?.note.body ?? '',
      url: noteUrl(mr, first.id),
    });
  }

  return reviews;
}

/** The current approve / request-changes verdict of every reviewer, with when they gave it. */
function verdicts(
  mr: RawMergeRequest,
  notes: RawNote[],
  reviewers: RawReviewer[],
  approvals: RawApprovals,
  versions: RawVersion[],
): ReviewerVerdict[] {
  const latest = (login: string, verdict: Verdict) =>
    notes
      .filter(
        (note) =>
          note.author && isSameUser(note.author.username, login) && verdictOf(note) === verdict,
      )
      .at(-1)?.created_at;
  const result: ReviewerVerdict[] = [];

  for (const { user } of approvals.approved_by ?? []) {
    const submittedAt = latest(user.username, 'approved') ?? mr.updated_at;

    result.push({
      login: user.username,
      state: 'APPROVED',
      submittedAt,
      commitOid: headAt(versions, submittedAt),
    });
  }

  for (const reviewer of reviewers) {
    if (reviewer.state !== 'requested_changes') continue;

    const submittedAt =
      latest(reviewer.user.username, 'requested_changes') ?? reviewer.created_at ?? mr.updated_at;

    result.push({
      login: reviewer.user.username,
      state: 'CHANGES_REQUESTED',
      submittedAt,
      commitOid: headAt(versions, submittedAt),
    });
  }

  return result;
}

function reviewDecision(reviewers: RawReviewer[], approvals: RawApprovals): string | null {
  if (reviewers.some((reviewer) => reviewer.state === 'requested_changes'))
    return 'CHANGES_REQUESTED';
  if (approvals.approved && (approvals.approved_by?.length ?? 0) > 0) return 'APPROVED';
  if (approvals.approved === false) return 'REVIEW_REQUIRED';

  return null;
}

/**
 * Whether a thread no longer sits on the current diff. On each push GitLab moves a thread whose
 * line it can trace to the new head, and leaves one whose line changed on its old commit (noting
 * "changed this line in version N"), so a thread on an older commit is outdated.
 */
const outdated = (position: RawPosition, head: string | null) =>
  Boolean(position.head_sha && head && position.head_sha !== head);

function threads(
  mr: RawMergeRequest,
  discussions: RawDiscussion[],
  ref: MergeRequestRef,
): ReviewThread[] {
  const head = mr.diff_refs?.head_sha ?? mr.sha;

  return discussions
    .filter((discussion) => discussion.notes[0]?.position && !discussion.notes[0].system)
    .map((discussion): ReviewThread => {
      const notes = discussion.notes.filter((note) => !note.system);
      const first = notes[0];
      const position = first.position!;
      const onNew = position.new_line !== null && position.new_line !== undefined;
      const line = (onNew ? position.new_line : position.old_line) ?? null;
      const start = position.line_range?.start;
      const startLine = (onNew ? start?.new_line : start?.old_line) ?? null;
      const resolvable = notes.filter((note) => note.resolvable);

      return {
        id: discussionId(ref, discussion.id),
        // A discussion nobody can resolve never waits on anyone.
        isResolved: resolvable.every((note) => note.resolved),
        isOutdated: outdated(position, head),
        path: position.new_path || position.old_path,
        line,
        diffSide: onNew ? 'RIGHT' : 'LEFT',
        startLine: startLine !== null && startLine !== line ? startLine : null,
        originalLine: line,
        subjectType: position.position_type === 'text' ? 'LINE' : 'FILE',
        viewerCanReply: !mr.discussion_locked,
        viewerCanResolve: resolvable.length > 0,
        comments: notes.map((note, index) => ({
          id: String(note.id),
          author: actor(note.author),
          body: note.body,
          createdAt: note.created_at,
          updatedAt: note.updated_at,
          url: noteUrl(mr, note.id),
          replyToId: index === 0 ? null : String(first.id),
          commitOid: note.position?.head_sha ?? null,
          originalCommitOid: note.position?.head_sha ?? null,
        })),
      };
    });
}

/** Comments not attached to code, oldest first, at most the latest 50 (as for GitHub). */
function conversation(mr: RawMergeRequest, discussions: RawDiscussion[]): ConversationComment[] {
  return discussions
    .filter((discussion) => !discussion.notes[0]?.position)
    .flatMap((discussion) => discussion.notes)
    .filter((note) => !note.system)
    .sort((a, b) => time(a.created_at) - time(b.created_at))
    .slice(-50)
    .map((note) => ({
      id: String(note.id),
      author: actor(note.author),
      body: note.body,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
      url: noteUrl(mr, note.id),
    }));
}

/** Added and removed lines in a diff. */
export function lineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }

  return { additions, deletions };
}

export const diffPath = (diff: RawDiff) => (diff.deleted_file ? diff.old_path : diff.new_path);

export function remoteFile(diff: RawDiff): RemoteFile {
  const tooLarge = Boolean(diff.too_large || diff.collapsed) && !diff.diff;
  const binary = !tooLarge && (diff.diff === '' || diff.diff.startsWith('Binary files'));

  return {
    path: diffPath(diff),
    previousPath: diff.renamed_file ? diff.old_path : undefined,
    status: diff.new_file
      ? 'added'
      : diff.deleted_file
        ? 'removed'
        : diff.renamed_file
          ? 'renamed'
          : 'modified',
    ...(binary ? { additions: 0, deletions: 0 } : lineCounts(diff.diff)),
    patch: binary || tooLarge ? undefined : diff.diff,
    sha: null,
    ...(tooLarge ? { tooLarge: true } : {}),
  };
}

function files(
  diffs: RawDiff[],
  viewed: Record<string, string>,
  revision: { head: string; start: string | null },
): PullFile[] {
  return diffs.map((diff) => {
    const file = remoteFile(diff);
    const mark = viewed[file.path];
    const key = diffKey(diff, revision);

    return {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: diff.new_file
        ? 'ADDED'
        : diff.deleted_file
          ? 'DELETED'
          : diff.renamed_file
            ? 'RENAMED'
            : 'MODIFIED',
      viewedKey: key,
      // A file viewed before its diff changed shows as changed since viewed, as on GitHub.
      viewerViewedState: !mark ? 'UNVIEWED' : mark === key ? 'VIEWED' : 'DISMISSED',
    };
  });
}

/** Builds the app's snapshot of a merge request, as `GitHub.snapshot` does for a pull request. */
export function mergeRequestSnapshot(
  data: MergeRequestData,
  viewer: string,
  sources: PullRequestSnapshot['sources'],
  previous: PullRequestSnapshot | undefined,
): PullRequestSnapshot {
  const { mr, discussions, reviewers, approvals, versions } = data;
  const ref = { projectId: mr.project_id, iid: mr.iid };
  const notes = discussions
    .flatMap((discussion) => discussion.notes)
    .sort((a, b) => time(a.created_at) - time(b.created_at));
  const events = requestEvents(notes, reviewers);
  const reviews = viewerReviews(mr, discussions, versions, viewer, data.submission);
  const changedFiles = data.diffs
    ? files(data.diffs, data.viewed ?? {}, {
        head: mr.sha,
        start: mr.diff_refs?.start_sha ?? null,
      })
    : [];
  const now = new Date().toISOString();
  const headCommittedAt = data.headCommittedAt ?? mr.updated_at;
  const lastReview = reviews.at(-1);
  const reconstructedHeadTime =
    lastReview && data.headCommittedAt && data.headCommittedAt > lastReview.submittedAt
      ? data.headCommittedAt
      : mr.updated_at;
  const pipeline = mr.head_pipeline ?? null;
  const drafts = data.drafts ?? [];

  return {
    id: mergeRequestId(mr.project_id, mr.iid),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    body: mr.description ?? '',
    repository: repositoryOf(mr),
    author: actor(mr.author),
    isDraft: Boolean(mr.draft ?? mr.work_in_progress),
    state: stateOf(mr.state),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    headOid: mr.sha,
    headCommittedAt,
    headObservedAt:
      previous?.headOid === mr.sha
        ? previous.headObservedAt
        : previous
          ? now
          : reconstructedHeadTime,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: changedFiles.length,
    reviewDecision: reviewDecision(reviewers, approvals),
    ...mergeStateOf(mr),
    sources,
    reviewRequests: pendingReviewers(mr, reviewers, events, notes, {
      login: viewer,
      reviewedAt: reviews.at(-1)?.submittedAt ?? null,
    }),
    requestEvents: events,
    reviews,
    threads: threads(mr, discussions, ref),
    files: changedFiles,
    checks: checks(data.jobs ?? []),
    ci: pipelineState(pipeline?.status),
    fetchedAt: now,
    version: SNAPSHOT_VERSION,
    baseOid: mr.diff_refs?.start_sha ?? null,
    conversation: conversation(mr, discussions),
    // Force pushes are not reported by GitLab's API; nothing reads them yet.
    forcePushes: [],
    verdicts: verdicts(mr, notes, reviewers, approvals, versions),
    pendingReview:
      drafts.length > 0
        ? { id: pendingReviewId(ref), createdAt: mr.updated_at, commentCount: drafts.length }
        : null,
  };
}
