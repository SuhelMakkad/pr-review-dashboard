/**
 * Every GraphQL document sent to GitHub lives here, so the contract test can validate all of them
 * against GitHub's published schema.
 */

export const pageInfo = 'pageInfo { hasNextPage endCursor }';

const reviewerFields =
  '__typename ... on User { login } ... on Team { name slug organization { login } }';

const reviewFields = 'id state submittedAt updatedAt body url commit { oid }';

export const commentFields =
  'id body createdAt updatedAt url author { login avatarUrl } replyTo { id } diffHunk commit { oid } originalCommit { oid }';

const threadFields = `id isResolved isOutdated path line diffSide startLine originalLine subjectType viewerCanReply viewerCanResolve comments(first: 100) { nodes { ${commentFields} } ${pageInfo} }`;

export const checkFields =
  '__typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }';

export const connections = {
  reviews: `reviews(first: 100, after: $cursor, author: $login) { nodes { ${reviewFields} } ${pageInfo} }`,
  reviewRequests: `reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ${reviewerFields} } } ${pageInfo} }`,
  timelineItems: `timelineItems(first: 100, after: $cursor, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) { nodes { __typename ... on ReviewRequestedEvent { id createdAt requestedReviewer { ${reviewerFields} } } ... on ReviewRequestRemovedEvent { id createdAt requestedReviewer { ${reviewerFields} } } } ${pageInfo} }`,
  reviewThreads: `reviewThreads(first: 50, after: $cursor) { nodes { ${threadFields} } ${pageInfo} }`,
  files: `files(first: 100, after: $cursor) { nodes { path additions deletions changeType viewerViewedState } ${pageInfo} }`,
} as const;

export type ConnectionKey = keyof typeof connections;

export const identityQuery = 'query Identity { viewer { login avatarUrl } }';

export const reviewReceiptQuery = `query ReviewReceipt($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReview {
    id state url body commit { oid }
    comments(first: 100, after: $cursor) { nodes { id body path line url } ${pageInfo} }
  } }
}`;

/** Looks up a PR by repository and number, for adding it to the queue by hand. */
export const resolvePullQuery = `query ResolvePull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id state } }
}`;

export const discoverQuery = `query Discover($query: String!, $cursor: String) {
  search(query: $query, type: ISSUE, first: 100, after: $cursor) { issueCount nodes { ... on PullRequest { id } } ${pageInfo} }
}`;

export const snapshotQuery = `query Snapshot($id: ID!, $login: String!, $cursor: String) {
  node(id: $id) { ... on PullRequest {
    id number title url body author { login avatarUrl } repository { nameWithOwner }
    isDraft state createdAt updatedAt headRefOid baseRefOid baseRefName headRefName additions deletions changedFiles reviewDecision mergeable mergeStateStatus
    ${Object.values(connections).join('\n')}
    verdicts: latestOpinionatedReviews(first: 50) { nodes { state submittedAt author { login } commit { oid } } }
    conversation: comments(last: 50) { nodes { id body createdAt updatedAt url author { login avatarUrl } } }
    pending: reviews(first: 1, author: $login, states: [PENDING]) { nodes { id createdAt comments { totalCount } } }
    forcePushes: timelineItems(last: 20, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { id createdAt beforeCommit { oid } afterCommit { oid } actor { login } } } }
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { ${checkFields} } ${pageInfo} } } } } }
  } }
}`;

export function connectionPageQuery(key: ConnectionKey): string {
  const declarations =
    key === 'reviews' ? '$id: ID!, $login: String!, $cursor: String' : '$id: ID!, $cursor: String';

  return `query Page(${declarations}) {
  node(id: $id) { ... on PullRequest { ${connections[key]} } }
}`;
}

/**
 * Cheap change detection for up to 100 PRs: everything that should trigger a full snapshot when it
 * changes. Check-run counts are included because CI results do not bump `updatedAt`.
 */
export const detectQuery = `query Detect($ids: [ID!]!) {
  rateLimit { limit remaining resetAt cost }
  nodes(ids: $ids) { ... on PullRequest {
    id state isDraft updatedAt headRefOid baseRefOid mergeStateStatus mergeable reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
      checkRunCountsByState { state count } statusContextCountsByState { state count }
    } } } } }
    timelineItems(first: 1) { totalCount }
    reviewThreads(first: 1) { totalCount }
    comments(first: 1) { totalCount }
    reviews(first: 1) { totalCount }
  } }
}`;

