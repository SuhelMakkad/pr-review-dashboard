import { FORGE_OPS, type ForgeOp } from '@/log.js';

const known = new Set<string>(FORGE_OPS);
const named = (name: string): ForgeOp => (known.has(name) ? (name as ForgeOp) : 'other');

const GITHUB_REST: [RegExp, ForgeOp][] = [
  [/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files(\?|$)/, 'pulls.files'],
  [/^repos\/[^/]+\/[^/]+\/pulls\/\d+(\?|$)/, 'pulls.get'],
  [/^repos\/[^/]+\/[^/]+\/compare\//, 'compare'],
  [/^repos\/[^/]+\/[^/]+\/tarball\//, 'tarball'],
  [/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments(\?|$)/, 'issue.comments'],
  [/^repos\/[^/]+\/[^/]+\/git\/ref\//, 'git.ref'],
  [/^rate_limit(\?|$)/, 'rate_limit'],
  [/^user\/teams(\?|$)/, 'teams'],
  [/^user(\?|$)/, 'user'],
];

/**
 * What a `gh api` request does, as a name from a fixed set: a GraphQL document's operation name,
 * or the shape of a REST path. Never the path itself, which names repositories and branches.
 */
export function githubOp(path: string | undefined, input?: string): ForgeOp {
  if (path === 'graphql') {
    let query = '';

    try {
      query = String((JSON.parse(input ?? '{}') as { query?: unknown }).query ?? '');
    } catch {
      // Not a document this server wrote.
    }

    const name = /^\s*(?:query|mutation)\s+([A-Za-z]+)/.exec(query)?.[1];

    return name ? named(name) : 'graphql';
  }

  return GITHUB_REST.find(([shape]) => shape.test(path ?? ''))?.[1] ?? 'other';
}

const GITLAB_MR_RESOURCES = new Set([
  'discussions',
  'notes',
  'versions',
  'diffs',
  'approvals',
  'approve',
  'unapprove',
  'reviewers',
  'draft_notes',
]);

const GITLAB: [RegExp, ForgeOp][] = [
  [/^projects\/[^/]+\/repository\/branches\//, 'repository.branch'],
  [/^projects\/[^/]+\/repository\/compare(\?|$)/, 'repository.compare'],
  [/^projects\/[^/]+\/repository\/merge_base(\?|$)/, 'repository.merge_base'],
  [/^projects\/[^/]+\/repository\/commits\//, 'repository.commit'],
  [/^projects\/[^/]+\/repository\/archive/, 'repository.archive'],
  [/^projects\/[^/]+\/repository\/files\//, 'repository.files'],
  [/^projects\/[^/]+\/pipelines\/\d+\/jobs(\?|$)/, 'pipeline.jobs'],
  [/^projects\/[^/]+\/merge_requests(\?|$)/, 'merge_requests'],
  [/^merge_requests(\?|$)/, 'merge_requests'],
  [/^todos(\?|$)/, 'todos'],
  [/^user(\?|$)/, 'user'],
  [/^version(\?|$)/, 'version'],
  [/^graphql(\?|$)/, 'graphql'],
];

/** What a `glab api` request does, as a name from a fixed set; never the path itself. */
export function gitlabOp(path: string | undefined): ForgeOp {
  const request = path ?? '';
  const mr = /^projects\/[^/]+\/merge_requests\/\d+(?:\/([a-z_]+))?(?:[/?]|$)/.exec(request);

  if (mr) {
    if (!mr[1]) return 'mr';

    return GITLAB_MR_RESOURCES.has(mr[1]) ? named(`mr.${mr[1]}`) : 'mr.other';
  }

  return GITLAB.find(([shape]) => shape.test(request))?.[1] ?? 'other';
}
