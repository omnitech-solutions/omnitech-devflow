import { join } from 'node:path';
import { CONFIG_FILE, DEFAULTS, GLOBAL_DIR } from '@omnitech/devflow-core';
import { type Env, readMaybe, writeFileEnsuringDir } from '../env.js';

/**
 * `devflow setup` — make this repository DevFlow-ready.
 *
 * Writes one directory and one config file. Everything it writes is inspectable and everything it
 * chooses, it says out loud: a setup command that silently decides things is a setup command whose
 * decisions surface three weeks later as a bug nobody can trace.
 *
 * Idempotent. Re-running it never overwrites a config that already exists — the second run of a
 * setup command is usually someone checking, not someone asking to start again.
 */

/** Only the settings a repository genuinely needs to state. The rest stay on defaults. */
function starterConfig(detected: { roots: string[]; houseRules: string[] }): string {
  const config = {
    $schema: 'https://omnitech.dev/devflow/config.schema.json',
    repository: {
      // Discovered rather than guessed: an empty roots list makes every query walk the whole tree.
      roots: detected.roots,
      houseRuleFiles: detected.houseRules.length ? detected.houseRules : DEFAULTS.repository.houseRuleFiles,
    },
    budgets: { runMicroUsd: DEFAULTS.budgets.runMicroUsd },
    observability: { verbosity: DEFAULTS.observability.verbosity },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const LIKELY_ROOTS = ['src', 'app', 'lib', 'server', 'packages'];

export async function setup(env: Env, flags: Readonly<Record<string, unknown>>): Promise<number> {
  const dir = join(env.repoRoot, env.config.config.repository.dir);
  const configPath = join(dir, CONFIG_FILE);
  const force = flags.force === true;

  const existing = await readMaybe(configPath);
  if (existing !== null && !force) {
    env.out(`already set up: ${configPath}`);
    env.out('  nothing changed. `devflow config show` prints the effective settings.');
    env.out('  `devflow setup --force` rewrites it.');
    return 0;
  }

  const roots: string[] = [];
  for (const candidate of LIKELY_ROOTS) {
    if ((await readMaybe(join(env.repoRoot, candidate, 'index.ts'))) !== null) roots.push(candidate);
    else if ((await readMaybe(join(env.repoRoot, candidate, 'package.json'))) !== null) roots.push(candidate);
  }
  const houseRules: string[] = [];
  for (const candidate of DEFAULTS.repository.houseRuleFiles) {
    if ((await readMaybe(join(env.repoRoot, candidate))) !== null) houseRules.push(candidate);
  }

  await writeFileEnsuringDir(configPath, starterConfig({ roots, houseRules }));
  // Runs and tasks are local working state, never someone else's business in a diff.
  await writeFileEnsuringDir(join(dir, '.gitignore'), ['runs/', 'tasks/', ''].join('\n'));

  env.out(`set up ${env.config.config.repository.dir}/ in ${env.repoRoot}`);
  env.out('');
  env.out(`  config     ${configPath}`);
  env.out(`  roots      ${roots.length ? roots.join(', ') : 'whole repository (none detected)'}`);
  env.out(`  house rules ${houseRules.length ? houseRules.join(', ') : 'none found'}`);
  env.out(`  global     ~/${GLOBAL_DIR}/${CONFIG_FILE}  (optional, applies to every repository)`);
  env.out('');
  env.out('  Every setting can be overridden on any command, for example:');
  env.out('    devflow discover "…" --budgets.runMicroUsd 500000');
  env.out('');
  env.out('  Next: devflow discover "<a task, or a pasted ticket>"');
  return 0;
}
