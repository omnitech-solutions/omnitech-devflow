import { join } from 'node:path';
import type { RunId } from '@omnitech/devflow-contracts';
import { viewOf } from '@omnitech/devflow-core';
import { type Env, readMaybe, taskDir } from '../env.js';
import { evidenceLine, say, tick } from '../render.js';

/**
 * `devflow show [task]` — everything DevFlow knows.
 *
 * A pure projection over the append-only log. It stores nothing and it changes nothing, so it is
 * safe to run mid-run and safe to run twice.
 *
 * With no id it lists recent work. With one it drills in — and it folds the LATEST run by default,
 * because "how is this going" is the question 95% of the time. `devflow history <id>` is the
 * timeline.
 */

const runsForTask = async (env: Env, taskId: string): Promise<RunId[]> =>
  (await env.runs.list()).filter((r) => r.startsWith(`${taskId}-`)).sort();

export async function show(env: Env, taskId: string | undefined, all: boolean): Promise<number> {
  if (!taskId) return list(env);

  const runs = await runsForTask(env, taskId);
  if (runs.length === 0) {
    env.out(`${taskId} — nothing recorded. Run: devflow discover "<the task>"`);
    return 2;
  }
  const chosen = all ? runs : runs.slice(-1);

  const dir = taskDir(env, taskId);
  const title = JSON.parse((await readMaybe(join(dir, 'task.json'))) ?? '{}').title ?? '';
  const hasPlan = (await readMaybe(join(dir, 'plan.json'))) !== null;

  env.out(`${taskId} — ${title}`);

  for (const runId of chosen) {
    const view = await viewOf(env.runs, runId);
    env.out('');
    if (all) env.out(`Run ${runId}`);

    env.out('');
    env.out('State');
    env.out(`  ${view.state}`);

    env.out('');
    env.out('Workflow');
    env.out(`  ${tick('done')} discovery`);
    env.out(`  ${tick(hasPlan ? 'done' : 'todo')} plan`);
    env.out(`  ${tick(view.steps.some((s) => s.state === 'passed') ? 'active' : 'todo')} execution`);
    env.out(`  ${tick('todo')} verification`);

    const blocked = view.steps.find((s) => s.stoppedBecause === 'needs-operator');
    if (blocked) {
      env.out('');
      env.out('Blocked');
      // The reason AND the detail. An earlier version printed only the detail when there was one,
      // so --verbose showed nothing extra in exactly the case a reader is most likely to use it.
      env.out(`  ${say('needs-operator', env.verbose)}`);
      if (blocked.detail) env.out(`  ${blocked.detail}`);
    }

    const withEvidence = view.steps.filter((s) => s.evidence);
    if (withEvidence.length) {
      env.out('');
      env.out('Evidence');
      for (const s of withEvidence) {
        // biome-ignore lint/style/noNonNullAssertion: filtered on `s.evidence` immediately above.
        env.out(`  step ${s.n}  ${evidenceLine(s.evidence!)}`);
      }
    }

    env.out('');
    env.out('Run');
    env.out(`  started    ${view.startedAt ?? '—'}`);
    env.out(`  events     ${view.seq + 1}`);
    env.out(`  cost       $${(view.spent.microUsd / 1e6).toFixed(4)}`);
  }

  if (!all && runs.length > 1) {
    env.out('');
    env.out(`  ${runs.length - 1} earlier run(s) — devflow show ${taskId} --all`);
  }
  return 0;
}

async function list(env: Env): Promise<number> {
  const runs = await env.runs.list();
  if (runs.length === 0) {
    env.out('nothing yet. Run: devflow discover "<a task, or a pasted ticket>"');
    return 0;
  }
  // One line per task, its most recent run.
  const latest = new Map<string, RunId>();
  for (const runId of [...runs].sort()) {
    const taskId = runId.replace(/-\d{4}-\d{2}-\d{2}T.*$/, '').replace(/-verify$/, '');
    latest.set(taskId, runId);
  }
  for (const [taskId, runId] of latest) {
    const view = await viewOf(env.runs, runId);
    env.out(`${taskId.padEnd(24)} ${view.state.padEnd(22)} ${view.seq + 1} event(s)`);
  }
  return 0;
}
