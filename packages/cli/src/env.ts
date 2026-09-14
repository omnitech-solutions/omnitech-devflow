import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AstGrepInspector,
  JsonlRunEventStore,
  OpenRouterModelClient,
  SystemClock,
} from '@omnitech/devflow-adapters';
import type { ModelRole } from '@omnitech/devflow-contracts';
import { type LoadedConfig, loadConfig, type ModelClient } from '@omnitech/devflow-core';

/**
 * The composition root: the one place ports are joined to adapters.
 *
 * Every command takes what it needs from here. Nothing below constructs an adapter, so a command
 * cannot quietly reach past a port — and swapping an implementation is an edit in this file only.
 */

export interface Env {
  readonly repoRoot: string;
  readonly config: LoadedConfig;
  readonly clock: SystemClock;
  readonly inspector: AstGrepInspector;
  readonly runs: JsonlRunEventStore;
  readonly branch: string | undefined;
  readonly verbose: boolean;
  readonly out: (line: string) => void;
  /**
   * Constructed lazily, and only by the commands that need it.
   *
   * A getter rather than a field because building it reads a credential: `devflow verify` and
   * `devflow show` must keep working on a machine that has never had an API key, and they would
   * not if the composition root demanded one to build the environment at all.
   */
  readonly model: ModelClient;
}

/** The repository we are in. Falls back to the working directory outside a checkout. */
export function repoRootOf(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

export function branchOf(repoRoot: string): string | undefined {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

export async function writeFileEnsuringDir(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

export async function makeEnv(
  overrides: Record<string, unknown>,
  verbose: boolean,
  out: (line: string) => void = console.log,
): Promise<Env> {
  const repoRoot = repoRootOf();
  const config = await loadConfig(
    { readFile: readMaybe, env: process.env, homeDir: homedir(), repoRoot, join },
    overrides,
  );
  const clock = new SystemClock();
  return {
    repoRoot,
    config,
    clock,
    inspector: new AstGrepInspector({ repoRoot, roots: config.config.repository.roots }),
    runs: new JsonlRunEventStore(join(repoRoot, config.config.observability.runsDir), clock),
    branch: branchOf(repoRoot),
    verbose,
    out,
    get model(): ModelClient {
      return modelClientFor(config, out);
    },
  };
}

/**
 * The model client, from configuration alone.
 *
 * Role → model comes out of `models.roles`; nothing here picks a model. The provider name is read
 * and checked rather than assumed, so a config naming a provider this build cannot talk to says so
 * instead of sending the request somewhere unintended.
 */
export function modelClientFor(
  config: LoadedConfig,
  out: (line: string) => void,
  /**
   * Injected only by tests, for the same reason `AstGrepInspector` takes its `parse`: the call
   * announcement below is the one piece of this function that cannot be reached without a network
   * call, and a line nobody can exercise is a line nobody knows works.
   */
  fetchImpl?: typeof globalThis.fetch,
): ModelClient {
  const roles = config.config.models.roles;
  const providers = new Set(Object.values(roles).map((binding) => binding.provider));
  const unknown = [...providers].filter((p) => p !== 'openrouter');
  if (unknown.length) {
    throw new Error(
      `this build can only talk to "openrouter"; the configuration asks for ${unknown.map((p) => `"${p}"`).join(', ')}. ` +
        'Set models.roles.<role>.provider to "openrouter" in .devflow/config.json.',
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set, so no model can be reached. Export it, or use --dry-run to ' +
        'see what would be sent without sending it.',
    );
  }

  const models = Object.fromEntries(
    Object.entries(roles).map(([role, binding]) => [role, binding.model]),
  ) as Record<ModelRole, string>;

  return new OpenRouterModelClient({
    apiKey,
    models,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    timeoutMs: config.config.execution.silenceMs,
    // Every call is announced. A run that spends money silently is a run nobody can audit while it
    // is happening, which is when it matters.
    onCall: (call) =>
      out(
        `      · ${call.role} ${call.model} attempt ${call.attempt + 1} ${call.ok ? 'ok' : 'retry'}` +
          ` $${(call.cost.microUsd / 1e6).toFixed(4)} ${(call.ms / 1000).toFixed(1)}s` +
          (call.detail ? ` — ${call.detail}` : ''),
      ),
  });
}

/** Where DevFlow keeps a task's artefacts inside the repository. */
export const taskDir = (env: Env, taskId: string): string =>
  join(env.repoRoot, env.config.config.repository.dir, 'tasks', taskId);
