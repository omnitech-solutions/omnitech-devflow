import type { Clock } from '@omnitech/devflow-core';

/**
 * Real time.
 *
 * `monotonicMs` uses `performance.now()`, never `Date.now()`. Wall-clock time jumps backwards
 * across an NTP correction or a laptop waking, and a supervisor measuring elapsed time with it
 * eventually decides a healthy process has been running for negative seconds.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return performance.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
