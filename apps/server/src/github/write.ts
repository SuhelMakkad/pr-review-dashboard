import type { ReviewEvent, Side } from '@review-desk/shared/review';
import { GitHubError } from './errors.js';
import { mutations } from './queries.js';
import type { GitHubTransport } from './transport.js';

export interface ThreadInput {
  path: string;
  body: string;
  line?: number | null;
  side?: Side;
  startLine?: number | null;
  startSide?: Side | null;
  subjectType?: 'LINE' | 'FILE';
}

/** GitHub writes used by the review workspace. Only ever called from explicit user actions. */
export interface GitHubWrites {
  addPendingReview(prId: string, commitOid: string): Promise<string>;
  addReviewThread(reviewId: string, thread: ThreadInput): Promise<string>;
  submitReview(
    reviewId: string,
    event: ReviewEvent,
    body: string,
  ): Promise<{ id: string; url: string }>;
  deleteReview(reviewId: string): Promise<void>;
  commentNow(
    prId: string,
    commitOid: string,
    thread: ThreadInput,
  ): Promise<{ id: string; url: string }>;
  replyToThread(
    threadId: string,
    body: string,
  ): Promise<{ id: string; url: string; pending: boolean }>;
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
  setFileViewed(prId: string, path: string, viewed: boolean): Promise<void>;
  addConversationComment(prId: string, body: string): Promise<{ id: string; url: string }>;
  /** Adds (never removes) requested reviewers; re-requesting someone asks them again. */
  requestReviews(prId: string, logins: string[]): Promise<void>;
}

function threadVariables(thread: ThreadInput) {
  const file = thread.subjectType === 'FILE' || thread.line === null || thread.line === undefined;

  return file
    ? { path: thread.path, body: thread.body, subjectType: 'FILE' }
    : {
        path: thread.path,
        body: thread.body,
        line: thread.line,
        side: thread.side ?? 'RIGHT',
        ...(thread.startLine && thread.startLine !== thread.line
          ? { startLine: thread.startLine, startSide: thread.startSide ?? thread.side ?? 'RIGHT' }
          : {}),
        subjectType: 'LINE',
      };
}

export function createWriter(transport: GitHubTransport): GitHubWrites {
  const run = <T>(name: keyof typeof mutations, variables: Record<string, unknown>) =>
    transport.graphql<T>(mutations[name], variables);

  return {
    async addPendingReview(prId, commitOid) {
      const data = await run<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
        'AddPendingReview',
        {
          pullRequestId: prId,
          commitOID: commitOid,
        },
      );

      return data.addPullRequestReview.pullRequestReview.id;
    },

    async addReviewThread(reviewId, thread) {
      const data = await run<{ addPullRequestReviewThread: { thread: { id: string } | null } }>(
        'AddReviewThread',
        {
          input: { pullRequestReviewId: reviewId, ...threadVariables(thread) },
        },
      );

      if (!data.addPullRequestReviewThread.thread) {
        throw new GitHubError(
          `GitHub did not accept the comment on ${thread.path}; the line may no longer be in the diff.`,
        );
      }

      return data.addPullRequestReviewThread.thread.id;
    },

    async submitReview(reviewId, event, body) {
      const data = await run<{
        submitPullRequestReview: { pullRequestReview: { id: string; url: string } };
      }>('SubmitReview', { id: reviewId, event, body: body || null });

      return data.submitPullRequestReview.pullRequestReview;
    },

    async deleteReview(reviewId) {
      await run('DeleteReview', { id: reviewId });
    },

    async commentNow(prId, commitOid, thread) {
      const variables = threadVariables(thread);

      if (variables.subjectType === 'FILE') {
        // File-level comments are not accepted in the one-shot threads input.
        const reviewId = await this.addPendingReview(prId, commitOid);

        await this.addReviewThread(reviewId, thread);

        return this.submitReview(reviewId, 'COMMENT', '');
      }

      const { subjectType: _subjectType, ...draft } = variables;
      const data = await run<{
        addPullRequestReview: { pullRequestReview: { id: string; url: string } };
      }>('CommentNow', { pullRequestId: prId, commitOID: commitOid, threads: [draft] });

      return data.addPullRequestReview.pullRequestReview;
    },

    async replyToThread(threadId, body) {
      const data = await run<{
        addPullRequestReviewThreadReply: { comment: { id: string; url: string; state: string } };
      }>('ReplyToThread', { threadId, body });
      const comment = data.addPullRequestReviewThreadReply.comment;

      // GitHub attaches replies to an open pending review instead of posting them.
      return { id: comment.id, url: comment.url, pending: comment.state === 'PENDING' };
    },

    async setThreadResolved(threadId, resolved) {
      await run(resolved ? 'ResolveThread' : 'UnresolveThread', { threadId });
    },

    async setFileViewed(prId, path, viewed) {
      await run(viewed ? 'MarkFileViewed' : 'UnmarkFileViewed', { pullRequestId: prId, path });
    },

    async requestReviews(prId, logins) {
      await run('RequestReviews', { pullRequestId: prId, userLogins: logins });
    },

    async addConversationComment(prId, body) {
      const data = await run<{
        addComment: { commentEdge: { node: { id: string; url: string } } };
      }>('AddComment', {
        subjectId: prId,
        body,
      });

      return data.addComment.commentEdge.node;
    },
  };
}
