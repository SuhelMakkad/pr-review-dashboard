import { deriveItem, sortItems } from '../shared/attention.js';
import type {
  PullRequestDetail,
  PullRequestList,
  Source,
  SyncStatus,
  TriageUpdate,
} from '../shared/types.js';
import { GitHub, GitHubError, safeError } from './github.js';
import { Store } from './store.js';

export const initialStatus = (): SyncStatus => ({
  account: null,
  teams: [],
  syncing: false,
  lastAttemptAt: null,
  lastCompletedAt: null,
  lastSuccessfulSync: null,
  nextSyncAt: null,
  retryAt: null,
  error: null,
  warnings: [],
});

export class SyncService {
  status: SyncStatus;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly store: Store,
    readonly github = new GitHub(),
  ) {
    const lastAccount = store.getSetting<string>('lastAccount');

    this.status =
      (lastAccount && store.getSetting<SyncStatus>(`status:${lastAccount}`)) || initialStatus();
    this.status.syncing = false;
  }

  start(): void {
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, 60_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    await this.running;
  }

  sync(): Promise<void> {
    if (this.running) return this.running;
    if (this.status.retryAt && Date.parse(this.status.retryAt) > Date.now())
      return Promise.resolve();

    this.running = this.perform().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  private async perform(): Promise<void> {
    this.status = {
      ...this.status,
      syncing: true,
      error: null,
      warnings: [],
      lastAttemptAt: new Date().toISOString(),
    };
    let retryAt: string | null = null;

    try {
      const account = await this.github.identity();

      if (account.login !== this.status.account?.login) {
        const saved = this.store.getSetting<SyncStatus>(`status:${account.login}`);

        this.status = {
          ...(saved ?? initialStatus()),
          account,
          syncing: true,
          error: null,
          warnings: [],
          lastAttemptAt: this.status.lastAttemptAt,
        };
      } else {
        this.status.account = account;
      }

      try {
        this.status.teams = await this.github.teams();
      } catch (error) {
        if (error instanceof GitHubError && error.retryAt) throw error;

        this.status.warnings.push(
          `Team membership could not be refreshed. Team request details may be incomplete. ${safeError(error)}`,
        );
      }

      const sources: Source[] = ['requested', 'assigned', 'reviewed'];
      const feeds = await Promise.allSettled(
        sources.map((source) => this.github.discover(account.login, source)),
      );
      const discovery = new Map<string, Source[]>();

      for (let index = 0; index < feeds.length; index++) {
        const feed = feeds[index];

        if (feed.status === 'rejected') {
          this.status.warnings.push(
            `${sources[index]} search incomplete: ${safeError(feed.reason)}`,
          );

          if (feed.reason instanceof GitHubError && feed.reason.retryAt)
            retryAt = feed.reason.retryAt;
          continue;
        }

        for (const id of feed.value)
          discovery.set(id, [...(discovery.get(id) ?? []), sources[index]]);
      }

      const previous = new Map(
        this.store
          .snapshots(account.login)
          .filter((pr) => pr.state === 'OPEN')
          .map((pr) => [pr.id, pr]),
      );
      const ids = [...new Set([...discovery.keys(), ...previous.keys()])];
      let cursor = 0;
      const worker = async () => {
        while (cursor < ids.length && !retryAt) {
          const id = ids[cursor++];
          const cached = previous.get(id);

          try {
            const prSources = discovery.get(id) ?? cached?.sources ?? [];
            const snapshot = await this.github.snapshot(id, account.login, prSources, cached);

            this.store.saveSnapshot(account.login, snapshot);

            const triage = this.store.triage(account.login, id);
            const item = deriveItem(snapshot, triage, account.login, this.status.teams);

            if (triage.snoozedUntil && !item.snoozedUntil) {
              this.store.saveTriage(account.login, id, {
                ...triage,
                snoozedUntil: null,
                snoozedActivityKeys: [],
              });
            }
          } catch (error) {
            this.status.warnings.push(
              `${cached ? `${cached.repository}#${cached.number}` : id}: ${safeError(error)}`,
            );

            if (error instanceof GitHubError && error.retryAt) retryAt = error.retryAt;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));

      if (this.status.warnings.length === 0)
        this.status.lastSuccessfulSync = new Date().toISOString();
      if (retryAt)
        this.status.error =
          'GitHub rate limit reached. Refresh will resume automatically after the cooldown.';
    } catch (error) {
      this.status.error = safeError(error);
      retryAt = error instanceof GitHubError ? error.retryAt : null;
    } finally {
      const now = new Date().toISOString();

      this.status = {
        ...this.status,
        syncing: false,
        lastCompletedAt: now,
        retryAt,
        nextSyncAt: retryAt ?? new Date(Date.now() + 60_000).toISOString(),
      };
      this.store.saveStatus(this.status);
    }
  }

  list(): PullRequestList {
    const account = this.status.account?.login;

    if (!account) return { account: null, items: [] };

    return {
      account,
      items: sortItems(
        this.store
          .snapshots(account)
          .filter((pr) => pr.state === 'OPEN')
          .map((pr) =>
            deriveItem(pr, this.store.triage(account, pr.id), account, this.status.teams),
          ),
      ),
    };
  }

  detail(id: string): PullRequestDetail | null {
    const account = this.status.account?.login;
    const snapshot = account ? this.store.snapshot(account, id) : null;

    if (!account || !snapshot || snapshot.state !== 'OPEN') return null;

    const triage = this.store.triage(account, id);

    return {
      account,
      snapshot,
      triage,
      item: deriveItem(snapshot, triage, account, this.status.teams),
    };
  }

  update(id: string, update: TriageUpdate): PullRequestDetail | null {
    if (update.account !== this.status.account?.login) throw new Error('ACCOUNT_CHANGED');

    const detail = this.detail(id);

    if (!detail) return null;

    const triage = detail.triage;

    if (update.note !== undefined) triage.note = update.note;
    if (update.seenReplyKeys) {
      const valid = new Set(detail.item.unreadReplyKeys);

      triage.seenReplyKeys = [
        ...new Set([
          ...triage.seenReplyKeys,
          ...update.seenReplyKeys.filter((key) => valid.has(key)),
        ]),
      ];
    }

    if (update.snoozeUntil !== undefined) {
      triage.snoozedUntil = update.snoozeUntil;
      triage.snoozedActivityKeys = detail.item.activityKeys;
    }

    this.store.saveTriage(update.account, id, triage);

    return this.detail(id);
  }
}
