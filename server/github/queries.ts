/**
 * Every GraphQL document sent to GitHub lives here, so the contract test can validate all of them
 * against GitHub's published schema.
 */

export const pageInfo = 'pageInfo { hasNextPage endCursor }';

const reviewerFields =
  '__typename ... on User { login } ... on Team { name slug organization { login } }';

const reviewFields = 'id state submittedAt updatedAt body url commit { oid }';

export const commentFields =
  'id body createdAt updatedAt url author { login avatarUrl } replyTo { id }';

const threadFields = `id isResolved isOutdated path line comments(first: 100) { nodes { ${commentFields} } ${pageInfo} }`;

export const checkFields =
  '__typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }';

export const connections = {
  reviews: `reviews(first: 100, after: $cursor, author: $login) { nodes { ${reviewFields} } ${pageInfo} }`,
  reviewRequests: `reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ${reviewerFields} } } ${pageInfo} }`,
  timelineItems: `timelineItems(first: 100, after: $cursor, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) { nodes { __typename ... on ReviewRequestedEvent { id createdAt requestedReviewer { ${reviewerFields} } } ... on ReviewRequestRemovedEvent { id createdAt requestedReviewer { ${reviewerFields} } } } ${pageInfo} }`,
  reviewThreads: `reviewThreads(first: 50, after: $cursor) { nodes { ${threadFields} } ${pageInfo} }`,
  files: `files(first: 100, after: $cursor) { nodes { path additions deletions } ${pageInfo} }`,
} as const;

export type ConnectionKey = keyof typeof connections;

export const identityQuery = 'query Identity { viewer { login avatarUrl } }';

export const discoverQuery = `query Discover($query: String!, $cursor: String) {
  search(query: $query, type: ISSUE, first: 100, after: $cursor) { issueCount nodes { ... on PullRequest { id } } ${pageInfo} }
}`;

export const snapshotQuery = `query Snapshot($id: ID!, $login: String!, $cursor: String) {
  node(id: $id) { ... on PullRequest {
    id number title url body author { login avatarUrl } repository { nameWithOwner }
    isDraft state createdAt updatedAt headRefOid baseRefName headRefName additions deletions changedFiles reviewDecision mergeable
    ${Object.values(connections).join('\n')}
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

export const threadCommentsQuery = `query Comments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { ${commentFields} } ${pageInfo} } } }
}`;

export const checksPageQuery = `query Checks($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequest { commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100, after: $cursor) { nodes { ${checkFields} } ${pageInfo} } } } } } } }
}`;

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
    Discover: discoverQuery,
    Snapshot: snapshotQuery,
    Comments: threadCommentsQuery,
    Checks: checksPageQuery,
    ...pages,
  };
}
