import type { DevFlowResult, EvidenceReport, StopReason } from '@omnitech/devflow-contracts';

/**
 * Two vocabularies, one table.
 *
 * The everyday surface says what happened in words a developer who has never read this codebase
 * can act on. `--verbose` adds the internal name beside it, so someone who knows the architecture
 * it borrows from can still recognise it. Neither is a translation of the other at the call site:
 * there is one table, and the internal name is the key.
 */

export const PLAIN: Readonly<Record<string, string>> = {
  'needs-operator': 'waiting for you',
  'evidence-failed': 'evidence check failed',
  'budget-exceeded': 'stopped — budget reached',
  'gate-failed': 'a check failed',
  'no-progress': 'stopped — no progress',
  cancelled: 'cancelled',
};

export const INTERNAL: Readonly<Record<string, string>> = {
  'needs-operator': 'ESCALATE',
  'evidence-failed': 'REFUSE predicate_failed',
  'budget-exceeded': 'TERMINATE budget',
  'gate-failed': 'REFUSE gate_error',
  'no-progress': 'PIVOT exhausted',
  cancelled: 'TERMINATE cancelled',
};

export const say = (reason: StopReason | string, verbose: boolean): string => {
  const plain = PLAIN[reason] ?? reason;
  return verbose && INTERNAL[reason] ? `${plain}  (${INTERNAL[reason]})` : plain;
};

export const tick = (state: 'done' | 'active' | 'todo'): string =>
  state === 'done' ? '✓' : state === 'active' ? '●' : '○';

/** `25/26 claims verified · 1 unresolved` — the line a reader actually needs. */
export function evidenceLine(report: EvidenceReport): string {
  const checked = report.verified + report.struck;
  const total = checked + report.unverifiable;
  const parts = [`${report.verified}/${total} claims verified`];
  if (report.struck) parts.push(`${report.struck} wrong`);
  if (report.unverifiable) parts.push(`${report.unverifiable} unresolved`);
  return parts.join(' · ');
}

/** The one place a result becomes text. Every command returns a result; only this renders it. */
export function renderResult(result: DevFlowResult, verbose: boolean): string {
  switch (result.kind) {
    case 'plan-ready':
      return `plan ready — ${result.plan.steps.length} step(s), ${result.plan.notes.length} notes`;
    case 'run-completed':
      return `done — ${result.stepsDone} step(s)`;
    case 'needs-operator':
      return [
        say('needs-operator', verbose),
        ...result.blockers.map((b) => `  step ${b.step}: ${b.question}`),
      ].join('\n');
    case 'verification-failed':
      return [`verification failed`, ...result.failures.map((f) => `  ${f}`)].join('\n');
    case 'budget-exceeded':
      return `${say('budget-exceeded', verbose)} — spent $${(result.spent.microUsd / 1e6).toFixed(4)} of $${(
        result.cap.microUsd / 1e6
      ).toFixed(2)}`;
    case 'run-failed':
      return `${say(result.reason, verbose)} — ${result.detail}`;
  }
}
