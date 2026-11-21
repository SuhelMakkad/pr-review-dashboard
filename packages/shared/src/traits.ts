import { forgeOf, type Forge } from '@/accounts.js';

/**
 * What a forge is like, declared once, where server and web used to ask "is this GitLab?" in
 * place. What depends on the instance, such as GitLab's release, stays a runtime capability
 * (`ForgeCapabilities`).
 */
export interface ForgeTraits {
  /**
   * An approval carries its summary in the same write (GitHub's review body). Where it cannot
   * (GitLab: an approval, then a note), the two are sent and checkpointed as separate steps.
   */
  approvalCarriesSummary: boolean;
  /**
   * The CLI signs each request in with its own sign-in (glab), so reads that must be one account's
   * sit between checks that it still is (`verifyAccount`). GitHub calls carry their own token.
   */
  checksAccount: boolean;
  /** The changed files can be listed at pinned commits, not only at the PR's head (GitLab). */
  pinnedFiles: boolean;
  /** Lines starting with `/` in a comment are commands (GitLab quick actions). */
  quickActions: boolean;
  /** How a review's snapshots are downloaded: `gh`'s tarball, or `glab`'s project archive. */
  archive: 'tarball' | 'archive';
  /** How a PR is named: `repo#12` or `group/project!12`, and whether its path can nest. */
  reference: { separator: '#' | '!'; nestedPaths: boolean };
  /** Review requests can name teams. */
  teams: boolean;
  /** The command that signs an account in on `host`. */
  signIn(host: string): string;
}

/** Frozen, nested objects included: a forge's traits are the same for every reader. */
const frozen = (traits: ForgeTraits): ForgeTraits =>
  Object.freeze({ ...traits, reference: Object.freeze({ ...traits.reference }) });

export const forgeTraits: Record<Forge, ForgeTraits> = {
  github: frozen({
    approvalCarriesSummary: true,
    checksAccount: false,
    pinnedFiles: false,
    quickActions: false,
    archive: 'tarball',
    reference: { separator: '#', nestedPaths: false },
    teams: true,
    signIn: () => 'gh auth login',
  }),
  gitlab: frozen({
    approvalCarriesSummary: false,
    checksAccount: true,
    pinnedFiles: true,
    quickActions: true,
    archive: 'archive',
    reference: { separator: '!', nestedPaths: true },
    teams: false,
    signIn: (host) => `glab auth login --hostname ${host}`,
  }),
};

/** The traits of `account`'s forge (`alice` on GitHub, `alice@gitlab.example` on GitLab). */
export const traitsOf = (account: string): ForgeTraits => forgeTraits[forgeOf(account)];
