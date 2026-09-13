import { z } from 'zod';
import { modelRoleSchema } from './roles.js';

/**
 * Configuration, split by domain rather than heaped into one object.
 *
 * Each section is a schema with its own defaults, so a caller can construct one section in a test
 * without satisfying the other six, and a bad value fails at load with a path that names it.
 *
 * Nothing here mentions a provider, a model, a company, a person or a ticket prefix. Two tests
 * enforce that by grepping the package: one for model and provider literals, one for organisation
 * names. This has to work in a repository nobody here has seen.
 */

/** `${VAR}` is resolved from the environment at load; `${VAR:-fallback}` takes a default. */
const envRef = z.string();

export const modelBindingSchema = z.strictObject({
  provider: envRef,
  model: envRef,
});
export type ModelBinding = z.infer<typeof modelBindingSchema>;

export const modelsConfigSchema = z.strictObject({
  /**
   * One binding per role. The application asks for `outline`; configuration decides what answers.
   * Changing a role from a hosted model to a local one is an edit here and nowhere else.
   */
  roles: z.record(modelRoleSchema, modelBindingSchema),
});

export const budgetsConfigSchema = z.strictObject({
  /** Whole run. Checked before each call, never after — an over-budget call must not be made. */
  runMicroUsd: z.number().int().positive(),
  /** One step, so a single runaway expansion cannot consume the run. */
  stepMicroUsd: z.number().int().positive(),
  /** How many times a step may be retried after its evidence is struck. */
  maxRetries: z.number().int().nonnegative(),
  /** How deep a step may split into sub-steps. Without a cap, a plan can recurse forever. */
  maxDepth: z.number().int().positive(),
});

export const verificationConfigSchema = z.strictObject({
  /** How far from a cited line a quoted fragment may actually be. */
  lineTolerance: z.number().int().nonnegative(),
  /** Refuse a plan whose steps carry no citations at all. */
  requireEvidence: z.boolean(),
  /** Commands that decide done. Discovered from the repository, never assumed. */
  gates: z.array(z.strictObject({ name: z.string().min(1), command: z.string().min(1), dir: z.string() })),
});

export const repositoryConfigSchema = z.strictObject({
  /**
   * Where DevFlow writes. Default is neutral: a directory named after a person is a directory
   * that cannot be shared with a team, let alone another company.
   */
  dir: z.string().min(1),
  /** Searched for symbols. Empty means the whole repository. */
  roots: z.array(z.string().min(1)),
  /** Files whose rules outrank anything DevFlow says. First one found wins. */
  houseRuleFiles: z.array(z.string().min(1)),
  /** Recognises a ticket key in free text. Any team's prefix, or none at all. */
  ticketPattern: z.string().min(1),
});

export const knowledgeConfigSchema = z.strictObject({
  /** Where learnings live. `jsonl` is an implementation; the port says nothing about it. */
  store: z.enum(['jsonl', 'memory']),
  location: z.string().min(1),
  /** Only verified entries feed forward, always. Off means none do. */
  loadForward: z.boolean(),
});

export const executionConfigSchema = z.strictObject({
  /** Who works a step when the plan does not say. */
  defaultExecutor: z.enum(['operator', 'agent']),
  /** Total silence for this long stops a stage. 0 disables. */
  silenceMs: z.number().int().nonnegative(),
  /** Total wall clock for one stage. 0 disables. */
  capMs: z.number().int().nonnegative(),
});

export const observabilityConfigSchema = z.strictObject({
  /** `plain` is the everyday surface; `verbose` also prints the internal vocabulary. */
  verbosity: z.enum(['quiet', 'plain', 'verbose']),
  /** Where the append-only run log is written. */
  runsDir: z.string().min(1),
});

export const devflowConfigSchema = z.strictObject({
  models: modelsConfigSchema,
  budgets: budgetsConfigSchema,
  verification: verificationConfigSchema,
  repository: repositoryConfigSchema,
  knowledge: knowledgeConfigSchema,
  execution: executionConfigSchema,
  observability: observabilityConfigSchema,
});
export type DevFlowConfig = z.infer<typeof devflowConfigSchema>;

/** Where a resolved value came from. `devflow config show` prints this beside every setting. */
export const provenanceSchema = z.enum(['default', 'file', 'env', 'flag']);
export type Provenance = z.infer<typeof provenanceSchema>;

export const resolvedSettingSchema = z.strictObject({
  path: z.string().min(1),
  value: z.unknown(),
  from: provenanceSchema,
});
export type ResolvedSetting = z.infer<typeof resolvedSettingSchema>;
