import type { ReviewEvent } from '@review-desk/shared/review';
import { ForgeError } from '@/forge/port.js';
import { safeError } from '@/redact.js';
import type { ForgeWrites } from '@/forge/port.js';
import type { ThreadInput } from '@/forge/types.js';
import { diffKey } from '@/gitlab/fingerprint.js';
import {
  discussionId,
  mergeRequestPath,
  parseDiscussionId,
  parseMergeRequestId,
  pendingReviewId,
  reviewNoteId,
  type MergeRequestRef,
} from '@/gitlab/ids.js';
import { commentPosition, type DiffRefs } from '@/gitlab/positions.js';
import {
  diffPath,
  noteUrl,
  repositoryOf,
  type RawApprovals,
  type RawDiff,
  type RawDraftNote,
  type RawMergeRequest,
  type RawNote,
  type RawReviewer,
  type RawUser,
} from '@/gitlab/snapshot.js';
import {
  call,
  paginate,
  responseError,
  type GitLabRequest,
  type GitLabTransport,
} from '@/gitlab/transport.js';
import { reviewFeatures, type GitLabVersion } from '@/gitlab/version.js';
import type { HttpMethod } from '@/forge/http.js';

export type GitLabWrites = ForgeWrites;

/** A review submission that has started, kept so an interrupted one can be confirmed later. */
export interface Submission {
  event: ReviewEvent;
  body: string;
  startedAt: string;
  /**
   * The newest note on the merge request before anything was sent. GitLab numbers notes in order,
   * so only later notes can be this submission's, whatever the clocks say.
   */
  afterNoteId?: number;
  /** Set once GitLab confirmed it; only an unconfirmed submission needs recognising later. */
  publishedAt?: string;
}

