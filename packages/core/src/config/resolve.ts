import {
  type DevFlowConfig,
  devflowConfigSchema,
  type Provenance,
  type ResolvedSetting,
} from '@omnitech/devflow-contracts';

/**
 * Turning what is on disk and in the environment into one validated configuration — and keeping a
 * record of where every value came from.
 *
 * The provenance half is not a nicety. A gate record was once produced with baselines nobody had
 * recorded, and the reason was invisible because there was no way to ask what settings a run had
 * actually used. `devflow config show` exists so that question has an answer.
 */

/**
 * Defaults. Deliberately dull, and deliberately anonymous: no provider, no model, no company, no
 * person, no ticket prefix belonging to anyone. This has to be the configuration a repository
 * nobody here has seen would want.
 */
export const DEFAULTS: DevFlowConfig = {
  models: {
    roles: {
      outline: { provider: '${DEVFLOW_OUTLINE_PROVIDER}', model: '${DEVFLOW_OUTLINE_MODEL}' },
      expansion: { provider: '${DEVFLOW_EXPANSION_PROVIDER}', model: '${DEVFLOW_EXPANSION_MODEL}' },
      audit: { provider: '${DEVFLOW_AUDIT_PROVIDER}', model: '${DEVFLOW_AUDIT_MODEL}' },
    },
  },
  budgets: {
    runMicroUsd: 2_000_000,
    stepMicroUsd: 250_000,
    maxRetries: 1,
    maxDepth: 2,
  },
  verification: {
    lineTolerance: 3,
    requireEvidence: true,
    gates: [],
  },
  repository: {
    dir: '.devflow',
    roots: [],
    houseRuleFiles: ['AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md'],
    // Two to ten uppercase alphanumerics, a hyphen, digits. Matches most trackers and is
    // configuration rather than a constant, because plenty of teams use none at all.
    ticketPattern: '\\b([A-Z][A-Z0-9]{1,9}-\\d+)\\b',
  },
  knowledge: { store: 'jsonl', location: '.devflow/knowledge.jsonl', loadForward: true },
  execution: { defaultExecutor: 'operator', silenceMs: 900_000, capMs: 0 },
  observability: { verbosity: 'plain', runsDir: '.devflow/runs' },
};

/** `${VAR}` or `${VAR:-fallback}`. Anything else is left exactly as written. */
const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)(?::-(.*))?\}$/;

export interface InterpolationResult {
  readonly value: string;
  readonly from: Provenance;
  /** Set when a reference had no value and no fallback — the caller decides if that is fatal. */
  readonly unresolved?: string;
}

/**
 * Resolve one string against the environment.
 *
 * An unresolved reference is returned as such rather than silently becoming the literal
 * `"${DEVFLOW_OUTLINE_MODEL}"`. A configuration that ships a placeholder as a model name fails at
 * the provider with a confusing error; failing here names the variable instead.
 */
export function interpolate(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): InterpolationResult {
  const m = ENV_REF.exec(raw);
  if (!m) return { value: raw, from: 'default' };
  const name = m[1] as string;
  const fallback = m[2];
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, from: 'env' };
  if (fallback !== undefined) return { value: fallback, from: 'default' };
  return { value: raw, from: 'default', unresolved: name };
}

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Layer overrides onto defaults.
 *
 * Deep for objects, replace for arrays. An array merged element-wise cannot be shortened, so a
 * repository that wants one house-rule file could never drop the other two.
 */
export function merge(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const existing = out[k];
    out[k] = isPlainObject(v) && isPlainObject(existing) ? merge(existing, v) : v;
  }
  return out;
}

export interface ResolveInput {
  readonly file?: Plain;
  readonly flags?: Plain;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedConfig {
  readonly config: DevFlowConfig;
  /** Every leaf, with where it came from. The data behind `devflow config show`. */
  readonly settings: readonly ResolvedSetting[];
  /** Environment references that resolved to nothing and had no fallback. */
  readonly unresolved: readonly string[];
}

/** Walk every leaf, interpolating strings and recording provenance as it goes. */
function walk(
  node: unknown,
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  origin: (p: string) => Provenance,
  out: ResolvedSetting[],
  unresolved: string[],
): unknown {
  if (typeof node === 'string') {
    const r = interpolate(node, env);
    if (r.unresolved) unresolved.push(r.unresolved);
    // An env reference reports `env` even when the layer under it was a file: the value that won
    // is the one the run used, and that is the question `config show` answers.
    out.push({ path, value: r.value, from: r.from === 'env' ? 'env' : origin(path) });
    return r.value;
  }
  if (Array.isArray(node)) {
    out.push({ path, value: node, from: origin(path) });
    return node.map((v, i) => walk(v, `${path}[${i}]`, env, origin, [], unresolved));
  }
  if (isPlainObject(node)) {
    const o: Plain = {};
    for (const [k, v] of Object.entries(node)) {
      o[k] = walk(v, path ? `${path}.${k}` : k, env, origin, out, unresolved);
    }
    return o;
  }
  out.push({ path, value: node, from: origin(path) });
  return node;
}

/** Collect every leaf path present in a layer, so provenance can name which layer set it. */
function leafPaths(node: unknown, path = '', into = new Set<string>()): Set<string> {
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) leafPaths(v, path ? `${path}.${k}` : k, into);
  } else if (path) {
    into.add(path);
  }
  return into;
}

/**
 * Defaults, then file, then flags, with the environment resolving references at every level.
 *
 * Validation happens last and on the merged whole, so a file that half-specifies a section is
 * completed by defaults rather than rejected for being incomplete.
 */
export function resolveConfig(input: ResolveInput = {}): ResolvedConfig {
  const env = input.env ?? {};
  const fromFile = leafPaths(input.file ?? {});
  const fromFlags = leafPaths(input.flags ?? {});
  const origin = (p: string): Provenance =>
    fromFlags.has(p) ? 'flag' : fromFile.has(p) ? 'file' : 'default';

  const merged = merge(merge(DEFAULTS as unknown as Plain, input.file ?? {}), input.flags ?? {});
  const settings: ResolvedSetting[] = [];
  const unresolved: string[] = [];
  const interpolated = walk(merged, '', env, origin, settings, unresolved);

  return {
    config: devflowConfigSchema.parse(interpolated),
    settings,
    unresolved: [...new Set(unresolved)],
  };
}
