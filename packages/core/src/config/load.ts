import { merge, type ResolvedConfig, type ResolveInput, resolveConfig } from './resolve.js';

/**
 * Where configuration comes from, in the order it wins.
 *
 *   defaults          shipped, anonymous, work in any repository
 *   global            ~/.devflow/config.json      — a person's preferences across every repo
 *   repo              <repo>/.devflow/config.json — this project's decisions, committed
 *   environment       ${VAR} references, resolved wherever they appear
 *   flags             one invocation only
 *
 * Repo above global is the important one: a project's settings are a team decision that travels
 * with the checkout, and a personal preference must never silently change what a colleague's run
 * does. Flags stay on top because a one-off override that could be overridden by a file is not an
 * override at all.
 */

export const GLOBAL_DIR = '.devflow';
export const CONFIG_FILE = 'config.json';

export interface ConfigSources {
  readonly globalPath: string;
  readonly repoPath: string;
}

export interface LoadConfigDeps {
  /** Returns the file's text, or null when it is not there. Never throws for absence. */
  readonly readFile: (path: string) => Promise<string | null>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly repoRoot: string;
  readonly join: (...parts: string[]) => string;
}

export function configSources(deps: Pick<LoadConfigDeps, 'homeDir' | 'repoRoot' | 'join'>): ConfigSources {
  return {
    globalPath: deps.join(deps.homeDir, GLOBAL_DIR, CONFIG_FILE),
    repoPath: deps.join(deps.repoRoot, GLOBAL_DIR, CONFIG_FILE),
  };
}

export interface LoadedConfig extends ResolvedConfig {
  /** Which files were actually read. `devflow config show` prints these. */
  readonly files: readonly string[];
}

type Plain = Record<string, unknown>;

/**
 * A malformed config file is fatal and names itself.
 *
 * Falling back to defaults would be worse than stopping: the run would proceed with settings
 * nobody chose, and the reason would be a file the operator believes is in force.
 */
async function readJson(path: string, read: LoadConfigDeps['readFile']): Promise<Plain | null> {
  const text = await read(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Plain;
  } catch (cause) {
    // Both throw sites above raise an Error, so no non-Error branch is reachable here.
    throw new Error(
      `${path} is not valid DevFlow configuration: ${(cause as Error).message}. ` +
        'Fix the file or delete it — running on defaults nobody chose would hide the problem.',
    );
  }
}

export async function loadConfig(deps: LoadConfigDeps, flags: Plain = {}): Promise<LoadedConfig> {
  const { globalPath, repoPath } = configSources(deps);
  const files: string[] = [];

  const global = await readJson(globalPath, deps.readFile);
  if (global) files.push(globalPath);
  const repo = await readJson(repoPath, deps.readFile);
  if (repo) files.push(repoPath);

  const input: ResolveInput = {
    // One `file` layer, global under repo, so provenance still reports `file` for either and the
    // resolver stays a pure function of three layers.
    //
    // Deep-merged, not spread. A shallow spread drops a whole section when both files touch it:
    // a global setting `budgets.runMicroUsd` and a repo setting `budgets.maxRetries` would lose
    // the global one entirely, silently, and the run would use a cap nobody set.
    file: merge(global ?? {}, repo ?? {}),
    flags,
    env: deps.env,
  };
  return { ...resolveConfig(input), files };
}
