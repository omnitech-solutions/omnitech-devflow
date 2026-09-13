import { z } from 'zod';
import { moneySchema, stopReasonSchema } from './events.js';
import { runIdSchema } from './ids.js';
import { planSchema } from './plan.js';

/**
 * What a DevFlow call returns. One union, every caller switches on `kind`.
 *
 * Separate bespoke entrypoints per outcome would push the branching into every consumer and let
 * the CLI grow orchestration. A single union keeps the CLI a renderer.
 *
 * `needs-operator` carries a resume token. That token is the one place the workflow engine shows
 * through the domain, deliberately: resuming a suspended run needs its handle, and hiding that
 * behind a lookup would buy nothing but indirection.
 */
export const blockerSchema = z.strictObject({
  step: z.number().int().positive(),
  /** One specific question, short enough to answer without a meeting. */
  question: z.string().min(1),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const devflowResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan-ready'), runId: runIdSchema, plan: planSchema }),
  z.strictObject({
    kind: z.literal('run-completed'),
    runId: runIdSchema,
    stepsDone: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('needs-operator'),
    runId: runIdSchema,
    blockers: z.array(blockerSchema).min(1),
    resumeToken: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('verification-failed'),
    runId: runIdSchema,
    failures: z.array(z.string()).min(1),
  }),
  z.strictObject({
    kind: z.literal('budget-exceeded'),
    runId: runIdSchema,
    spent: moneySchema,
    cap: moneySchema,
  }),
  z.strictObject({
    kind: z.literal('run-failed'),
    runId: runIdSchema,
    reason: stopReasonSchema,
    detail: z.string(),
  }),
]);
export type DevFlowResult = z.infer<typeof devflowResultSchema>;
export type DevFlowResultKind = DevFlowResult['kind'];
