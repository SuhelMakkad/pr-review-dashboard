import { MIN_WINDOW_SAMPLES } from '@/http/loop.js';
import { LOOP_P99_MS, ROUTE_P95_MS, stats, type Stats } from '@/bench/run.js';

export interface LogSummary {
  routes: { route: string; method: string; stats: Stats; verdict: 'pass' | 'fail' }[];
  loop: {
    windows: number;
    qualifying: number;
    samples: number;
    /** The worst p99 of a window with enough samples: windows cannot be merged into one p99. */
    worstWindowP99: number | null;
    maxStall: number | null;
    /** Share of qualifying windows whose p99 is past the gate. */
    overGate: number | null;
    verdict: 'pass' | 'fail' | 'insufficient samples';
  };
}

/**
 * Summarises a log written at `debug` (every request, every delay window): each route's p50
 * and p95 against the route gate, and the event loop's windows against the loop gate.
 */
export function summariseLog(lines: string[]): LogSummary {
  const requests = new Map<string, number[]>();
  const windows: { p99: number; max: number; count: number }[] = [];

  for (const line of lines) {
    let record: Record<string, unknown>;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.event === 'http.request' && typeof record.ms === 'number') {
      const key = `${String(record.method)} ${String(record.route)}`;

      requests.set(key, [...(requests.get(key) ?? []), record.ms]);
    } else if (record.event === 'loop.delay') {
      windows.push({
        p99: Number(record.p99),
        max: Number(record.max),
        count: Number(record.count),
      });
    }
  }

  const qualifying = windows.filter((window) => window.count >= MIN_WINDOW_SAMPLES);
  const worst = qualifying.length ? Math.max(...qualifying.map((window) => window.p99)) : null;

  return {
    routes: [...requests.entries()]
      .map(([key, values]) => {
        const [method, route] = key.split(' ');
        const summary = stats(values);

        return {
          route,
          method,
          stats: summary,
          verdict: summary.p95 < ROUTE_P95_MS ? ('pass' as const) : ('fail' as const),
        };
      })
      .sort((a, b) => b.stats.p95 - a.stats.p95),
    loop: {
      windows: windows.length,
      qualifying: qualifying.length,
      samples: windows.reduce((sum, window) => sum + window.count, 0),
      worstWindowP99: worst,
      maxStall: windows.length ? Math.max(...windows.map((window) => window.max)) : null,
      overGate: qualifying.length
        ? qualifying.filter((window) => window.p99 > LOOP_P99_MS).length / qualifying.length
        : null,
      verdict: worst === null ? 'insufficient samples' : worst < LOOP_P99_MS ? 'pass' : 'fail',
    },
  };
}
