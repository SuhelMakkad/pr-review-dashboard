import {
  LOOP_P99_MS,
  MIN_ROUTE_SAMPLES,
  MIN_WINDOW_SAMPLES,
  ROUTE_P95_MS,
  stats,
  type Stats,
} from '@/bench/stats.js';

/** `incomplete`: the log dropped records, so a pass cannot be trusted; a failure still stands. */
export type Verdict = 'pass' | 'fail' | 'insufficient samples' | 'incomplete';

export interface LogSummary {
  routes: { route: string; method: string; stats: Stats; verdict: Verdict }[];
  loop: {
    windows: number;
    qualifying: number;
    samples: number;
    /** The worst p99 of a window with enough samples: windows cannot be merged into one p99. */
    worstWindowP99: number | null;
    maxStall: number | null;
    /** Share of qualifying windows whose p99 is past the gate. */
    overGate: number | null;
    verdict: Verdict;
  };
  /** Records the log itself reported dropping (`log.dropped`). */
  dropped: number;
}

/**
 * Summarises a log written at `debug` (every request, every delay window): each route's p50
 * and p95 against the route gate, and the event loop's windows against the loop gate. A route
 * with too few requests, or no window with enough samples, cannot be decided.
 */
export function summariseLog(lines: Iterable<string>): LogSummary {
  const requests = new Map<string, { method: string; route: string; ms: number[] }>();
  const windows: { p99: number; max: number; count: number }[] = [];
  let dropped = 0;

  for (const line of lines) {
    let record: Record<string, unknown>;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.event === 'http.request' && typeof record.ms === 'number') {
      const method = String(record.method);
      const route = String(record.route);
      const key = `${method} ${route}`;
      const entry = requests.get(key) ?? { method, route, ms: [] };

      entry.ms.push(record.ms);
      requests.set(key, entry);
    } else if (record.event === 'loop.delay') {
      windows.push({
        p99: Number(record.p99),
        max: Number(record.max),
        count: Number(record.count),
      });
    } else if (record.event === 'log.dropped' && typeof record.count === 'number') {
      dropped += record.count;
    }
  }

  const decide = (enough: boolean, passes: boolean): Verdict =>
    !enough ? 'insufficient samples' : !passes ? 'fail' : dropped > 0 ? 'incomplete' : 'pass';

  const qualifying = windows.filter((window) => window.count >= MIN_WINDOW_SAMPLES);
  let worst: number | null = null;
  let maxStall: number | null = null;
  let over = 0;
  let samples = 0;

  for (const window of windows) {
    samples += window.count;
    maxStall = Math.max(maxStall ?? 0, window.max);
  }

  for (const window of qualifying) {
    worst = Math.max(worst ?? 0, window.p99);
    if (window.p99 > LOOP_P99_MS) over += 1;
  }

  return {
    routes: [...requests.values()]
      .map(({ method, route, ms }) => {
        const summary = stats(ms);

        return {
          route,
          method,
          stats: summary,
          verdict: decide(summary.n >= MIN_ROUTE_SAMPLES, summary.p95 < ROUTE_P95_MS),
        };
      })
      .sort((a, b) => b.stats.p95 - a.stats.p95),
    loop: {
      windows: windows.length,
      qualifying: qualifying.length,
      samples,
      worstWindowP99: worst,
      maxStall,
      overGate: qualifying.length ? over / qualifying.length : null,
      verdict: decide(worst !== null, worst !== null && worst < LOOP_P99_MS),
    },
    dropped,
  };
}
