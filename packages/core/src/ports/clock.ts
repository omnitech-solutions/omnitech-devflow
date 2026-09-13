/**
 * Time, injected.
 *
 * `monotonicMs` is separate from `now` deliberately: wall-clock time can jump backwards across an
 * NTP correction or a laptop sleeping, and a supervisor that measures elapsed time with it will
 * eventually decide a healthy process has been running for negative seconds. Durations use the
 * monotonic source; timestamps written into the event log use the wall clock.
 */
export interface Clock {
  /** For stamping events. Formatted as ISO-8601 where it is persisted. */
  now(): Date;
  /** For measuring durations. Origin is arbitrary; only differences are meaningful. */
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}
