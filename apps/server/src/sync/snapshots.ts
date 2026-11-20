import { systemClock, type Clock } from '@/clock.js';
import { deriveItem } from '@review-desk/shared/attention';
import type { PullRequestSnapshot, Source } from '@review-desk/shared/types';
import type { Store } from '@/db/store.js';
import type { ViewedRevision } from '@/github/write.js';
import { extractActivity } from '@/insights/extract.js';

/** How often each PR is fetched in full regardless of its fingerprint, with jitter. */
const RECONCILE_MS = 30 * 60_000;
const RECONCILE_JITTER_MS = 5 * 60_000;

/** A read of one PR from the forge, numbered when it started. */
export interface Observation {
  readonly account: string;
  readonly id: string;
  readonly generation: number;
}

export type CommitOutcome =
  /** Saved: `snapshot` is what this read saw, with local state merged in. */
  | { status: 'committed'; snapshot: PullRequestSnapshot }
  /** A read that started later was saved first; `snapshot` is that newer state. */
  | { status: 'superseded'; snapshot: PullRequestSnapshot | null }
  /**
   * The PR was removed or dropped locally after this read started, so nothing was saved and the
   * stored `snapshot` (if any) can be older than this read.
   */
  | { status: 'invalidated'; snapshot: PullRequestSnapshot | null }
  /** A state read found the stored PR already in that state; nothing needed saving. */
  | { status: 'unchanged'; snapshot: PullRequestSnapshot };

export interface CommitOptions {
  /** The change-detection fingerprint the read answers, or null to have the next sync check. */
  fingerprint: string | null;
  /** The sources to store, given the latest stored row (null when the PR is new). */
  sources(latest: PullRequestSnapshot | null): Source[];
  /** Drop the read when the PR is no longer stored: it was removed while being fetched. */
  requireStored?: boolean;
}

interface ViewedMark {
  path: string;
  state: 'VIEWED' | 'UNVIEWED';
  /**
   * The revision the forge marked; a read of another revision keeps the forge's own state. Null
   * for an unmark, which holds for every revision.
   */
  revision: ViewedRevision | null;
  /** Reads that started before this saw the state from before the mark. */
  since: number;
}

/**
 * True when the mark is about the diff `snapshot` shows for `file`. Where the forge identifies the
 * diff of each file, that decides; otherwise the snapshot's head and base must be the revision.
 */
function covers(
  mark: ViewedMark,
  snapshot: PullRequestSnapshot,
  file: PullRequestSnapshot['files'][number],
): boolean {
  if (!mark.revision) return true;
  if (mark.revision.fileKey !== undefined || file.viewedKey !== undefined)
    return mark.revision.fileKey !== undefined && mark.revision.fileKey === file.viewedKey;

  return (
    mark.revision.headOid === snapshot.headOid &&
    mark.revision.baseOid === (snapshot.baseOid ?? null)
  );
}

interface Marks {
  /** The newest full read saved. */
  committed: number;
  /**
   * The newest state saved (open, closed or merged), from a full read or from change detection.
   * State is ordered apart from the rest: a full read that started before a closure was seen still
   * brings its details (a final approval, say), but never its older state.
   */
  state: { generation: number; value: PullRequestSnapshot['state'] } | null;
  /** Reads that started before this may not be saved: the PR was removed or reduced since. */
  floor: number;
  /** Viewed marks newer than some read still in flight. */
  viewed: ViewedMark[];
}

/**
 * The only writer of cached PR snapshots. Forge reads finish in any order, so each read takes a
 * generation when it starts and is saved only if no read that started later has been saved and the
 * PR was not removed after it started; head equality or `updatedAt` cannot order reads of the same
 * head, such as CI updates. Local state the forge read does not know about (sources and manual
 * membership, viewed marks written meanwhile, when a head was first seen) is merged onto the latest
 * stored row, and the snapshot, its sync bookkeeping, activity history and triage wake-ups are saved
 * in one transaction.
 *
 * Generations live in memory: reads never outlive the process, and one process owns the data. They
 * change only once the transaction that saved the read commits, so a rolled-back save can neither
 * refuse a read in flight nor be taken for a newer one.
 */
export class SnapshotCoordinator {
  private sequence = 0;
  private readonly marks = new Map<string, Marks>();

