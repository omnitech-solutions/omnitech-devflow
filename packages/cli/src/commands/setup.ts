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

/**
 * What DevFlow writes under its directory, and whether it is worth committing.
 *
 * The default for `tasks/` is **commit**, which is a deliberate reversal. It used to be ignored
 * alongside `runs/`, and that was wrong: the book under `tasks/` is the plan a reviewer is supposed
 * to read and argue with. A plan git never sees cannot be reviewed in the pull request that
 * implements it, which removes most of the reason for writing one down.
 *
 * `runs/` stays ignored. It is an append-only log of what happened on one machine — useful to the
 * person who ran it, noise in everyone else's diff, and it grows without bound.
 */
const KEEPABLE: ReadonlyArray<readonly [path: string, why: string]> = [
  ['config', 'the settings this repo runs on — everyone needs the same ones'],
  ['tasks', 'the plans and their verified citations — what a reviewer reads'],
  ['runs', 'one machine’s event log — grows without bound, useful only locally'],
];

/** Paths that are ignored by default. Anything not listed here is committed. */
const IGNORED_BY_DEFAULT = ['runs'];

/**
 * Resolve which paths to ignore from `--keep` and `--ignore`.
 *
 * Both accept a comma-separated list, and both may be given at once; `--ignore` is applied after
 * `--keep`, so a path named in both ends up ignored. Naming an unknown path is not an error — it
 * is written into the file as given, because a repository may put something of its own there and
 * having to patch DevFlow to ignore it would be absurd.
 */
export function ignoredPaths(flags: Readonly<Record<string, unknown>>): readonly string[] {
  const list = (value: unknown): readonly string[] =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim().replace(/\/+$/, ''))
          .filter(Boolean)
      : [];

  const keep = new Set(list(flags.keep));
  const ignored = IGNORED_BY_DEFAULT.filter((p) => !keep.has(p));
  for (const path of list(flags.ignore)) if (!ignored.includes(path)) ignored.push(path);
  return ignored;
}

/** The `.gitignore` body, with its reasoning in it — the file is read by people, not just git. */
export function gitignoreFor(ignored: readonly string[]): string {
  const lines = [
    '# Written by `devflow setup`. Change it with:',
    '#   devflow setup --force --keep <path>     commit it',
    '#   devflow setup --force --ignore <path>   keep it local',
    '#',
    '# Committed by default: config (everyone needs the same settings) and tasks/ (the plan and',
    '# its verified citations — what a reviewer reads in the PR that implements it).',
    '',
  ];
  if (ignored.length === 0) {
    lines.push('# Nothing is ignored: every DevFlow artifact in this repository is committed.');
  } else {
    for (const path of ignored) {
      const why = KEEPABLE.find(([p]) => p === path)?.[1];
      if (why) lines.push(`# ${why}`);
      lines.push(`${path}/`);
    }
  }
  return `${lines.join('\n')}\n`;
}

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
  const ignore = ignoredPaths(flags);
  await writeFileEnsuringDir(join(dir, '.gitignore'), gitignoreFor(ignore));

  env.out(`set up ${env.config.config.repository.dir}/ in ${env.repoRoot}`);
  env.out('');
  env.out(`  config     ${configPath}`);
  env.out(`  roots      ${roots.length ? roots.join(', ') : 'whole repository (none detected)'}`);
  env.out(`  house rules ${houseRules.length ? houseRules.join(', ') : 'none found'}`);
  env.out(`  global     ~/${GLOBAL_DIR}/${CONFIG_FILE}  (optional, applies to every repository)`);
  env.out('');
  env.out('  What gets committed, and what stays on this machine:');
  for (const [path, why] of KEEPABLE) {
    const kept = !ignore.includes(path);
    env.out(
      `    ${kept ? 'committed' : 'ignored  '}  ${env.config.config.repository.dir}/${path.padEnd(8)} ${why}`,
    );
  }
  env.out('');
  env.out(`    Change it with --keep or --ignore, for example:`);
  env.out(`      devflow setup --force --keep tasks     # share plans in the PR`);
  env.out(`      devflow setup --force --ignore tasks   # keep plans local`);
  env.out('');
  env.out('  Every setting can be overridden on any command, for example:');
  env.out('    devflow discover "…" --budgets.runMicroUsd 500000');
  env.out('');
  env.out('  Next: devflow discover "<a task, or a pasted ticket>"');
  return 0;
}
