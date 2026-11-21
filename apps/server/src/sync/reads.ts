import type { Clock } from '@/clock.js';
import { deriveItem, sortItems } from '@review-desk/shared/attention';
import { deriveAuthorItem, sortAuthorItems, type AuthorItem } from '@review-desk/shared/author';
import { isSameUser } from '@review-desk/shared/accounts';
import {
  REVIEW_SOURCES,
  type PullRequestDetail,
  type PullRequestList,
  type PullRequestSnapshot,
} from '@review-desk/shared/types';
import type { Store } from '@/db/store.js';
import type { AccountState } from '@/sync/accounts.js';

const MENTION_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface MineList {
  account: string | null;
  items: AuthorItem[];
}

/** The queue as each account sees it, read from the store: its inbox, its own PRs, and one PR. */
export class PullReads {
  constructor(
    private readonly store: Store,
    private readonly state: AccountState,
    private readonly clock: Clock,
  ) {}

  private openSnapshots(account: string): PullRequestSnapshot[] {
    return this.store.snapshots(account).filter((pr) => pr.state === 'OPEN');
  }

  /** The selected account's inbox (see `listFor`). */
  list(): PullRequestList {
    const account = this.state.status.account?.login;

    return account ? this.listFor(account) : { account: null, items: [] };
  }

  /** `account`'s reviewer inbox: PRs it reviews or was asked about, never its own. */
  listFor(account: string): PullRequestList {
    const teams = this.state.teamsOf(account);
    const now = this.clock.now();
    const items = this.openSnapshots(account)
      .filter((pr) => !isSameUser(pr.author.login, account))
      .filter(
        (pr) =>
          pr.sources.length === 0 || pr.sources.some((source) => REVIEW_SOURCES.includes(source)),
      )
      .map((pr) => ({
        pr,
        item: deriveItem(pr, this.store.triage(account, pr.id), account, teams, now),
      }))
      .filter(({ pr, item }) => {
        const mentionOnly =
          pr.sources.every((source) => source === 'mentioned') && pr.sources.length > 0;

        // A mention alone keeps a PR around only while it is recent or still unread.
        return (
          !mentionOnly ||
          item.reasons.length > 0 ||
          now - Date.parse(pr.updatedAt) < MENTION_WINDOW_MS
        );
      })
      .map(({ item }) => item);

    return { account, items: sortItems(items) };
  }

  /** The selected account's own PRs (see `mineFor`). */
  mine(): MineList {
    const account = this.state.status.account?.login;

    return account ? this.mineFor(account) : { account: null, items: [] };
  }

  /** The author view: `account`'s own open PRs and what blocks each one. */
  mineFor(account: string): MineList {
    return {
      account,
      items: sortAuthorItems(
        this.openSnapshots(account)
          .filter((pr) => isSameUser(pr.author.login, account))
          .map((pr) =>
            deriveAuthorItem(pr, account, this.store.triage(account, pr.id).note.trim().length > 0),
          ),
      ),
    };
  }

  /** The PR as the selected account has it (see `detailFor`). */
  detail(id: string): PullRequestDetail | null {
    const account = this.state.status.account?.login;

    return account ? this.detailFor(account, id) : null;
  }

  /** The PR as `account` has it, with its triage, or null when it does not track it open. */
  detailFor(account: string, id: string): PullRequestDetail | null {
    const snapshot = this.store.snapshot(account, id);

    return snapshot ? this.detailOf(account, snapshot) : null;
  }

  /** A stored snapshot with its triage, or null when the PR is no longer open. */
  detailOf(account: string, snapshot: PullRequestSnapshot): PullRequestDetail | null {
    if (snapshot.state !== 'OPEN') return null;

    const triage = this.store.triage(account, snapshot.id);

    return {
      account,
      snapshot,
      triage,
      item: deriveItem(snapshot, triage, account, this.state.teamsOf(account), this.clock.now()),
    };
  }
}
