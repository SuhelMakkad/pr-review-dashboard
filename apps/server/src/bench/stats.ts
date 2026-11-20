/** The plan's gates: a route's p95, and the event loop's worst delay, while the server works. */
export const ROUTE_P95_MS = 100;
export const LOOP_P99_MS = 50;
/** Fewer samples than this cannot decide a route's gate. */
export const MIN_ROUTE_SAMPLES = 30;
/** Windows with fewer samples than this say little about a p99. */
export const MIN_WINDOW_SAMPLES = 100;

export interface Stats {
  n: number;
  median: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentiles of `values`, rounded to a tenth. No application imports. */
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;

  return {
    n: sorted.length,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}
