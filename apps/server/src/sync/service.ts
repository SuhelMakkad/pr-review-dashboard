import { systemClock, type Clock } from '@/clock.js';
import type {
  PullRequestDetail,
  PullRequestList,
  SyncStatus,
  TriageUpdate,
} from '@review-desk/shared/types';
import type { Store } from '@/db/store.js';
import { EventBus } from '@/events.js';
import type { GitHubApi } from '@/github/api.js';
import type { GitHubAccounts } from '@/github/credentials.js';
import { GitHub } from '@/github/read.js';
import type { ViewedRevision } from '@/github/write.js';
import { AccountState } from '@/sync/accounts.js';
import { PullQueue } from '@/sync/queue.js';
import { PullReads, type MineList } from '@/sync/reads.js';
import { SyncRunner, type AfterSync, type SyncRun } from '@/sync/runner.js';
import { SnapshotCoordinator } from '@/sync/snapshots.js';

export { initialStatus } from '@/sync/accounts.js';
export type { MineList } from '@/sync/reads.js';

/**
 * The sync, the account in use, and the queue's reads and writes, behind the one API the routes
 * and services use. Each part owns its own state:
 *
 * - `AccountState`: the status, its publication, and each account's cooldown;
 * - `PullReads`: the inbox, the author view and a PR's detail, read from the store;
 * - `PullQueue`: work on one PR (refresh, adding and removing by hand, viewed files, triage);
 * - `SyncRunner`: the background sync and account switches, which share one slot.
 */
export class SyncService {
  private readonly state: AccountState;
  private readonly reads: PullReads;
  private readonly queue: PullQueue;
  private readonly runner: SyncRunner;
  /** Runs after every sync with the active login (used for notifications), as this object's method. */
  afterSync: ((login: string) => Promise<AfterSync | void>) | null = null;

  constructor(
    readonly store: Store,
    readonly github: GitHubApi = new GitHub(),
    readonly events = new EventBus(),
    /** Lets the app switch GitHub CLI accounts; null where the account is fixed. */
    readonly accounts: GitHubAccounts | null = null,
    /** The app's one clock: the outbox, the AI runner and the auto reviewer read it too. */
    readonly clock: Clock = systemClock,
  ) {
    // Restores the saved status and the CLI selection before anything can start.
    this.state = new AccountState(store, events, accounts, clock);
    this.reads = new PullReads(store, this.state, clock);

    // One coordinator orders every write of a cached PR: the sync's, refreshes, removals and
    // viewed marks.
    const snapshots = new SnapshotCoordinator(
      store,
      (account) => this.state.teamsOf(account),
      clock,
    );

    this.queue = new PullQueue(store, github, events, clock, this.state, this.reads, snapshots);
    this.runner = new SyncRunner(
      this,
      store,
      github,
      events,
      accounts,
      clock,
      this.state,
      this.reads,
      snapshots,
    );
  }

  /** The status in use. Production code changes it only through `AccountState`; tests set it. */
  get status(): SyncStatus {
    return this.state.status;
  }

  set status(status: SyncStatus) {
    this.state.status = status;
  }

  /** Identifies this server process in the statuses it sends; `createApp` sets the app's own. */
  get bootId(): string {
    return this.state.bootId;
  }

  set bootId(bootId: string) {
    this.state.bootId = bootId;
  }

  /** The data folder this process uses, sent with each status; set at start. */
  set dataFolder(folder: string) {
    this.state.dataFolder = folder;
  }

  /** The last status published, as sent to the browser (see `AccountState.sentStatus`). */
  get sentStatus(): SyncStatus {
    return this.state.sentStatus;
  }

  start(): void {
    this.runner.start();
  }

  /** Stops the schedule and waits for a sync in progress; no sync starts after this. */
  stop(): Promise<void> {
    return this.runner.stop();
  }

  /** Runs one sync, or joins the one in progress (see `SyncRunner.sync`). */
  sync(options?: { scheduled?: boolean; trigger?: 'start' | 'switch' | 'manual' }): Promise<void> {
    return this.runner.sync(options);
  }

