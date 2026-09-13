import type { Clock } from '../clock.js';

/**
 * Time under the test's control.
 *
 * `sleep` advances the clock instead of waiting, so a test for a five-minute silence cap runs in
 * microseconds. A fake that actually slept would make the stall tests too slow to run, which is
 * how those tests stop being run at all.
 */
export class FakeClock implements Clock {
  private ms: number;

  constructor(private readonly origin = new Date('2026-01-01T00:00:00.000Z')) {
    this.ms = 0;
  }

  now(): Date {
    return new Date(this.origin.getTime() + this.ms);
  }

  monotonicMs(): number {
    return this.ms;
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  /** Move time forward without a sleep, for driving a supervisor directly. */
  advance(ms: number): void {
    this.ms += ms;
  }
}