/** State Review Desk keeps for GitLab on this machine (GitLab has nowhere to keep it). */
export interface LocalState {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

export interface WriterContext {
  mergeRequest(ref: MergeRequestRef): Promise<RawMergeRequest>;
  diffs(ref: MergeRequestRef): Promise<RawDiff[]>;
  version(): Promise<GitLabVersion | null>;
  /** The signed-in username, for checking what GitLab recorded. */
  username(): Promise<string>;
  /** Refuses when glab is no longer signed in as the account the work runs as. */
  assertAccount(): Promise<void>;
  markViewed(prId: string, path: string, mark: string | null): void;
  local: LocalState;
}

/** Keys of what is kept about one pending review. */
export const submissionKey = (reviewId: string) => `submission:${reviewId}`;
const headKey = (reviewId: string) => `head:${reviewId}`;

const rejected = (message: string, status = 422) =>
  new ForgeError(message, null, status, 'rejected');

export const REQUEST_CHANGES_UNSUPPORTED =
  'This GitLab’s API cannot request changes (that needs GitLab 19.2 or later). Submit the review as a comment that says what needs to change.';

/** GitLab lists a draft without a diff position with a position whose fields are all null. */
const isSummary = (draft: RawDraftNote) => !draft.position?.new_path && !draft.position?.old_path;

const lineOf = (end: unknown) => {
  const value = end as { new_line?: number | null; old_line?: number | null } | undefined;

  return value?.new_line ?? value?.old_line ?? null;
};

/**
 * GitLab writes behind the same interface as GitHub's. A pending review is your draft notes on the
 * merge request: comments are added as drafts and published together when the review is submitted,
 * with its summary. Approving sends the reviewed commit, so GitLab refuses it if new commits
 * arrived. Each write reads what it needs before sending, so a failed read never follows a write
 * that took effect.
 */
/**
 * The revision a viewed mark is for, when both reads of the merge request around the diff agree
 * on complete diff refs whose head is the merge request's head; else unknown. GitLab fills diff
 * refs in asynchronously, so missing ones identify nothing.
 */
function markedRevision(
  before: RawMergeRequest,
  after: RawMergeRequest,
): { headOid: string; baseOid: string } | null {
  const complete = (mr: RawMergeRequest) =>
    mr.diff_refs?.head_sha && mr.diff_refs.start_sha && mr.diff_refs.base_sha ? mr.diff_refs : null;
  const [first, second] = [complete(before), complete(after)];

  if (!first || !second || first.head_sha !== after.sha || before.sha !== after.sha) return null;
  if (first.head_sha !== second.head_sha || first.start_sha !== second.start_sha) return null;
  if (first.base_sha !== second.base_sha) return null;

  return { headOid: after.sha, baseOid: second.start_sha };
}

export function createGitLabWriter(
  transport: GitLabTransport,
  context: WriterContext,
): GitLabWrites {
  // Every write first checks that glab is still signed in as the account the work runs as: glab
  // keeps one sign-in per host, and a new `glab auth login` must not post as someone else.
  const write = async <T>(request: GitLabRequest) => {
    await context.assertAccount();

    return transport.request<T>(request);
  };
  const send = async <T>(method: HttpMethod, path: string, body: unknown, action: string) => {
    const response = await write<T>({ method, path, body });

    if (response.status >= 400) throw responseError(response, action, method);

    return response.data;
  };

  async function diffRefs(
    ref: MergeRequestRef,
    commitOid: string | null,
  ): Promise<{ mr: RawMergeRequest; refs: DiffRefs }> {
    const mr = await context.mergeRequest(ref);
    const refs = mr.diff_refs;

    if (!refs)
      throw rejected(
        'GitLab has not prepared this merge request’s diff yet. Try again shortly.',
        409,
      );
    if (commitOid && refs.head_sha !== commitOid)
      throw rejected('New commits were pushed. Review the comment location before sending.', 409);

    return { mr, refs };
  }

  /** Where a comment goes, against the diff of `commitOid` (refused if the head moved past it). */
  async function position(ref: MergeRequestRef, commitOid: string | null, thread: ThreadInput) {
    const [{ mr, refs }, diffs] = await Promise.all([diffRefs(ref, commitOid), context.diffs(ref)]);

    // The diff was read after the head was checked; a push in between would make them disagree.
    const current = await context.mergeRequest(ref);

    if (current.diff_refs?.head_sha !== refs.head_sha)
      throw rejected('New commits were pushed. Review the comment location before sending.', 409);

    const file = diffs.find(
      (diff) =>
        diffPath(diff) === thread.path ||
        diff.new_path === thread.path ||
        diff.old_path === thread.path,
    );

    if (!file)
      throw rejected(
        `GitLab did not accept the comment on ${thread.path}; the file is no longer in the diff.`,
      );

    const at = commentPosition(
      { oldPath: file.old_path, newPath: file.new_path, diff: file.diff },
      refs,
      thread,
    );

    return { mr, position: at };
  }

  /**
   * Posts a comment with a position. GitLab rejects a line range it cannot match to its own line
   * codes with 400, which means nothing was saved: it is sent again on the range's last line, saying
   * which lines it covers so the comment keeps its meaning.
   */
  async function withPosition<T>(
    path: string,
    field: 'note' | 'body',
    text: string,
    positioned: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    const response = await write<T>({
      method: 'POST',
      path,
      body: { [field]: text, position: positioned },
    });

    if (response.status === 400 && positioned.line_range) {
      const { line_range: range, ...single } = positioned;
      const lines = range as { start?: unknown; end?: unknown };
      const from = lineOf(lines.start);
      const to = lineOf(lines.end);
      const label = from && to ? `_Lines ${from}–${to}:_\n\n` : '';

      return send<T>('POST', path, { [field]: `${label}${text}`, position: single }, action);
    }

    if (response.status >= 400) throw responseError(response, action, 'POST');

    return response.data;
  }

  const drafts = (ref: MergeRequestRef) =>
    paginate<RawDraftNote>(
      transport,
      `${mergeRequestPath(ref)}/draft_notes`,
      'Could not load your pending review',
    );

  /** The id of the newest note on the merge request, system notes included; 0 when there is none. */
  async function latestNoteId(ref: MergeRequestRef): Promise<number> {
    // The highest id among the newest notes: ids grow with each note, while a note's date can be
    // set when it is imported.
    const notes = await call<RawNote[]>(
      transport,
      { path: `${mergeRequestPath(ref)}/notes?sort=desc&order_by=created_at&per_page=100` },
      'Could not read the merge request’s notes',
    );

    return Math.max(0, ...notes.map((note) => note.id));
  }

  /**
   * GitLab publishes the review even when it cannot record the change request (without permission
   * to update the merge request, say), and still answers 204. The comments are published either
   * way, so a missing change request is reported as unconfirmed for you to check, not retried.
   */
  async function confirmChangesRequested(ref: MergeRequestRef, submission: Submission) {
    // The review is already published: any failure here must be checked, never sent again.
    let answers: [string, RawReviewer[], RawNote[]];

    try {
      answers = await Promise.all([
        context.username(),
        call<RawReviewer[]>(
          transport,
          { path: `${mergeRequestPath(ref)}/reviewers` },
          'Could not read reviewers',
        ),
        call<RawNote[]>(
          transport,
          { path: `${mergeRequestPath(ref)}/notes?sort=desc&order_by=created_at&per_page=20` },
          'Could not read the merge request’s notes',
        ),
      ]);
    } catch (error) {
      throw new ForgeError(
        `Your review was published, but whether GitLab recorded the change request could not be checked (${safeError(error)}). Check it on GitLab.`,
        null,
        null,
        'unknown',
      );
    }

    const [username, reviewers, notes] = answers;
    const mine = (login: string | undefined) => login?.toLowerCase() === username.toLowerCase();
    const recorded =
      reviewers.some(
        (reviewer) => mine(reviewer.user.username) && reviewer.state === 'requested_changes',
      ) ||
      notes.some(
        (note) =>
          note.system &&
          mine(note.author?.username) &&
          note.body.trim() === 'requested changes' &&
          note.id > (submission.afterNoteId ?? 0),
      );

    if (!recorded)
      throw new ForgeError(
        'Your review was published, but GitLab did not record the change request; you may not be allowed to request changes on this merge request. Check it on GitLab.',
        null,
        null,
        'unknown',
      );
  }

  async function approve(ref: MergeRequestRef, sha: string): Promise<void> {
    const approvals = await call<RawApprovals>(
      transport,
      { path: `${mergeRequestPath(ref)}/approvals` },
      'Could not read approvals',
    );

    // Approving twice is an error on GitLab; an existing approval already says the same.
    if (approvals.user_has_approved) return;

    await send(
      'POST',
      `${mergeRequestPath(ref)}/approve`,
      { sha },
      'GitLab did not accept the approval',
    );
  }

  async function userId(username: string): Promise<number> {
    const users = await call<RawUser[]>(
      transport,
      { path: `users?username=${encodeURIComponent(username)}` },
      `Could not look up ${username}`,
    );
    const user = users.find(
      (candidate) => candidate.username.toLowerCase() === username.toLowerCase(),
    );

    if (!user) throw rejected(`${username} is not a GitLab user here.`, 404);

    return user.id;
  }

  return {
    async approveReview(prId, commitOid, body) {
      const ref = parseMergeRequestId(prId);
      const mr = await context.mergeRequest(ref);

      await approve(ref, commitOid);

      if (!body) return { id: pendingReviewId(ref), url: mr.web_url };

      const note = await send<RawNote>(
        'POST',
        `${mergeRequestPath(ref)}/notes`,
        { body },
        'GitLab did not accept the review summary',
      );

      return { id: reviewNoteId(note.id), url: noteUrl(mr, note.id) };
    },

    async addPendingReview(prId, commitOid) {
      const reviewId = pendingReviewId(parseMergeRequestId(prId));

      // Draft notes need no container: the pending review is simply yours on this merge request.
      // The commit it reviews is kept, so its comments and approval stay on that commit.
      context.local.set(headKey(reviewId), commitOid);

      return reviewId;
    },

    async addReviewThread(reviewId, thread) {
      const ref = parseMergeRequestId(reviewId);
      const reviewed = context.local.get<string>(headKey(reviewId));
      const { position: at } = await position(ref, reviewed, thread);
      const draft = await withPosition<RawDraftNote>(
        `${mergeRequestPath(ref)}/draft_notes`,
        'note',
        thread.body,
        at,
        `GitLab did not accept the comment on ${thread.path}`,
      );

      return `draft-${draft.id}`;
    },

    async submitReview(reviewId, event: ReviewEvent, body) {
      const ref = parseMergeRequestId(reviewId);
      const [mr, version, pending] = await Promise.all([
        context.mergeRequest(ref),
        context.version(),
        drafts(ref),
      ]);
      const features = reviewFeatures(version);

      if (event === 'REQUEST_CHANGES' && !features.reviewerState)
        throw rejected(REQUEST_CHANGES_UNSUPPORTED);

      // The commit reviewed: recorded when the review began, else the one its comments are on.
      // Every comment in the pending review must be on it, or the approval would cover new code.
      const heads = pending.map((draft) => draft.position?.head_sha).filter(Boolean);
      const reviewed = context.local.get<string>(headKey(reviewId)) ?? heads[0] ?? mr.sha;

      if (mr.sha !== reviewed || heads.some((head) => head !== reviewed))
        throw rejected('New commits were pushed. Review them before submitting.', 409);

      // Saved before anything is sent: if the response is lost, the review it published can still
      // be recognised, rather than looking like a pending review that vanished.
      const submission: Submission = {
        event,
        body,
        startedAt: new Date().toISOString(),
        afterNoteId: await latestNoteId(ref),
      };

      context.local.set(submissionKey(reviewId), submission);

      if (event === 'APPROVE') await approve(ref, reviewed);

      // Before GitLab 19.2 the summary is one more draft; a retry finds the one already saved.
      if (
        body &&
        !features.summary &&
        !pending.some((draft) => isSummary(draft) && draft.note === body)
      )
        await send(
          'POST',
          `${mergeRequestPath(ref)}/draft_notes`,
          { note: body },
          'GitLab did not accept the review summary',
        );

      const publish: Record<string, string> = {};

      if (body && features.summary) publish.note = body;
      if (features.reviewerState && event !== 'APPROVE')
        publish.reviewer_state = event === 'REQUEST_CHANGES' ? 'requested_changes' : 'reviewed';

      if (pending.length > 0 || (body && !features.summary) || Object.keys(publish).length > 0) {
        const response = await write({
          method: 'POST',
          path: `${mergeRequestPath(ref)}/draft_notes/bulk_publish`,
          body: publish,
        });

        // GitLab publishes the drafts before saving the summary and the reviewer state, so a
        // failure can follow published comments: it is checked, never sent again blindly.
        if (response.status >= 400) {
          const error = responseError(response, 'GitLab did not publish the whole review', 'POST');

          throw new ForgeError(error.message, null, error.status, 'unknown');
        }

        if (event === 'REQUEST_CHANGES') await confirmChangesRequested(ref, submission);
      }

      context.local.set(headKey(reviewId), null);
      context.local.set(submissionKey(reviewId), {
        ...submission,
        publishedAt: new Date().toISOString(),
      } satisfies Submission);

      return { id: reviewId, url: mr.web_url };
    },

    async deleteReview(reviewId) {
      const ref = parseMergeRequestId(reviewId);

      context.local.set(submissionKey(reviewId), null);
      context.local.set(headKey(reviewId), null);

      for (const draft of await drafts(ref)) {
        const response = await write({
          method: 'DELETE',
          path: `${mergeRequestPath(ref)}/draft_notes/${draft.id}`,
        });

        if (response.status >= 400 && response.status !== 404)
          throw responseError(response, 'GitLab did not delete the pending comment', 'DELETE');
      }
    },

    async commentNow(prId, commitOid, thread) {
      const ref = parseMergeRequestId(prId);
      const { mr, position: at } = await position(ref, commitOid, thread);
      const discussion = await withPosition<{ id: string; notes: RawNote[] }>(
        `${mergeRequestPath(ref)}/discussions`,
        'body',
        thread.body,
        at,
        `GitLab did not accept the comment on ${thread.path}`,
      );
      const note = discussion.notes[0];

      return {
        id: discussionId(ref, discussion.id),
        url: note ? noteUrl(mr, note.id) : mr.web_url,
      };
    },

    async replyToThread(threadId, body) {
      const { discussion, ...ref } = parseDiscussionId(threadId);
      const mr = await context.mergeRequest(ref);
      const note = await send<RawNote>(
        'POST',
        `${mergeRequestPath(ref)}/discussions/${discussion}/notes`,
        { body },
        'GitLab did not accept the reply',
      );

      // GitLab posts replies at once, even while you have a pending review.
      return { id: String(note.id), url: noteUrl(mr, note.id), pending: false };
    },

    async setThreadResolved(threadId, resolved) {
      const { discussion, ...ref } = parseDiscussionId(threadId);

      await send(
        'PUT',
        `${mergeRequestPath(ref)}/discussions/${discussion}`,
        { resolved },
        'GitLab did not update the thread',
      );
    },

    async setFileViewed(prId, path, viewed, expected) {
      const ref = parseMergeRequestId(prId);

      if (!viewed) {
        context.markViewed(prId, path, null);
        return null;
      }

      // The diff is read between two reads of the merge request, so it is known which revision
      // the mark is for; a push in between leaves that unknown. Every read happens before the mark
      // is saved, so nothing awaits between saving it and the outbox recording the receipt.
      const before = await context.mergeRequest(ref);
      const file = (await context.diffs(ref)).find((diff) => diffPath(diff) === path);

      if (!file) throw rejected(`${path} is no longer part of this merge request.`, 404);

      // Only says which revision is marked; failing to read it must not fail the mark.
      const after = await context.mergeRequest(ref).catch(() => null);
      const key = diffKey(file, { head: before.sha, start: before.diff_refs?.start_sha ?? null });

      // The mark is for the diff you viewed: a newer one, which you have not seen, is not marked.
      if (expected && expected.fileKey !== key)
        throw rejected(
          `${path} changed after you viewed it, so it was not marked viewed. Look at the new diff first.`,
          409,
        );

      context.markViewed(prId, path, key);

      // The diff it marked is known either way; the head and base only when both reads agree.
      const revision = (after ? markedRevision(before, after) : null) ?? {
        headOid: before.sha,
        baseOid: null,
      };

      return { ...revision, fileKey: key };
    },

    async addConversationComment(prId, body) {
      const ref = parseMergeRequestId(prId);
      const mr = await context.mergeRequest(ref);
      const note = await send<RawNote>(
        'POST',
        `${mergeRequestPath(ref)}/notes`,
        { body },
        'GitLab did not accept the comment',
      );

      return { id: String(note.id), url: noteUrl(mr, note.id) };
    },

    async requestReviews(prId, logins) {
      const ref = parseMergeRequestId(prId);
      const mr = await context.mergeRequest(ref);
      const current = mr.reviewers ?? [];
      const existing = (login: string) =>
        current.find((user) => user.username.toLowerCase() === login.toLowerCase());

      // Every lookup comes first, so a failed one never follows a request already sent.
      const added: number[] = [];

      for (const login of logins) if (!existing(login)) added.push(await userId(login));

      for (const login of logins) {
        const reviewer = existing(login);

        if (!reviewer) continue;

        // Already a reviewer: ask again, which resets their review state.
        const result = await call<{
          data?: { mergeRequestReviewerRereview?: { errors?: string[] } };
          errors?: { message: string }[];
        }>(
          transport,
          {
            method: 'POST',
            path: 'graphql',
            body: {
              query:
                'mutation Rereview($input: MergeRequestReviewerRereviewInput!) { mergeRequestReviewerRereview(input: $input) { errors } }',
              variables: {
                input: {
                  projectPath: repositoryOf(mr),
                  iid: String(mr.iid),
                  userId: `gid://gitlab/User/${reviewer.id}`,
                },
              },
            },
          },
          `GitLab did not ask ${login} again`,
        );
        const errors = [
          ...(result.errors?.map((error) => error.message) ?? []),
          ...(result.data?.mergeRequestReviewerRereview?.errors ?? []),
        ];

        if (errors.length > 0)
          throw rejected(`GitLab did not ask ${login} again: ${errors.join('; ')}`);
      }

      if (added.length > 0)
        await send(
          'PUT',
          mergeRequestPath(ref),
          { reviewer_ids: [...current.map((user) => user.id), ...added] },
          'GitLab did not add the reviewers',
        );
    },
  };
}