  constructor(
    private readonly store: Store,
    /** The teams of an account, for its activity and triage. */
    private readonly teams: (account: string) => string[],
    private readonly clock: Clock = systemClock,
  ) {}

  /** Starts a read of a PR. Take it before reading the cached PR or asking the forge. */
  observe(account: string, id: string): Observation {
    return { account, id, generation: ++this.sequence };
  }

  private marksOf(account: string, id: string): Marks {
    const key = `${account}\u0000${id}`;
    let marks = this.marks.get(key);

    if (!marks) {
      marks = { committed: 0, state: null, floor: 0, viewed: [] };
      this.marks.set(key, marks);
    }

    return marks;
  }

  /** Why a read may not be saved, or null when it may. Removal wins: the stored row may be older. */
  private refusal(observation: Observation, marks: Marks): 'invalidated' | 'superseded' | null {
    if (marks.floor > observation.generation) return 'invalidated';
    if (marks.committed > observation.generation) return 'superseded';

    return null;
  }

  /** Saves a full read of a PR, unless a newer read was saved or the PR was removed meanwhile. */
  commit(
    observation: Observation,
    fetched: PullRequestSnapshot,
    options: CommitOptions,
  ): CommitOutcome {
    const { account, id } = observation;

    return this.store.transaction(() => {
      const marks = this.marksOf(account, id);
      const latest = this.store.snapshot(account, id);
      const refusal = this.refusal(observation, marks);

      if (refusal) return { status: refusal, snapshot: latest };
      if (options.requireStored && !latest) return { status: 'invalidated', snapshot: null };

      const snapshot = this.merge(observation, marks, latest, {
        ...fetched,
        sources: options.sources(latest),
      });

      this.save(account, snapshot, options.fingerprint);
      this.saved(marks, observation, snapshot.state);

      return { status: 'committed', snapshot };
    });
  }

  /**
   * Saves a state seen by change detection (closed or merged) onto the latest stored row, unless a
   * read that started later saw the PR since. Recorded even when nothing is stored or the stored
   * row already has that state: a full read that started earlier, such as a first add still in
   * flight, then saves its details with this state rather than the one it saw.
   */
  commitState(observation: Observation, state: PullRequestSnapshot['state']): CommitOutcome {
    const { account, id } = observation;

    return this.store.transaction(() => {
      const marks = this.marksOf(account, id);
      const latest = this.store.snapshot(account, id);
      const refusal = this.refusal(observation, marks);

      if (refusal) return { status: refusal, snapshot: latest };
      if ((marks.state?.generation ?? 0) > observation.generation)
        return { status: 'superseded', snapshot: latest };

      this.savedState(marks, observation, state);

      if (!latest) return { status: 'invalidated', snapshot: null };
      if (latest.state === state) return { status: 'unchanged', snapshot: latest };

      const snapshot = { ...latest, state };

      this.store.saveSnapshot(account, snapshot);
      this.store.recordActivity(account, extractActivity(snapshot, account, this.teams(account)));

      return { status: 'committed', snapshot };
    });
  }

  /** Changes local state on the latest stored row, such as its sources; null when not stored. */
  update(
    account: string,
    id: string,
    change: (latest: PullRequestSnapshot) => PullRequestSnapshot,
  ): PullRequestSnapshot | null {
    return this.store.transaction(() => {
      const latest = this.store.snapshot(account, id);

      if (!latest) return null;

      const next = change(latest);

      this.store.saveSnapshot(account, next);

      return next;
    });
  }

  /**
   * Records a viewed mark the forge (or Review Desk, for GitLab) now holds, for the revision it
   * says it marked: on the stored row and on reads that started before the mark, where they show
   * that revision. Where they show another revision, or the forge could not say which one it
   * marked, the forge's own state stands until the next read. Returns the stored row when it
   * changed.
   */
  markViewed(
    account: string,
    id: string,
    path: string,
    viewed: boolean,
    revision: ViewedRevision | null,
  ): PullRequestSnapshot | null {
    // A mark the forge cannot place could be for a diff nobody has seen here.
    if (viewed && !revision) return null;

    const mark: ViewedMark = {
      path,
      state: viewed ? 'VIEWED' : 'UNVIEWED',
      revision: viewed ? revision : null,
      since: ++this.sequence,
    };
    const marks = this.marksOf(account, id);

    return this.store.transaction(() => {
      const latest = this.store.snapshot(account, id);

      this.store.afterCommit(() => marks.viewed.push(mark));

      const file = latest?.files.find((candidate) => candidate.path === path);

      if (!latest || !file || !covers(mark, latest, file)) return null;

      const next = {
        ...latest,
        files: latest.files.map((candidate) =>
          candidate === file ? { ...candidate, viewerViewedState: mark.state } : candidate,
        ),
      };

      this.store.saveSnapshot(account, next);

      return next;
    });
  }