  /** Runs a sync of the account's own, and says how it went (see `SyncRunner.syncOwn`). */
  syncOwn(account: string, signal: AbortSignal): Promise<SyncRun> {
    return this.runner.syncOwn(account, signal);
  }

  /** The account's teams, in use or not (see `AccountState.teamsOf`). */
  teamsOf(account: string): string[] {
    return this.state.teamsOf(account);
  }

  /** The account's cooldown, in use or not, or null (see `AccountState.cooldown`). */
  cooldown(account: string): string | null {
    return this.state.cooldown(account);
  }

  /** Switches to another account signed in to the CLI (see `SyncRunner.switchAccount`). */
  switchAccount(from: string | null, to: string): Promise<SyncStatus> {
    return this.runner.switchAccount(from, to);
  }

  /** Holds the account's reads and syncs back until `retryAt` (see `AccountState.deferUntil`). */
  deferUntil(retryAt: string, account?: string | null): void {
    this.state.deferUntil(retryAt, account);
  }

  /** True for an account this app has worked as. */
  knows(account: string): boolean {
    return this.state.knows(account);
  }

  /** What the account's forge supports, as its last sync read it, in use or not. */
  capabilitiesOf(account: string): SyncStatus['capabilities'] {
    return this.state.capabilitiesOf(account);
  }

  /** Refuses a read while the account is cooling down after a rate limit. */
  assertNotCoolingDown(account?: string | null): void {
    this.state.assertNotCoolingDown(account);
  }

  /** Refetches one PR now (see `PullQueue.refresh`). */
  refresh(
    id: string,
    account?: string | null,
    forge?: GitHubApi,
  ): Promise<PullRequestDetail | null> {
    return this.queue.refresh(id, account, forge);
  }

  /** Adds a PR to the queue by hand (see `PullQueue.track`). */
  track(
    account: string,
    path: string,
    number: number,
    host?: string,
    gitlab?: boolean,
  ): Promise<PullRequestDetail & { membershipId: string | null }> {
    return this.queue.track(account, path, number, host, gitlab);
  }

  /** Removes a PR added by hand (see `PullQueue.untrack`). */
  untrack(account: string, id: string, membershipId?: string): { tracked: boolean } {
    return this.queue.untrack(account, id, membershipId);
  }

  /** Records a viewed mark the forge accepted (see `PullQueue.markViewed`). */
  markViewed(
    account: string,
    id: string,
    path: string,
    viewed: boolean,
    revision: ViewedRevision | null,
  ): boolean {
    return this.queue.markViewed(account, id, path, viewed, revision);
  }

  /** The selected account's inbox. */
  list(): PullRequestList {
    return this.reads.list();
  }

  /** `account`'s reviewer inbox: PRs it reviews or was asked about, never its own. */
  listFor(account: string): PullRequestList {
    return this.reads.listFor(account);
  }

  /** The selected account's own PRs. */
  mine(): MineList {
    return this.reads.mine();
  }

  /** The author view: `account`'s own open PRs and what blocks each one. */
  mineFor(account: string): MineList {
    return this.reads.mineFor(account);
  }

  /** The PR as the selected account has it. */
  detail(id: string): PullRequestDetail | null {
    return this.reads.detail(id);
  }

  /** The PR as `account` has it, with its triage, or null when it does not track it open. */
  detailFor(account: string, id: string): PullRequestDetail | null {
    return this.reads.detailFor(account, id);
  }

  /**
   * Triage from a request that names the account it was made for, which must be the selected
   * one: a window still showing another account must not write to this one (see `updateFor`).
   */
  update(id: string, update: TriageUpdate): PullRequestDetail | null {
    if (update.account !== this.status.account?.login) throw new Error('ACCOUNT_CHANGED');

    return this.updateFor(update.account, id, update);
  }

  /** Triage of `account`'s PR, whichever account is selected. */
  updateFor(
    account: string,
    id: string,
    update: Omit<TriageUpdate, 'account'>,
  ): PullRequestDetail | null {
    return this.queue.updateFor(account, id, update);
  }
}