export const threadCommentsQuery = `query Comments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { ${commentFields} } ${pageInfo} } } }
}`;

export const checksPageQuery = `query Checks($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequest { commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100, after: $cursor) { nodes { ${checkFields} } ${pageInfo} } } } } } } }
}`;

/** Fetches file contents at specific commits; one aliased `object` per expression variable. */
export function blobsQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, index) => `$e${index}: String!`).join(', ');
  const fields = Array.from(
    { length: count },
    (_, index) =>
      `b${index}: object(expression: $e${index}) { ... on Blob { text isBinary isTruncated byteSize } }`,
  ).join('\n    ');

  return `query Blobs($owner: String!, $name: String!, ${variables}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
}

/** Light review history for many PRs at once (insights backfill). */
export const historyQuery = `query History($ids: [ID!]!, $login: String!) {
  nodes(ids: $ids) { ... on PullRequest {
    id number title url repository { nameWithOwner } author { login } state isDraft createdAt updatedAt
    headRefName baseRefName headRefOid
    timelineItems(first: 100, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) { nodes { __typename ... on ReviewRequestedEvent { id createdAt requestedReviewer { ${reviewerFields} } } ... on ReviewRequestRemovedEvent { id createdAt requestedReviewer { ${reviewerFields} } } } }
    reviews(first: 100, author: $login) { nodes { ${reviewFields} } }
    verdicts: latestOpinionatedReviews(first: 30) { nodes { state submittedAt author { login } commit { oid } } }
  } }
}`;

export const searchQuery = `query Search($query: String!, $cursor: String) {
  search(query: $query, type: ISSUE, first: 100, after: $cursor) { issueCount nodes { ... on PullRequest { id } } ${pageInfo} }
}`;

/** Review writes, requested directly or enabled through automation settings. */
export const mutations = {
  ApproveReview: `mutation ApproveReview($pullRequestId: ID!, $commitOID: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: APPROVE, body: $body }) { pullRequestReview { id url } }
}`,
  AddPendingReview: `mutation AddPendingReview($pullRequestId: ID!, $commitOID: GitObjectID) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) { pullRequestReview { id } }
}`,
  AddReviewThread: `mutation AddReviewThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`,
  SubmitReview: `mutation SubmitReview($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { pullRequestReview { id url state submittedAt } }
}`,
  DeleteReview: `mutation DeleteReview($id: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $id }) { pullRequestReview { id } }
}`,
  CommentNow: `mutation CommentNow($pullRequestId: ID!, $commitOID: GitObjectID, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: COMMENT, threads: $threads }) { pullRequestReview { id url } }
}`,
  ReplyToThread: `mutation ReplyToThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id url state } }
}`,
  ResolveThread: `mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`,
  UnresolveThread: `mutation UnresolveThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`,
  MarkFileViewed: `mutation MarkFileViewed($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } }
}`,
  UnmarkFileViewed: `mutation UnmarkFileViewed($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } }
}`,
  RequestReviews: `mutation RequestReviews($pullRequestId: ID!, $userLogins: [String!]) {
  requestReviewsByLogin(input: { pullRequestId: $pullRequestId, userLogins: $userLogins, union: true }) { pullRequest { id } }
}`,
  AddComment: `mutation AddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { id url } } }
}`,
} as const;

/** All static documents plus each generated page query, for the schema contract test. */
export function allDocuments(): Record<string, string> {
  const pages = Object.fromEntries(
    (Object.keys(connections) as ConnectionKey[]).map((key) => [
      `Page:${key}`,
      connectionPageQuery(key),
    ]),
  );

  return {
    Identity: identityQuery,
    ReviewReceipt: reviewReceiptQuery,
    Discover: discoverQuery,
    ResolvePull: resolvePullQuery,
    Snapshot: snapshotQuery,
    Detect: detectQuery,
    Comments: threadCommentsQuery,
    Checks: checksPageQuery,
    Blobs: blobsQuery(2),
    History: historyQuery,
    Search: searchQuery,
    ...pages,
    ...mutations,
  };
}
