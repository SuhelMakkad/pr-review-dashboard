/** Review history and the numbers the insights page shows. Pure, so it is easy to test. */

export type ActivityKind =
  | 'request_received'
  | 'request_removed'
  | 'review_submitted'
  | 'comment_posted'
  | 'pr_closed'
  | 'pr_merged'
  | 'authored_opened'
  | 'authored_review_received';

export interface ActivityEvent {
  /** Unique per account; re-extracting the same snapshot yields the same keys. */
  key: string;
  prId: string;
  repository: string;
  number: number;
  kind: ActivityKind;
  actor: string | null;
  at: string;
  data?: Record<string, unknown>;
}

export interface QueueSample {
  at: string;
  attention: number;
  waiting: number;
  authoredBlocked: number;
  oldestAttentionAt: string | null;
}

export interface TurnaroundBucket {
  label: string;
  /** Inclusive lower bound and exclusive upper bound, in hours. */
  fromHours: number;
  toHours: number | null;
  count: number;
  overTarget: boolean;
}

export interface Insights {
  range: { days: number; from: string; to: string };
  slaHours: number;
  turnaround: {
    count: number;
    medianHours: number | null;
    p90Hours: number | null;
    breaches: number;
    buckets: TurnaroundBucket[];
  };
  reviews: {
    total: number;
    granularity: 'day' | 'week';
    series: { start: string; count: number }[];
  };
  verdicts: { approved: number; changesRequested: number; commented: number };
  queue: { day: string; attention: number; waiting: number }[];
  repositories: {
    repository: string;
    reviews: number;
    medianHours: number | null;
    breaches: number;
  }[];
  open: { count: number; oldestAt: string | null };
  authored: { opened: number; medianFirstReviewHours: number | null; merged: number };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);

  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

const BUCKETS: { label: string; fromHours: number; toHours: number | null }[] = [
  { label: '< 1h', fromHours: 0, toHours: 1 },
  { label: '1–4h', fromHours: 1, toHours: 4 },
  { label: '4–8h', fromHours: 4, toHours: 8 },
  { label: '8–24h', fromHours: 8, toHours: 24 },
  { label: '1–2d', fromHours: 24, toHours: 48 },
  { label: '2–5d', fromHours: 48, toHours: 120 },
  { label: '> 5d', fromHours: 120, toHours: null },
];

/**
 * Pairs every review request (including re-requests) with your next review on that PR. A removed
 * request ends without a pair; a request still open at the end counts as an open request.
 */
export function turnarounds(events: ActivityEvent[]): {
  pairs: {
    prId: string;
    repository: string;
    requestedAt: string;
    reviewedAt: string;
    hours: number;
  }[];
  open: { prId: string; requestedAt: string }[];
} {
  const byPr = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    if (
      event.kind === 'request_received' ||
      event.kind === 'request_removed' ||
      event.kind === 'review_submitted' ||
      event.kind === 'pr_merged' ||
      event.kind === 'pr_closed'
    ) {
      byPr.set(event.prId, [...(byPr.get(event.prId) ?? []), event]);
    }
  }

  const pairs: {
    prId: string;
    repository: string;
    requestedAt: string;
    reviewedAt: string;
    hours: number;
  }[] = [];
  const open: { prId: string; requestedAt: string }[] = [];

  for (const [prId, list] of byPr) {
    const ordered = [...list].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    let pending: ActivityEvent | null = null;
    let closed = false;

    for (const event of ordered) {
      if (event.kind === 'request_received' && !pending) pending = event;
      else if (event.kind === 'request_removed') pending = null;
      else if (event.kind === 'review_submitted' && pending) {
        pairs.push({
          prId,
          repository: event.repository,
          requestedAt: pending.at,
          reviewedAt: event.at,
          hours: Math.max(0, (Date.parse(event.at) - Date.parse(pending.at)) / HOUR),
        });
        pending = null;
      } else if (event.kind === 'pr_merged' || event.kind === 'pr_closed') {
        closed = true;
      }
    }

    if (pending && !closed) open.push({ prId, requestedAt: pending.at });
  }

  return { pairs, open };
}

function startOfDay(time: number): number {
  const date = new Date(time);

  date.setHours(0, 0, 0, 0);

  return date.getTime();
}

function startOfWeek(time: number): number {
  const date = new Date(startOfDay(time));
  const offset = (date.getDay() + 6) % 7;

  date.setDate(date.getDate() - offset);

  return date.getTime();
}

