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
 * A route's verdict against its gate. `missing` records were dropped, and any of them could have
 * been this route's: a pass stands only if that many slow requests could not sink it, and a
 * failure only if that many fast ones could not lift it.
 */
function routeVerdict(ms: number[], missing: number): Verdict {
  if (ms.length < MIN_ROUTE_SAMPLES) return 'insufficient samples';

  // The nearest-rank p95 is under the gate when that many requests are.
  const needed = (count: number) => Math.ceil(0.95 * count);
  const fast = ms.filter((value) => value < ROUTE_P95_MS).length;

  if (fast >= needed(ms.length)) return fast >= needed(ms.length + missing) ? 'pass' : 'incomplete';

  return fast + missing >= needed(ms.length + missing) ? 'incomplete' : 'fail';
}

/**
 * Summarises a log written at `debug` (every request, every delay window), one line at a time:
 * each route's p50 and p95 against the route gate, and the event loop's windows against the loop
 * gate. A route with too few requests, or no window with enough samples, cannot be decided.
 */
export class LogSummariser {
  private readonly requests = new Map<string, { method: string; route: string; ms: number[] }>();
  private readonly windows: { p99: number; max: number; count: number }[] = [];
  private dropped = 0;

  add(line: string): void {
    let record: Record<string, unknown>;

    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    if (record.event === 'http.request' && typeof record.ms === 'number') {
      const method = String(record.method);
      const route = String(record.route);
      const key = `${method} ${route}`;
      const entry = this.requests.get(key) ?? { method, route, ms: [] };

      entry.ms.push(record.ms);
      this.requests.set(key, entry);
    } else if (record.event === 'loop.delay') {
      this.windows.push({
        p99: Number(record.p99),
        max: Number(record.max),
        count: Number(record.count),
      });
    } else if (record.event === 'log.dropped' && typeof record.count === 'number') {
      this.dropped += record.count;
    }
  }

  summary(): LogSummary {
    const { windows, dropped } = this;
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
      if (window.p99 >= LOOP_P99_MS) over += 1;
    }

    // A window past the gate is a failure whatever was dropped; a pass could hide a worse one.
    const loopVerdict: Verdict =
      worst === null
        ? 'insufficient samples'
        : worst >= LOOP_P99_MS
          ? 'fail'
          : dropped > 0
            ? 'incomplete'
            : 'pass';

    return {
      routes: [...this.requests.values()]
        .map(({ method, route, ms }) => ({
          route,
          method,
          stats: stats(ms),
          verdict: routeVerdict(ms, dropped),
        }))
        .sort((a, b) => b.stats.p95 - a.stats.p95),
      loop: {
        windows: windows.length,
        qualifying: qualifying.length,
        samples,
        worstWindowP99: worst,
        maxStall,
        overGate: qualifying.length ? over / qualifying.length : null,
        verdict: loopVerdict,
      },
      dropped,
    };
  }
}

export function summariseLog(lines: Iterable<string>): LogSummary {
  const summariser = new LogSummariser();

  for (const line of lines) summariser.add(line);

  return summariser.summary();
}
