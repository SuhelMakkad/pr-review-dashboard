/**
 * Account keys name the account Review Desk works as. A GitHub account is its login (`octocat`);
 * a GitLab account is `username@host`, where the host is the GitLab instance as the GitLab CLI
 * names it, port included (`alice@gitlab.com`, `alice@git.example.com:8443`). Neither GitHub
 * logins nor GitLab usernames can contain `@`, so a key always tells which kind it is, and the
 * same username on two hosts or on GitHub stays two accounts with separate data.
 */

export type Forge = 'github' | 'gitlab';

export interface AccountRef {
  forge: Forge;
  /** The login or username, as it appears on PRs, comments and reviews. */
  handle: string;
  /** `github.com`, or the GitLab host. */
  host: string;
}

export const GITHUB_HOST = 'github.com';

export function gitlabAccountKey(username: string, host: string): string {
  return `${username}@${host}`;
}

export function parseAccount(account: string): AccountRef {
  const at = account.indexOf('@');

  return at > 0
    ? { forge: 'gitlab', handle: account.slice(0, at), host: account.slice(at + 1) }
    : { forge: 'github', handle: account, host: GITHUB_HOST };
}

/** The login inside an account key: `alice@gitlab.com` → `alice`, `octocat` → `octocat`. */
export const accountHandle = (account: string): string => parseAccount(account).handle;

export const forgeOf = (account: string | null | undefined): Forge =>
  account ? parseAccount(account).forge : 'github';

/**
 * True when a login seen on a PR (an author, reviewer or commenter) is the account's own. Both
 * sides may be account keys; comparison ignores case, as GitHub and GitLab do.
 */
export function isSameUser(login: string, account: string): boolean {
  return accountHandle(login).toLowerCase() === accountHandle(account).toLowerCase();
}

export interface ForgeTerms {
  /** `GitHub` or `GitLab`. */
  name: string;
  /** `PR` or `MR`. */
  short: string;
  /** `pull request` or `merge request`. */
  long: string;
  /** The CLI the server signs in with. */
  cli: 'gh' | 'glab';
}

const TERMS: Record<Forge, ForgeTerms> = {
  github: { name: 'GitHub', short: 'PR', long: 'pull request', cli: 'gh' },
  gitlab: { name: 'GitLab', short: 'MR', long: 'merge request', cli: 'glab' },
};

/** User-facing names for the account's forge; GitHub when no account is known yet. */
export const forgeTerms = (account: string | null | undefined): ForgeTerms =>
  TERMS[forgeOf(account)];

/**
 * A message written for GitHub, worded for the account's forge: for a GitLab account, "GitHub"
 * becomes "GitLab" and "pull request" becomes "merge request". GitHub messages are unchanged.
 */
export function forForge(text: string, account: string | null | undefined): string {
  if (forgeOf(account) !== 'gitlab') return text;

  return text
    .replace(/\bGitHub\b/g, 'GitLab')
    .replace(/\bpull request(s?)\b/g, 'merge request$1')
    .replace(/\bPull request(s?)\b/g, 'Merge request$1');
}

interface PullRef {
  repository: string;
  number: number;
  url: string;
}

/** `#` for a GitHub PR, `!` for a GitLab MR (whose web address contains `/-/merge_requests/`). */
const separator = (pull: PullRef) => (pull.url.includes('/-/merge_requests/') ? '!' : '#');

/** `acme/api#12`, or `team/sub/web!12` for a GitLab MR. */
export const fullRef = (pull: PullRef) => `${pull.repository}${separator(pull)}${pull.number}`;

/** `api#12`, or `web!12` for a GitLab MR: the repository's own name and the number. */
export const shortRef = (pull: PullRef) =>
  `${pull.repository.split('/').at(-1)}${separator(pull)}${pull.number}`;

/**
 * A GitLab instance's web address from the signed-in user's profile page:
 * `https://example.com/gitlab/alice` → `https://example.com/gitlab`.
 */
export function instanceUrl(profileUrl: string | null | undefined): string | null {
  const match = /^(https?:\/\/[^/]+(?:\/.*)?)\/[^/]+\/?$/.exec(profileUrl ?? '');

  return match ? match[1] : null;
}

/**
 * The app path of a PR below `base`, as the web router builds it: a GitLab namespace with nested
 * groups (`team/sub`) is one encoded segment, so `team/sub/web!12` is `/base/team%2Fsub/web/12`.
 */
export function pullPath(base: string, pull: { repository: string; number: number }): string {
  const slash = pull.repository.lastIndexOf('/');
  const owner = encodeURIComponent(pull.repository.slice(0, slash));
  const repo = encodeURIComponent(pull.repository.slice(slash + 1));

  return `/${base}/${owner}/${repo}/${pull.number}`;
}
