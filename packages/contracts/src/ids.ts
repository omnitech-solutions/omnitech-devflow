import { z } from 'zod';

/**
 * Identifiers, branded so one kind cannot be passed where another is expected.
 *
 * A `RunId` and a `TaskId` are both strings at runtime, and tonight's ancestor of this tool spent
 * a cycle on exactly that confusion: a campaign row id (`R-01`) and a book row number (`3`) were
 * both passed around as bare values, and the bug — a book numbering from 1 while another book had
 * already taken `R-01` — was invisible until three books collided. Branding does not prevent that
 * class of mistake at runtime, but it turns the ones that survive a refactor into compile errors.
 */

// The brand is a type-level tag: `B` is never read at runtime, which is the whole point — the
// distinction exists for the compiler and costs nothing when the program runs.
const brand = <B extends string>() => z.string().min(1).brand<B>();

/** A unit of work a human asked for. From a ticket key when there is one, else derived. */
export const taskIdSchema = brand<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;

/** One attempt at a task. A task re-run produces a new RunId; the old one is never reused. */
export const runIdSchema = brand<'RunId'>();
export type RunId = z.infer<typeof runIdSchema>;

/** A plan. Re-planning a task produces a new PlanId. */
export const planIdSchema = brand<'PlanId'>();
export type PlanId = z.infer<typeof planIdSchema>;

/** Stable across re-emissions of the same plan, so progress survives a re-plan. */
export const stepIdSchema = brand<'StepId'>();
export type StepId = z.infer<typeof stepIdSchema>;

/**
 * Content hash of the thing under test. Two gate records for the same run are told apart by this,
 * never by which was written last — the lesson of a full-scope gate record being silently replaced
 * by a narrower one, and a verifier then rejecting work for a scope it could no longer see.
 */
export const candidateDigestSchema = brand<'CandidateDigest'>();
export type CandidateDigest = z.infer<typeof candidateDigestSchema>;
