import { z } from 'zod';
import { evidenceReportSchema } from './evidence.js';
import { candidateDigestSchema, planIdSchema, runIdSchema, taskIdSchema } from './ids.js';

/**
 * The append-only run log. This is the only thing DevFlow writes about what happened.
 *
 * Nothing here is ever rewritten. Current state is a fold over these events, computed on read and
 * stored nowhere — so there is no second copy to disagree with the first.
 *
 * The incident that settled the design: a full-scope gate record was written, then a later,
 * narrower run overwrote the same file, and a verifier rejected the work for a scope it could no
 * longer see. The evidence still existed in the world; it had been UPSERTed out of the record.
 * Append-only makes that a non-event — both runs are there, and the reader picks by
 * `candidateDigest` rather than by which was written last.
 *
 * Duplication is therefore expected and correct. Re-running a step appends a second attempt; it
 * does not replace the first.
 */

export const gateScopeSchema = z.enum(['selected', 'full']);
export type GateScope = z.infer<typeof gateScopeSchema>;

/** Why a step stopped. Closed, for the same reason `EvidenceFailure` is closed. */
export const stopReasonSchema = z.enum([
  'needs-operator',
  'evidence-failed',
  'budget-exceeded',
  'gate-failed',
  'no-progress',
  'cancelled',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

/** Money as minor units, never a float. Fractions of a cent are how budgets drift. */
export const moneySchema = z.strictObject({
  microUsd: z.number().int().nonnegative(),
});
export type Money = z.infer<typeof moneySchema>;

const base = {
  /** Monotonic within a run. The fold's ordering key — never a timestamp, which can tie or skew. */
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  runId: runIdSchema,
};

export const runEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('run.started'),
    taskId: taskIdSchema,
    mode: z.enum(['discover', 'plan', 'run', 'verify']),
  }),
  z.strictObject({ ...base, kind: z.literal('context.gathered'), probes: z.number().int().nonnegative() }),
  z.strictObject({
    ...base,
    kind: z.literal('plan.created'),
    planId: planIdSchema,
    steps: z.number().int().positive(),
  }),
  z.strictObject({ ...base, kind: z.literal('step.started'), step: z.number().int().positive() }),
  z.strictObject({
    ...base,
    kind: z.literal('evidence.checked'),
    step: z.number().int().positive(),
    report: evidenceReportSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('gates.recorded'),
    scope: gateScopeSchema,
    candidateDigest: candidateDigestSchema,
    passed: z.boolean(),
  }),
  z.strictObject({ ...base, kind: z.literal('step.passed'), step: z.number().int().positive() }),
  z.strictObject({
    ...base,
    kind: z.literal('step.stopped'),
    step: z.number().int().positive(),
    reason: stopReasonSchema,
    detail: z.string(),
  }),
  z.strictObject({ ...base, kind: z.literal('cost.recorded'), role: z.string().min(1), spent: moneySchema }),
  z.strictObject({ ...base, kind: z.literal('run.finished'), outcome: z.enum(['completed', 'stopped']) }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventKind = RunEvent['kind'];
