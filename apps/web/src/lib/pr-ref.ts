import { instanceUrl, parseAccount } from '@review-desk/shared/accounts';
import { forgeTraits } from '@review-desk/shared/traits';

export interface PrRef {
  /** The GitHub owner, or a GitLab project's namespace, which can be nested (`group/sub`). */
  owner: string;
  repo: string;
  number: number;
  /** The host of a pasted link: `github.com`, or a GitLab host with its port. */
  host?: string;
  /** True for a GitLab merge request. */
  gitlab?: boolean;
}

/** The repository's last path segment is its name; everything before it is the owner. */
export function refOf(item: { repository: string; number: number; url?: string }): PrRef {
  const slash = item.repository.lastIndexOf('/');

  return {
    owner: item.repository.slice(0, slash),
    repo: item.repository.slice(slash + 1),
    number: item.number,
    ...(item.url && isGitLabUrl(item.url) ? { gitlab: true } : {}),
  };
}

/** GitLab MR web addresses, on any host, contain `/-/merge_requests/`. */
export const isGitLabUrl = (url: string) => url.includes('/-/merge_requests/');

/** `#` before a GitHub PR's number, `!` before a GitLab MR's. */
export const numberSign = (url: string | undefined) => (url && isGitLabUrl(url) ? '!' : '#');

/** The changed-files page of a PR (`/files`) or MR (`/diffs`). */
export const filesUrl = (url: string) => `${url}/${isGitLabUrl(url) ? 'diffs' : 'files'}`;

export function sameRef(item: { repository: string; number: number }, ref: PrRef): boolean {
  return (
    item.number === ref.number &&
    item.repository.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase()
  );
}

const SEGMENT = '[\\w.-]+';
/** github.com itself (not `notgithub.com`), with or without a scheme or `www.`. */
const GITHUB_LINK = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${SEGMENT})/(${SEGMENT})/pull/(\\d+)`,
  'i',
);
const GITHUB_SHORT = new RegExp(`^(${SEGMENT})/(${SEGMENT})(?:#|/pull/)(\\d+)$`, 'i');
/** Any host: GitLab's `/-/merge_requests/` separator marks the end of the project path. */
const GITLAB_LINK = new RegExp(
  `^(?:https?://)?([\\w.-]+(?::\\d{1,5})?)/((?:${SEGMENT}/)+${SEGMENT})/-/merge_requests/(\\d+)`,
  'i',
);
const GITLAB_SHORT = new RegExp(`^((?:${SEGMENT}/)+)(${SEGMENT})!(\\d+)$`, 'i');

function split(path: string, number: string, extra: Partial<PrRef>): PrRef | null {
  const slash = path.lastIndexOf('/');
  const value = Number(number);

  return value > 0
    ? { owner: path.slice(0, slash), repo: path.slice(slash + 1), number: value, ...extra }
    : null;
}

/**
 * Parses a PR or MR reference:
 * - a GitHub PR link such as https://github.com/acme/api/pull/12/files, or `acme/api#12`;
 * - a GitLab MR link on any host, such as https://git.example.com:8443/team/web/app/-/merge_requests/7,
 *   or `team/web/app!7`. A GitLab served under a path (`https://example.com/gitlab/...`) keeps that
 *   path in the owner; the server removes it.
 */
export function parsePrRef(text: string): PrRef | null {
  const value = text.trim();
  const github = GITHUB_LINK.exec(value);

  if (github) return split(`${github[1]}/${github[2]}`, github[3], { host: 'github.com' });

  const gitlab = GITLAB_LINK.exec(value);

  if (gitlab) return split(gitlab[2], gitlab[3], { host: gitlab[1].toLowerCase(), gitlab: true });

  const short = GITHUB_SHORT.exec(value);

  if (short) return split(`${short[1]}/${short[2]}`, short[3], {});

  const gitlabShort = GITLAB_SHORT.exec(value);

  return gitlabShort
    ? split(`${gitlabShort[1]}${gitlabShort[2]}`, gitlabShort[3], { gitlab: true })
    : null;
}

/** `owner/repo#number` as GitHub writes a PR reference, or `group/project!number` for GitLab. */
export const formatRef = (ref: PrRef) =>
  `${ref.owner}/${ref.repo}${ref.gitlab ? '!' : '#'}${ref.number}`;

/** A GitLab instance's relative URL root, e.g. `gitlab` for `https://example.com/gitlab`. */
export function relativeRoot(webUrl: string | null | undefined): string {
  const base = instanceUrl(webUrl);

  return base ? new URL(base).pathname.replace(/^\/+|\/+$/g, '') : '';
}

/**
 * Where a pasted reference belongs for the account in use: `elsewhere` names the other host or
 * forge when it cannot be opened here (the same path there is a different PR); otherwise `ref` is
 * it as this account's queue writes it, with a GitLab link's relative URL root removed.
 */
export function placeRef(
  ref: PrRef,
  account: { login: string; webUrl?: string } | null | undefined,
): { ref: PrRef; elsewhere: null } | { ref: null; elsewhere: string } {
  if (!account) return { ref, elsewhere: null };

  const { forge, host } = parseAccount(account.login);

  // A `group/project!12` reference names a project path this forge cannot take.
  if (ref.gitlab && !forgeTraits[forge].reference.nestedPaths)
    return { ref: null, elsewhere: 'GitLab' };
  if (!ref.host) return { ref, elsewhere: null };

  const web = instanceUrl(account.webUrl);
  const hosts = [host, web ? new URL(web).host : null];

  if (!hosts.some((candidate) => candidate?.toLowerCase() === ref.host!.toLowerCase()))
    return { ref: null, elsewhere: ref.host };

  const root = forge === 'gitlab' ? relativeRoot(account.webUrl) : '';

  if (!root) return { ref, elsewhere: null };

  // Links into this GitLab always start with its root; any other path is another instance.
  if (!`${ref.owner}/`.toLowerCase().startsWith(`${root.toLowerCase()}/`))
    return { ref: null, elsewhere: `${ref.host}/${ref.owner.split('/')[0]}` };

  // Already this account's path: without the host, nothing removes the root a second time.
  const { host: _host, ...placed } = ref;

  return { ref: { ...placed, owner: ref.owner.slice(root.length + 1) }, elsewhere: null };
}
