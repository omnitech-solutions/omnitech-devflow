import { z } from 'zod';
import { evidenceReportSchema } from './evidence.js';
import { planIdSchema, stepIdSchema, taskIdSchema } from './ids.js';

/**
 * A plan, and the steps in it.
 *
 * The field set is MJ's, verbatim, because it is the part of his approach that does the work. His
 * execution books run ~6,300 characters per row against ~1,100 for the books that preceded this
 * tool, and the difference is entirely research already done: the file, the line, the constraint's
 * name, the command that finds it again. A step that makes its executor go looking has failed
 * before it starts.
 *
 * `estimatedDecisions` is the field that looks like bookkeeping and is not. A step claiming zero
 * decisions is claiming they were all made upstream; a step claiming two must name both. It is the
 * cheapest available check on whether a plan actually decided anything.
 */

export const executorSchema = z.enum(['operator', 'agent']);
export type Executor = z.infer<typeof executorSchema>;

/**
 * A decision the step cannot make on evidence alone.
 *
 * Named rather than counted. "2 decisions" tells a reader a number; "whether subdomains are in
 * scope; the config key names" tells them what they are about to be asked.
 */
export const decisionSchema = z.strictObject({
  question: z.string().min(1),
  /** Filled once answered, so a re-plan does not ask again. */
  answer: z.string().optional(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const stepSchema = z.strictObject({
  id: stepIdSchema,
  /** 1-indexed position as a human refers to it: "step 3". */
  n: z.number().int().positive(),
  title: z.string().min(1),
  /** Step numbers this one cannot start before. Empty means independent. */
  dependsOn: z.array(z.number().int().positive()),
  /** Files this step may touch. Anything outside is scope drift and is reported as such. */
  landsIn: z.array(z.string().min(1)),
  estimatedDecisions: z.array(decisionSchema),
  /**
   * The tempting wrong move, stated so that making it is disobedience rather than a guess.
   * Tonight's worked example: "editing the guardian to make it pass".
   */
  prohibited: z.array(z.string().min(1)),
  executor: executorSchema,
  /** The instruction itself, carrying the citations the evidence report adjudicates. */
  prompt: z.string().min(1),
  /** Observable and falsifiable: true after, false before, and the command that shows it. */
  acceptanceCriteria: z.array(z.string().min(1)),
  evidence: evidenceReportSchema,
});
export type Step = z.infer<typeof stepSchema>;

/**
 * Context notes that precede the steps — MJ's books open with six to nine of them, and every step
 * is written against them so no step has to restate the shared ground.
 */
export const noteSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

export const planSchema = z.strictObject({
  id: planIdSchema,
  taskId: taskIdSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-kebab: it becomes a filename'),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  notes: z.array(noteSchema),
  steps: z.array(stepSchema),
});
export type Plan = z.infer<typeof planSchema>;
