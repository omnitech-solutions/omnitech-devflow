import { join } from 'node:path';
import type { RunId, TaskId } from '@omnitech/devflow-contracts';
import { intake, notesFrom, discover as research } from '@omnitech/devflow-core';
import { type Env, readMaybe, taskDir, writeFileEnsuringDir } from '../env.js';

/**
 * `devflow discover "<task>"` — the research that happens before a plan exists.
 *
 * No model, no spend. Every line it prints, it read from the repository, and a probe that could
 * not run is reported louder than one that found nothing — a thinner brief must never read like a
 * cleaner one.
 */
export async function discover(env: Env, text: string): Promise<number> {
  const cfg = env.config.config;
  const task = intake(text, {
    ticketPattern: cfg.repository.ticketPattern,
    ...(env.branch === undefined ? {} : { branch: env.branch }),
  });

  const runId = `${task.id}-${env.clock.now().toISOString().replace(/[:.]/g, '-')}` as RunId;
  await env.runs.append(runId, { kind: 'run.started', taskId: task.id as TaskId, mode: 'discover' });

  const ctx = await research(task, cfg, {
    inspector: env.inspector,
    readFile: (p) => readMaybe(join(env.repoRoot, p)),
  });
  await env.runs.append(runId, { kind: 'context.gathered', probes: ctx.probes });

  const dir = taskDir(env, task.id);
  await writeFileEnsuringDir(join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  await writeFileEnsuringDir(
    join(dir, 'context.json'),
    `${JSON.stringify({ ...ctx, notes: notesFrom(ctx) }, null, 2)}\n`,
  );

  env.out(`${task.id} — ${task.title}`);
  env.out('');
  env.out('Context');
  env.out(`  house rules   ${ctx.houseRules.rules.length} from ${ctx.houseRules.file ?? 'nothing found'}`);
  env.out(`  paths named   ${ctx.files.filter((f) => f.exists).length} of ${ctx.files.length} exist`);
  const sites = ctx.symbols.reduce((n, s) => n + s.definitions.length + s.references.length, 0);
  env.out(`  symbols       ${sites} site(s) across ${ctx.symbols.length} symbol(s)`);
  env.out(`  prior learnings ${ctx.knowledge.length}`);

  for (const f of ctx.files.filter((x) => !x.exists)) {
    env.out(`  ! ${f.path} does not exist`);
  }
  for (const s of ctx.symbols.filter((x) => x.definitions.length === 0 && x.references.length === 0)) {
    env.out(`  ! ${s.symbol} is neither defined nor referenced anywhere searched`);
  }
  for (const gap of ctx.gaps) env.out(`  ! ${gap}`);

  env.out('');
  env.out(`  written to ${cfg.repository.dir}/tasks/${task.id}/`);
  env.out('');
  env.out(`  Next: devflow plan ${task.id}`);
  return 0;
}
