import type { Side } from '@review-desk/shared/review';
import type { ForgeWrites } from '@/forge/port.js';
import { GitHubError } from '@/github/errors.js';
import { mutations } from '@/github/queries.js';
import type { GitHubTransport } from '@/github/transport.js';

export interface ThreadInput {
  path: string;
  body: string;
  line?: number | null;
  side?: Side;
  startLine?: number | null;
  startSide?: Side | null;
  subjectType?: 'LINE' | 'FILE';
}

/**
 * The PR revision whose diff of a file a viewed write marked: its head and base commits, as a
 * snapshot records them. Null when the forge cannot say, or for an unmark, which holds for every
 * revision.
 */
export interface ViewedRevision {
  headOid: string;
  baseOid: string | null;
  /**
   * The `viewedKey` of the file's diff that was marked, where the forge knows it (GitLab). It
   * decides on its own: a snapshot's head and base and its files are not always read together.
   */
  fileKey?: string;
}

/** The forge's writes under their original name (see `ForgeWrites`). */
export type GitHubWrites = ForgeWrites;

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
    async approveReview(prId, commitOid, body) {
      const data = await run<{
        addPullRequestReview: { pullRequestReview: { id: string; url: string } };
      }>('ApproveReview', { pullRequestId: prId, commitOID: commitOid, body });

      return data.addPullRequestReview.pullRequestReview;
    },

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
          null,
          422,
          'rejected',
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
      type Payload = { pullRequest: { headRefOid: string; baseRefOid: string | null } | null };

      const data = await run<{ markFileAsViewed?: Payload; unmarkFileAsViewed?: Payload }>(
        viewed ? 'MarkFileViewed' : 'UnmarkFileViewed',
        { pullRequestId: prId, path },
      );
      // The PR as the mutation left it: the revision whose file it marked.
      const pull = (viewed ? data.markFileAsViewed : data.unmarkFileAsViewed)?.pullRequest;

      return viewed && pull ? { headOid: pull.headRefOid, baseOid: pull.baseRefOid ?? null } : null;
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
