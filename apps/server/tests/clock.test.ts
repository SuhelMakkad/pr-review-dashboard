import { describe, expect, it, vi } from 'vitest';
import { isoNow, systemClock, TestClock } from '@/clock.js';

describe('the clock', () => {
  it('moves a test clock by hand without touching the process clock', () => {
    const before = Date.now();
    const clock = new TestClock(Date.parse('2030-01-01T00:00:00Z'));

    expect(Math.abs(clock.now() - Date.parse('2030-01-01T00:00:00Z'))).toBeLessThan(1_000);

    clock.advance(3_600_000);

    expect(isoNow(clock).startsWith('2030-01-01T01:00')).toBe(true);
    // The process's own time went on as before.
    expect(Date.now() - before).toBeGreaterThanOrEqual(0);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
  });

  it('runs a timer once, or every interval until cancelled', async () => {
    let once = 0;
    let repeated = 0;

    systemClock.after(5, () => (once += 1));

    const cancelled = systemClock.after(5, () => (once += 100));
    const stop = systemClock.every(5, () => (repeated += 1));

    cancelled();
    // However late the loop runs them: the interval fires again and again until it is stopped.
    await vi.waitFor(() => expect(repeated).toBeGreaterThanOrEqual(2));
    stop();

    const stopped = repeated;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(once).toBe(1);
    expect(repeated).toBe(stopped);
  });
});
