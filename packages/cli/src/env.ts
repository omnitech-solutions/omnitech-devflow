import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AstGrepInspector, JsonlRunEventStore, SystemClock } from '@omnitech/devflow-adapters';
import { type LoadedConfig, loadConfig } from '@omnitech/devflow-core';

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
  };
}

/** Where DevFlow keeps a task's artefacts inside the repository. */
export const taskDir = (env: Env, taskId: string): string =>
  join(env.repoRoot, env.config.config.repository.dir, 'tasks', taskId);
