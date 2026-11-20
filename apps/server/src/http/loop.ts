import { monitorEventLoopDelay } from 'node:perf_hooks';
import { log } from '@/log.js';

/**
 * Samples the event loop's delay and logs each window's p50, p99, maximum and sample count, then
 * starts the next window: a window's p99 is valid on its own, while windows cannot be merged into
 * a session p99. A p99 past 200 ms is a warning. Returns a stop function.
 */
export function watchEventLoop(windowMs = 10_000, resolutionMs = 20): () => void {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  const ms = (nanoseconds: number) => nanoseconds / 1e6;

  histogram.enable();

  const timer = setInterval(() => {
    const p99 = ms(histogram.percentile(99));

    log.event(p99 > 200 ? 'warn' : 'debug', 'loop.delay', {
      p50: ms(histogram.percentile(50)),
      p99,
      max: ms(histogram.max),
      count: histogram.count,
    });
    histogram.reset();
  }, windowMs);

  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
