import { z } from 'zod';

/**
 * What DevFlow asks a model for, never which model answers.
 *
 * A role is a domain concept: the application knows it needs a structured outline, or a step
 * expanded against gathered facts. Which provider and model fulfils that is configuration, and a
 * test greps this package and `core` for provider and model literals to keep it that way.
 *
 * Closed on purpose. An open role set would let a caller invent `outline-v2` and quietly bypass
 * whatever budget and threshold the configuration set for `outline`.
 */
export const modelRoleSchema = z.enum(['outline', 'expansion', 'audit']);
export type ModelRole = z.infer<typeof modelRoleSchema>;
