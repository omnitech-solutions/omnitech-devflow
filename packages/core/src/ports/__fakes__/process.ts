import type { Clock } from '../clock.js';
import type { CommandOutcome, CommandSpec, ProcessRunner } from '../process.js';
import { shouldStop } from '../process.js';

/** One scripted command: what it emits, when, and how it ends if left alone. */
export interface ScriptedProcess {
  /** `[afterMs, text]` — output arriving this long after the previous chunk. */
  readonly chunks: ReadonlyArray<readonly [number, string]>;
  /** How long after the last chunk it would exit, if the supervisor lets it. */
  readonly finishAfterMs: number;
  readonly code: number;
  readonly stderr?: string;
}

/**
 * A process runner driven by a fake clock.
 *
 * This exists to make the stall supervisor testable at all. The real failures it guards — a
 * thirty-three-minute hang on an invisible prompt, and a model killed at five minutes for thinking
 * for six — take thirty-three minutes and six minutes to reproduce against a real process. Here
 * they take no time, because the clock is a number the test controls.
 */
export class FakeProcessRunner implements ProcessRunner {
  constructor(
    private readonly clock: Clock & { advance(ms: number): void },
    private readonly script: ScriptedProcess,
  ) {}

  async run(spec: CommandSpec, onOutput?: (chunk: string) => void): Promise<CommandOutcome> {
    const started = this.clock.monotonicMs();
    let lastOutput = started;
    let stdout = '';
    let bytesOut = 0;

    const stopNow = (): CommandOutcome | null => {
      const elapsed = this.clock.monotonicMs() - started;
      const quiet = this.clock.monotonicMs() - lastOutput;
      const verdict = shouldStop(elapsed, quiet, spec.supervision);
      if (verdict === 'continue') return null;
      return {
        kind: 'stalled',
        reason: verdict,
        ms: elapsed,
        bytesOut,
        stdout,
        stderr: this.script.stderr ?? '',
      };
    };

    for (const [afterMs, text] of this.script.chunks) {
      // Step to the moment the chunk would arrive, checking the supervisor on the way — a
      // supervisor only consulted at chunk boundaries can never catch total silence.
      const stopped = this.advanceWatching(afterMs, stopNow);
      if (stopped) return stopped;
      stdout += text;
      bytesOut += text.length;
      lastOutput = this.clock.monotonicMs();
      onOutput?.(text);
    }

    const stopped = this.advanceWatching(this.script.finishAfterMs, stopNow);
    if (stopped) return stopped;

    return {
      kind: 'exited',
      code: this.script.code,
      stdout,
      stderr: this.script.stderr ?? '',
      ms: this.clock.monotonicMs() - started,
    };
  }

  /** Advance in slices so the supervisor is consulted during a quiet stretch, not only after it. */
  private advanceWatching(ms: number, check: () => CommandOutcome | null): CommandOutcome | null {
    const slice = 1_000;
    for (let moved = 0; moved < ms; moved += slice) {
      this.clock.advance(Math.min(slice, ms - moved));
      const stopped = check();
      if (stopped) return stopped;
    }
    return check();
  }
}
