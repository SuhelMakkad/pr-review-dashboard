import { randomUUID } from 'node:crypto';
import { isoNow, type Clock } from '@/clock.js';
import { forForge } from '@review-desk/shared/accounts';
import type { Actor, ForgeCapabilities, SyncStatus } from '@review-desk/shared/types';
import {
  initialStatus,
  LAST_ACCOUNT,
  SELECTED_ACCOUNT,
  STATUS,
  STATUS_RECOVERED,
  WRITE_COOLDOWN,
} from '@/db/settings.js';
import type { Store } from '@/db/store.js';
import type { EventBus } from '@/events.js';
import type { GitHubAccounts } from '@/github/credentials.js';
import { GitHubError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';

export { initialStatus } from '@/db/settings.js';

/** Account keys match exactly (ignoring case): `alice` on GitHub is not `alice@gitlab.com`. */
export const sameAccount = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** The latest of `deadlines` still ahead of `now`, or null. A missing one counts as none. */
export function laterDeadline(
  now: number,
  ...deadlines: (string | null | undefined)[]
): string | null {
  const latest = Math.max(
    ...deadlines.map((deadline) => (deadline ? Date.parse(deadline) : -Infinity)),
  );

  return latest > now ? new Date(latest).toISOString() : null;
}

/**
 * The account in use and its status, with each account's cooldown. This is the only production
 * writer of `status`, and it publishes every change the browser sees. The sync changes the status
 * through the methods below, which keep the order of today's writes: a read's result lands on the
 * status object in use when the read started.
 */
export class AccountState {
  status: SyncStatus;
  /** Identifies this server process in the statuses it sends; `createApp` sets the app's own. */
  bootId: string = randomUUID();
  /** Status changes made by this process, counted from its start, never loaded from storage. */
  private revision = 0;
  /** The last status published, which a revision names: changes in between are not shown. */
  private published: SyncStatus | null = null;

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
    /** Lets the app switch GitHub CLI accounts; null where the account is fixed. */
    private readonly accounts: GitHubAccounts | null,
    private readonly clock: Clock,
  ) {
    const lastAccount = store.settings.get(LAST_ACCOUNT);
    const selected = store.settings.get(SELECTED_ACCOUNT);

    this.status = (lastAccount && store.settings.get(STATUS.of(lastAccount))) || initialStatus();
    this.status.syncing = false;

    if (selected) accounts?.select(selected);
  }

  /**
   * Share write cooldowns with reads so a manual/background sync cannot bypass the forge's limit.
   * The deadline is the account's own; only the selected account's also shows in the status.
   */
  deferUntil(retryAt: string, account: string | null = this.status.account?.login ?? null): void {
    if (!account) return;

    const until = new Date(
      Math.max(Date.parse(retryAt), Date.parse(this.cooldown(account) ?? '') || -Infinity),
    ).toISOString();

    this.store.settings.set(WRITE_COOLDOWN.of(account), until);

    if (account !== this.status.account?.login) return;

    this.status = { ...this.status, retryAt: until, nextSyncAt: until };
    this.store.saveStatus(this.status);
    this.emitStatus();
  }

  /**
   * The account's cooldown: the later unexpired one of a write's deadline and the deadline its
   * last sync saved, or null.
   */
  cooldown(account: string | null = this.status.account?.login ?? null): string | null {
    // Before any account is known, the status's own deadline (from the identity read) applies.
    if (!account) return laterDeadline(this.clock.now(), this.status.retryAt);

    const saved = this.store.settings.get(WRITE_COOLDOWN.of(account));
    const synced =
      account === this.status.account?.login
        ? this.status.retryAt
        : (this.store.settings.get(STATUS.of(account))?.retryAt ?? null);
    // A missing deadline is none at all, never the epoch, whatever the clock reads.
    const until = Math.max(
      saved ? Date.parse(saved) : -Infinity,
      synced ? Date.parse(synced) : -Infinity,
    );

    return until > this.clock.now() ? new Date(until).toISOString() : null;
  }

  /**
   * True for an account this app has worked as: the one identified now, or one with a saved
   * status. Routes that name an account serve only these.
   */
  knows(account: string): boolean {
    return (
      account === this.status.account?.login || this.store.settings.get(STATUS.of(account)) !== null
    );
  }

  /** Refuses a read while the account is cooling down after a rate limit. */
  assertNotCoolingDown(account: string | null = this.status.account?.login ?? null): void {
    const retryAt = this.cooldown(account);

    if (retryAt)
      throw new GitHubError(
        this.worded('GitHub is rate limited. Saved data is still available.'),
        retryAt,
        429,
        'rate_limit',
      );
  }

  /** `account`, refused unless this app has worked as it. */
  knownLogin(account: string): string {
    if (!account || !this.knows(account))
      throw new ReviewError('UNKNOWN_ACCOUNT', 404, 'Review Desk has not used this account.');

    return account;
  }

  /** The account's own saved details (its web address, say), in use or not. */
  accountOf(login: string): SyncStatus['account'] {
    return login === this.status.account?.login
      ? this.status.account
      : (this.store.settings.get(STATUS.of(login))?.account ?? null);
  }

  /**
   * Selects `login`, once the sync before the switch has finished: that sync can itself notice a
   * different account, so the account in use must still be `from`. The new account's saved
   * status shows at once.
   */
  applySwitch(from: string | null, login: string): void {
    if ((this.status.account?.login ?? null) !== from)
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        this.worded('GitHub account changed. Refresh before switching.'),
      );

    this.accounts?.select(login);
    this.store.settings.set(SELECTED_ACCOUNT, login);

    if (login === from) return;

    const saved = this.store.settings.get(STATUS.of(login));
    // A refresh or write made while it was not selected may have hit a limit since.
    const deadline = laterDeadline(
      this.clock.now(),
      saved?.retryAt,
      this.store.settings.get(WRITE_COOLDOWN.of(login)),
    );

    this.status = {
      ...(saved ?? initialStatus()),
      account: saved?.account ?? { login },
      syncing: false,
      // A stale sync error goes; a rebuilt saved status still says so until a sync replaces it.
      error: saved?.error === STATUS_RECOVERED ? STATUS_RECOVERED : null,
      warnings: [],
      retryAt: deadline,
      nextSyncAt: deadline ?? saved?.nextSyncAt ?? null,
    };
    this.store.saveStatus(this.status);
    this.emitStatus();
  }

  /** A sync starts: published at once, with no error or warnings yet. */
  beginSync(): void {
    this.status = {
      ...this.status,
      syncing: true,
      error: null,
      warnings: [],
      lastAttemptAt: isoNow(this.clock),
    };
    this.emitStatus();
  }

  /**
   * The sync found the CLI signed in as another account: that account's saved status, published
   * at once. Returns its cooldown, during which the sync reads nothing.
   */
  adoptIdentity(account: Actor): string | null {
    const saved = this.store.settings.get(STATUS.of(account.login));

    this.status = {
      ...(saved ?? initialStatus()),
      account,
      syncing: true,
      error: null,
      warnings: [],
      lastAttemptAt: this.status.lastAttemptAt,
    };
    // A cooldown this account met while it was not in use (a scoped refresh, a write) holds:
    // the check this sync started with was the previous account's.
    const waiting = this.cooldown(account.login);

    if (waiting) {
      this.status.retryAt = waiting;
      this.status.nextSyncAt = waiting;
    }

    // Published at once, with a new revision: the routes that follow the account in use serve
    // this account from now on, and the status must say so before they do.
    this.emitStatus();

    return waiting;
  }

  /** The same account read again: its profile as the forge has it now, shown when the sync ends. */
  setProfile(account: Actor): void {
    this.status.account = account;
  }

  /**
   * Where a read about to start puts its result: the status in use now, as an assignment's target
   * is chosen before its right-hand side runs. A cooldown that replaces the status while the read
   * is on its way leaves the result on the previous one. Take it synchronously, just before the
   * read, and await the read itself, so no turn is added between the reads of a sync.
   */
  readTarget(): {
    setTeams(teams: string[]): void;
    setCapabilities(capabilities: ForgeCapabilities | undefined): void;
  } {
    const target = this.status;

    return {
      setTeams: (teams) => {
        target.teams = teams;
      },
      setCapabilities: (capabilities) => {
        target.capabilities = capabilities;
      },
    };
  }

  /** A warning for the sync in progress, shown when it ends. */
  warn(message: string): void {
    this.status.warnings.push(message);
  }

  /** The error the sync in progress ends with. */
  setError(message: string): void {
    this.status.error = message;
  }

  /** The sync read everything without a warning: its time is the last successful sync. */
  succeeded(): void {
    if (this.status.warnings.length === 0) this.status.lastSuccessfulSync = isoNow(this.clock);
  }

  /**
   * The sync ends, saved and published. Its deadline is `retryAt`, or a later one that a refresh
   * or a write met while it ran; with none, the next sync is due `intervalMs` from now. Returns
   * the account the sync ended as.
   */
  finishSync({
    retryAt,
    completedAt,
    intervalMs,
  }: {
    retryAt: string | null;
    completedAt: string;
    intervalMs: number;
  }): string | null {
    const login = this.status.account?.login ?? null;
    // A refresh or a write may have hit a limit while this ran: the later deadline stands.
    const written = login ? this.store.settings.get(WRITE_COOLDOWN.of(login)) : null;
    const deadline = laterDeadline(this.clock.now(), retryAt, written);

    this.status = {
      ...this.status,
      syncing: false,
      lastCompletedAt: completedAt,
      retryAt: deadline,
      nextSyncAt: deadline ?? new Date(this.clock.now() + intervalMs).toISOString(),
    };
    this.store.saveStatus(this.status);
    this.emitStatus();

    return login;
  }

  /**
   * The status as sent to the browser: the last one published, with this process's `bootId` and
   * its revision, so two statuses with one revision are always the same state.
   */
  get sentStatus(): SyncStatus {
    const published = this.published ?? structuredClone(this.status);

    return { ...structuredClone(published), bootId: this.bootId, revision: this.revision };
  }

  private emitStatus(): void {
    this.revision += 1;
    this.published = structuredClone(this.status);
    this.events.emit({ type: 'status', status: this.sentStatus });
  }

  /** A message written for GitHub, worded for the current account's forge. */
  worded(text: string): string {
    return forForge(text, this.status.account?.login);
  }

  /**
   * The teams of `account`: as last synced for the account in use, else as saved with its last
   * status. A read started as one account can finish after a switch to another.
   */
  teamsOf(account: string): string[] {
    if (sameAccount(account, this.status.account?.login ?? '')) return this.status.teams;

    return this.store.settings.get(STATUS.of(account))?.teams ?? [];
  }
}