  /**
   * Refuses every read of the PR that started before now. Call it in the transaction that removes
   * the PR or reduces its sources, so an earlier read cannot bring the old state back.
   */
  invalidate(account: string, id: string): void {
    const marks = this.marksOf(account, id);
    const floor = ++this.sequence;

    this.store.afterCommit(() => (marks.floor = Math.max(marks.floor, floor)));
  }

  /** Once the save commits: newer than any read started before it, and older marks are in it. */
  private saved(marks: Marks, observation: Observation, state: PullRequestSnapshot['state']): void {
    const { generation } = observation;

    this.store.afterCommit(() => {
      marks.committed = Math.max(marks.committed, generation);
      marks.viewed = marks.viewed.filter((mark) => mark.since > generation);
    });
    this.savedState(marks, observation, state);
  }

  /** Once the save commits: the PR's state as of this read, unless a newer one is known. */
  private savedState(
    marks: Marks,
    observation: Observation,
    value: PullRequestSnapshot['state'],
  ): void {
    const { generation } = observation;

    this.store.afterCommit(() => {
      if ((marks.state?.generation ?? 0) < generation) marks.state = { generation, value };
    });
  }

  private merge(
    observation: Observation,
    marks: Marks,
    latest: PullRequestSnapshot | null,
    snapshot: PullRequestSnapshot,
  ): PullRequestSnapshot {
    // The first time this head was seen stays as stored; the read may have been given an older row.
    const headObservedAt =
      latest?.headOid === snapshot.headOid ? latest.headObservedAt : snapshot.headObservedAt;
    // Viewed marks written after this read started are newer than what it saw, where they are
    // about the diff it shows.
    const viewed = marks.viewed.filter((mark) => mark.since > observation.generation);
    const files =
      viewed.length === 0
        ? snapshot.files
        : snapshot.files.map((file) => {
            const mark = viewed.findLast(
              (candidate) => candidate.path === file.path && covers(candidate, snapshot, file),
            );

            return mark ? { ...file, viewerViewedState: mark.state } : file;
          });

    // A state seen after this read started (a closure found by change detection) is newer.
    const state =
      marks.state && marks.state.generation > observation.generation
        ? marks.state.value
        : snapshot.state;

    return { ...snapshot, state, headObservedAt, files };
  }

  /** The snapshot with its sync bookkeeping, activity history and triage wake-ups. */
  private save(account: string, snapshot: PullRequestSnapshot, fingerprint: string | null): void {
    const now = this.clock.now();
    const jitter = Math.floor(Math.random() * RECONCILE_JITTER_MS);
    const teams = this.teams(account);

    this.store.saveSnapshot(account, snapshot);
    this.store.saveSyncState(account, snapshot.id, {
      fingerprint,
      lastFullAt: new Date(now).toISOString(),
      nextFullAt: new Date(now + RECONCILE_MS + jitter).toISOString(),
    });
    this.store.recordActivity(account, extractActivity(snapshot, account, teams));

    const triage = this.store.triage(account, snapshot.id);
    const item = deriveItem(snapshot, triage, account, teams, now);
    const wokeFromSnooze = Boolean(triage.snoozedUntil && !item.snoozedUntil);
    const wokeFromDone = Boolean(triage.doneAt && !item.doneAt && !item.snoozedUntil);

    // New activity permanently ends a snooze or a "done" mark, even if it is later reviewed.
    if (wokeFromSnooze || wokeFromDone) {
      this.store.saveTriage(account, snapshot.id, {
        ...triage,
        ...(wokeFromSnooze ? { snoozedUntil: null, snoozedActivityKeys: [] } : {}),
        ...(wokeFromDone ? { doneAt: null, doneActivityKeys: [] } : {}),
      });
    }
  }
}
