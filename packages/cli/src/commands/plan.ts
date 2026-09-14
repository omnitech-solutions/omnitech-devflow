import { join } from 'node:path';
import type { Plan, Task } from '@omnitech/devflow-contracts';
import {
  blanks,
  type DiscoveredContext,
  notesFrom,
  parseBook,
  renderBook,
  slug,
  undisciplinedTodos,
} from '@omnitech/devflow-core';
import { type Env, readMaybe, taskDir, writeFileEnsuringDir } from '../env.js';

/**
 * `devflow plan <task>` — turn discovered context into a book.
 *
 * The notes are filled from what discovery measured. The steps are deliberately left blank: what
 * the steps ARE is a judgement, and a plan that invented them would be asserting something nobody
 * decided. `devflow verify` refuses while a blank remains, which is what stops a half-written plan
 * reaching an executor.
 */
export async function plan(env: Env, taskId: string, steps: number): Promise<number> {
  const dir = taskDir(env, taskId);
  const taskJson = await readMaybe(join(dir, 'task.json'));
  const contextJson = await readMaybe(join(dir, 'context.json'));
  if (!taskJson || !contextJson) {
    env.out(`no context for ${taskId}. Run: devflow discover "<the task>"`);
    return 2;
  }

  const task = JSON.parse(taskJson) as Task;
  const ctx = JSON.parse(contextJson) as DiscoveredContext;

  const draft: Plan = {
    id: `${task.id}-plan` as Plan['id'],
    taskId: task.id,
    slug: slug(task.title),
    title: task.title,
    createdAt: env.clock.now().toISOString(),
    notes: [...notesFrom(ctx)],
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `${task.id}-${i + 1}` as Plan['steps'][number]['id'],
      n: i + 1,
      title: '<one line: the claim this step closes>',
      dependsOn: [],
      landsIn: ['<path this step may touch>'],
      estimatedDecisions: [{ question: '<name each decision, or state there are none>' }],
      prohibited: ['<the tempting wrong move this step must not make>'],
      executor: env.config.config.execution.defaultExecutor,
      prompt:
        '<what to do, written so the executor never has to go looking.\n' +
        '\n' +
        'Anchor every claim to something that survives an edit — `devflow verify` checks these:\n' +
        '  `theSymbol` is defined in `path/to/file.ts`\n' +
        '  `path/to/file.tsx` calls `theSymbol`\n' +
        '  `path/to/other.tsx` does not call `theSymbol`\n' +
        '  `path/to/file.ts` contains `some source text`\n' +
        'A trailing `:42` is kept as a navigation hint and is never what passes or fails.>',
      acceptanceCriteria: ['<an observable that is true after and was false before>'],
      evidence: { items: [], verified: 0, struck: 0, unverifiable: 0 },
    })),
  };

  const book = renderBook(draft, {
    slug: draft.slug,
    name: draft.title,
    repo_url: env.repoRoot,
    ...(task.ticketKey ? { ticket: task.ticketKey } : {}),
  });

  const bookPath = join(dir, `${draft.slug}.book.md`);
  await writeFileEnsuringDir(bookPath, book);
  await writeFileEnsuringDir(join(dir, 'plan.json'), `${JSON.stringify(draft, null, 2)}\n`);

  const parsed = parseBook(book);
  env.out(`${task.id} — ${draft.title}`);
  env.out('');
  env.out('Plan');
  env.out(
    `  notes      ${parsed.rows.filter((r) => r.type === 'note').length} briefed from measured context`,
  );
  env.out(`  steps      ${steps} to write`);
  env.out(`  undisciplined ${undisciplinedTodos(parsed).length}`);
  env.out(`  blanks     ${blanks(book).length}`);
  env.out('');
  env.out(`  ${env.config.config.repository.dir}/tasks/${task.id}/${draft.slug}.book.md`);
  env.out('');
  env.out('  Fill every `<…>` — that is the part only a human can do.');
  env.out(`  Then: devflow verify ${task.id}`);
  return 0;
}
