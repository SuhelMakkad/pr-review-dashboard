import type { Reviewer, PullRequestSnapshot, ReviewState } from '@review-desk/shared/types';
import type { Store } from '@/db/store.js';

/** Small seeded PRNG so the demo history is identical on every run. */
function random(seed: number) {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;

    let value = Math.imul(state ^ (state >>> 15), 1 | state);

    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const repos = ['acme/api', 'acme/web', 'acme/infra'];
const people = ['alex', 'mara', 'jonas', 'priya'];
const iso = (time: number) => new Date(time).toISOString();

function base(
  id: string,
  number: number,
  repository: string,
  author: string,
  createdAt: number,
  updatedAt: number,
): PullRequestSnapshot {
  return {
    id,
    number,
    title: `Historical change ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    body: '',
    repository,
    author: { login: author },
    isDraft: false,
    state: 'MERGED',
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
    headOid: `h${number}`,
    headCommittedAt: iso(createdAt),
    headObservedAt: iso(createdAt),
    baseRefName: 'main',
    headRefName: `feat/${number}`,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: null,
    mergeable: 'UNKNOWN',
    sources: [],
    reviewRequests: [],
    requestEvents: [],
    reviews: [],
    threads: [],
    files: [],
    checks: [],
    ci: 'none',
    fetchedAt: iso(updatedAt),
    baseOid: null,
    mergeStateStatus: null,
    conversation: [],
    forcePushes: [],
    verdicts: [],
    pendingReview: null,
  };
}

/**
 * Ninety days of fictional review history: mostly quick reviews with a long tail, some
 * re-requests after requested changes, and a few of your own PRs with their first reviews.
 */
export function demoHistory(anchor: number, viewer: string): PullRequestSnapshot[] {
  const next = random(20261105);
  const pulls: PullRequestSnapshot[] = [];
  const delays = [0.4, 0.8, 1.2, 2, 2.5, 3, 4, 5, 6, 7, 9, 14, 20, 30, 40, 55, 75, 130];
  const me: Reviewer = { kind: 'user', login: viewer, name: viewer };

  for (let index = 0; index < 72; index++) {
    const repository = repos[Math.floor(next() * repos.length)];
    const author = people[Math.floor(next() * people.length)];
    const created = anchor - (2 + next() * 86) * 24 * HOUR;
    const requested = created + 0.5 * HOUR;
    const delay = delays[Math.floor(next() * delays.length)] * HOUR;
    const roll = next();
    const state: ReviewState =
      roll < 0.6 ? 'APPROVED' : roll < 0.85 ? 'CHANGES_REQUESTED' : 'COMMENTED';
    const number = 1200 + index;
    const pull = base(
      `HIST_${number}`,
      number,
      repository,
      author,
      created,
      requested + delay + 6 * HOUR,
    );

    pull.requestEvents.push({
      id: `hreq-${number}`,
      createdAt: iso(requested),
      removed: false,
      reviewer: me,
    });
    pull.reviews.push({
      id: `hrev-${number}`,
      state,
      submittedAt: iso(requested + delay),
      updatedAt: iso(requested + delay),
      commitOid: pull.headOid,
      body: '',
      url: pull.url,
    });

    if (state === 'CHANGES_REQUESTED') {
      const again = requested + delay + 20 * HOUR;
      const second = again + delays[Math.floor(next() * 8)] * HOUR;

      pull.requestEvents.push({
        id: `hreq2-${number}`,
        createdAt: iso(again),
        removed: false,
        reviewer: me,
      });
      pull.reviews.push({
        id: `hrev2-${number}`,
        state: 'APPROVED',
        submittedAt: iso(second),
        updatedAt: iso(second),
        commitOid: `h${number}b`,
        body: '',
        url: pull.url,
      });
      pull.updatedAt = iso(second + 4 * HOUR);
    }

    if (Date.parse(pull.updatedAt) > anchor) pull.updatedAt = iso(anchor - HOUR);

    pulls.push(pull);
  }

  for (let index = 0; index < 14; index++) {
    const repository = repos[Math.floor(next() * repos.length)];
    const created = anchor - (3 + next() * 84) * 24 * HOUR;
    const firstReview = created + delays[Math.floor(next() * delays.length)] * HOUR;
    const number = 1400 + index;
    const pull = base(
      `HIST_${number}`,
      number,
      repository,
      viewer,
      created,
      Math.min(anchor - HOUR, firstReview + 10 * HOUR),
    );

    pull.verdicts.push({
      login: people[index % people.length],
      state: 'APPROVED',
      submittedAt: iso(firstReview),
      commitOid: pull.headOid,
    });
    pulls.push(pull);
  }

  return pulls;
}

/** Daily queue sizes for the demo; real installs record these hourly as they run. */
export function seedDemoQueue(store: Store, login: string, anchor: number): void {
  const next = random(42);

  for (let day = 89; day >= 1; day--) {
    const at = anchor - day * 24 * HOUR;
    const weekday = new Date(at).getDay();
    const busy = weekday === 1 || weekday === 2 ? 3 : 0;

    store.saveQueueSample(login, {
      at: iso(at),
      attention: Math.round(2 + busy + next() * 5),
      waiting: Math.round(next() * 3),
      authoredBlocked: Math.round(next() * 2),
      oldestAttentionAt: null,
    });
  }
}
