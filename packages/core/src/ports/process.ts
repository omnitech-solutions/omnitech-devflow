import type { Clock } from './clock.js';

/**
 * Running a command, supervised.
 *
 * The shape is set by an incident. A copy command inherited an interactive alias, blocked on an
 * "overwrite?" prompt that no terminal was attached to, and sat there for thirty-three minutes
 * while a heartbeat printed sixty-six contented lines beside a process that was never going to
 * finish. Later, the opposite failure: a model that legitimately thinks for six minutes before
 * emitting its first byte was killed twice by a silence cap set at five.
 *
 * Both are the same missing distinction — **slow is not stuck** — so the outcome type refuses to
 * conflate them. A stall is not an exit code. Reporting one as `exit 125` is what let a killed
 * stage read like a failed one.
 */

/** Total silence for this long means the process is not alive in any useful sense. */
export interface Supervision {
  /** No output at all for this long → stop. 0 disables. */
  readonly silenceMs: number;
  /** Total wall clock → stop, however chatty it has been. 0 disables. */
  readonly capMs: number;
}

export interface CommandSpec {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly supervision: Supervision;
}

/**
 * `stalled` carries what was seen before the stop, because "0 bytes in 300s" and "40KB then
 * nothing for 300s" are different diagnoses and the caller cannot tell them apart afterwards.
 */
export type CommandOutcome =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly ms: number;
    }
  | {
      readonly kind: 'stalled';
      readonly reason: 'silence' | 'cap';
      readonly ms: number;
      readonly bytesOut: number;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface ProcessRunner {
  run(spec: CommandSpec, onOutput?: (chunk: string) => void): Promise<CommandOutcome>;
}

/**
 * The supervision decision, extracted so it can be tested without spawning anything.
 *
 * Pure: given how long it has been running and how long since the last byte, should it stop? The
 * real runner does the I/O; this decides. Both stall bugs above were failures of this judgement,
 * not of process handling, and a pure function is the only way to pin them exhaustively.
 */
export function shouldStop(
  elapsedMs: number,
  sinceOutputMs: number,
  s: Supervision,
): 'continue' | 'silence' | 'cap' {
  if (s.capMs > 0 && elapsedMs >= s.capMs) return 'cap';
  if (s.silenceMs > 0 && sinceOutputMs >= s.silenceMs) return 'silence';
  return 'continue';
}

/**
 * A heartbeat line that reports bytes seen, not just elapsed time.
 *
 * "…300s elapsed" is what printed beside the thirty-three-minute hang and it read as progress.
 * "…300s elapsed, 0 bytes out, NOTHING for 300s" is the same line doing its job.
 */
export function heartbeat(elapsedMs: number, bytesOut: number, sinceOutputMs: number): string {
  const s = Math.round(elapsedMs / 1000);
  const quiet = Math.round(sinceOutputMs / 1000);
  const tail = sinceOutputMs >= 30_000 ? `, NOTHING for ${quiet}s` : '';
  return `${s}s elapsed, ${bytesOut} bytes out${tail}`;
}

export type { Clock };
