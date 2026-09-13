import type { EvidenceReport, Money, RunEvent, RunId, StopReason } from '@omnitech/devflow-contracts';

/**
 * Current state, computed from the log. Stored nowhere.
 *
 * This is the whole reason the log is append-only. A previous generation of this tool kept
 * "is step N done?" in three places — a rows file, a ledger, and a browser's localStorage — and
 * when they disagreed nobody could say which was right. The fix is not to synchronise them. It is
 * that there is one log, and everything else is this function.
 *
 * Pure. Same events in, same state out, no I/O, no clock.
 */

export type RunState = 'running' | 'waiting-for-operator' | 'completed' | 'stopped';

export interface StepView {
  readonly n: number;
  readonly state: 'running' | 'passed' | 'stopped';
  /** How many times this step has been attempted. Re-runs append; they do not replace. */
  readonly attempts: number;
  /** From the most recent attempt. Earlier attempts stay in the log. */
  readonly evidence?: EvidenceReport;
  readonly stoppedBecause?: StopReason;
  readonly detail?: string;
}

export interface GateView {
  readonly scope: 'selected' | 'full';
  readonly candidateDigest: string;
  readonly passed: boolean;
}

export interface RunView {
  readonly runId: RunId;
  readonly state: RunState;
  readonly steps: readonly StepView[];
  /**
   * Every gate run, not the last one.
   *
   * A full-scope record was once overwritten by a later narrower run, and a verifier then rejected
   * work for a scope it could no longer see. Both are kept; a reader picks by `candidateDigest`.
   */
  readonly gates: readonly GateView[];
  readonly spent: Money;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** The highest seq folded. A snapshot taken from this view can say what it was taken at. */
  readonly seq: number;
}

const ZERO: Money = { microUsd: 0 };

/**
 * Fold events into the current view.
 *
 * Events are sorted by `seq`, never by timestamp: two events written in the same millisecond tie,
 * and a clock that steps backwards would reorder history.
 */
export function fold(events: readonly RunEvent[], runId: RunId): RunView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const steps = new Map<number, StepView>();
  const gates: GateView[] = [];
  let state: RunState = 'running';
  let spent = ZERO;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let seq = -1;

  const touch = (n: number): StepView => steps.get(n) ?? { n, state: 'running', attempts: 0 };

  for (const e of ordered) {
    seq = e.seq;
    switch (e.kind) {
      case 'run.started':
        startedAt = e.at;
        break;
      case 'step.started': {
        const prior = touch(e.step);
        // A re-run is an attempt, never a replacement. The count is how "we tried this three
        // times" becomes visible instead of being inferred from a log nobody reads.
        steps.set(e.step, { ...prior, state: 'running', attempts: prior.attempts + 1 });
        break;
      }
      case 'evidence.checked':
        steps.set(e.step, { ...touch(e.step), evidence: e.report });
        break;
      case 'step.passed':
        steps.set(e.step, { ...touch(e.step), state: 'passed' });
        break;
      case 'step.stopped':
        steps.set(e.step, {
          ...touch(e.step),
          state: 'stopped',
          stoppedBecause: e.reason,
          detail: e.detail,
        });
        if (e.reason === 'needs-operator') state = 'waiting-for-operator';
        break;
      case 'gates.recorded':
        gates.push({ scope: e.scope, candidateDigest: e.candidateDigest, passed: e.passed });
        break;
      case 'cost.recorded':
        spent = { microUsd: spent.microUsd + e.spent.microUsd };
        break;
      case 'run.finished':
        finishedAt = e.at;
        state = e.outcome === 'completed' ? 'completed' : 'stopped';
        break;
      case 'context.gathered':
      case 'plan.created':
        break;
    }
  }

  return {
    runId,
    state,
    steps: [...steps.values()].sort((a, b) => a.n - b.n),
    gates,
    spent,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    seq,
  };
}

/**
 * The gate record a verifier should judge by.
 *
 * By digest, never by recency. "Whichever was written last" is exactly the rule that discarded a
 * full-scope pass and failed a cycle over it.
 */
export function gateFor(view: RunView, candidateDigest: string): GateView | undefined {
  const matching = view.gates.filter((g) => g.candidateDigest === candidateDigest);
  // Among records for the same candidate, a full-scope run is the stronger claim.
  return matching.find((g) => g.scope === 'full') ?? matching[0];
}
