import { join } from 'node:path';
import { CONFIG_FILE } from '@omnitech/devflow-core';
import { type Env, readMaybe } from '../env.js';

/**
 * `devflow doctor` — what would stop a run, and what to do about it.
 *
 * Every row that is not OK carries the command that fixes it. A diagnostic that names a problem
 * without naming its remedy makes the reader do the work twice.
 */
export async function doctor(env: Env): Promise<number> {
  const cfg = env.config.config;
  const rows: Array<{ level: 'ok' | 'warn' | 'stop'; name: string; detail: string; fix?: string }> = [];

  rows.push({ level: 'ok', name: 'repository', detail: env.repoRoot });

  const configPath = join(env.repoRoot, cfg.repository.dir, CONFIG_FILE);
  const hasConfig = (await readMaybe(configPath)) !== null;
  rows.push({
    level: hasConfig ? 'ok' : 'warn',
    name: 'set up here',
    detail: hasConfig ? configPath : `no ${cfg.repository.dir}/${CONFIG_FILE}`,
    ...(hasConfig ? {} : { fix: 'devflow setup' }),
  });

  const inspectorUp = await env.inspector.available();
  rows.push({
    level: inspectorUp ? 'ok' : 'stop',
    name: 'code inspector',
    detail: inspectorUp ? 'parses' : 'cannot parse — every structural claim would be unverifiable',
    ...(inspectorUp ? {} : { fix: 'pnpm install' }),
  });

  let rules = 0;
  let ruleFile = '';
  for (const candidate of cfg.repository.houseRuleFiles) {
    const text = await readMaybe(join(env.repoRoot, candidate));
    if (text === null) continue;
    ruleFile = candidate;
    rules = [...text.matchAll(/^\s*(?:\d+[.)]|[-*])\s+\S.{15,}/gm)].length;
    break;
  }
  rows.push({
    level: rules ? 'ok' : 'warn',
    name: 'house rules',
    detail: rules
      ? `${rules} from ${ruleFile}`
      : `none found (looked for ${cfg.repository.houseRuleFiles.join(', ')})`,
    ...(rules ? {} : { fix: `add one of ${cfg.repository.houseRuleFiles.join(', ')} to this repository` }),
  });

  rows.push({
    level: cfg.repository.roots.length ? 'ok' : 'warn',
    name: 'search roots',
    detail: cfg.repository.roots.length
      ? cfg.repository.roots.join(', ')
      : 'whole repository — queries will be slow',
    ...(cfg.repository.roots.length
      ? {}
      : { fix: `set repository.roots in ${cfg.repository.dir}/${CONFIG_FILE}` }),
  });

  if (env.config.unresolved.length) {
    rows.push({
      level: 'warn',
      name: 'environment',
      detail: `${env.config.unresolved.join(', ')} not set`,
      fix: 'export them, or leave them — only model-backed commands need them',
    });
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  const mark = { ok: ' ok ', warn: 'warn', stop: 'STOP' } as const;
  for (const r of rows) env.out(`  ${mark[r.level]}  ${r.name.padEnd(width)}  ${r.detail}`);

  const problems = rows.filter((r) => r.level !== 'ok');
  if (problems.length) {
    env.out('');
    env.out('How to fix');
    for (const [i, r] of problems.entries()) {
      env.out(`  ${i + 1}. ${r.name}`);
      if (r.fix) env.out(`     run  ${r.fix}`);
    }
  }
  env.out('');
  env.out(`  ${rows.length} checks · ${rows.filter((r) => r.level === 'stop').length} blocking`);
  return rows.some((r) => r.level === 'stop') ? 1 : 0;
}