export function computeInsights(
  events: ActivityEvent[],
  samples: QueueSample[],
  options: { days: number; slaHours: number; now?: number; repository?: string | null },
): Insights {
  const now = options.now ?? Date.now();
  const from = now - options.days * DAY;
  const inRepo = (event: { repository: string }) =>
    !options.repository || event.repository === options.repository;
  const scoped = events.filter(inRepo);
  const { pairs, open } = turnarounds(scoped);
  const inRange = pairs.filter(
    (pair) => Date.parse(pair.reviewedAt) >= from && Date.parse(pair.reviewedAt) <= now,
  );
  const hours = inRange.map((pair) => pair.hours);
  const reviews = scoped.filter(
    (event) =>
      event.kind === 'review_submitted' &&
      Date.parse(event.at) >= from &&
      Date.parse(event.at) <= now,
  );
  const granularity: 'day' | 'week' = options.days > 31 ? 'week' : 'day';
  const bucketStart = granularity === 'week' ? startOfWeek : startOfDay;
  const series: { start: string; count: number }[] = [];

  for (
    let cursor = bucketStart(from);
    cursor <= now;
    cursor = granularity === 'week' ? cursor + 7 * DAY : startOfDay(cursor + DAY + HOUR)
  ) {
    series.push({
      start: new Date(cursor).toISOString(),
      count: reviews.filter((event) => bucketStart(Date.parse(event.at)) === cursor).length,
    });
  }

  const verdict = (state: string) => reviews.filter((event) => event.data?.state === state).length;
  const repositories = [...new Set(inRange.map((pair) => pair.repository))]
    .map((repository) => {
      const repoHours = inRange
        .filter((pair) => pair.repository === repository)
        .map((pair) => pair.hours);

      return {
        repository,
        reviews: reviews.filter((event) => event.repository === repository).length,
        medianHours: percentile(repoHours, 0.5),
        breaches: repoHours.filter((value) => value > options.slaHours).length,
      };
    })
    .sort((left, right) => right.reviews - left.reviews);

  const days = new Map<string, QueueSample>();

  for (const sample of samples.filter((candidate) => Date.parse(candidate.at) >= from)) {
    // The last sample of each day stands for that day.
    days.set(new Date(startOfDay(Date.parse(sample.at))).toISOString(), sample);
  }

  const authoredIds = new Set(
    scoped.filter((event) => event.kind === 'authored_opened').map((event) => event.prId),
  );
  const openedInRange = scoped.filter(
    (event) => event.kind === 'authored_opened' && Date.parse(event.at) >= from,
  );
  const firstReviewHours = openedInRange
    .map((opened) => {
      const first = scoped
        .filter((event) => event.kind === 'authored_review_received' && event.prId === opened.prId)
        .map((event) => Date.parse(event.at))
        .sort((left, right) => left - right)[0];

      return first === undefined ? null : (first - Date.parse(opened.at)) / HOUR;
    })
    .filter((value): value is number => value !== null);
  const oldestOpen = open.map((entry) => entry.requestedAt).sort()[0] ?? null;

  return {
    range: {
      days: options.days,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
    },
    slaHours: options.slaHours,
    turnaround: {
      count: inRange.length,
      medianHours: percentile(hours, 0.5),
      p90Hours: percentile(hours, 0.9),
      breaches: hours.filter((value) => value > options.slaHours).length,
      buckets: BUCKETS.map((bucket) => ({
        ...bucket,
        count: hours.filter(
          (value) =>
            value >= bucket.fromHours && (bucket.toHours === null || value < bucket.toHours),
        ).length,
        overTarget: bucket.fromHours >= options.slaHours,
      })),
    },
    reviews: { total: reviews.length, granularity, series },
    verdicts: {
      approved: verdict('APPROVED'),
      changesRequested: verdict('CHANGES_REQUESTED'),
      commented: verdict('COMMENTED'),
    },
    queue: [...days].map(([day, sample]) => ({
      day,
      attention: sample.attention,
      waiting: sample.waiting,
    })),
    repositories,
    open: { count: open.length, oldestAt: oldestOpen },
    authored: {
      opened: openedInRange.length,
      medianFirstReviewHours: percentile(firstReviewHours, 0.5),
      merged: scoped.filter(
        (event) =>
          event.kind === 'pr_merged' && authoredIds.has(event.prId) && Date.parse(event.at) >= from,
      ).length,
    },
  };
}
